require('dotenv').config();

const {
  MASTER_MIGRATIONS_DIR,
  TENANT_MIGRATIONS_DIR,
  getDirectoryMigrationStatus
} = require('../src/services/migration-service');
const {
  createMasterPool,
  createTenantPool,
  listCompanies
} = require('./tenant_migration_common');

function printDatabaseStatus(label, status) {
  const applied = status.files.filter((item) => item.state === 'applied');
  const pending = status.files.filter((item) => item.state !== 'applied');

  console.log('');
  console.log(`${label}: aplicadas=${applied.length}, pendientes=${pending.length}`);
  for (const item of status.files) {
    console.log(`  [${item.state}] ${item.filename}`);
  }
  for (const record of status.unknownRecords) {
    console.log(`  [registrada_sin_archivo:${record.status}] ${record.filename}`);
  }
}

async function main() {
  const masterPool = createMasterPool();
  let hasErrors = false;

  try {
    const masterStatus = await getDirectoryMigrationStatus(masterPool, MASTER_MIGRATIONS_DIR);
    printDatabaseStatus('master', masterStatus);
    hasErrors = masterStatus.files.some((item) =>
      item.state === 'failed' || item.state === 'checksum_mismatch'
    );

    const companies = await listCompanies(masterPool);
    for (const company of companies) {
      const databaseName = String(company.database_name || '').trim();
      const label = `tenant id=${company.id} empresa="${company.name}" base=${databaseName || '(sin database_name)'}`;
      if (!databaseName) {
        console.log('');
        console.log(`${label}: ERROR`);
        hasErrors = true;
        continue;
      }

      const tenantPool = createTenantPool(databaseName);
      try {
        const tenantStatus = await getDirectoryMigrationStatus(tenantPool, TENANT_MIGRATIONS_DIR);
        printDatabaseStatus(label, tenantStatus);
        if (tenantStatus.files.some((item) =>
          item.state === 'failed' || item.state === 'checksum_mismatch'
        )) {
          hasErrors = true;
        }
      } catch (error) {
        console.log('');
        console.log(`${label}: ERROR - ${error.message}`);
        hasErrors = true;
      } finally {
        await tenantPool.end();
      }
    }
  } finally {
    await masterPool.end();
  }

  if (hasErrors) process.exitCode = 1;
}

main().catch((error) => {
  console.error('No se pudo consultar el estado de migraciones.');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
