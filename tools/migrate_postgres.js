require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createPostgresPool, createSqliteDatabase, getDatabaseConfig, getSqliteConfig } = require('../src/config/database');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKUP_ROOT = path.join(ROOT_DIR, 'storage', 'backups');

const summary = {
  tablesCreated: 0,
  tablesMigrated: 0,
  recordsCopied: 0,
  recordsSkipped: 0,
  errors: []
};

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function sqliteGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function mapSqliteTypeToPostgres(type, isPrimaryKey) {
  const normalized = String(type || '').trim().toUpperCase();
  if (isPrimaryKey && normalized.includes('INT')) return 'BIGINT';
  if (normalized.includes('INT')) return 'BIGINT';
  if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) return 'DOUBLE PRECISION';
  if (normalized.includes('BLOB')) return 'BYTEA';
  if (normalized.includes('NUM') || normalized.includes('DEC')) return 'NUMERIC';
  return 'TEXT';
}

function defaultExpression(defaultValue) {
  if (defaultValue === null || defaultValue === undefined) return '';
  const raw = String(defaultValue).trim();
  if (!raw) return '';
  if (/^NULL$/i.test(raw)) return ' DEFAULT NULL';
  if (/^CURRENT_(TIME|DATE|TIMESTAMP)$/i.test(raw)) return ` DEFAULT ${raw}`;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return ` DEFAULT ${raw}`;
  if (/^'.*'$/.test(raw)) return ` DEFAULT ${raw}`;
  return '';
}

async function createBackup() {
  const sqlitePath = getSqliteConfig().filename;
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found: ${sqlitePath}`);
  }

  const backupDir = path.join(BACKUP_ROOT, `sqlite-before-postgres-migration-${stamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, 'app.db');
  fs.copyFileSync(sqlitePath, backupPath);
  console.log(`SQLite backup created: ${backupPath}`);
}

async function getSqliteTables(db) {
  return sqliteAll(
    db,
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  );
}

async function createPostgresTable(pg, tableName, columns) {
  const existed = await postgresTableExists(pg, tableName);
  const pkColumns = columns
    .filter((column) => Number(column.pk || 0) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => column.name);

  const definitions = columns.map((column) => {
    const isPrimaryKey = pkColumns.includes(column.name);
    const pieces = [
      quoteIdent(column.name),
      mapSqliteTypeToPostgres(column.type, isPrimaryKey)
    ];
    if (Number(column.notnull || 0) === 1 && !isPrimaryKey) pieces.push('NOT NULL');
    pieces.push(defaultExpression(column.dflt_value));
    return pieces.filter(Boolean).join(' ');
  });

  if (pkColumns.length > 0) {
    definitions.push(`PRIMARY KEY (${pkColumns.map(quoteIdent).join(', ')})`);
  }

  await pg.query(`CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (${definitions.join(', ')})`);
  await ensurePostgresColumns(pg, tableName, columns);
  await ensureUsersChatPresenceDefault(pg, tableName);
  if (!existed) summary.tablesCreated += 1;
  const hasConflictTarget = pkColumns.length > 0
    && (!existed || await postgresHasUniqueConstraint(pg, tableName, pkColumns));
  return { pkColumns, hasConflictTarget };
}

async function ensureUsersChatPresenceDefault(pg, tableName) {
  if (tableName !== 'users') return;

  const result = await pg.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'users'
       AND column_name = 'chat_presence_status'`
  );

  if (result.rowCount === 0) return;

  await pg.query(
    `ALTER TABLE ${quoteIdent(tableName)}
     ALTER COLUMN ${quoteIdent('chat_presence_status')} SET DEFAULT 'offline'`
  );
}

async function postgresTableExists(pg, tableName) {
  const result = await pg.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0] && result.rows[0].exists);
}

async function ensurePostgresColumns(pg, tableName, columns) {
  const existing = await pg.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1`,
    [tableName]
  );
  const existingColumns = new Set(existing.rows.map((row) => row.column_name));

  for (const column of columns) {
    if (existingColumns.has(column.name)) continue;
    const isPrimaryKey = Number(column.pk || 0) > 0;
    const type = mapSqliteTypeToPostgres(column.type, isPrimaryKey);
    await pg.query(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(column.name)} ${type}`);
  }
}

async function tableHasRows(pg, tableName) {
  const result = await pg.query(`SELECT EXISTS (SELECT 1 FROM ${quoteIdent(tableName)} LIMIT 1) AS has_rows`);
  return Boolean(result.rows[0] && result.rows[0].has_rows);
}

async function postgresHasUniqueConstraint(pg, tableName, columns) {
  const result = await pg.query(
    `SELECT 1
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema()
       AND t.relname = $1
       AND c.contype IN ('p', 'u')
       AND (
         SELECT array_agg(a.attname ORDER BY a.attname)
         FROM unnest(c.conkey) AS key(attnum)
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
       ) = $2::text[]`,
    [tableName, [...columns].sort()]
  );
  return result.rowCount > 0;
}

async function rowExistsByPrimaryKey(pg, tableName, pkColumns, row) {
  const params = pkColumns.map((name) => row[name]);
  if (params.some((value) => value === null || value === undefined)) return false;

  const where = pkColumns
    .map((name, index) => `${quoteIdent(name)} = $${index + 1}`)
    .join(' AND ');
  const result = await pg.query(
    `SELECT 1 FROM ${quoteIdent(tableName)} WHERE ${where} LIMIT 1`,
    params
  );
  return result.rowCount > 0;
}

async function insertRows(pg, tableName, columns, pkColumns, hasConflictTarget, rows) {
  if (!rows.length) return 0;

  const columnNames = columns.map((column) => column.name);
  const quotedColumns = columnNames.map(quoteIdent).join(', ');
  let copied = 0;

  for (const row of rows) {
    if (!hasConflictTarget && pkColumns.length && await rowExistsByPrimaryKey(pg, tableName, pkColumns, row)) {
      continue;
    }

    const values = columnNames.map((name) => row[name]);
    const params = values.map((_, index) => `$${index + 1}`).join(', ');
    const conflictClause = hasConflictTarget
      ? ` ON CONFLICT (${pkColumns.map(quoteIdent).join(', ')}) DO NOTHING`
      : '';
    const result = await pg.query(
      `INSERT INTO ${quoteIdent(tableName)} (${quotedColumns}) VALUES (${params})${conflictClause}`,
      values
    );
    copied += Number(result.rowCount || 0);
  }

  return copied;
}

async function migrateTable(sqliteDb, pg, tableName) {
  const columns = await sqliteAll(sqliteDb, `PRAGMA table_info(${quoteIdent(tableName)})`);
  if (!columns.length) {
    console.log(`SKIP ${tableName}: no columns found`);
    return;
  }

  const { pkColumns, hasConflictTarget } = await createPostgresTable(pg, tableName, columns);
  const sqliteCount = await sqliteGet(sqliteDb, `SELECT COUNT(*) AS count FROM ${quoteIdent(tableName)}`);
  const totalRows = Number(sqliteCount && sqliteCount.count ? sqliteCount.count : 0);

  if (totalRows === 0) {
    summary.tablesMigrated += 1;
    console.log(`OK ${tableName}: table created, no records to copy`);
    return;
  }

  if (!pkColumns.length && await tableHasRows(pg, tableName)) {
    summary.recordsSkipped += totalRows;
    console.log(`SKIP ${tableName}: PostgreSQL table has data and SQLite table has no primary key (${totalRows} records skipped)`);
    summary.tablesMigrated += 1;
    return;
  }

  const rows = await sqliteAll(sqliteDb, `SELECT * FROM ${quoteIdent(tableName)}`);
  const copied = await insertRows(pg, tableName, columns, pkColumns, hasConflictTarget, rows);
  const skipped = rows.length - copied;
  summary.tablesMigrated += 1;
  summary.recordsCopied += copied;
  summary.recordsSkipped += skipped;
  console.log(`OK ${tableName}: copied ${copied}/${rows.length} records, skipped ${skipped}`);
}

async function main() {
  const config = getDatabaseConfig();
  if (config.client !== 'postgres') {
    throw new Error('DATABASE_URL is required for PostgreSQL migration.');
  }

  await createBackup();

  const sqliteDb = createSqliteDatabase(getSqliteConfig());
  const pg = createPostgresPool(config);
  let inTransaction = false;

  try {
    await pg.query('BEGIN');
    inTransaction = true;
    const tables = await getSqliteTables(sqliteDb);

    for (const table of tables) {
      await migrateTable(sqliteDb, pg, table.name);
    }

    await pg.query('COMMIT');
    inTransaction = false;
  } catch (err) {
    summary.errors.push({ table: 'migration', message: err.message });
    if (inTransaction) {
      await pg.query('ROLLBACK');
      inTransaction = false;
    }
    console.error(`ERROR migration: ${err.message}`);
  } finally {
    await pg.end();
    sqliteDb.close();
  }

  console.log('Migration summary');
  console.log(`Tables created: ${summary.tablesCreated}`);
  console.log(`Tables migrated: ${summary.tablesMigrated}`);
  console.log(`Records copied: ${summary.recordsCopied}`);
  console.log(`Records skipped: ${summary.recordsSkipped}`);
  console.log(`Errors: ${summary.errors.length}`);
  summary.errors.forEach((err) => console.log(`- ${err.table}: ${err.message}`));

  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('PostgreSQL migration failed.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
