const path = require('path');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();

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

  throw new Error('DATABASE_URL is required. SQLite is available only as a historical backup source.');
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

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < String(sql || '').length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    current += char;
    if (quote) {
      if (char === quote && next === quote) {
        current += next;
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ';') {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = '';
    }
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function translatePlaceholders(sql) {
  let index = 0;
  let quote = null;
  let output = '';
  const raw = String(sql || '');
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];
    if (quote) {
      output += char;
      if (char === quote && next === quote) {
        output += next;
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }
    if (char === '?') {
      index += 1;
      output += `$${index}`;
      continue;
    }
    output += char;
  }
  return output;
}

function translateSqliteSql(sql) {
  let translated = String(sql || '').trim();
  translated = translated.replace(/`/g, '"');
  translated = translated.replace(/\bAUTOINCREMENT\b/gi, '');
  translated = translated.replace(/\bINTEGER\s+PRIMARY\s+KEY\s*(,|\))/gi, 'BIGSERIAL PRIMARY KEY$1');
  translated = translated.replace(/\bDATETIME\b/gi, 'TIMESTAMP');
  translated = translated.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
  translated = translated.replace(/\bBLOB\b/gi, 'BYTEA');
  translated = translated.replace(/\bCOLLATE\s+NOCASE\b/gi, '');
  translated = translated.replace(/date\('now'\s*,\s*'localtime'\)/gi, 'CURRENT_DATE');
  translated = translated.replace(/datetime\('now'\s*,\s*'localtime'\)/gi, 'CURRENT_TIMESTAMP');
  translated = translated.replace(/CURRENT_TIMESTAMP\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP');
  translated = translated.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ');
  translated = translated.replace(/^UPDATE\s+OR\s+IGNORE\s+/i, 'UPDATE ');
  translated = translatePlaceholders(translated);
  translated = translated.replace(/date\((\$\d+)\)/gi, 'CAST($1 AS date)');
  if (/^INSERT\s+INTO\s+/i.test(translated) && !/\bON\s+CONFLICT\b/i.test(translated) && !/\bRETURNING\b/i.test(translated)) {
    translated += ' RETURNING id';
  } else if (/^INSERT\s+INTO\s+/i.test(translated) && !/\bRETURNING\b/i.test(translated)) {
    translated += ' RETURNING id';
  }
  if (/^INSERT\s+INTO\s+/i.test(translated) && /^INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(String(sql || '').trim())) {
    translated = translated.replace(/\s+RETURNING\s+id\s*$/i, ' ON CONFLICT DO NOTHING RETURNING id');
  }
  return translated;
}

function parsePragmaTableInfo(sql) {
  const match = String(sql || '').trim().match(/^PRAGMA\s+table_info\s*\(\s*["']?([A-Za-z0-9_]+)["']?\s*\)/i);
  return match ? match[1] : null;
}

function sqliteCallbackArgs(params, callback) {
  if (typeof params === 'function') return { params: [], callback: params };
  return { params: Array.isArray(params) ? params : [], callback };
}

class PostgresSqliteStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run(...args) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return this.db.run(this.sql, params, callback);
  }

  finalize(callback) {
    if (callback) callback(null);
  }
}

class PostgresSqliteCompatDatabase {
  constructor(config) {
    this.client = 'postgres';
    this.pool = createPostgresPool(config);
    this.ready = this.ensureInsertDefaults();
  }

  async ensureInsertDefaults() {
    const result = await this.pool.query(
      `SELECT table_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND column_name = 'id'
         AND column_default IS NULL`
    );
    for (const row of result.rows) {
      const table = row.table_name;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
      const seq = `${table}_id_seq`;
      await this.pool.query(`CREATE SEQUENCE IF NOT EXISTS "${seq}"`);
      await this.pool.query(`ALTER TABLE "${table}" ALTER COLUMN id SET DEFAULT nextval('"${seq}"')`);
      await this.pool.query(`SELECT setval('"${seq}"', COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`);
    }
  }

  async query(sql, params = []) {
    await this.ready;
    return this.pool.query(translateSqliteSql(sql), params);
  }

  get(sql, params, callback) {
    const args = sqliteCallbackArgs(params, callback);
    this.all(sql, args.params, (err, rows) => args.callback(err, rows && rows[0] ? rows[0] : undefined));
  }

  all(sql, params, callback) {
    const args = sqliteCallbackArgs(params, callback);
    const tableInfo = parsePragmaTableInfo(sql);
    const run = async () => {
      await this.ready;
      if (tableInfo) return this.getTableInfo(tableInfo);
      if (/sqlite_master/i.test(sql)) return this.getSqliteMasterRows(sql, args.params);
      const result = await this.pool.query(translateSqliteSql(sql), args.params);
      return result.rows || [];
    };
    run().then((rows) => args.callback(null, rows)).catch((err) => args.callback(err));
  }

  run(sql, params, callback) {
    const args = sqliteCallbackArgs(params, callback);
    const run = async () => {
      await this.ready;
      const result = await this.pool.query(translateSqliteSql(sql), args.params);
      return {
        changes: result.rowCount || 0,
        lastID: result.rows && result.rows[0] && result.rows[0].id !== undefined ? result.rows[0].id : undefined
      };
    };
    run()
      .then((context) => {
        if (args.callback) args.callback.call(context, null);
      })
      .catch((err) => {
        if (args.callback) return args.callback(err);
        console.error('[postgres] run failed', err);
      });
  }

  exec(sql, callback) {
    const run = async () => {
      await this.ready;
      const statements = splitSqlStatements(sql);
      for (const statement of statements) {
        if (parsePragmaTableInfo(statement)) continue;
        await this.pool.query(translateSqliteSql(statement));
      }
    };
    run().then(() => callback && callback(null)).catch((err) => callback && callback(err));
  }

  serialize(callback) {
    if (callback) callback();
  }

  prepare(sql) {
    return new PostgresSqliteStatement(this, sql);
  }

  close(callback) {
    this.pool.end().then(() => callback && callback(null)).catch((err) => callback && callback(err));
  }

  async getTableInfo(tableName) {
    const result = await this.pool.query(
      `SELECT c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
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
    const whereName = hasNameParam ? 'AND table_name = $1' : '';
    const result = await this.pool.query(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'
         ${whereName}
       ORDER BY table_name`,
      values
    );
    return result.rows;
  }
}

function createSqliteDatabase(config = getSqliteConfig()) {
  const filename = config.filename || ':memory:';
  if (filename === ':memory:') return new sqlite3.Database(filename);
  return new sqlite3.Database(filename, sqlite3.OPEN_READONLY);
}

function createAppDatabase(env = process.env) {
  const config = getDatabaseConfig(env);
  return new PostgresSqliteCompatDatabase(config);
}

function getActiveDatabaseInfo(env = process.env) {
  const config = getDatabaseConfig(env);
  if (config.client === 'postgres') {
    const parsed = new URL(config.url);
    return {
      client: 'postgres',
      database: parsed.pathname.replace(/^\//, ''),
      host: parsed.hostname,
      port: parsed.port || '5432',
      user: decodeURIComponent(parsed.username || '')
    };
  }
  return {
    client: 'sqlite',
    filename: config.filename
  };
}

function getSqliteConfig(env = process.env) {
  return {
    client: 'sqlite',
    filename: path.resolve(ROOT_DIR, env.DATABASE_PATH || DEFAULT_SQLITE_PATH)
  };
}

async function resolveDatabaseConfig(env = process.env) {
  const config = getDatabaseConfig(env);
  const pool = createPostgresPool(config);
  try {
    await pool.query('SELECT 1');
    return config;
  } catch (err) {
    throw new Error(`PostgreSQL connection failed: ${err && err.message ? err.message : String(err)}`);
  } finally {
    await pool.end();
  }
}

async function testPostgresConnection(env = process.env) {
  const config = getDatabaseConfig(env);
  if (config.client !== 'postgres') {
    throw new Error('DATABASE_URL is not configured. PostgreSQL multi-tenant mode is required.');
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
  createSqliteDatabase,
  createAppDatabase,
  getActiveDatabaseInfo,
  testPostgresConnection
};
