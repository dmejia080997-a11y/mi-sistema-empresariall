const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
const CATALOG_PATH = path.join(__dirname, '..', 'data', 'cuscar-catalogs.json');

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeString(value) {
  if (!value) return null;
  return String(value).trim();
}

function normalizeEntry(entry, index, fallbackSource) {
  if (!entry || typeof entry !== 'object') return null;
  const code = normalizeString(entry.code);
  const name = normalizeString(entry.name);
  if (!code || !name) return null;
  const description = normalizeString(entry.description);
  const isActive = entry.is_active === undefined || entry.is_active === null ? 1 : Number(entry.is_active) ? 1 : 0;
  const sortOrderRaw = entry.sort_order !== undefined && entry.sort_order !== null ? Number(entry.sort_order) : null;
  const sortOrder = Number.isFinite(sortOrderRaw) ? sortOrderRaw : index + 1;
  const source = normalizeString(entry.source) || fallbackSource || 'SAT';
  return { code, name, description, is_active: isActive, sort_order: sortOrder, source };
}

const CATALOGS = [
  { type: 'countries', table: 'cuscar_countries', scope: 'global' },
  { type: 'customs_offices', table: 'cuscar_customs_offices', scope: 'global' },
  { type: 'airports', table: 'cuscar_airports', scope: 'global' },
  { type: 'ports', table: 'cuscar_ports', scope: 'global' },
  { type: 'transport_modes', table: 'cuscar_transport_modes', scope: 'global' },
  { type: 'transport_means', table: 'cuscar_transport_means', scope: 'global' },
  { type: 'message_types', table: 'cuscar_message_types', scope: 'global' },
  { type: 'message_functions', table: 'cuscar_message_functions', scope: 'global' },
  { type: 'reference_qualifiers', table: 'cuscar_reference_qualifiers', scope: 'global' },
  { type: 'message_responsibles', table: 'cuscar_message_responsibles', scope: 'global' },
  { type: 'transport_id_agencies', table: 'cuscar_transport_id_agencies', scope: 'global' },
  { type: 'package_types', table: 'cuscar_package_types', scope: 'global' },
  { type: 'units', table: 'cuscar_units', scope: 'global' },
  { type: 'airlines', table: 'cuscar_airlines', scope: 'global' },
  { type: 'transporters', table: 'cuscar_transporters', scope: 'company' }
];

if (!fs.existsSync(CATALOG_PATH)) {
  console.error('[cuscar] Falta data/cuscar-catalogs.json');
  process.exit(1);
}

const seedData = readJson(CATALOG_PATH);
const db = new sqlite3.Database(DB_PATH);

function seedCatalogRows(catalog, rows, companyId, done) {
  let pending = rows.length;
  if (!pending) return done();
  rows.forEach((row, index) => {
    const fallbackSource = catalog.scope === 'company' ? 'BASE' : 'SAT';
    const normalized = normalizeEntry(row, index, fallbackSource);
    if (!normalized) {
      pending -= 1;
      if (pending <= 0) done();
      return;
    }
    db.get(
      `SELECT id FROM ${catalog.table} WHERE company_id = ? AND code = ? LIMIT 1`,
      [companyId, normalized.code],
      (lookupErr, existing) => {
        if (existing && existing.id) {
          db.run(
            `UPDATE ${catalog.table}
             SET name = ?, description = ?, is_active = ?, source = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              normalized.name,
              normalized.description || null,
              normalized.is_active,
              normalized.source,
              normalized.sort_order,
              existing.id
            ],
            () => {
              pending -= 1;
              if (pending <= 0) done();
            }
          );
          return;
        }
        db.run(
          `INSERT INTO ${catalog.table}
           (company_id, code, name, description, is_active, source, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            companyId,
            normalized.code,
            normalized.name,
            normalized.description || null,
            normalized.is_active,
            normalized.source,
            normalized.sort_order
          ],
          () => {
            pending -= 1;
            if (pending <= 0) done();
          }
        );
      }
    );
  });
}

function seedAll() {
  db.all('SELECT id FROM companies', (err, companies) => {
    const companyIds = err ? [] : (companies || []).map((row) => row.id).filter((id) => Number.isInteger(id));
    let pendingCatalogs = CATALOGS.length;
    const finish = () => {
      pendingCatalogs -= 1;
      if (pendingCatalogs <= 0) {
        console.log('[cuscar] Catalogos base cargados.');
        db.close();
      }
    };
    CATALOGS.forEach((catalog) => {
      const rows = Array.isArray(seedData[catalog.type]) ? seedData[catalog.type] : [];
      if (!rows.length) {
        finish();
        return;
      }
      if (catalog.scope === 'company') {
        let pendingCompanies = companyIds.length || 0;
        if (!pendingCompanies) {
          finish();
          return;
        }
        companyIds.forEach((companyId) => {
          seedCatalogRows(catalog, rows, companyId, () => {
            pendingCompanies -= 1;
            if (pendingCompanies <= 0) finish();
          });
        });
        return;
      }
      seedCatalogRows(catalog, rows, 0, finish);
    });
  });
}

seedAll();
