require('dotenv').config();

const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_SQLITE_PATH = path.join(ROOT_DIR, 'data', 'app.db');

function getDatabaseUrl() {
  return String(process.env.DATABASE_URL || '').trim();
}

function getSqlitePath() {
  return path.resolve(ROOT_DIR, process.env.DATABASE_PATH || DEFAULT_SQLITE_PATH);
}

function maskDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return '(not configured)';

  try {
    const parsed = new URL(databaseUrl);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch (err) {
    return databaseUrl.replace(/(:\/\/[^:\s]+:)([^@\s]+)(@)/, '$1****$3');
  }
}

const databaseUrl = getDatabaseUrl();
const hasDatabaseUrl = Boolean(databaseUrl);

console.log(`DATABASE_URL exists: ${hasDatabaseUrl ? 'yes' : 'no'}`);
console.log(`Active engine: ${hasDatabaseUrl ? 'PostgreSQL' : 'none'}`);
console.log(`DATABASE_URL: ${maskDatabaseUrl(databaseUrl)}`);

if (!hasDatabaseUrl) {
  console.log('SQLite mode: historical backup only');
  console.log(`Historical SQLite path: ${getSqlitePath()}`);
}
