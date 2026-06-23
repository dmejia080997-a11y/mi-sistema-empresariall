const {
  createMasterPool,
  listCompanies,
  tenantStats
} = require('./tenant_migration_common');

function statusFor(company, stats) {
  if (!company.database_name) return 'ERROR';
  if (!stats.exists) return 'ERROR';
  if (stats.tables < 1) return 'ERROR';
  if (stats.users < 1) return 'ERROR';
  return 'OK';
}

async function main() {
  const masterPool = createMasterPool();
  let hasErrors = false;

  try {
    const companies = await listCompanies(masterPool);
    console.log('empresa | id | database_name | base_existe | tablas | usuarios | estado');
    console.log('--- | --- | --- | --- | --- | --- | ---');

    for (const company of companies) {
      const databaseName = company.database_name || '';
      const stats = databaseName
        ? await tenantStats(databaseName)
        : { exists: false, tables: 0, users: 0 };
      const status = statusFor(company, stats);
      if (status !== 'OK') hasErrors = true;
      console.log([
        company.name || '',
        company.id,
        databaseName || '(sin database_name)',
        stats.exists ? 'si' : 'no',
        stats.tables,
        stats.users,
        status
      ].join(' | '));
    }
  } finally {
    await masterPool.end();
  }

  if (hasErrors) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Tenant check failed.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
