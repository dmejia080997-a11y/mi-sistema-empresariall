const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_SQLITE_PATH = path.join(ROOT_DIR, 'data', 'app.db');

function getSqliteConfig(env = process.env) {
  return {
    client: 'sqlite',
    filename: path.resolve(ROOT_DIR, env.DATABASE_PATH || DEFAULT_SQLITE_PATH)
  };
}

function createSqliteDatabase(config = getSqliteConfig()) {
  const filename = config.filename || ':memory:';
  if (filename === ':memory:') return new sqlite3.Database(filename);
  return new sqlite3.Database(filename, sqlite3.OPEN_READONLY);
}

module.exports = {
  createSqliteDatabase,
  getSqliteConfig
};
