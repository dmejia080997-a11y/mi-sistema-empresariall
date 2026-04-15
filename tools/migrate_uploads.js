const fs = require('fs/promises');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..');
const OLD_ROOT = path.join(ROOT, 'public', 'uploads', 'packages');
const NEW_ROOT = path.join(ROOT, 'data', 'uploads', 'packages');
const DB_PATH = path.join(ROOT, 'data', 'app.db');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function moveFiles(src, dest) {
  let entries = [];
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }

  await ensureDir(dest);
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await moveFiles(srcPath, destPath);
      continue;
    }
    await ensureDir(path.dirname(destPath));
    try {
      await fs.rename(srcPath, destPath);
    } catch (err) {
      if (err && err.code === 'EXDEV') {
        await fs.copyFile(srcPath, destPath);
        await fs.unlink(srcPath);
      } else {
        throw err;
      }
    }
  }
}

function normalizeStoredPath(value) {
  if (!value || typeof value !== 'string') return value;
  let s = value.trim().replace(/\\/g, '/');

  if (s.startsWith('/files/') || s.startsWith('files/')) return s;

  const markers = [
    '/public/uploads/packages/',
    'public/uploads/packages/',
    '/uploads/packages/',
    'uploads/packages/',
    '/data/uploads/packages/',
    'data/uploads/packages/',
    '/data/uploads/',
    'data/uploads/',
  ];

  for (const marker of markers) {
    const idx = s.indexOf(marker);
    if (idx !== -1) {
      s = s.slice(idx + marker.length);
      break;
    }
  }

  if (s.startsWith('/')) s = s.slice(1);
  if (!s.startsWith('packages/')) {
    if (s.startsWith('invoices/') || s.startsWith('photos/')) {
      s = `packages/${s}`;
    }
  }
  return s;
}

function runQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function allQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function migrateDbPaths() {
  const db = new sqlite3.Database(DB_PATH);
  try {
    await runQuery(db, 'BEGIN');

    const packages = await allQuery(db, 'SELECT id, invoice_file FROM packages');
    let packageUpdates = 0;
    for (const row of packages) {
      const nextValue = normalizeStoredPath(row.invoice_file);
      if (nextValue && nextValue !== row.invoice_file) {
        await runQuery(db, 'UPDATE packages SET invoice_file = ? WHERE id = ?', [
          nextValue,
          row.id,
        ]);
        packageUpdates += 1;
      }
    }

    const photos = await allQuery(db, 'SELECT id, file_path FROM package_photos');
    let photoUpdates = 0;
    for (const row of photos) {
      const nextValue = normalizeStoredPath(row.file_path);
      if (nextValue && nextValue !== row.file_path) {
        await runQuery(db, 'UPDATE package_photos SET file_path = ? WHERE id = ?', [
          nextValue,
          row.id,
        ]);
        photoUpdates += 1;
      }
    }

    await runQuery(db, 'COMMIT');
    return { packageUpdates, photoUpdates };
  } catch (err) {
    await runQuery(db, 'ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}

async function main() {
  await ensureDir(NEW_ROOT);
  await moveFiles(OLD_ROOT, NEW_ROOT);
  const result = await migrateDbPaths();
  console.log(`Migrated uploads. Packages updated: ${result.packageUpdates}. Photos updated: ${result.photoUpdates}.`);
}

main().catch((err) => {
  console.error('Upload migration failed:', err);
  process.exit(1);
});
