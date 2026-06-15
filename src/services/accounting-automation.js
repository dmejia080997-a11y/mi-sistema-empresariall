const DEFAULT_ACCOUNTS = [
  ['1000', 'Caja y bancos', 'asset', 'cash'],
  ['1100', 'Cuentas por cobrar', 'asset', 'receivable'],
  ['1180', 'IVA credito fiscal', 'asset', 'tax_credit'],
  ['2000', 'Cuentas por pagar', 'liability', 'payable'],
  ['2050', 'Deducciones de planilla por pagar', 'liability', 'payroll_deductions'],
  ['2100', 'IVA por pagar', 'liability', 'tax'],
  ['4000', 'Ingresos por ventas', 'income', 'revenue'],
  ['5000', 'Costo de ventas', 'expense', 'cogs'],
  ['5200', 'Sueldos y salarios', 'expense', 'payroll']
];

function createAccountingAutomation(db) {
  let queue = Promise.resolve();
  const ready = ensureSchema(db);

  function syncCompany(companyId) {
    const id = Number(companyId);
    if (!Number.isInteger(id) || id <= 0) return Promise.resolve();
    queue = queue.then(() => ready).then(() => reconcileCompany(db, id)).catch((error) => {
      console.error('[accounting-automation] sync failed', { companyId: id, error });
    });
    return queue;
  }

  return { ready, syncCompany };
}

async function ensureSchema(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS accounting_automation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, event_type TEXT NOT NULL, source_id INTEGER NOT NULL,
    journal_entry_id INTEGER, status TEXT NOT NULL DEFAULT 'posted', details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, event_type, source_id)
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS accounting_auto_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, direction TEXT NOT NULL, category_key TEXT NOT NULL,
    account_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(company_id, direction, category_key)
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS accounting_account_mirrors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, chart_account_id INTEGER NOT NULL, nif_account_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(company_id, chart_account_id), UNIQUE(company_id, nif_account_id)
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS hr_payroll_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, salary_id INTEGER NOT NULL, employee_id INTEGER NOT NULL,
    period TEXT NOT NULL, gross_amount REAL NOT NULL DEFAULT 0, deductions REAL NOT NULL DEFAULT 0, net_amount REAL NOT NULL DEFAULT 0,
    payment_method TEXT, paid_at TEXT NOT NULL, notes TEXT, status TEXT NOT NULL DEFAULT 'paid', created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, salary_id, period)
  )`);
  await ensureColumn(db, 'bills', 'accounting_category', 'TEXT');
  await ensureColumn(db, 'bills', 'supplier_id', 'INTEGER');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_accounting_automation_company ON accounting_automation_events (company_id, event_type)');
}

async function reconcileCompany(db, companyId) {
  await ensureColumn(db, 'bills', 'accounting_category', 'TEXT');
  await ensureColumn(db, 'bills', 'supplier_id', 'INTEGER');
  await ensureBaseAccounts(db, companyId);
  await createBillsFromProjectExpenses(db, companyId);
  await postInvoices(db, companyId);
  await postReversals(db, companyId, 'invoice_issued', 'invoice_voided', 'invoice_headers', ['voided', 'cancelled']);
  await postInvoicePayments(db, companyId);
  await postBills(db, companyId);
  await postReversals(db, companyId, 'bill_received', 'bill_voided', 'bills', ['voided', 'cancelled']);
  await postBillPayments(db, companyId);
  await postPayroll(db, companyId);
  await backfillNifJournalDetails(db, companyId);
}

async function createBillsFromProjectExpenses(db, companyId) {
  const exists = await tableExists(db, 'project_expenses');
  if (!exists) return;
  const expenses = await all(db, `SELECT pe.*, s.trade_name AS supplier_name
    FROM project_expenses pe LEFT JOIN suppliers s ON s.id = pe.supplier_id AND s.company_id = pe.company_id
    WHERE pe.company_id = ? AND pe.accounting_bill_id IS NULL AND COALESCE(pe.is_estimated, 0) = 0`, [companyId]);
  for (const expense of expenses) {
    const subtotal = amount(expense.amount);
    const tax = amount(expense.tax_amount);
    const total = amount(expense.total_amount) > 0 ? amount(expense.total_amount) : round2(subtotal + tax);
    const insert = await run(db, `INSERT INTO bills
      (vendor_name, supplier_id, accounting_category, subtotal, tax_rate, tax_amount, total, currency, exchange_rate,
       subtotal_base, tax_amount_base, total_base, status, company_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'GTQ', 1, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)`, [
      expense.supplier_name || `Gasto de proyecto ${expense.project_id}`,
      expense.supplier_id || null,
      expense.category || 'Gastos de proyectos',
      subtotal,
      subtotal > 0 ? round2((tax / subtotal) * 100) : 0,
      tax,
      total,
      subtotal,
      tax,
      total,
      companyId
    ]);
    await run(db, `UPDATE project_expenses SET accounting_bill_id = ?, accounting_status = 'sent', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND company_id = ? AND accounting_bill_id IS NULL`, [insert.lastID, expense.id, companyId]);
  }
}

async function postInvoices(db, companyId) {
  const rows = await all(db, `SELECT * FROM invoice_headers
    WHERE company_id = ? AND status NOT IN ('draft', 'voided', 'cancelled')`, [companyId]);
  for (const row of rows) {
    const revenue = await dynamicAccount(db, companyId, 'income', row.source || row.invoice_type || 'ventas');
    const subtotal = baseAmount(row.subtotal_base, row.subtotal, row.exchange_rate);
    const tax = baseAmount(row.tax_amount_base, row.tax_total, row.exchange_rate);
    const discount = baseAmount(row.discount_amount_base, row.discount_total, row.exchange_rate);
    const total = baseTotal(row.total_base, row.total, row.exchange_rate, subtotal + tax - discount);
    await postEvent(db, companyId, 'invoice_issued', row.id, row.issue_date || row.created_at, `Factura ${row.invoice_number || row.id}`, [
      line('1100', total, 0),
      line(revenue, 0, Math.max(0, total - tax)),
      line('2100', 0, tax)
    ]);
  }
}

async function postInvoicePayments(db, companyId) {
  if (!await tableExists(db, 'invoice_payments')) return;
  const rows = await all(db, 'SELECT * FROM invoice_payments WHERE company_id = ?', [companyId]);
  for (const row of rows) {
    const paid = baseAmount(row.amount_base, row.amount, row.exchange_rate);
    await postEvent(db, companyId, 'invoice_payment', row.id, row.paid_at || row.created_at, `Cobro de factura ${row.invoice_header_id || row.invoice_id}`, [
      line('1000', paid, 0),
      line('1100', 0, paid)
    ]);
  }
}

async function postBills(db, companyId) {
  const rows = await all(db, `SELECT * FROM bills WHERE company_id = ? AND status NOT IN ('voided', 'cancelled')`, [companyId]);
  for (const row of rows) {
    const expense = await dynamicAccount(db, companyId, 'expense', row.accounting_category || 'Gastos generales');
    const subtotal = baseAmount(row.subtotal_base, row.subtotal, row.exchange_rate);
    const tax = baseAmount(row.tax_amount_base, row.tax_amount, row.exchange_rate);
    const total = baseTotal(row.total_base, row.total, row.exchange_rate, subtotal + tax);
    await postEvent(db, companyId, 'bill_received', row.id, row.created_at, `Cuenta por pagar: ${row.vendor_name || row.id}`, [
      line(expense, subtotal, 0),
      line('1180', tax, 0),
      line('2000', 0, total)
    ]);
  }
}

async function postBillPayments(db, companyId) {
  if (!await tableExists(db, 'bill_payments')) return;
  const rows = await all(db, 'SELECT * FROM bill_payments WHERE company_id = ?', [companyId]);
  for (const row of rows) {
    const paid = baseAmount(row.amount_base, row.amount, row.exchange_rate);
    await postEvent(db, companyId, 'bill_payment', row.id, row.paid_at || row.created_at, `Pago de cuenta por pagar ${row.bill_id}`, [
      line('2000', paid, 0),
      line('1000', 0, paid)
    ]);
  }
}

async function postPayroll(db, companyId) {
  const rows = await all(db, 'SELECT * FROM hr_payroll_payments WHERE company_id = ? AND status = ?', [companyId, 'paid']);
  for (const row of rows) {
    await postEvent(db, companyId, 'payroll_payment', row.id, row.paid_at || row.created_at, `Pago de planilla ${row.period}`, [
      line('5200', amount(row.gross_amount), 0),
      line('2050', 0, amount(row.deductions)),
      line('1000', 0, amount(row.net_amount))
    ]);
  }
}

async function postReversals(db, companyId, originalType, reversalType, table, statuses) {
  const placeholders = statuses.map(() => '?').join(',');
  const rows = await all(db, `SELECT source.id, event.journal_entry_id
    FROM ${table} source
    JOIN accounting_automation_events event ON event.company_id = source.company_id AND event.event_type = ? AND event.source_id = source.id
    WHERE source.company_id = ? AND source.status IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM accounting_automation_events reversal WHERE reversal.company_id = source.company_id AND reversal.event_type = ? AND reversal.source_id = source.id)`,
  [originalType, companyId, ...statuses, reversalType]);
  for (const row of rows) {
    const originalLines = await all(db, 'SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = ? AND company_id = ?', [row.journal_entry_id, companyId]);
    await postEvent(db, companyId, reversalType, row.id, new Date().toISOString(), `Reversion automatica de ${originalType} ${row.id}`,
      originalLines.map((entry) => line(entry.account_id, amount(entry.credit), amount(entry.debit))));
  }
}

async function postEvent(db, companyId, eventType, sourceId, entryDate, memo, rawLines) {
  if (await get(db, 'SELECT id FROM accounting_automation_events WHERE company_id = ? AND event_type = ? AND source_id = ?', [companyId, eventType, sourceId])) return;
  const lines = rawLines.filter((entry) => entry.debit > 0 || entry.credit > 0);
  const debit = round2(lines.reduce((sum, entry) => sum + entry.debit, 0));
  const credit = round2(lines.reduce((sum, entry) => sum + entry.credit, 0));
  if (!lines.length || Math.abs(debit - credit) > 0.01) throw new Error(`Unbalanced automatic entry ${eventType}:${sourceId}`);
  const resolved = [];
  for (const entry of lines) {
    const account = typeof entry.account === 'number' ? entry.account : await accountId(db, companyId, entry.account);
    resolved.push({ ...entry, account });
  }
  const insert = await run(db, `INSERT INTO journal_entries
    (company_id, entry_date, description, memo, source_type, source_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'posted', CURRENT_TIMESTAMP)`, [companyId, entryDate || new Date().toISOString(), memo, memo, eventType, sourceId]);
  for (const entry of resolved) {
    await run(db, `INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, amount_base, created_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [insert.lastID, companyId, entry.account, entry.debit, entry.credit, Math.max(entry.debit, entry.credit)]);
  }
  await mirrorEntryToNif(db, companyId, insert.lastID);
  await run(db, `INSERT INTO accounting_automation_events (company_id, event_type, source_id, journal_entry_id, details)
    VALUES (?, ?, ?, ?, ?)`, [companyId, eventType, sourceId, insert.lastID, JSON.stringify({ memo, debit, credit })]);
}

async function ensureBaseAccounts(db, companyId) {
  for (const account of DEFAULT_ACCOUNTS) await ensureAccount(db, companyId, ...account);
}

async function backfillNifJournalDetails(db, companyId) {
  if (!await tableExists(db, 'accounts') || !await tableExists(db, 'journal_details')) return;
  const entries = await all(db, `SELECT DISTINCT event.journal_entry_id
    FROM accounting_automation_events event
    WHERE event.company_id = ? AND event.journal_entry_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM journal_details jd WHERE jd.entry_id = event.journal_entry_id AND jd.company_id = event.company_id)`, [companyId]);
  for (const entry of entries) await mirrorEntryToNif(db, companyId, entry.journal_entry_id);
}

async function mirrorEntryToNif(db, companyId, entryId) {
  if (!await tableExists(db, 'accounts') || !await tableExists(db, 'journal_details')) return;
  if (await get(db, 'SELECT id FROM journal_details WHERE entry_id = ? AND company_id = ? LIMIT 1', [entryId, companyId])) return;
  const company = await get(db, 'SELECT base_currency, currency, accounting_framework FROM companies WHERE id = ?', [companyId]);
  const currency = String(company && (company.base_currency || company.currency) || 'GTQ').toUpperCase();
  const lines = await all(db, 'SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = ? AND company_id = ?', [entryId, companyId]);
  for (const entry of lines) {
    const nifAccountId = await ensureNifMirror(db, companyId, entry.account_id, company && company.accounting_framework);
    await run(db, `INSERT INTO journal_details
      (entry_id, company_id, account_id, line_memo, debit, credit, currency, exchange_rate, debit_base, credit_base, created_at)
      VALUES (?, ?, ?, 'Generado automaticamente', ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)`,
    [entryId, companyId, nifAccountId, amount(entry.debit), amount(entry.credit), currency, amount(entry.debit), amount(entry.credit)]);
  }
}

async function ensureNifMirror(db, companyId, chartAccountId, frameworkValue) {
  const mapping = await get(db, 'SELECT nif_account_id FROM accounting_account_mirrors WHERE company_id = ? AND chart_account_id = ?', [companyId, chartAccountId]);
  if (mapping) return mapping.nif_account_id;
  const chart = await get(db, 'SELECT * FROM chart_of_accounts WHERE id = ? AND company_id = ?', [chartAccountId, companyId]);
  if (!chart) throw new Error(`Missing chart account ${chartAccountId}`);
  const framework = String(frameworkValue || 'NIF').toUpperCase();
  const code = `AUTO-${chart.code}`;
  let account = await get(db, 'SELECT id FROM accounts WHERE company_id = ? AND code = ? AND (framework = ? OR framework IS NULL)', [companyId, code, framework]);
  if (!account) {
    const type = chart.type === 'asset' ? 'ACTIVO' : chart.type === 'liability' ? 'PASIVO' : chart.type === 'equity' ? 'CAPITAL' : chart.type === 'income' ? 'INGRESO' : 'GASTO';
    const insert = await run(db, `INSERT INTO accounts
      (company_id, code, name, type, level, subtype, framework, is_active, created_at)
      VALUES (?, ?, ?, ?, 4, ?, ?, 1, CURRENT_TIMESTAMP)`, [companyId, code, chart.name, type, chart.subtype || null, framework]);
    account = { id: insert.lastID };
  }
  await run(db, 'INSERT OR IGNORE INTO accounting_account_mirrors (company_id, chart_account_id, nif_account_id) VALUES (?, ?, ?)', [companyId, chartAccountId, account.id]);
  return account.id;
}
async function ensureAccount(db, companyId, code, name, type, subtype) {
  const existing = await get(db, 'SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = ?', [companyId, code]);
  if (existing) return existing.id;
  const insert = await run(db, 'INSERT INTO chart_of_accounts (company_id, code, name, type, subtype, is_active) VALUES (?, ?, ?, ?, ?, 1)', [companyId, code, name, type, subtype]);
  return insert.lastID;
}
async function accountId(db, companyId, code) {
  const definition = DEFAULT_ACCOUNTS.find((entry) => entry[0] === code);
  return definition ? ensureAccount(db, companyId, ...definition) : null;
}
async function dynamicAccount(db, companyId, direction, category) {
  const key = slug(category) || (direction === 'income' ? 'ingresos' : 'gastos');
  const mapping = await get(db, 'SELECT account_id FROM accounting_auto_accounts WHERE company_id = ? AND direction = ? AND category_key = ?', [companyId, direction, key]);
  if (mapping) return mapping.account_id;
  const prefix = direction === 'income' ? 419000 : 519000;
  const count = await get(db, 'SELECT COUNT(*) AS total FROM accounting_auto_accounts WHERE company_id = ? AND direction = ?', [companyId, direction]);
  let offset = Number(count && count.total || 0) + 1;
  let code = String(prefix + offset);
  while (await get(db, 'SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = ?', [companyId, code])) {
    offset += 1;
    code = String(prefix + offset);
  }
  const account = await ensureAccount(db, companyId, code, `${direction === 'income' ? 'Ingresos' : 'Gastos'} - ${String(category || key)}`, direction, `automatic_${key}`);
  await run(db, 'INSERT OR IGNORE INTO accounting_auto_accounts (company_id, direction, category_key, account_id) VALUES (?, ?, ?, ?)', [companyId, direction, key, account]);
  return account;
}
async function ensureColumn(db, table, column, type) {
  if (!await tableExists(db, table)) return;
  const columns = await all(db, `PRAGMA table_info(${table})`);
  if (!columns.some((entry) => entry.name === column)) await run(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
async function tableExists(db, table) { return Boolean(await get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])); }
function line(account, debit, credit) { return { account, debit: round2(debit), credit: round2(credit) }; }
function amount(value) { const number = Number(value); return Number.isFinite(number) ? round2(number) : 0; }
function baseAmount(baseValue, transactionValue, exchangeRate) {
  const base = amount(baseValue);
  if (base > 0) return base;
  return round2(amount(transactionValue) * (amount(exchangeRate) || 1));
}
function baseTotal(baseValue, transactionValue, exchangeRate, fallback) {
  const base = amount(baseValue);
  if (base > 0) return base;
  const transaction = amount(transactionValue);
  if (transaction > 0) return round2(transaction * (amount(exchangeRate) || 1));
  return round2(Math.max(0, amount(fallback)));
}
function round2(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function slug(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function done(error) { error ? reject(error) : resolve({ lastID: this.lastID, changes: this.changes }); })); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null))); }
function all(db, sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []))); }

module.exports = { createAccountingAutomation };
