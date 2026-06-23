const { Pool } = require('pg');
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
    let index = 0;
    return String(sql || '').replace(/\?/g, () => `$${++index}`);
  }

  query(sql, params = []) {
    return this.pool.query(sql, params);
  }

  get(sql, params = [], callback) {
    this.pool.query(this.translate(sql), params)
      .then((result) => callback(null, result.rows[0] || null))
      .catch((err) => callback(err));
  }

  all(sql, params = [], callback) {
    this.pool.query(this.translate(sql), params)
      .then((result) => callback(null, result.rows || []))
      .catch((err) => callback(err));
  }

  run(sql, params = [], callback) {
    this.pool.query(this.translate(sql), params)
      .then((result) => {
        const context = {
          changes: result.rowCount || 0,
          lastID: result.rows && result.rows[0] && result.rows[0].id ? result.rows[0].id : undefined
        };
        if (callback) callback.call(context, null);
      })
      .catch((err) => {
        if (callback) return callback(err);
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
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    );
    return tables
      .map((row) => row.name)
      .filter((name) => name && !TENANT_EXCLUDED_TABLES.has(name));
  }

  async function runInitialMigrations(pool) {
    const tables = await getTenantTablesFromMaster();
    for (const tableName of tables) {
      const columns = await sqliteAll(masterDb, `PRAGMA table_info(${quoteIdent(tableName)})`);
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
