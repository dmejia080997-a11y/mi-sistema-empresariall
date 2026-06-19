const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const STORAGE_ROOT = path.join(ROOT_DIR, 'storage');
const STORAGE_DATABASE_DIR = path.join(STORAGE_ROOT, 'database');
const STORAGE_UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
const STORAGE_BACKUPS_DIR = path.join(STORAGE_ROOT, 'backups');
const STORAGE_LOGS_DIR = path.join(STORAGE_ROOT, 'logs');
const LEGACY_UPLOADS_DIR = path.join(ROOT_DIR, 'data', 'uploads');

module.exports = {
  ROOT_DIR,
  STORAGE_ROOT,
  STORAGE_DATABASE_DIR,
  STORAGE_UPLOADS_DIR,
  STORAGE_BACKUPS_DIR,
  STORAGE_LOGS_DIR,
  LEGACY_UPLOADS_DIR
};
