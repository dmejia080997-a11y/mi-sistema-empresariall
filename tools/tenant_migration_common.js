require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { buildSafeDatabaseName } = require('../src/services/company-database-service');
const { getDatabaseConfig } = require('../src/config/database');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKUP_ROOT = path.join(ROOT_DIR, 'storage', 'backups');

const TENANT_EXCLUDED_TABLES = new Set([
  'companies',
  'company_inactivation_notes',
  'business_activities',
  'migration_events'
]);

const RELATED_COPY_RULES = {
  awb_items: [{ column: 'awb_id', parentTable: 'awbs', parentColumn: 'id' }],
  awb_manifests: [
    { column: 'awb_id', parentTable: 'awbs', parentColumn: 'id' },
    { column: 'manifest_id', parentTable: 'manifests', parentColumn: 'id' }
  ],
  manifest_pieces: [{ column: 'manifest_id', parentTable: 'manifests', parentColumn: 'id' }],
  manifest_piece_packages: [
    { column: 'manifest_piece_id', parentTable: 'manifest_pieces', parentColumn: 'id' },
    { column: 'package_id', parentTable: 'packages', parentColumn: 'id' }
  ],
  cartas_porte_items: [{ column: 'carta_porte_id', parentTable: 'cartas_porte', parentColumn: 'id' }]
};

function getPostgresConfig() {
  const config = getDatabaseConfig();
  if (config.client !== 'postgres') {
    throw new Error('DATABASE_URL is required. The master database must be PostgreSQL.');
  }
  return config;
}

function getSsl(config) {
  return config.ssl ? { rejectUnauthorized: false } : false;
}

function parseDatabaseUrl(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  return new URL(databaseUrl);
}

function databaseUrlForName(baseUrl, databaseName) {
  const parsed = parseDatabaseUrl(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function maintenanceUrl(baseUrl) {
  const parsed = parseDatabaseUrl(baseUrl);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

function connectionParts(baseUrl, databaseName) {
  const parsed = parseDatabaseUrl(baseUrl);
  return {
    database_name: databaseName,
    database_host: parsed.hostname || 'localhost',
    database_port: parsed.port || '5432',
    database_user: decodeURIComponent(parsed.username || ''),
    database_password_ref: parsed.password ? 'DATABASE_URL_PASSWORD' : null,
    database_type: 'postgresql',
    database_status: 'active'
  };
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createMasterPool() {
  const config = getPostgresConfig();
  return new Pool({
    connectionString: config.url,
    ssl: getSsl(config)
  });
}

function createMaintenancePool() {
  const config = getPostgresConfig();
  return new Pool({
    connectionString: maintenanceUrl(config.url),
    ssl: getSsl(config)
  });
}

function createTenantPool(databaseName) {
  const config = getPostgresConfig();
  return new Pool({
    connectionString: databaseUrlForName(config.url, databaseName),
    ssl: getSsl(config)
  });
}

async function databaseExists(pg, databaseName) {
  const result = await pg.query('SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1', [databaseName]);
  return result.rowCount > 0;
}

async function resolveAvailableDatabaseName(adminPool, company) {
  const baseName = buildSafeDatabaseName(company.name || `empresa_${company.id}`);
  let candidate = baseName;
  let counter = 2;
  while (await databaseExists(adminPool, candidate)) {
    const suffix = `_${counter}`;
    candidate = `${baseName.slice(0, 63 - suffix.length)}${suffix}`;
    counter += 1;
  }
  return candidate;
}

async function createPhysicalDatabase(databaseName) {
  const adminPool = createMaintenancePool();
  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  } finally {
    await adminPool.end();
  }
}

async function listCompanies(masterPool) {
  const result = await masterPool.query(
    `SELECT id, name, database_name, database_type, database_status
     FROM companies
     ORDER BY id`
  );
  return result.rows;
}

async function listTenantTables(masterPool) {
  const result = await masterPool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  return result.rows
    .map((row) => row.table_name)
    .filter((name) => name && !TENANT_EXCLUDED_TABLES.has(name));
}

async function getTableColumns(masterPool, tableName) {
  const result = await masterPool.query(
    `SELECT c.column_name,
            c.data_type,
            c.udt_name,
            c.is_nullable,
            c.column_default,
            c.character_maximum_length,
            c.numeric_precision,
            c.numeric_scale,
            c.datetime_precision,
            CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 1 ELSE 0 END AS is_pk
     FROM information_schema.columns c
     LEFT JOIN information_schema.key_column_usage kcu
       ON kcu.table_schema = c.table_schema
      AND kcu.table_name = c.table_name
      AND kcu.column_name = c.column_name
     LEFT JOIN information_schema.table_constraints tc
       ON tc.constraint_schema = kcu.constraint_schema
      AND tc.constraint_name = kcu.constraint_name
      AND tc.constraint_type = 'PRIMARY KEY'
     WHERE c.table_schema = current_schema()
       AND c.table_name = $1
     ORDER BY c.ordinal_position`,
    [tableName]
  );
  return result.rows;
}

async function tableHasCompanyId(masterPool, tableName) {
  const result = await masterPool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = 'company_id'
     LIMIT 1`,
    [tableName]
  );
  return result.rowCount > 0;
}

function columnType(column) {
  if (Number(column.is_pk || 0) === 1 && /^(int2|int4|int8)$/.test(column.udt_name)) {
    return column.udt_name === 'int4' ? 'SERIAL' : 'BIGSERIAL';
  }

  if (column.data_type === 'character varying') {
    return column.character_maximum_length ? `VARCHAR(${column.character_maximum_length})` : 'VARCHAR';
  }
  if (column.data_type === 'character') {
    return column.character_maximum_length ? `CHAR(${column.character_maximum_length})` : 'CHAR';
  }
  if (column.data_type === 'numeric') {
    if (column.numeric_precision && column.numeric_scale !== null) {
      return `NUMERIC(${column.numeric_precision}, ${column.numeric_scale})`;
    }
    return 'NUMERIC';
  }
  if (column.data_type === 'timestamp without time zone') return 'TIMESTAMP';
  if (column.data_type === 'timestamp with time zone') return 'TIMESTAMPTZ';
  if (column.data_type === 'time without time zone') return 'TIME';
  if (column.data_type === 'time with time zone') return 'TIMETZ';
  if (column.data_type === 'USER-DEFINED') return quoteIdent(column.udt_name);

  const byUdt = {
    int2: 'SMALLINT',
    int4: 'INTEGER',
    int8: 'BIGINT',
    float4: 'REAL',
    float8: 'DOUBLE PRECISION',
    bool: 'BOOLEAN',
    text: 'TEXT',
    json: 'JSON',
    jsonb: 'JSONB',
    bytea: 'BYTEA',
    date: 'DATE',
    uuid: 'UUID'
  };
  return byUdt[column.udt_name] || String(column.data_type || 'TEXT').toUpperCase();
}

function defaultExpression(column) {
  const raw = String(column.column_default || '').trim();
  if (!raw || /nextval\(/i.test(raw)) return '';
  return ` DEFAULT ${raw}`;
}

function createTableSql(tableName, columns) {
  const pkColumns = columns.filter((column) => Number(column.is_pk || 0) === 1);
  const singlePk = pkColumns.length === 1 ? pkColumns[0].column_name : null;
  const definitions = columns.map((column) => {
    const isSinglePk = singlePk === column.column_name;
    const pieces = [quoteIdent(column.column_name), columnType(column)];
    if (isSinglePk) pieces.push('PRIMARY KEY');
    if (column.is_nullable === 'NO' && !isSinglePk) pieces.push('NOT NULL');
    if (!isSinglePk) pieces.push(defaultExpression(column));
    return pieces.filter(Boolean).join(' ');
  });

  if (pkColumns.length > 1) {
    definitions.push(`PRIMARY KEY (${pkColumns.map((column) => quoteIdent(column.column_name)).join(', ')})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (${definitions.join(', ')})`;
}

async function createTenantTables(masterPool, tenantPool, tableNames) {
  const tableSpecs = [];
  for (const tableName of tableNames) {
    const columns = await getTableColumns(masterPool, tableName);
    if (!columns.length) continue;
    await tenantPool.query(createTableSql(tableName, columns));
    tableSpecs.push({
      tableName,
      columns,
      hasCompanyId: columns.some((column) => column.column_name === 'company_id')
    });
  }
  return tableSpecs;
}

async function copyCompanyRows(masterPool, tenantPool, tableSpec, companyId) {
  if (!tableSpec.hasCompanyId) return 0;

  const columnNames = tableSpec.columns.map((column) => column.column_name);
  const rows = await masterPool.query(
    `SELECT ${columnNames.map(quoteIdent).join(', ')}
     FROM ${quoteIdent(tableSpec.tableName)}
     WHERE ${quoteIdent('company_id')} = $1`,
    [companyId]
  );

  for (const row of rows.rows) {
    const values = columnNames.map((name) => row[name]);
    const params = values.map((_, index) => `$${index + 1}`).join(', ');
    await tenantPool.query(
      `INSERT INTO ${quoteIdent(tableSpec.tableName)} (${columnNames.map(quoteIdent).join(', ')})
       VALUES (${params})`,
      values
    );
  }

  return rows.rowCount;
}

async function tenantTableIds(tenantPool, tableName, columnName) {
  const result = await tenantPool.query(
    `SELECT ${quoteIdent(columnName)} AS id FROM ${quoteIdent(tableName)}`
  );
  return result.rows.map((row) => row.id).filter((value) => value !== null && value !== undefined);
}

async function insertRows(tenantPool, tableSpec, rows) {
  if (!rows.length) return 0;

  const columnNames = tableSpec.columns.map((column) => column.column_name);
  const quotedColumns = columnNames.map(quoteIdent).join(', ');
  let copied = 0;

  for (const row of rows) {
    const values = columnNames.map((name) => row[name]);
    const params = values.map((_, index) => `$${index + 1}`).join(', ');
    await tenantPool.query(
      `INSERT INTO ${quoteIdent(tableSpec.tableName)} (${quotedColumns})
       VALUES (${params})`,
      values
    );
    copied += 1;
  }

  return copied;
}

async function copyRelatedRows(masterPool, tenantPool, tableSpec) {
  if (tableSpec.hasCompanyId) return 0;

  const rules = RELATED_COPY_RULES[tableSpec.tableName] || [];
  if (!rules.length) return 0;

  const columnNames = tableSpec.columns.map((column) => column.column_name);
  const seen = new Set();
  const rowsToInsert = [];

  for (const rule of rules) {
    if (!columnNames.includes(rule.column)) continue;
    const parentIds = await tenantTableIds(tenantPool, rule.parentTable, rule.parentColumn);
    if (!parentIds.length) continue;

    const result = await masterPool.query(
      `SELECT ${columnNames.map(quoteIdent).join(', ')}
       FROM ${quoteIdent(tableSpec.tableName)}
       WHERE ${quoteIdent(rule.column)} = ANY($1::bigint[])`,
      [parentIds]
    );

    for (const row of result.rows) {
      const key = JSON.stringify(columnNames.map((name) => row[name]));
      if (seen.has(key)) continue;
      seen.add(key);
      rowsToInsert.push(row);
    }
  }

  return insertRows(tenantPool, tableSpec, rowsToInsert);
}

async function resetTenantSequences(tenantPool, tableSpecs) {
  for (const spec of tableSpecs) {
    const pk = spec.columns.find((column) => Number(column.is_pk || 0) === 1 && /^(int2|int4|int8)$/.test(column.udt_name));
    if (!pk) continue;

    await tenantPool.query(
      `SELECT setval(
         pg_get_serial_sequence($1, $2),
         COALESCE((SELECT MAX(${quoteIdent(pk.column_name)}) FROM ${quoteIdent(spec.tableName)}), 0) + 1,
         false
       )
       WHERE pg_get_serial_sequence($1, $2) IS NOT NULL`,
      [spec.tableName, pk.column_name]
    );
  }
}

async function backupMasterData(masterPool) {
  const backupDir = path.join(BACKUP_ROOT, `tenant-migrate-existing-${stamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const tables = await masterPool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );

  const backup = {
    created_at: new Date().toISOString(),
    source_database: parseDatabaseUrl(getPostgresConfig().url).pathname.replace(/^\//, ''),
    tables: {}
  };

  for (const row of tables.rows) {
    const tableName = row.table_name;
    const result = await masterPool.query(`SELECT * FROM ${quoteIdent(tableName)}`);
    backup.tables[tableName] = result.rows;
  }

  const backupPath = path.join(backupDir, 'master-backup.json');
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  return backupPath;
}

async function updateCompanyDatabaseConfig(masterPool, companyId, config) {
  await masterPool.query(
    `UPDATE companies
     SET database_name = $1,
         database_host = $2,
         database_port = $3,
         database_user = $4,
         database_password_ref = $5,
         database_type = $6,
         database_status = $7
     WHERE id = $8`,
    [
      config.database_name,
      config.database_host,
      config.database_port,
      config.database_user,
      config.database_password_ref,
      config.database_type,
      config.database_status,
      companyId
    ]
  );
}

async function tenantStats(databaseName) {
  const adminPool = createMaintenancePool();
  let exists = false;
  try {
    exists = await databaseExists(adminPool, databaseName);
  } finally {
    await adminPool.end();
  }

  if (!exists) {
    return { exists: false, tables: 0, users: 0 };
  }

  const tenantPool = createTenantPool(databaseName);
  try {
    const tables = await tenantPool.query(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'`
    );
    const usersTable = await tenantPool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'users'
       LIMIT 1`
    );
    const users = usersTable.rowCount > 0
      ? await tenantPool.query('SELECT COUNT(*)::int AS count FROM users')
      : { rows: [{ count: 0 }] };

    return {
      exists: true,
      tables: Number(tables.rows[0].count || 0),
      users: Number(users.rows[0].count || 0)
    };
  } finally {
    await tenantPool.end();
  }
}

module.exports = {
  connectionParts,
  createMasterPool,
  createMaintenancePool,
  createPhysicalDatabase,
  createTenantPool,
  databaseExists,
  resolveAvailableDatabaseName,
  listCompanies,
  listTenantTables,
  createTenantTables,
  copyCompanyRows,
  copyRelatedRows,
  resetTenantSequences,
  backupMasterData,
  updateCompanyDatabaseConfig,
  tenantStats
};
