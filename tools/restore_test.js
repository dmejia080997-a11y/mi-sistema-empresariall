require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { getDatabaseConfig } = require('../src/config/database');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT_DIR, 'storage', 'backups', 'postgres');
const RESTORE_DB = 'restore_test_db';

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function databaseUrlForName(baseUrl, databaseName) {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function maintenanceUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

function activeDatabaseName(databaseUrl) {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

function latestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    throw new Error(`Backup directory not found: ${BACKUP_DIR}`);
  }

  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^backup-all-\d{8}-\d{6}\.(tar\.gz|zip)$/i.test(name))
    .map((name) => {
      const filePath = path.join(BACKUP_DIR, name);
      return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!backups.length) {
    throw new Error(`No backup-all archives found in ${BACKUP_DIR}`);
  }

  return backups[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result;
}

function extractBackup(backup, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  if (/\.tar\.gz$/i.test(backup.name)) {
    run('tar', ['-xzf', backup.filePath, '-C', extractDir]);
    return;
  }
  if (/\.zip$/i.test(backup.name)) {
    run('unzip', ['-q', backup.filePath, '-d', extractDir]);
    return;
  }
  throw new Error(`Unsupported backup archive: ${backup.name}`);
}

function findExtractedRoot(extractDir) {
  const entries = fs.readdirSync(extractDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extractDir, entry.name));
  if (entries.length !== 1) {
    throw new Error(`Could not identify extracted backup root in ${extractDir}`);
  }
  return entries[0];
}

function readManifest(extractedRoot) {
  const manifestPath = path.join(extractedRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function chooseTenantDump(extractedRoot, masterDatabaseName) {
  const manifest = readManifest(extractedRoot);
  if (manifest && Array.isArray(manifest.databases)) {
    const tenant = manifest.databases.find((db) =>
      db &&
      db.database &&
      db.database !== masterDatabaseName &&
      db.file &&
      !db.error &&
      fs.existsSync(path.join(extractedRoot, db.file))
    );
    if (tenant) {
      return {
        database: tenant.database,
        dumpPath: path.join(extractedRoot, tenant.file)
      };
    }
  }

  const dumpDir = path.join(extractedRoot, 'databases');
  if (!fs.existsSync(dumpDir)) {
    throw new Error('No databases directory found in backup.');
  }

  const dumps = fs.readdirSync(dumpDir)
    .filter((name) => /\.dump$/i.test(name))
    .filter((name) => path.basename(name, '.dump') !== masterDatabaseName)
    .sort();

  if (!dumps.length) {
    throw new Error('No tenant dump found in latest backup.');
  }

  return {
    database: path.basename(dumps[0], '.dump'),
    dumpPath: path.join(dumpDir, dumps[0])
  };
}

async function recreateRestoreDatabase(config) {
  const adminPool = new Pool({
    connectionString: maintenanceUrl(config.url),
    ssl: config.ssl ? { rejectUnauthorized: false } : false
  });
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(RESTORE_DB)} WITH (FORCE)`);
  } catch (err) {
    if (err && err.code === '42601') {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(RESTORE_DB)}`);
    } else {
      throw err;
    }
  }
  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdent(RESTORE_DB)}`);
  } finally {
    await adminPool.end();
  }
}

function restoreDump(config, dumpPath) {
  run('pg_restore', [
    '--dbname',
    databaseUrlForName(config.url, RESTORE_DB),
    '--no-owner',
    '--no-privileges',
    dumpPath
  ]);
}

async function verifyRestore(config) {
  const pool = new Pool({
    connectionString: databaseUrlForName(config.url, RESTORE_DB),
    ssl: config.ssl ? { rejectUnauthorized: false } : false
  });
  try {
    const tables = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );

    const usersTable = tables.rows.some((row) => row.table_name === 'users');
    const users = usersTable
      ? await pool.query('SELECT COUNT(*)::int AS count FROM users')
      : { rows: [{ count: 0 }] };

    let records = 0;
    for (const row of tables.rows) {
      const count = await pool.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(row.table_name)}`);
      records += Number(count.rows[0].count || 0);
    }

    return {
      tables: tables.rowCount,
      users: Number(users.rows[0].count || 0),
      records
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  const started = Date.now();
  const config = getDatabaseConfig();
  if (config.client !== 'postgres') {
    throw new Error('PostgreSQL multi-tenant mode is required.');
  }

  const backup = latestBackup();
  const extractDir = path.join(BACKUP_DIR, `restore-test-${Date.now()}`);
  let selected = null;

  try {
    extractBackup(backup, extractDir);
    const extractedRoot = findExtractedRoot(extractDir);
    selected = chooseTenantDump(extractedRoot, activeDatabaseName(config.url));

    await recreateRestoreDatabase(config);
    restoreDump(config, selected.dumpPath);
    const stats = await verifyRestore(config);

    const ok = stats.tables > 0 && stats.users > 0 && stats.records > 0;
    console.log(`Backup usado: ${backup.filePath}`);
    console.log(`Tenant probado: ${selected.database}`);
    console.log(`Base temporal: ${RESTORE_DB}`);
    console.log(`Tablas: ${stats.tables}`);
    console.log(`Usuarios: ${stats.users}`);
    console.log(`Registros: ${stats.records}`);
    console.log(`Duracion: ${formatDuration(Date.now() - started)}`);
    console.log(`Resultado: ${ok ? 'OK' : 'ERROR'}`);

    if (!ok) process.exitCode = 1;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Resultado: ERROR');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
