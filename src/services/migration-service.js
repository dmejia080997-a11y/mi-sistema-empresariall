const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const MIGRATIONS_ROOT = path.join(ROOT_DIR, 'migrations');
const MASTER_MIGRATIONS_DIR = path.join(MIGRATIONS_ROOT, 'master');
const TENANT_MIGRATIONS_DIR = path.join(MIGRATIONS_ROOT, 'tenants');
const MIGRATION_FILE_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 'mi-sistema-empresarial:schema-migrations';

const CREATE_SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id BIGSERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    checksum CHAR(64) NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL,
    error_message TEXT,
    CONSTRAINT schema_migrations_status_check
      CHECK (status IN ('applied', 'failed'))
  )
`;

function checksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function listMigrationFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function readMigrations(directory) {
  return listMigrationFiles(directory).map((filename) => {
    const fullPath = path.join(directory, filename);
    const sql = fs.readFileSync(fullPath, 'utf8');
    return {
      filename,
      fullPath,
      sql,
      checksum: checksum(sql)
    };
  });
}

function sanitizeSqlForValidation(sql) {
  const input = String(sql || '');
  let output = '';
  let index = 0;
  let state = 'normal';
  let dollarTag = '';

  while (index < input.length) {
    const current = input[index];
    const next = input[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'normal';
        output += '\n';
      } else {
        output += ' ';
      }
      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        output += '  ';
        index += 2;
        state = 'normal';
      } else {
        output += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (state === 'single-quote') {
      if (current === "'" && next === "'") {
        output += '  ';
        index += 2;
      } else if (current === "'") {
        output += ' ';
        index += 1;
        state = 'normal';
      } else {
        output += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (state === 'double-quote') {
      if (current === '"' && next === '"') {
        output += '  ';
        index += 2;
      } else if (current === '"') {
        output += ' ';
        index += 1;
        state = 'normal';
      } else {
        output += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (state === 'dollar-quote') {
      if (input.startsWith(dollarTag, index)) {
        output += ' '.repeat(dollarTag.length);
        index += dollarTag.length;
        state = 'normal';
      } else {
        output += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (current === '-' && next === '-') {
      output += '  ';
      index += 2;
      state = 'line-comment';
      continue;
    }
    if (current === '/' && next === '*') {
      output += '  ';
      index += 2;
      state = 'block-comment';
      continue;
    }
    if (current === "'") {
      output += ' ';
      index += 1;
      state = 'single-quote';
      continue;
    }
    if (current === '"') {
      output += ' ';
      index += 1;
      state = 'double-quote';
      continue;
    }
    if (current === '$') {
      const tagMatch = input.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (tagMatch) {
        dollarTag = tagMatch[0];
        output += ' '.repeat(dollarTag.length);
        index += dollarTag.length;
        state = 'dollar-quote';
        continue;
      }
    }

    output += current;
    index += 1;
  }

  return output;
}

function splitStatements(sql) {
  return String(sql || '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function validateMigrationSql(sql, filename = 'migration.sql') {
  const sanitized = sanitizeSqlForValidation(sql);
  const violations = [];

  for (const statement of splitStatements(sanitized)) {
    if (/\bDROP\b/i.test(statement)) {
      violations.push('DROP no se ejecuta automaticamente');
    }
    if (/\bTRUNCATE\b/i.test(statement)) {
      violations.push('TRUNCATE no esta permitido');
    }
    if (/^\s*DELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) {
      violations.push('DELETE sin WHERE no esta permitido');
    }
    if (/\bALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i.test(statement)) {
      violations.push('ALTER COLUMN TYPE requiere respaldo y migracion manual');
    }
    if (/\bRENAME\s+COLUMN\b/i.test(statement)) {
      violations.push('RENAME COLUMN requiere migracion manual');
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i.test(statement)) {
      violations.push('el control de transacciones pertenece al motor de migraciones');
    }
  }

  if (violations.length) {
    throw new Error(`Migracion insegura ${filename}: ${Array.from(new Set(violations)).join('; ')}.`);
  }
}

async function ensureSchemaMigrations(poolOrClient) {
  await poolOrClient.query(CREATE_SCHEMA_MIGRATIONS_SQL);
}

async function getMigrationRecords(poolOrClient) {
  await ensureSchemaMigrations(poolOrClient);
  const result = await poolOrClient.query(
    `SELECT id, filename, checksum, executed_at, status, error_message
     FROM schema_migrations
     ORDER BY filename`
  );
  return result.rows;
}

function buildMigrationStatus(migrations, records) {
  const byFilename = new Map(records.map((record) => [record.filename, record]));
  return migrations.map((migration) => {
    const record = byFilename.get(migration.filename);
    let state = 'pending';
    if (record && record.status === 'applied') {
      state = record.checksum === migration.checksum ? 'applied' : 'checksum_mismatch';
    } else if (record && record.status === 'failed') {
      state = 'failed';
    }
    return { ...migration, record: record || null, state };
  });
}

async function recordFailure(poolOrClient, migration, error) {
  await poolOrClient.query(
    `INSERT INTO schema_migrations
       (filename, checksum, executed_at, status, error_message)
     VALUES ($1, $2, CURRENT_TIMESTAMP, 'failed', $3)
     ON CONFLICT (filename) DO UPDATE
       SET checksum = EXCLUDED.checksum,
           executed_at = EXCLUDED.executed_at,
           status = EXCLUDED.status,
           error_message = EXCLUDED.error_message`,
    [migration.filename, migration.checksum, String(error && error.message ? error.message : error)]
  );
}

async function applyMigration(client, migration) {
  try {
    validateMigrationSql(migration.sql, migration.filename);
    await client.query('BEGIN');
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO schema_migrations
         (filename, checksum, executed_at, status, error_message)
       VALUES ($1, $2, CURRENT_TIMESTAMP, 'applied', NULL)
       ON CONFLICT (filename) DO UPDATE
         SET checksum = EXCLUDED.checksum,
             executed_at = EXCLUDED.executed_at,
             status = EXCLUDED.status,
             error_message = NULL`,
      [migration.filename, migration.checksum]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await recordFailure(client, migration, error).catch(() => {});
    throw error;
  }
}

async function applyDirectoryMigrations(pool, directory, databaseLabel, options = {}) {
  const migrations = readMigrations(directory);
  const client = await pool.connect();
  const result = {
    database: databaseLabel,
    total: migrations.length,
    applied: [],
    skipped: [],
    failed: null
  };

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await ensureSchemaMigrations(client);
    const records = await getMigrationRecords(client);
    const status = buildMigrationStatus(migrations, records);

    for (const migration of status) {
      if (migration.state === 'checksum_mismatch') {
        throw new Error(
          `Checksum distinto para ${migration.filename} en ${databaseLabel}. ` +
          'No modifique una migracion ya aplicada; cree una nueva.'
        );
      }
      if (migration.state === 'applied') {
        result.skipped.push(migration.filename);
        continue;
      }

      if (options.log) options.log(`Aplicando ${migration.filename} en ${databaseLabel}...`);
      try {
        await applyMigration(client, migration);
        result.applied.push(migration.filename);
      } catch (error) {
        result.failed = { filename: migration.filename, error: error.message };
        const wrapped = new Error(
          `Fallo ${migration.filename} en ${databaseLabel}: ${error.message}`
        );
        wrapped.migrationResult = result;
        throw wrapped;
      }
    }

    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function getDirectoryMigrationStatus(pool, directory) {
  const migrations = readMigrations(directory);
  const records = await getMigrationRecords(pool);
  const files = buildMigrationStatus(migrations, records);
  const unknownRecords = records.filter(
    (record) => !migrations.some((migration) => migration.filename === record.filename)
  );
  return { files, unknownRecords };
}

module.exports = {
  MASTER_MIGRATIONS_DIR,
  TENANT_MIGRATIONS_DIR,
  applyDirectoryMigrations,
  buildMigrationStatus,
  checksum,
  ensureSchemaMigrations,
  getDirectoryMigrationStatus,
  listMigrationFiles,
  readMigrations,
  sanitizeSqlForValidation,
  validateMigrationSql
};
