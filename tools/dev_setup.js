const { Pool } = require('pg');
const {
  MASTER_DATABASE,
  TENANT_DATABASE,
  maintenanceUrl,
  localConfig,
  createDatabaseIfMissing,
  bootstrapEmptyDatabases
} = require('./dev_database_common');

async function main() {
  const config = localConfig();
  const adminPool = new Pool({ connectionString: maintenanceUrl(config.url), ssl: false });
  let masterCreated;
  let tenantCreated;
  try {
    masterCreated = await createDatabaseIfMissing(adminPool, MASTER_DATABASE);
    tenantCreated = await createDatabaseIfMissing(adminPool, TENANT_DATABASE);
  } finally {
    await adminPool.end();
  }

  await bootstrapEmptyDatabases(config);
  console.log(`${MASTER_DATABASE}: ${masterCreated ? 'creada' : 'existente'}`);
  console.log(`${TENANT_DATABASE}: ${tenantCreated ? 'creada' : 'existente'}`);
  console.log('Entorno PostgreSQL local listo.');
}

main().catch((error) => {
  console.error(`dev:setup fallo: ${error.message}`);
  process.exit(1);
});
