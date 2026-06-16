const sqlite3 = require('sqlite3').verbose();
const { createAccountingAutomation } = require('../src/services/accounting-automation');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function done(error) {
  error ? reject(error) : resolve({ lastID: this.lastID, changes: this.changes });
}));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));

async function main() {
  await run('CREATE TABLE chart_of_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, code TEXT, name TEXT, type TEXT, subtype TEXT, is_active INTEGER)');
  await run('CREATE TABLE companies (id INTEGER PRIMARY KEY, base_currency TEXT, currency TEXT, accounting_framework TEXT)');
  await run("INSERT INTO companies VALUES (1, 'GTQ', 'GTQ', 'NIF')");
  await run('CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, code TEXT, name TEXT, type TEXT, level INTEGER, subtype TEXT, framework TEXT, is_active INTEGER, created_at TEXT)');
  await run('CREATE TABLE journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, entry_date TEXT, description TEXT, memo TEXT, source_type TEXT, source_id INTEGER, status TEXT, created_at TEXT)');
  await run('CREATE TABLE journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, company_id INTEGER, account_id INTEGER, debit REAL, credit REAL, amount_base REAL, created_at TEXT)');
  await run('CREATE TABLE journal_details (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, company_id INTEGER, account_id INTEGER, line_memo TEXT, debit REAL, credit REAL, currency TEXT, exchange_rate REAL, debit_base REAL, credit_base REAL, created_at TEXT)');
  await run('CREATE TABLE invoice_headers (id INTEGER PRIMARY KEY, company_id INTEGER, invoice_number TEXT, source TEXT, invoice_type TEXT, status TEXT, issue_date TEXT, created_at TEXT, total REAL, total_base REAL, tax_total REAL, tax_amount_base REAL)');
  await run('CREATE TABLE invoice_payments (id INTEGER PRIMARY KEY, company_id INTEGER, invoice_id INTEGER, invoice_header_id INTEGER, amount REAL, amount_base REAL, paid_at TEXT, created_at TEXT)');
  await run('CREATE TABLE bills (id INTEGER PRIMARY KEY, company_id INTEGER, vendor_name TEXT, status TEXT, subtotal REAL, subtotal_base REAL, tax_amount REAL, tax_amount_base REAL, total REAL, total_base REAL, created_at TEXT)');
  await run('CREATE TABLE bill_payments (id INTEGER PRIMARY KEY, company_id INTEGER, bill_id INTEGER, amount REAL, amount_base REAL, paid_at TEXT, created_at TEXT)');
  await run("INSERT INTO invoice_headers VALUES (1,1,'FAC-1','services','standard','issued','2026-06-04','2026-06-04',112,112,12,12)");
  await run("INSERT INTO invoice_payments VALUES (1,1,1,1,112,112,'2026-06-04','2026-06-04')");
  await run("INSERT INTO bills (id,company_id,vendor_name,status,subtotal,subtotal_base,tax_amount,tax_amount_base,total,total_base,created_at) VALUES (1,1,'Proveedor','pending',100,100,12,12,112,112,'2026-06-04')");
  await run("INSERT INTO bill_payments VALUES (1,1,1,112,112,'2026-06-04','2026-06-04')");
  const automation = createAccountingAutomation(db);
  await automation.ready;
  await run("INSERT INTO hr_payroll_payments (company_id,salary_id,employee_id,period,gross_amount,deductions,net_amount,paid_at,status) VALUES (1,1,1,'2026-06',1000,50,950,'2026-06-04','paid')");
  await automation.syncCompany(1);
  await automation.syncCompany(1);
  const entries = await get('SELECT COUNT(*) AS total FROM journal_entries');
  const events = await get('SELECT COUNT(*) AS total FROM accounting_automation_events');
  const imbalance = await get(`SELECT COUNT(*) AS total FROM (
    SELECT entry_id, ROUND(SUM(debit), 2) AS total_debit, ROUND(SUM(credit), 2) AS total_credit FROM journal_lines GROUP BY entry_id
  ) WHERE ABS(total_debit-total_credit) > 0.01`);
  const mirrored = await get('SELECT COUNT(DISTINCT entry_id) AS total FROM journal_details');
  if (entries.total !== 5 || events.total !== 5 || imbalance.total !== 0 || mirrored.total !== 5) throw new Error(`unexpected totals entries=${entries.total} events=${events.total} imbalance=${imbalance.total} mirrored=${mirrored.total}`);
  console.log('[accounting-automation-selfcheck] automatic accounts, entries and idempotency OK');
}

main().then(() => db.close()).catch((error) => {
  console.error('[accounting-automation-selfcheck]', error);
  db.close(() => process.exit(1));
});
