const sqlite3 = require('sqlite3').verbose();
const { ensureSupplierSchema } = require('../src/modules/suppliers/routes');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function done(error) {
  if (error) reject(error);
  else resolve({ lastID: this.lastID, changes: this.changes });
}));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

async function main() {
  await run('CREATE TABLE permission_modules (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT, description TEXT)');
  await run('CREATE TABLE permission_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT, description TEXT)');
  await run('CREATE TABLE module_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, module_id INTEGER, action_id INTEGER, UNIQUE(module_id, action_id))');
  await run(`INSERT INTO permission_actions (code, name) VALUES
    ('view','Ver'),('create','Crear'),('edit','Editar'),('delete','Eliminar'),('approve','Aprobar'),('block','Bloquear'),
    ('view_fiscal','Fiscal'),('manage_bank','Bancos'),('evaluate','Evaluar'),('purchase','Compras'),('reports','Reportes')`);
  await ensureSupplierSchema(db);

  const requiredTables = ['suppliers', 'supplier_contacts', 'supplier_bank_accounts', 'supplier_documents', 'supplier_commercial_terms', 'supplier_evaluations', 'supplier_products', 'supplier_audit_logs'];
  for (const table of requiredTables) {
    const columns = await all(`PRAGMA table_info(${table})`);
    const names = new Set(columns.map((column) => column.name));
    for (const required of ['id', 'company_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'status']) {
      if (!names.has(required)) throw new Error(`${table} missing ${required}`);
    }
  }

  await run("INSERT INTO suppliers (company_id, code, trade_name, supplier_type, status) VALUES (1, 'PROV-000001', 'Empresa uno', 'national', 'active')");
  await run("INSERT INTO suppliers (company_id, code, trade_name, supplier_type, status) VALUES (2, 'PROV-000001', 'Empresa dos', 'international', 'active')");
  const companyOneRows = await all('SELECT * FROM suppliers WHERE company_id = ?', [1]);
  const crossCompany = await get('SELECT * FROM suppliers WHERE id = ? AND company_id = ?', [companyOneRows[0].id, 2]);
  if (companyOneRows.length !== 1 || companyOneRows[0].trade_name !== 'Empresa uno' || crossCompany) {
    throw new Error('company_id isolation failed');
  }
  console.log('[suppliers-selfcheck] schema and company isolation OK');
}

main()
  .then(() => db.close())
  .catch((error) => {
    console.error('[suppliers-selfcheck]', error);
    db.close(() => process.exit(1));
  });
