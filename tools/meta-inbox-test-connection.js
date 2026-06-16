require('dotenv').config();

const { getUserPages, getGraphVersion } = require('../src/modules/meta-inbox/meta-graph');

async function main() {
  const token = process.argv[2] || process.env.META_TEST_TOKEN || process.env.META_ACCESS_TOKEN || '';
  if (!token) {
    console.error('Falta token. Usa META_TEST_TOKEN o pasa el token como argumento.');
    process.exitCode = 1;
    return;
  }
  console.log(`Probando Meta Graph API ${getGraphVersion()}...`);
  const result = await getUserPages(token);
  const pages = Array.isArray(result.data) ? result.data : [];
  console.log(`Paginas detectadas: ${pages.length}`);
  pages.forEach((page) => {
    const perms = Array.isArray(page.perms) ? page.perms.join(',') : '';
    const tasks = Array.isArray(page.tasks) ? page.tasks.join(',') : '';
    console.log(`- ${page.name || '(sin nombre)'} [${page.id}] ${perms || tasks}`);
  });
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
