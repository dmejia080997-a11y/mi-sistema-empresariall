const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const {
  ROOT_DIR,
  MASTER_DATABASE,
  TENANT_DATABASE,
  databaseUrlForName,
  maintenanceUrl,
  localConfig,
  poolFor,
  recreateDatabase,
  ensureLocalTenantRegistration,
  run,
  runNpm
} = require('./dev_database_common');

const BACKUP_DIR = path.join(ROOT_DIR, 'storage', 'backups', 'postgres');

function latestDumpSource() {
  if (process.env.DEV_DUMP_PATH) {
    const explicit = path.resolve(ROOT_DIR, process.env.DEV_DUMP_PATH);
    if (!fs.existsSync(explicit)) throw new Error(`DEV_DUMP_PATH no existe: ${explicit}`);
    return explicit;
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    throw new Error(`No existe ${BACKUP_DIR}. Configure DEV_DUMP_PATH.`);
  }
  const candidates = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /\.(sql|dump|tar\.gz|zip)$/i.test(name))
    .map((name) => {
      const filePath = path.join(BACKUP_DIR, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) throw new Error('No se encontro un dump PostgreSQL local.');
  return candidates[0].filePath;
}

function extractArchive(source, tempDir) {
  if (/\.tar\.gz$/i.test(source)) {
    run('tar', ['-xzf', source, '-C', tempDir]);
    return tempDir;
  }
  if (/\.zip$/i.test(source)) {
    run('unzip', ['-q', source, '-d', tempDir]);
    return tempDir;
  }
  return source;
}

function allFiles(root) {
  if (fs.statSync(root).isFile()) return [root];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(entryPath) : [entryPath];
  });
}

function selectDumps(sourceRoot) {
  if (fs.statSync(sourceRoot).isFile() && /\.(sql|dump)$/i.test(sourceRoot)) {
    throw new Error('El refresh requiere los dumps master y tenant, no un archivo individual.');
  }

  const files = allFiles(sourceRoot).filter((file) => /\.(sql|dump)$/i.test(file));
  if (!files.length) throw new Error('El backup no contiene archivos .sql o .dump.');

  const manifestPath = allFiles(sourceRoot)
    .find((file) => path.basename(file).toLowerCase() === 'manifest.json');
  if (manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entries = (manifest.databases || []).filter((item) => item && item.file && !item.error);
    const tenantSource = String(process.env.DEV_TENANT_SOURCE_DATABASE || '').trim();
    const tenantEntry = entries.find((item) => item.database === tenantSource)
      || entries.find((item) => /cf.*multi.*services/i.test(item.database))
      || entries[1];
    return {
      master: entries[0] ? path.resolve(path.dirname(manifestPath), entries[0].file) : files[0],
      tenant: tenantEntry ? path.resolve(path.dirname(manifestPath), tenantEntry.file) : null
    };
  }

  const tenant = files.find((file) => /cf.*multi.*services/i.test(path.basename(file)));
  const master = files.find((file) =>
    file !== tenant && /master|mi[_-]?sistema/i.test(path.basename(file))
  ) || files.find((file) => file !== tenant);
  return { master, tenant: tenant || files.find((file) => file !== master) || null };
}

function restoreFile(config, databaseName, dumpPath) {
  if (!dumpPath || !fs.existsSync(dumpPath)) {
    throw new Error(`Dump no encontrado para ${databaseName}.`);
  }
  const url = databaseUrlForName(config.url, databaseName);
  if (/\.sql$/i.test(dumpPath)) {
    run('psql', ['--dbname', url, '--set', 'ON_ERROR_STOP=1', '--file', dumpPath], {
      stdio: 'inherit'
    });
    return;
  }
  run(
    'pg_restore',
    ['--dbname', url, '--no-owner', '--no-privileges', '--exit-on-error', dumpPath],
    { stdio: 'inherit' }
  );
}

async function main() {
  const config = localConfig();
  const source = latestDumpSource();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-sistema-dev-refresh-'));
  try {
    const dumps = selectDumps(extractArchive(source, tempDir));
    if (!dumps.master || !dumps.tenant) {
      throw new Error('Se requiere un backup con dump master y dump tenant.');
    }

    const adminPool = new Pool({ connectionString: maintenanceUrl(config.url), ssl: false });
    try {
      await recreateDatabase(adminPool, MASTER_DATABASE);
      await recreateDatabase(adminPool, TENANT_DATABASE);
    } finally {
      await adminPool.end();
    }

    restoreFile(config, MASTER_DATABASE, dumps.master);
    restoreFile(config, TENANT_DATABASE, dumps.tenant);

    const masterPool = poolFor(config, MASTER_DATABASE);
    try {
      await ensureLocalTenantRegistration(masterPool, config);
    } finally {
      await masterPool.end();
    }

    console.log(`Dump importado: ${source}`);
    runNpm(['run', 'migrate:safe']);
    console.log('Entorno local actualizado.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`dev:refresh fallo: ${error.message}`);
  process.exit(1);
});
