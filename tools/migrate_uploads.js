const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { LEGACY_UPLOADS_DIR, STORAGE_UPLOADS_DIR } = require('../src/core/storage-paths');

const stats = {
  copied: 0,
  skipped: 0,
  errors: 0
};

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch (err) {
    return false;
  }
}

async function copyFilePreservingTimes(srcPath, destPath) {
  const relative = path.relative(LEGACY_UPLOADS_DIR, srcPath).replace(/\\/g, '/');
  try {
    if (await exists(destPath)) {
      stats.skipped += 1;
      console.log(`SKIP existing: ${relative}`);
      return;
    }

    await ensureDir(path.dirname(destPath));
    await fsp.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL);

    try {
      const sourceStat = await fsp.stat(srcPath);
      await fsp.utimes(destPath, sourceStat.atime, sourceStat.mtime);
    } catch (timeErr) {
      console.warn(`WARN could not preserve timestamps: ${relative} (${timeErr.message})`);
    }

    stats.copied += 1;
    console.log(`COPY ${relative}`);
  } catch (err) {
    stats.errors += 1;
    console.error(`ERROR ${relative}: ${err.message}`);
  }
}

async function copyTree(src, dest) {
  let entries = [];
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.log(`Source uploads directory does not exist: ${src}`);
      return;
    }
    throw err;
  }

  await ensureDir(dest);
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath);
      continue;
    }
    if (entry.isFile()) {
      await copyFilePreservingTimes(srcPath, destPath);
      continue;
    }
    stats.skipped += 1;
    console.log(`SKIP non-file: ${path.relative(LEGACY_UPLOADS_DIR, srcPath).replace(/\\/g, '/')}`);
  }
}

async function main() {
  console.log(`Migrating uploads from ${LEGACY_UPLOADS_DIR}`);
  console.log(`Migrating uploads to   ${STORAGE_UPLOADS_DIR}`);

  await ensureDir(STORAGE_UPLOADS_DIR);
  await copyTree(LEGACY_UPLOADS_DIR, STORAGE_UPLOADS_DIR);

  console.log('Upload migration finished.');
  console.log(`Files copied: ${stats.copied}`);
  console.log(`Files skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.errors}`);

  if (stats.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Upload migration failed:', err);
  process.exit(1);
});
