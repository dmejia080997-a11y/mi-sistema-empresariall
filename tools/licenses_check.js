require('dotenv').config();

const masterSaasService = require('../src/services/master-saas-service');

async function main() {
  const db = masterSaasService.createPool();
  try {
    const companies = await masterSaasService.getCompaniesWithSaasInfo(db);
    const active = companies.filter((company) => company.license_status_computed === 'active');
    const expired = companies.filter((company) => company.license_status_computed === 'expired');
    const expiring = companies.filter((company) => company.license_status_computed === 'expiring');

    console.log(`Empresas activas: ${active.length}`);
    console.log(`Empresas vencidas: ${expired.length}`);
    expired.forEach((company) => console.log(`- ${company.id} ${company.name} vence=${company.license_ends_at || company.active_until || '-'}`));
    console.log(`Empresas proximas a vencer: ${expiring.length}`);
    expiring.forEach((company) => console.log(`- ${company.id} ${company.name} vence=${company.license_ends_at || company.active_until || '-'}`));
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('licenses:check failed.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
