require('dotenv').config();

const masterSaasService = require('../src/services/master-saas-service');

async function main() {
  const db = masterSaasService.createPool();
  try {
    const health = await masterSaasService.getSystemHealth(db);
    const failedTenants = health.tenants.filter((tenant) => tenant.health === 'red');
    console.log(`PostgreSQL: ${health.postgres.label}`);
    console.log(`PM2: ${health.pm2.label}`);
    console.log(`Cron: ${health.cron.label}`);
    console.log(`Disco: ${health.disk.usedPercent || 0}% usado, ${health.disk.availableLabel || '-'} disponible`);
    console.log(`Backups: ${health.backups.length} registrados, ultimo=${health.latestBackup ? health.latestBackup.name : 'ninguno'}`);
    console.log(`Tenants: ${health.tenants.length} registrados, errores=${failedTenants.length}`);
    failedTenants.forEach((tenant) => console.log(`- ERROR tenant ${tenant.id} ${tenant.name}: ${tenant.tenant.error || 'salud roja'}`));
    console.log(`Resultado: ${health.postgres.ok && health.pm2.ok && health.cron.ok && !failedTenants.length ? 'OK' : 'ERROR'}`);
    if (!health.postgres.ok || !health.pm2.ok || !health.cron.ok || failedTenants.length) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('system:health failed.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
