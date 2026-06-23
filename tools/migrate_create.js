const fs = require('fs');
const path = require('path');
const {
  MASTER_MIGRATIONS_DIR,
  TENANT_MIGRATIONS_DIR
} = require('../src/services/migration-service');

function timestamp() {
  const date = new Date();
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ];
  return parts.join('');
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function template(scope, name) {
  return [
    `-- Migracion ${scope}: ${name}`,
    '-- Use solamente operaciones seguras e idempotentes.',
    '-- Ejemplo: ALTER TABLE tabla ADD COLUMN IF NOT EXISTS campo TEXT;',
    '',
    ''
  ].join('\n');
}

function createFile(directory, filename, content) {
  fs.mkdirSync(directory, { recursive: true });
  const fullPath = path.join(directory, filename);
  fs.writeFileSync(fullPath, content, { encoding: 'utf8', flag: 'wx' });
  return fullPath;
}

function main() {
  const name = normalizeName(process.argv.slice(2).join('_'));
  if (!name) {
    throw new Error('Uso: npm run migrate:create -- nombre_de_migracion');
  }

  const filename = `${timestamp()}_${name}.sql`;
  const masterPath = createFile(
    MASTER_MIGRATIONS_DIR,
    filename,
    template('master', name)
  );

  try {
    const tenantPath = createFile(
      TENANT_MIGRATIONS_DIR,
      filename,
      template('tenant', name)
    );
    console.log(`Creada: ${masterPath}`);
    console.log(`Creada: ${tenantPath}`);
  } catch (error) {
    fs.unlinkSync(masterPath);
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
