const {
  backupMasterData,
  connectionParts,
  copyCompanyRows,
  copyRelatedRows,
  createMasterPool,
  createMaintenancePool,
  createPhysicalDatabase,
  createTenantPool,
  createTenantTables,
  listCompanies,
  listTenantTables,
  resetTenantSequences,
  resolveAvailableDatabaseName,
  updateCompanyDatabaseConfig
} = require('./tenant_migration_common');
const { getDatabaseConfig } = require('../src/config/database');

const RELATED_COPY_ORDER = [
  'awb_items',
  'awb_manifests',
  'manifest_pieces',
  'manifest_piece_packages',
  'cartas_porte_items'
];

async function migrateCompany(masterPool, adminPool, tableNames, company) {
  const databaseName = await resolveAvailableDatabaseName(adminPool, company);
  console.log(`Migrating company id=${company.id} name="${company.name}" database=${databaseName}`);

  await createPhysicalDatabase(databaseName);

  const tenantPool = createTenantPool(databaseName);
  const copied = {};
  try {
    await tenantPool.query('BEGIN');
    const tableSpecs = await createTenantTables(masterPool, tenantPool, tableNames);

    for (const spec of tableSpecs) {
      const count = await copyCompanyRows(masterPool, tenantPool, spec, company.id);
      copied[spec.tableName] = count;
    }

    for (const tableName of RELATED_COPY_ORDER) {
      const spec = tableSpecs.find((candidate) => candidate.tableName === tableName);
      if (!spec) continue;
      copied[spec.tableName] = (copied[spec.tableName] || 0) + await copyRelatedRows(masterPool, tenantPool, spec);
    }

    await resetTenantSequences(tenantPool, tableSpecs);

    const users = copied.users || 0;
    if (users < 1) {
      throw new Error(`Company ${company.id} has no users to copy into tenant database.`);
    }
    const admins = await tenantPool.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'"
    );
    if (Number(admins.rows[0].count || 0) < 1) {
      throw new Error(`Company ${company.id} has no admin user to copy into tenant database.`);
    }

    await tenantPool.query('COMMIT');
  } catch (err) {
    await tenantPool.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await tenantPool.end();
  }

  await updateCompanyDatabaseConfig(
    masterPool,
    company.id,
    connectionParts(getDatabaseConfig().url, databaseName)
  );

  const totalRows = Object.values(copied).reduce((sum, count) => sum + count, 0);
  console.log(`OK company id=${company.id} database=${databaseName} copied_rows=${totalRows} users=${copied.users || 0}`);
}

async function main() {
  const masterPool = createMasterPool();
  const adminPool = createMaintenancePool();
  const summary = { migrated: 0, skipped: 0, errors: [] };

  try {
    const backupPath = await backupMasterData(masterPool);
    console.log(`Backup created: ${backupPath}`);

    const companies = await listCompanies(masterPool);
    const pending = companies.filter((company) => !String(company.database_name || '').trim());
    summary.skipped = companies.length - pending.length;

    if (pending.length === 0) {
      console.log('No existing companies without database_name were found.');
      return;
    }

    const tableNames = await listTenantTables(masterPool);
    for (const company of pending) {
      try {
        await migrateCompany(masterPool, adminPool, tableNames, company);
        summary.migrated += 1;
      } catch (err) {
        summary.errors.push({ company_id: company.id, company: company.name, error: err.message });
        console.error(`ERROR company id=${company.id} name="${company.name}": ${err.message}`);
      }
    }
  } finally {
    await adminPool.end();
    await masterPool.end();
  }

  console.log('Tenant migration summary');
  console.log(`Migrated: ${summary.migrated}`);
  console.log(`Skipped with database_name: ${summary.skipped}`);
  console.log(`Errors: ${summary.errors.length}`);
  summary.errors.forEach((err) => {
    console.log(`- company_id=${err.company_id} company="${err.company}": ${err.error}`);
  });

  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Tenant migration failed.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
