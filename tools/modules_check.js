require('dotenv').config();

const { Pool } = require('pg');
const { getDatabaseConfig } = require('../src/config/database');

async function main() {
  const config = getDatabaseConfig();
  if (config.client !== 'postgres') {
    throw new Error('PostgreSQL multi-tenant mode is required.');
  }

  const pool = new Pool({
    connectionString: config.url,
    ssl: config.ssl ? { rejectUnauthorized: false } : false
  });

  try {
    const total = await pool.query('SELECT COUNT(*)::int AS total FROM permission_modules');
    const unique = await pool.query('SELECT COUNT(DISTINCT code)::int AS total FROM permission_modules');
    const duplicates = await pool.query(
      `SELECT code, COUNT(*)::int AS count, MIN(id)::int AS keep_id, ARRAY_AGG(id ORDER BY id) AS ids
       FROM permission_modules
       GROUP BY code
       HAVING COUNT(*) > 1
       ORDER BY count DESC, code`
    );

    console.log(`Total de registros: ${total.rows[0].total}`);
    console.log(`Total de codigos unicos: ${unique.rows[0].total}`);
    console.log(`Codigos duplicados: ${duplicates.rowCount}`);
    for (const row of duplicates.rows) {
      console.log(`- ${row.code}: ${row.count} registros, conservar id=${row.keep_id}, ids=${row.ids.join(',')}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('modules:check failed.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
