require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { getDatabaseConfig } = require('../src/config/database');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT_DIR, 'storage', 'backups', 'postgres');

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function activeDatabaseName(databaseUrl) {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function createBackup(config) {
  ensureBackupDir();
  const databaseName = activeDatabaseName(config.url);
  const backupPath = path.join(BACKUP_DIR, `permission-modules-before-dedupe-${stamp()}.dump`);
  const result = spawnSync(
    'pg_dump',
    [
      '--dbname',
      config.url,
      '--file',
      backupPath,
      '--format=custom',
      '--no-owner',
      '--no-privileges'
    ],
    {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `pg_dump failed for ${databaseName}`).trim());
  }
  return backupPath;
}

async function main() {
  const config = getDatabaseConfig();
  if (config.client !== 'postgres') {
    throw new Error('PostgreSQL multi-tenant mode is required.');
  }

  const backupPath = createBackup(config);
  console.log(`Backup creado: ${backupPath}`);

  const pool = new Pool({
    connectionString: config.url,
    ssl: config.ssl ? { rejectUnauthorized: false } : false
  });

  try {
    await pool.query('BEGIN');

    const before = await pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT code)::int AS unique_codes
       FROM permission_modules`
    );
    const duplicateCodes = await pool.query(
      `SELECT code, COUNT(*)::int AS count, MIN(id)::int AS keep_id
       FROM permission_modules
       GROUP BY code
       HAVING COUNT(*) > 1
       ORDER BY code`
    );

    await pool.query(
      `CREATE TEMP TABLE permission_module_dedupe_map AS
       SELECT id AS duplicate_id,
              MIN(id) OVER (PARTITION BY code) AS keep_id
       FROM permission_modules`
    );

    await pool.query(
      `INSERT INTO module_actions (module_id, action_id, created_at)
       SELECT map.keep_id, ma.action_id, MIN(ma.created_at)
       FROM module_actions ma
       JOIN permission_module_dedupe_map map ON ma.module_id = map.duplicate_id
       WHERE map.duplicate_id <> map.keep_id
       GROUP BY map.keep_id, ma.action_id
       ON CONFLICT (module_id, action_id) DO NOTHING`
    );

    await pool.query(
      `DELETE FROM module_actions ma
       USING permission_module_dedupe_map map
       WHERE ma.module_id = map.duplicate_id
         AND map.duplicate_id <> map.keep_id`
    );

    await pool.query(
      `INSERT INTO user_permissions (user_id, company_id, module_id, action_id, created_at)
       SELECT up.user_id, up.company_id, map.keep_id, up.action_id, MIN(up.created_at)
       FROM user_permissions up
       JOIN permission_module_dedupe_map map ON up.module_id = map.duplicate_id
       WHERE map.duplicate_id <> map.keep_id
       GROUP BY up.user_id, up.company_id, map.keep_id, up.action_id
       ON CONFLICT (user_id, module_id, action_id) DO NOTHING`
    );

    await pool.query(
      `DELETE FROM user_permissions up
       USING permission_module_dedupe_map map
       WHERE up.module_id = map.duplicate_id
         AND map.duplicate_id <> map.keep_id`
    );

    await pool.query(
      `DELETE FROM permission_modules pm
       USING permission_module_dedupe_map map
       WHERE pm.id = map.duplicate_id
         AND map.duplicate_id <> map.keep_id`
    );

    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS permission_modules_code_unique
       ON permission_modules (code)`
    );

    const after = await pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT code)::int AS unique_codes
       FROM permission_modules`
    );
    const remaining = await pool.query(
      `SELECT code, COUNT(*)::int AS count
       FROM permission_modules
       GROUP BY code
       HAVING COUNT(*) > 1
       ORDER BY code`
    );

    if (remaining.rowCount > 0) {
      throw new Error(`Still duplicated codes after dedupe: ${remaining.rows.map((row) => row.code).join(', ')}`);
    }

    await pool.query('COMMIT');

    console.log(`Antes: registros=${before.rows[0].total}, codigos_unicos=${before.rows[0].unique_codes}`);
    console.log(`Codigos duplicados corregidos: ${duplicateCodes.rowCount}`);
    for (const row of duplicateCodes.rows) {
      console.log(`- ${row.code}: ${row.count} registros, conservado id=${row.keep_id}`);
    }
    console.log(`Despues: registros=${after.rows[0].total}, codigos_unicos=${after.rows[0].unique_codes}`);
    console.log('Resultado: OK');
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('Resultado: ERROR');
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('modules:dedupe failed.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
