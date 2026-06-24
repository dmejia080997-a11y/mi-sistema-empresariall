const { Pool } = require('pg');
const { translateSqliteSql } = require('../config/database');
const {
  TENANT_MIGRATIONS_DIR,
  applyDirectoryMigrations
} = require('./migration-service');

const TENANT_EXCLUDED_TABLES = new Set([
  'companies',
  'company_inactivation_notes',
  'business_activities',
  'migration_events',
  'schema_migrations'
]);

function sqliteGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function sqliteRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizeTenantSlug(value) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return normalized || 'empresa';
}

function buildSafeDatabaseName(companyName) {
  const slug = normalizeTenantSlug(companyName).slice(0, 48).replace(/_+$/g, '') || 'empresa';
  return `empresa_${slug}`.slice(0, 63).replace(/_+$/g, '');
}

function parseDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL no esta configurado. No se pueden crear bases PostgreSQL por empresa.');
  }
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
    database_host: parsed.hostname || 'localhost',
    database_port: parsed.port || '5432',
    database_user: decodeURIComponent(parsed.username || ''),
    database_password_ref: parsed.password ? 'DATABASE_URL_PASSWORD' : null,
    database_name: databaseName
  };
}

function mapSqliteTypeToPostgres(type, column) {
  const normalized = String(type || '').toUpperCase();
  const isPk = Number(column.pk || 0) > 0;
  if (isPk && normalized.includes('INT')) return 'BIGSERIAL';
  if (normalized.includes('INT')) return 'BIGINT';
  if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) return 'DOUBLE PRECISION';
  if (normalized.includes('BLOB')) return 'BYTEA';
  if (normalized.includes('NUM') || normalized.includes('DEC')) return 'NUMERIC';
  if (normalized.includes('BOOL')) return 'BOOLEAN';
  return 'TEXT';
}

function postgresDefaultExpression(defaultValue) {
  if (defaultValue === null || defaultValue === undefined) return '';
  const raw = String(defaultValue).trim();
  if (!raw) return '';
  if (/^NULL$/i.test(raw)) return ' DEFAULT NULL';
  if (/^CURRENT_(TIME|DATE|TIMESTAMP)$/i.test(raw)) return ` DEFAULT ${raw}`;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return ` DEFAULT ${raw}`;
  if (/^'.*'$/.test(raw)) return ` DEFAULT ${raw}`;
  return '';
}

function buildCreateTableSql(tableName, columns) {
  const pkColumns = columns
    .filter((column) => Number(column.pk || 0) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk));

  const definitions = columns.map((column) => {
    const pieces = [quoteIdent(column.name), mapSqliteTypeToPostgres(column.type, column)];
    const isPk = pkColumns.length === 1 && pkColumns[0].name === column.name;
    if (isPk) pieces.push('PRIMARY KEY');
    if (Number(column.notnull || 0) === 1 && !isPk) pieces.push('NOT NULL');
    if (!isPk) pieces.push(postgresDefaultExpression(column.dflt_value));
    return pieces.filter(Boolean).join(' ');
  });

  if (pkColumns.length > 1) {
    definitions.push(`PRIMARY KEY (${pkColumns.map((column) => quoteIdent(column.name)).join(', ')})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (${definitions.join(', ')})`;
}

class PgSqliteCompat {
  constructor(pool) {
    this.pool = pool;
    this.client = 'postgres';
  }

  translate(sql) {
    return translateSqliteSql(sql);
  }

  query(sql, params = []) {
    return this.pool.query(sql, params);
  }

  get(sql, params = [], callback) {
    const values = typeof params === 'function' ? [] : params;
    const done = typeof params === 'function' ? params : callback;
    this.pool.query(this.translate(sql), values)
      .then((result) => done && done(null, result.rows[0] || null))
      .catch((err) => done ? done(err) : Promise.reject(err));
  }

  all(sql, params = [], callback) {
    const values = typeof params === 'function' ? [] : params;
    const done = typeof params === 'function' ? params : callback;
    this.pool.query(this.translate(sql), values)
      .then((result) => done && done(null, result.rows || []))
      .catch((err) => done ? done(err) : Promise.reject(err));
  }

  run(sql, params = [], callback) {
    const values = typeof params === 'function' ? [] : params;
    const done = typeof params === 'function' ? params : callback;
    this.pool.query(this.translate(sql), values)
      .then((result) => {
        const context = {
          changes: result.rowCount || 0,
          lastID: result.rows && result.rows[0] && result.rows[0].id ? result.rows[0].id : undefined
        };
        if (done) done.call(context, null);
      })
      .catch((err) => {
        if (done) return done(err);
        throw err;
      });
  }

  exec(sql, callback) {
    const statements = String(sql || '')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    const run = async () => {
      for (const statement of statements) {
        await this.pool.query(this.translate(statement));
      }
    };
    run()
      .then(() => callback && callback(null))
      .catch((err) => callback ? callback(err) : Promise.reject(err));
  }

  serialize(callback) {
    if (callback) callback();
  }

  prepare(sql) {
    const db = this;
    return {
      run(...args) {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        return db.run(sql, params, callback);
      },
      finalize(callback) {
        if (callback) callback(null);
      }
    };
  }

  async close() {
    await this.pool.end();
  }

  async getTableInfo(tableName) {
    const result = await this.pool.query(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
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
       WHERE c.table_schema = current_schema() AND c.table_name = $1
       ORDER BY c.ordinal_position`,
      [tableName]
    );
    return result.rows.map((row, index) => ({
      cid: index,
      name: row.column_name,
      type: row.data_type,
      notnull: row.is_nullable === 'NO' ? 1 : 0,
      dflt_value: row.column_default,
      pk: Number(row.is_pk || 0)
    }));
  }

  async getSqliteMasterRows(sql, params) {
    const hasNameParam = /name\s*=\s*\?/i.test(sql) || /name\s*=\s*\$\d+/i.test(sql);
    const values = hasNameParam && params.length ? [params[0]] : [];
    const result = await this.pool.query(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'
         ${hasNameParam ? 'AND table_name = $1' : ''}
       ORDER BY table_name`,
      values
    );
    return result.rows;
  }

  async getIndexList(tableName) {
    const result = await this.pool.query(
      `SELECT i.relname AS name,
              CASE WHEN ix.indisunique THEN 1 ELSE 0 END AS unique,
              CASE WHEN con.contype IS NULL THEN 'c' ELSE 'u' END AS origin
       FROM pg_class t
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
       JOIN pg_index ix ON ix.indrelid = t.oid
       JOIN pg_class i ON i.oid = ix.indexrelid
       LEFT JOIN pg_constraint con ON con.conindid = i.oid
       WHERE ns.nspname = current_schema() AND t.relname = $1
       ORDER BY i.relname`,
      [tableName]
    );
    return result.rows;
  }

  async getIndexInfo(indexName) {
    const result = await this.pool.query(
      `SELECT key_columns.ordinality - 1 AS seqno, a.attname AS name
       FROM pg_class i
       JOIN pg_namespace ns ON ns.oid = i.relnamespace
       JOIN pg_index ix ON ix.indexrelid = i.oid
       JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality) ON true
       JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = key_columns.attnum
       WHERE ns.nspname = current_schema() AND i.relname = $1
       ORDER BY key_columns.ordinality`,
      [indexName]
    );
    return result.rows;
  }
}

function createCompanyDatabaseService(options) {
  const {
    masterDb,
    databaseUrl = process.env.DATABASE_URL,
    databaseSsl = process.env.DATABASE_SSL,
    logger = console
  } = options || {};

  if (!masterDb) throw new Error('masterDb is required');

  const pools = new Map();
  const ssl = ['1', 'true', 'yes', 'require'].includes(String(databaseSsl || '').trim().toLowerCase())
    ? { rejectUnauthorized: false }
    : false;

  function assertPostgresConfigured() {
    parseDatabaseUrl(databaseUrl);
  }

  function createPoolForDatabase(databaseName) {
    return new Pool({
      connectionString: databaseUrlForName(databaseUrl, databaseName),
      ssl
    });
  }

  async function databaseExists(pg, databaseName) {
    const result = await pg.query('SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1', [databaseName]);
    return result.rowCount > 0;
  }

  async function resolveAvailableDatabaseName(pg, companyName) {
    const baseName = buildSafeDatabaseName(companyName);
    let candidate = baseName;
    let counter = 2;
    while (await databaseExists(pg, candidate)) {
      const suffix = `_${counter}`;
      candidate = `${baseName.slice(0, 63 - suffix.length)}${suffix}`;
      counter += 1;
    }
    return candidate;
  }

  async function createPhysicalDatabase(databaseName) {
    const adminPool = new Pool({ connectionString: maintenanceUrl(databaseUrl), ssl });
    try {
      await adminPool.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    } finally {
      await adminPool.end();
    }
  }

  async function dropPhysicalDatabase(databaseName) {
    const adminPool = new Pool({ connectionString: maintenanceUrl(databaseUrl), ssl });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    } catch (err) {
      if (err && err.code === '42601') {
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`);
        return;
      }
      throw err;
    } finally {
      await adminPool.end();
    }
  }

  async function getTenantTablesFromMaster() {
    const tables = await sqliteAll(
      masterDb,
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );
    return tables
      .map((row) => row.name)
      .filter((name) => name && !TENANT_EXCLUDED_TABLES.has(name));
  }

  async function runInitialMigrations(pool) {
    const tables = await getTenantTablesFromMaster();
    for (const tableName of tables) {
      const columns = await sqliteAll(
        masterDb,
        `SELECT c.column_name AS name,
                c.data_type AS type,
                CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
                c.column_default AS dflt_value,
                CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 1 ELSE 0 END AS pk
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
           AND c.table_name = ?
         ORDER BY c.ordinal_position`,
        [tableName]
      );
      if (!columns.length) continue;
      await pool.query(buildCreateTableSql(tableName, columns));
    }
    await applyDirectoryMigrations(
      pool,
      TENANT_MIGRATIONS_DIR,
      'tenant:nuevo'
    );
  }

  async function getCompanyDatabase(companyId) {
    const id = Number(companyId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('companyId invalido para resolver base de datos de empresa.');
    }

    const company = await sqliteGet(
      masterDb,
      `SELECT id, name, database_name, database_host, database_port, database_user,
              database_password_ref, database_type, database_status, is_active
       FROM companies
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (!company) throw new Error(`Empresa ${id} no existe en la base master.`);
    if (company.is_active === 0 || company.is_active === '0' || company.database_status === 'inactive') {
      throw new Error(`Empresa ${id} esta inactiva.`);
    }
    if (company.database_type !== 'postgresql' || !company.database_name) {
      throw new Error(`Empresa ${id} no tiene base PostgreSQL provisionada.`);
    }

    if (pools.has(id)) return pools.get(id);

    const pool = createPoolForDatabase(company.database_name);
    await pool.query('SELECT 1');
    const adapter = new PgSqliteCompat(pool);
    pools.set(id, adapter);
    return adapter;
  }

  async function createCompanyDatabase(companyData) {
    assertPostgresConfigured();
    const name = companyData && companyData.name ? companyData.name : null;
    if (!name) throw new Error('El nombre de la empresa es obligatorio para crear su base de datos.');

    const adminPool = new Pool({ connectionString: maintenanceUrl(databaseUrl), ssl });
    let databaseName;
    let tenantPool;
    try {
      databaseName = await resolveAvailableDatabaseName(adminPool, name);
    } finally {
      await adminPool.end();
    }

    await createPhysicalDatabase(databaseName);
    try {
      tenantPool = createPoolForDatabase(databaseName);
      await runInitialMigrations(tenantPool);
      const parts = connectionParts(databaseUrl, databaseName);
      return {
        ok: true,
        database_name: databaseName,
        database_host: parts.database_host,
        database_port: parts.database_port,
        database_user: parts.database_user,
        database_password_ref: parts.database_password_ref,
        database_type: 'postgresql',
        database_status: 'active'
      };
    } catch (err) {
      try {
        await dropPhysicalDatabase(databaseName);
      } catch (dropErr) {
        logger.error('[company-db] failed cleanup after tenant provisioning error', dropErr);
      }
      throw err;
    } finally {
      if (tenantPool) await tenantPool.end();
    }
  }

  async function saveCompanyDatabaseConfig(companyId, config) {
    await sqliteRun(
      masterDb,
      `UPDATE companies
       SET database_name = ?,
           database_host = ?,
           database_port = ?,
           database_user = ?,
           database_password_ref = ?,
           database_type = ?,
           database_status = ?
       WHERE id = ?`,
      [
        config.database_name,
        config.database_host,
        config.database_port,
        config.database_user,
        config.database_password_ref || null,
        config.database_type || 'postgresql',
        config.database_status || 'active',
        companyId
      ]
    );
  }

  async function auditCompanyDatabaseCreated(companyId, config, userId) {
    const details = JSON.stringify({
      database_name: config.database_name,
      database_host: config.database_host,
      database_port: config.database_port,
      database_type: config.database_type || 'postgresql',
      status: config.database_status || 'active'
    });
    await sqliteRun(
      masterDb,
      'INSERT INTO audit_logs (user_id, action, details, company_id) VALUES (?, ?, ?, ?)',
      [userId || null, 'company_database_created', details, companyId]
    ).catch((err) => {
      logger.warn('[company-db] audit log failed', err);
    });
  }

  return {
    buildSafeDatabaseName,
    createCompanyDatabase,
    getCompanyDatabase,
    saveCompanyDatabaseConfig,
    auditCompanyDatabaseCreated,
    dropPhysicalDatabase
  };
}

module.exports = {
  createCompanyDatabaseService,
  buildSafeDatabaseName
};
