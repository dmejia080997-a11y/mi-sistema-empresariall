const fs = require('fs');
const path = require('path');
const { getSqliteConfig } = require('../tools/sqlite_legacy');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKUPS_DIR = path.join(ROOT_DIR, 'storage', 'backups');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFileIfExists(source, target) {
  if (!fs.existsSync(source)) {
    console.log(`Skipped missing file: ${path.relative(ROOT_DIR, source)}`);
    return false;
  }
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  console.log(`Copied file: ${path.relative(ROOT_DIR, source)}`);
  return true;
}

function copyDirIfExists(source, target) {
  if (!fs.existsSync(source)) {
    console.log(`Skipped missing directory: ${path.relative(ROOT_DIR, source)}`);
    return false;
  }
  ensureDir(target);
  fs.cpSync(source, target, { recursive: true, force: true });
  console.log(`Copied directory: ${path.relative(ROOT_DIR, source)}`);
  return true;
}

function main() {
  console.log('Starting backup...');
  ensureDir(BACKUPS_DIR);

  const backupDir = path.join(BACKUPS_DIR, `backup-${stamp()}`);
  ensureDir(backupDir);

  const copied = [];
  const sqlitePath = getSqliteConfig().filename;
  const sqliteBackupName = path.basename(sqlitePath);
  if (copyFileIfExists(sqlitePath, path.join(backupDir, 'data', sqliteBackupName))) {
    copied.push(path.relative(ROOT_DIR, sqlitePath).replace(/\\/g, '/'));
  }
  if (copyFileIfExists(path.join(ROOT_DIR, 'data', 'sessions.db'), path.join(backupDir, 'data', 'sessions.db'))) {
    copied.push('data/sessions.db');
  }
  if (copyDirIfExists(path.join(ROOT_DIR, 'storage', 'uploads'), path.join(backupDir, 'storage', 'uploads'))) {
    copied.push('storage/uploads');
  }

  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
    created_at: new Date().toISOString(),
    backup_dir: backupDir,
    copied
  }, null, 2));

  console.log(`Backup created: ${backupDir}`);
  console.log(`Included: ${copied.length ? copied.join(', ') : 'no matching files found'}`);
}

try {
  main();
} catch (err) {
  console.error('Backup failed.');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
