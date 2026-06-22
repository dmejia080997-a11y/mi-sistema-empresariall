require('dotenv').config();

const fs = require('fs');
const { getActiveDatabaseInfo, getDatabaseConfig, createPostgresPool } = require('../src/config/database');

async function main() {
  const config = getDatabaseConfig();
  const info = getActiveDatabaseInfo();

  if (info.client === 'postgres') {
    const pool = createPostgresPool(config);
    try {
      const result = await pool.query('SELECT current_database() AS database, current_user AS "user", inet_server_addr() AS host, inet_server_port() AS port');
      const row = result.rows[0] || {};
      console.log('Using PostgreSQL database');
      console.log(`database=${row.database || info.database}`);
      console.log(`host=${row.host || info.host}`);
      console.log(`port=${row.port || info.port}`);
      console.log(`user=${row.user || info.user}`);
    } finally {
      await pool.end();
    }
    return;
  }

  console.log('Using SQLite database');
  console.log(`filename=${info.filename}`);
  console.log(`exists=${fs.existsSync(info.filename) ? 'yes' : 'no'}`);
}

main().catch((err) => {
  console.error('Could not determine active database.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
