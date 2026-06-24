require('../src/config/load-env');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { getDatabaseConfig } = require('../src/config/database');

const ROOT_DIR = path.resolve(__dirname, '..');
const MASTER_DATABASE = 'mi_sistema_dev';
const TENANT_DATABASE = 'empresa_cf_multi_services_dev';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function databaseUrlForName(baseUrl, databaseName) {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function maintenanceUrl(baseUrl) {
  return databaseUrlForName(baseUrl, 'postgres');
}

function localConfig() {
  const config = getDatabaseConfig();
  const parsed = new URL(config.url);
  const database = parsed.pathname.replace(/^\/+/, '');
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Los comandos dev requieren NODE_ENV=development.');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname) || database !== MASTER_DATABASE || config.ssl) {
    throw new Error(
      `Conexion rechazada. Use PostgreSQL local sin SSL y la base ${MASTER_DATABASE}.`
    );
  }
  return config;
}

function poolFor(config, databaseName) {
  return new Pool({
    connectionString: databaseUrlForName(config.url, databaseName),
    ssl: false
  });
}

async function databaseExists(adminPool, databaseName) {
  const result = await adminPool.query(
    'SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1',
    [databaseName]
  );
  return result.rowCount > 0;
}

async function createDatabaseIfMissing(adminPool, databaseName) {
  if (await databaseExists(adminPool, databaseName)) return false;
  await adminPool.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  return true;
}

async function recreateDatabase(adminPool, databaseName) {
  if (await databaseExists(adminPool, databaseName)) {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName]
    );
    await adminPool.query(`DROP DATABASE ${quoteIdent(databaseName)}`);
  }
  await adminPool.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
}

function translateBootstrapSql(sql) {
  return String(sql)
    .replace(/`/g, '"')
    .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
    .replace(/\bBLOB\b/gi, 'BYTEA');
}

async function ensureLocalTenantRegistration(masterPool, config) {
  const parsed = new URL(config.url);
  const values = [
    TENANT_DATABASE,
    parsed.hostname,
    parsed.port || '5432',
    decodeURIComponent(parsed.username || ''),
    parsed.password ? 'DATABASE_URL_PASSWORD' : null
  ];

  await masterPool.query(
    `ALTER TABLE companies
     ADD COLUMN IF NOT EXISTS database_name TEXT,
     ADD COLUMN IF NOT EXISTS database_host TEXT,
     ADD COLUMN IF NOT EXISTS database_port TEXT,
     ADD COLUMN IF NOT EXISTS database_user TEXT,
     ADD COLUMN IF NOT EXISTS database_password_ref TEXT,
     ADD COLUMN IF NOT EXISTS database_type TEXT,
     ADD COLUMN IF NOT EXISTS database_status TEXT`
  );

  await masterPool.query(
    `UPDATE companies
     SET database_name = NULL,
         database_status = CASE WHEN database_name IS NULL THEN database_status ELSE 'inactive' END
     WHERE database_name IS DISTINCT FROM $1`,
    [TENANT_DATABASE]
  );

  const existing = await masterPool.query(
    `SELECT id
     FROM companies
     WHERE database_name = $1
        OR LOWER(COALESCE(name, '')) LIKE '%cf%multi%services%'
     ORDER BY CASE WHEN database_name = $1 THEN 0 ELSE 1 END, id
     LIMIT 1`,
    [TENANT_DATABASE]
  );

  if (existing.rowCount) {
    await masterPool.query(
      `UPDATE companies
       SET database_name = $1, database_host = $2, database_port = $3,
           database_user = $4, database_password_ref = $5,
           database_type = 'postgresql', database_status = 'active'
       WHERE id = $6`,
      [...values, existing.rows[0].id]
    );
    return;
  }

  await masterPool.query(
    `INSERT INTO companies
      (name, username, password_hash, database_name, database_host, database_port,
       database_user, database_password_ref, database_type, database_status)
     VALUES
      ('CF Multi Services Dev', 'cf_multi_services_dev', 'LOCAL_DEVELOPMENT_ONLY',
       $1, $2, $3, $4, $5, 'postgresql', 'active')
     ON CONFLICT (username) DO UPDATE
     SET database_name = EXCLUDED.database_name,
         database_host = EXCLUDED.database_host,
         database_port = EXCLUDED.database_port,
         database_user = EXCLUDED.database_user,
         database_password_ref = EXCLUDED.database_password_ref,
         database_type = EXCLUDED.database_type,
         database_status = EXCLUDED.database_status`,
    values
  );
}

async function bootstrapEmptyDatabases(config) {
  const masterPool = poolFor(config, MASTER_DATABASE);
  const tenantPool = poolFor(config, TENANT_DATABASE);
  try {
    const companiesSql = translateBootstrapSql(
      fs.readFileSync(path.join(ROOT_DIR, 'db', 'companies.sql'), 'utf8')
    );
    const schemaSql = translateBootstrapSql(
      fs.readFileSync(path.join(ROOT_DIR, 'db', 'schema.sql'), 'utf8')
    );
    await masterPool.query(companiesSql);
    await masterPool.query(schemaSql);
    await tenantPool.query(companiesSql);
    await tenantPool.query(schemaSql);
    await ensureLocalTenantRegistration(masterPool, config);
    await ensureLocalTenantAdmin(masterPool);
    await ensureLocalTenantAdmin(tenantPool);
  } finally {
    await Promise.all([masterPool.end(), tenantPool.end()]);
  }
}

async function ensureLocalTenantAdmin(tenantPool) {
  const username = String(process.env.MASTER_USER || 'admin').trim();
  const password = String(process.env.MASTER_PASS || '').trim();
  if (!username || !password) {
    throw new Error('MASTER_USER y MASTER_PASS son obligatorios para crear el administrador local.');
  }

  const existing = await tenantPool.query(
    'SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
    [username]
  );
  if (existing.rowCount) return existing.rows[0].id;

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await tenantPool.query(
    `INSERT INTO users (username, password_hash, role, company_id, is_active)
     VALUES ($1, $2, 'admin', 1, 1)
     RETURNING id`,
    [username, passwordHash]
  );
  return result.rows[0].id;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} fallo`).trim());
  }
  return result;
}

function runNpm(args) {
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit' });
}

module.exports = {
  ROOT_DIR,
  MASTER_DATABASE,
  TENANT_DATABASE,
  databaseUrlForName,
  maintenanceUrl,
  localConfig,
  poolFor,
  createDatabaseIfMissing,
  recreateDatabase,
  bootstrapEmptyDatabases,
  ensureLocalTenantRegistration,
  ensureLocalTenantAdmin,
  run,
  runNpm
};
