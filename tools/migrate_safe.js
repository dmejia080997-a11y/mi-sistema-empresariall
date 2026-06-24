require('dotenv').config();

const path = require('path');
const { spawnSync } = require('child_process');
const {
  MASTER_MIGRATIONS_DIR,
  TENANT_MIGRATIONS_DIR,
  applyDirectoryMigrations
} = require('../src/services/migration-service');
const {
  createMasterPool,
  createTenantPool,
  listCompanies
} = require('./tenant_migration_common');

const ROOT_DIR = path.resolve(__dirname, '..');

function runBackup() {
  console.log('Creando backup completo antes de migrar...');
  const result = spawnSync(process.execPath, [path.join(ROOT_DIR, 'tools', 'backup_all.js')], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: 'inherit'
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`backup:all fallo con codigo ${result.status}. No se ejecutaron migraciones.`);
  }
}

function printSummary(summary) {
  console.log('');
  console.log('Resumen de migraciones');
  for (const item of summary.databases) {
    const failed = item.failed ? `, fallo=${item.failed.filename}` : '';
    console.log(
      `- ${item.database}: aplicadas=${item.applied.length}, ` +
      `omitidas=${item.skipped.length}, total=${item.total}${failed}`
    );
  }
  console.log(`Resultado: ${summary.error ? 'FALLIDO' : 'OK'}`);
  if (summary.error) console.log(`Error: ${summary.error}`);
}

async function main() {
  const summary = { databases: [], error: null };
  let masterPool;

  try {
    runBackup();
    masterPool = createMasterPool();

    const masterResult = await applyDirectoryMigrations(
      masterPool,
      MASTER_MIGRATIONS_DIR,
      'master',
      { log: console.log }
    );
    summary.databases.push(masterResult);

    const companies = await listCompanies(masterPool);
    const tenantDatabases = Array.from(new Set(
      companies
        .map((company) => String(company.database_name || '').trim())
        .filter(Boolean)
    )).sort();

    for (const databaseName of tenantDatabases) {
      const tenantPool = createTenantPool(databaseName);
      try {
        const tenantResult = await applyDirectoryMigrations(
          tenantPool,
          TENANT_MIGRATIONS_DIR,
          `tenant:${databaseName}`,
          { log: console.log }
        );
        summary.databases.push(tenantResult);
      } catch (error) {
        if (error.migrationResult) summary.databases.push(error.migrationResult);
        throw error;
      } finally {
        await tenantPool.end();
      }
    }
  } catch (error) {
    if (error.migrationResult && !summary.databases.includes(error.migrationResult)) {
      summary.databases.push(error.migrationResult);
    }
    summary.error = error.message;
    process.exitCode = 1;
  } finally {
    if (masterPool) await masterPool.end();
    printSummary(summary);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
