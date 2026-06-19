const path = require('path');
const { Pool } = require('pg');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_SQLITE_PATH = path.join(ROOT_DIR, 'data', 'app.db');

function getDatabaseConfig(env = process.env) {
  const databaseUrl = String(env.DATABASE_URL || '').trim();

  if (databaseUrl) {
    return {
      client: 'postgres',
      url: databaseUrl,
      ssl: shouldUsePostgresSsl(env)
    };
  }

  return {
    client: 'sqlite',
    filename: path.resolve(ROOT_DIR, env.DATABASE_PATH || DEFAULT_SQLITE_PATH)
  };
}

function shouldUsePostgresSsl(env = process.env) {
  const raw = String(env.DATABASE_SSL || '').trim().toLowerCase();
  if (!raw) return false;
  return ['1', 'true', 'yes', 'require'].includes(raw);
}

function createPostgresPool(config = getDatabaseConfig()) {
  if (!config || config.client !== 'postgres') {
    throw new Error('DATABASE_URL is required to create a PostgreSQL pool.');
  }

  return new Pool({
    connectionString: config.url,
    ssl: config.ssl ? { rejectUnauthorized: false } : false
  });
}

function getSqliteConfig(env = process.env) {
  return {
    client: 'sqlite',
    filename: path.resolve(ROOT_DIR, env.DATABASE_PATH || DEFAULT_SQLITE_PATH)
  };
}

async function resolveDatabaseConfig(env = process.env) {
  const config = getDatabaseConfig(env);
  if (config.client !== 'postgres') return config;

  const pool = createPostgresPool(config);
  try {
    await pool.query('SELECT 1');
    return config;
  } catch (err) {
    const fallback = getSqliteConfig(env);
    return {
      ...fallback,
      fallbackFrom: 'postgres',
      fallbackReason: err && err.message ? err.message : String(err)
    };
  } finally {
    await pool.end();
  }
}

async function testPostgresConnection(env = process.env) {
  const config = getDatabaseConfig(env);
  if (config.client !== 'postgres') {
    throw new Error('DATABASE_URL is not configured. PostgreSQL is disabled; SQLite fallback is active.');
  }

  const pool = createPostgresPool(config);
  try {
    const result = await pool.query('SELECT NOW() AS now, current_database() AS database, current_user AS user');
    return result.rows[0];
  } finally {
    await pool.end();
  }
}

module.exports = {
  getDatabaseConfig,
  getSqliteConfig,
  resolveDatabaseConfig,
  createPostgresPool,
  testPostgresConnection
};
