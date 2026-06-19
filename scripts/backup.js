const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKUPS_DIR = path.join(ROOT_DIR, 'storage', 'backups');

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
  ensureDir(BACKUPS_DIR);

  const backupDir = path.join(BACKUPS_DIR, `backup-${stamp()}`);
  ensureDir(backupDir);

  const copied = [];
  if (copyFileIfExists(path.join(ROOT_DIR, 'data', 'app.db'), path.join(backupDir, 'data', 'app.db'))) {
    copied.push('data/app.db');
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

main();
