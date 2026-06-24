require('../src/config/load-env');

const assert = require('assert');
const {
  getDatabaseConfig,
  translateSqliteSql
} = require('../src/config/database');

const requiredInProd = ['SESSION_SECRET', 'MASTER_USER', 'MASTER_PASS', 'FILE_TOKEN_SECRET'];
const isProd = (process.env.NODE_ENV || 'development') === 'production';
let failed = false;
if (isProd) {
  requiredInProd.forEach((key) => {
    if (!process.env[key]) {
      console.error(`[selfcheck] Missing env var in production: ${key}`);
      failed = true;
    }
  });
} else {
  requiredInProd.forEach((key) => {
    if (!process.env[key]) {
      console.warn(`[selfcheck] Missing env var (dev ok): ${key}`);
    }
  });
}
if (failed) {
  process.exit(1);
}

assert.strictEqual(
  translateSqliteSql("SELECT datetime(created_at), date('now') FROM invoices WHERE id = ?"),
  'SELECT CAST(created_at AS timestamp), CURRENT_DATE FROM invoices WHERE id = $1'
);
assert.strictEqual(
  translateSqliteSql("SELECT GROUP_CONCAT(name, ', ') FROM items"),
  "SELECT STRING_AGG((name)::text, ', ') FROM items"
);
assert.strictEqual(
  translateSqliteSql("SELECT printf('FAC-%06d', id) FROM invoices"),
  "SELECT 'FAC-' || LPAD((id)::text, 6, '0') FROM invoices"
);
assert.strictEqual(
  translateSqliteSql('ALTER TABLE items ADD COLUMN production_type TEXT'),
  'ALTER TABLE items ADD COLUMN IF NOT EXISTS production_type TEXT'
);
assert.strictEqual(
  translateSqliteSql('SELECT company_id, COUNT(*) AS total FROM users GROUP BY company_id HAVING total > 1'),
  'SELECT company_id, COUNT(*) AS total FROM users GROUP BY company_id HAVING COUNT(*) > 1'
);
assert.strictEqual(
  translateSqliteSql('SELECT ROUND(COALESCE(qty, 0) * COALESCE(unit_price, 0), 2) FROM invoice_items'),
  'SELECT ROUND((COALESCE(qty, 0) * COALESCE(unit_price, 0))::numeric, 2) FROM invoice_items'
);
assert.throws(
  () => getDatabaseConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/mi_sistema_dev'
  }),
  /localhost/
);
assert.throws(
  () => getDatabaseConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/production'
  }),
  /mi_sistema_dev/
);
assert.strictEqual(
  getDatabaseConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/mi_sistema_dev',
    DATABASE_SSL: 'false'
  }).client,
  'postgres'
);

console.log('[selfcheck] OK');
