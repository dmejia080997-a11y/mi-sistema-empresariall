require('./load-env');

const { Pool } = require('pg');

function getDatabaseConfig(env = process.env) {
  const databaseUrl = String(env.DATABASE_URL || '').trim();

  if (databaseUrl) {
    assertSafeDevelopmentDatabase(databaseUrl, env);
    return {
      client: 'postgres',
      url: databaseUrl,
      ssl: shouldUsePostgresSsl(env)
    };
  }

  throw new Error('DATABASE_URL is required. SQLite is available only as a historical backup source.');
}

function assertSafeDevelopmentDatabase(databaseUrl, env = process.env) {
  if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'development') return;

  const parsed = new URL(databaseUrl);
  const database = parsed.pathname.replace(/^\/+/, '');
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!localHosts.has(parsed.hostname)) {
    throw new Error('NODE_ENV=development solo permite PostgreSQL en localhost.');
  }
  if (database !== 'mi_sistema_dev') {
    throw new Error('NODE_ENV=development requiere DATABASE_URL apuntando a mi_sistema_dev.');
  }
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
  translated = translated.replace(/\bINTEGER\s+PRIMARY\s+KEY\s*(,|\))/gi, 'BIGSERIAL PRIMARY KEY$1');
  translated = translated.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
  translated = translated.replace(/\bBLOB\b/gi, 'BYTEA');
  translated = translated.replace(/\bCOLLATE\s+NOCASE\b/gi, '');
  translated = translated.replace(/date\('now'\s*,\s*'localtime'\)/gi, 'CURRENT_DATE');
  translated = translated.replace(/date\('now'\)/gi, 'CURRENT_DATE');
  translated = translated.replace(/TIMESTAMP\('now'\s*,\s*'localtime'\)/gi, 'CURRENT_TIMESTAMP');
  translated = translated.replace(/TIMESTAMP\('now'\)/gi, 'CURRENT_TIMESTAMP');
  translated = translated.replace(/TIMESTAMP\(([^,()]+),\s*'unixepoch'\)/gi, 'TO_TIMESTAMP($1)');
  translated = translated.replace(/\bdate\(([^()]+)\)/gi, 'CAST($1 AS date)');
  translated = translated.replace(/\bdatetime\(([^()]+)\)/gi, 'CAST($1 AS timestamp)');
  translated = translated.replace(/strftime\('%Y-%m',\s*([^()]+)\)/gi, "TO_CHAR($1, 'YYYY-MM')");
  translated = translated.replace(/CAST\s*\(\s*julianday\('now'\)\s*-\s*julianday\(([^()]+)\)\s+AS\s+INTEGER\s*\)/gi, 'FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - $1::timestamp)) / 86400)::INTEGER');
  translated = translated.replace(/GROUP_CONCAT\(([^,()]+),\s*'([^']*)'\)/gi, "STRING_AGG(($1)::text, '$2')");
  translated = translated.replace(/GROUP_CONCAT\(([^()]+)\)/gi, "STRING_AGG(($1)::text, ',')");
  translated = translated.replace(
    /printf\('([^']*)%0(\d+)d',\s*([^()]+)\)/gi,
    (_match, prefix, width, expression) =>
      `'${prefix.replace(/'/g, "''")}' || LPAD((${expression.trim()})::text, ${Number(width)}, '0')`
  );
  translated = translated.replace(
    /ROUND\(COALESCE\(([^,()]+),\s*0\)\s*\*\s*COALESCE\(([^,()]+),\s*0\),\s*(\d+)\)/gi,
    'ROUND((COALESCE($1, 0) * COALESCE($2, 0))::numeric, $3)'
  );
  translated = translated.replace(/\bHAVING\s+total\b/gi, 'HAVING COUNT(*)');
  translated = translated.replace(/\bDATETIME\b/gi, 'TIMESTAMP');
  translated = translated.replace(/CURRENT_TIMESTAMP\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP');
  translated = translated.replace(
    /^ALTER\s+TABLE\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/i,
    'ALTER TABLE $1 ADD COLUMN IF NOT EXISTS '
  );
  translated = translatePlaceholders(translated);
  translated = translated.replace(/date\((\$\d+)\)/gi, 'CAST($1 AS date)');
  if (/^INSERT\s+INTO\s+/i.test(translated) && !/\bON\s+CONFLICT\b/i.test(translated) && !/\bRETURNING\b/i.test(translated)) {
    translated += ' RETURNING id';
  } else if (/^INSERT\s+INTO\s+/i.test(translated) && !/\bRETURNING\b/i.test(translated)) {
    translated += ' RETURNING id';
  }
  return translated;
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
    const run = async () => {
      await this.ready;
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
       WHERE ns.nspname = current_schema()
         AND t.relname = $1
       ORDER BY i.relname`,
      [tableName]
    );
    return result.rows;
  }

  async getIndexInfo(indexName) {
    const result = await this.pool.query(
      `SELECT key_columns.ordinality - 1 AS seqno,
              a.attname AS name
       FROM pg_class i
       JOIN pg_namespace ns ON ns.oid = i.relnamespace
       JOIN pg_index ix ON ix.indexrelid = i.oid
       JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality) ON true
       JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = key_columns.attnum
       WHERE ns.nspname = current_schema()
         AND i.relname = $1
       ORDER BY key_columns.ordinality`,
      [indexName]
    );
    return result.rows;
  }
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
  resolveDatabaseConfig,
  createPostgresPool,
  createAppDatabase,
  getActiveDatabaseInfo,
  testPostgresConnection,
  translateSqliteSql
};
