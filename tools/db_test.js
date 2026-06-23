require('dotenv').config();

const { getDatabaseConfig, testPostgresConnection } = require('../src/config/database');

async function main() {
  let config;
  try {
    config = getDatabaseConfig();
  } catch (err) {
    console.log('DATABASE_URL is not configured.');
    console.log('PostgreSQL multi-tenant mode is required.');
    process.exitCode = 1;
    return;
  }

  if (config.client !== 'postgres') {
    console.log('DATABASE_URL is not configured.');
    console.log('PostgreSQL multi-tenant mode is required.');
    process.exitCode = 1;
    return;
  }

  const result = await testPostgresConnection();
  console.log('PostgreSQL connection successful');
  console.log(`Database: ${result.database}`);
  console.log(`User: ${result.user}`);
  console.log(`Server time: ${result.now}`);
}

main().catch((err) => {
  console.error('PostgreSQL connection failed.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
