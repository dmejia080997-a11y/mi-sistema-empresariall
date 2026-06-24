const fs = require('fs');
const path = require('path');
const {
  ROOT_DIR,
  STORAGE_DATABASE_DIR,
  STORAGE_UPLOADS_DIR,
  STORAGE_BACKUPS_DIR,
  STORAGE_LOGS_DIR
} = require('../src/core/storage-paths');
const { getSqliteConfig } = require('./sqlite_legacy');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFileIfExists(source, target) {
  if (!fs.existsSync(source)) return false;
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  return true;
}

function copyDirIfExists(source, target) {
  if (!fs.existsSync(source)) return false;
  ensureDir(target);
  fs.cpSync(source, target, { recursive: true, force: true });
  return true;
}

function main() {
  ensureDir(STORAGE_DATABASE_DIR);
  ensureDir(STORAGE_UPLOADS_DIR);
  ensureDir(STORAGE_BACKUPS_DIR);
  ensureDir(STORAGE_LOGS_DIR);
  const backupDir = path.join(STORAGE_BACKUPS_DIR, `backup-${stamp()}`);
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
  if (copyDirIfExists(STORAGE_UPLOADS_DIR, path.join(backupDir, 'storage', 'uploads'))) {
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

main();
