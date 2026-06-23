require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { getDatabaseConfig } = require('../src/config/database');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT_DIR, 'storage', 'backups', 'postgres');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backup-all.log');
const UPLOADS_DIR = path.join(ROOT_DIR, 'storage', 'uploads');
const RETAIN_BACKUPS = 30;

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(LOG_FILE, `${text}\n`);
}

function ensureDirs() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function databaseUrlForName(baseUrl, databaseName) {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function activeDatabaseName(databaseUrl) {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

function safeFileName(value) {
  return String(value || 'database').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'database';
}

async function listDatabases(masterPool, masterDatabaseName) {
  const result = await masterPool.query(
    `SELECT DISTINCT database_name
     FROM companies
     WHERE COALESCE(TRIM(database_name), '') != ''
     ORDER BY database_name`
  );

  const names = new Set([masterDatabaseName]);
  for (const row of result.rows) {
    names.add(row.database_name);
  }
  return Array.from(names);
}

function runPgDump(databaseUrl, databaseName, outputFile) {
  const started = Date.now();
  const result = spawnSync(
    'pg_dump',
    [
      '--dbname',
      databaseUrl,
      '--file',
      outputFile,
      '--format=custom',
      '--no-owner',
      '--no-privileges'
    ],
    {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      windowsHide: true
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `pg_dump failed for ${databaseName}`).trim());
  }

  return {
    database: databaseName,
    file: outputFile,
    size: fs.statSync(outputFile).size,
    durationMs: Date.now() - started
  };
}

function copyUploads(stagingDir) {
  const started = Date.now();
  const target = path.join(stagingDir, 'uploads');
  if (!fs.existsSync(UPLOADS_DIR)) {
    return { copied: false, size: 0, durationMs: Date.now() - started };
  }
  fs.cpSync(UPLOADS_DIR, target, { recursive: true });
  return {
    copied: true,
    size: directorySize(target),
    durationMs: Date.now() - started
  };
}

function directorySize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return total;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(entryPath);
    } else if (entry.isFile()) {
      total += fs.statSync(entryPath).size;
    }
  }
  return total;
}

function writeManifest(stagingDir, manifest) {
  fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createZip(stagingDir, zipPath) {
  const command = `$items = Get-ChildItem -LiteralPath ${psQuote(stagingDir)} -Force; ` +
    `Compress-Archive -LiteralPath $items.FullName -DestinationPath ${psQuote(zipPath)} -Force`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      windowsHide: true
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Compress-Archive failed').trim());
  }
  return fs.statSync(zipPath).size;
}

function applyRetention() {
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^backup-all-\d{8}-\d{6}\.zip$/i.test(name))
    .map((name) => {
      const filePath = path.join(BACKUP_DIR, name);
      return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  for (const backup of backups.slice(RETAIN_BACKUPS)) {
    fs.unlinkSync(backup.filePath);
    removed.push(backup.name);
  }
  return removed;
}

async function main() {
  ensureDirs();
  const started = Date.now();
  const backupStamp = stamp();
  const stagingDir = path.join(BACKUP_DIR, `backup-all-${backupStamp}`);
  const zipPath = path.join(BACKUP_DIR, `backup-all-${backupStamp}.zip`);
  const manifest = {
    created_at: new Date().toISOString(),
    status: 'running',
    databases: [],
    uploads: null,
    errors: []
  };

  fs.mkdirSync(stagingDir, { recursive: true });
  log(`backup started staging=${stagingDir}`);

  let config;
  let masterPool;
  try {
    config = getDatabaseConfig();
    if (config.client !== 'postgres') {
      throw new Error('PostgreSQL multi-tenant mode is required.');
    }

    const masterDatabase = activeDatabaseName(config.url);
    masterPool = new Pool({
      connectionString: config.url,
      ssl: config.ssl ? { rejectUnauthorized: false } : false
    });

    const databaseNames = await listDatabases(masterPool, masterDatabase);
    const dumpDir = path.join(stagingDir, 'databases');
    fs.mkdirSync(dumpDir, { recursive: true });

    for (const databaseName of databaseNames) {
      const outputFile = path.join(dumpDir, `${safeFileName(databaseName)}.dump`);
      try {
        const result = runPgDump(databaseUrlForName(config.url, databaseName), databaseName, outputFile);
        manifest.databases.push({ ...result, file: path.relative(stagingDir, result.file) });
        log(`database ok name=${databaseName} size=${result.size} durationMs=${result.durationMs}`);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        manifest.databases.push({ database: databaseName, error: message });
        manifest.errors.push({ database: databaseName, error: message });
        log(`database error name=${databaseName} error=${message}`);
      }
    }

    const uploads = copyUploads(stagingDir);
    manifest.uploads = uploads;
    log(`uploads ${uploads.copied ? 'ok' : 'missing'} size=${uploads.size} durationMs=${uploads.durationMs}`);

    manifest.status = manifest.errors.length ? 'completed_with_errors' : 'ok';
    manifest.durationMs = Date.now() - started;
    writeManifest(stagingDir, manifest);

    const zipSize = createZip(stagingDir, zipPath);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    const removed = applyRetention();

    log(`backup finished zip=${zipPath} size=${zipSize} status=${manifest.status} removed=${removed.length}`);

    console.log('Bases respaldadas:');
    for (const db of manifest.databases) {
      if (db.error) {
        console.log(`- ${db.database}: ERROR - ${db.error}`);
      } else {
        console.log(`- ${db.database}: OK (${formatBytes(db.size)}, ${formatDuration(db.durationMs)})`);
      }
    }
    console.log(`Uploads: ${uploads.copied ? 'OK' : 'NO ENCONTRADO'} (${formatBytes(uploads.size)}, ${formatDuration(uploads.durationMs)})`);
    console.log(`Archivo: ${zipPath}`);
    console.log(`Tamaño: ${formatBytes(zipSize)}`);
    console.log(`Duración: ${formatDuration(manifest.durationMs)}`);
    console.log(`Resultado final: ${manifest.status}`);

    if (manifest.errors.length) {
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    manifest.status = 'failed';
    manifest.durationMs = Date.now() - started;
    manifest.errors.push({ error: message });
    writeManifest(stagingDir, manifest);
    log(`backup failed error=${message}`);
    console.error('Backup failed.');
    console.error(message);
    process.exitCode = 1;
  } finally {
    if (masterPool) await masterPool.end();
  }
}

main().catch((err) => {
  log(`backup crashed error=${err && err.stack ? err.stack : err}`);
  console.error('Backup failed.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
