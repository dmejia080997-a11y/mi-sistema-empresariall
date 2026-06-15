const STATUSES = [
  { key: 'active', label: 'Activa' },
  { key: 'recovered', label: 'Recuperada' },
  { key: 'overdue', label: 'Vencida' },
  { key: 'cancelled', label: 'Cancelada' }
];

function registerFloatingInvestmentRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    getCompanyId,
    setFlash,
    logAction
  } = deps;

  const schemaReady = ensureFloatingInvestmentSchema(db).catch((error) => {
    console.error('[floating-investments] schema initialization failed', error);
    throw error;
  });
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  const viewGuard = [
    requireAuth,
    requirePermission('floating_investments', 'view')
  ];
  const createGuard = [
    requireAuth,
    requirePermission('floating_investments', 'create')
  ];
  const editGuard = [
    requireAuth,
    requirePermission('floating_investments', 'edit')
  ];

  app.get('/floating-investments', viewGuard, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const filters = normalizeFilters(req.query);
    const where = ['fi.company_id = ?'];
    const params = [companyId];

    if (filters.q) {
      where.push(`(fi.provider LIKE ? OR fi.description LIKE ? OR c.name LIKE ? OR EXISTS (
        SELECT 1 FROM floating_investment_lines fil
        LEFT JOIN suppliers s ON s.id = fil.supplier_id AND s.company_id = fil.company_id
        WHERE fil.investment_id = fi.id
          AND fil.company_id = fi.company_id
          AND (fil.supplier_name LIKE ? OR s.trade_name LIKE ? OR fil.cost_center LIKE ? OR fil.description LIKE ?)
      ))`);
      const term = `%${filters.q}%`;
      params.push(term, term, term, term, term, term, term);
    }
    if (filters.status) {
      where.push('fi.status = ?');
      params.push(filters.status);
    }

    const investments = await allDb(db, `
      SELECT fi.*, c.name AS customer_name, c.customer_code,
             COUNT(fil.id) AS line_count,
             GROUP_CONCAT(DISTINCT COALESCE(s.trade_name, fil.supplier_name)) AS line_suppliers,
             GROUP_CONCAT(DISTINCT fil.cost_center) AS cost_centers,
             COALESCE(SUM(fil.investment_value), fi.investment_value, 0) AS line_investment_value,
             COALESCE(SUM(fil.expected_profit), fi.expected_profit, 0) AS line_expected_profit
      FROM floating_investments fi
      LEFT JOIN customers c ON c.id = fi.customer_id AND c.company_id = fi.company_id
      LEFT JOIN floating_investment_lines fil ON fil.investment_id = fi.id AND fil.company_id = fi.company_id
      LEFT JOIN suppliers s ON s.id = fil.supplier_id AND s.company_id = fil.company_id
      WHERE ${where.join(' AND ')}
      GROUP BY fi.id
      ORDER BY date(fi.recovery_date) ASC, fi.id DESC
    `, params);
    const summary = await getDb(db, `
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'recovered' THEN 1 ELSE 0 END) AS recovered,
             SUM(CASE WHEN status <> 'recovered' AND recovery_date < date('now') THEN 1 ELSE 0 END) AS overdue
      FROM floating_investments
      WHERE company_id = ?
    `, [companyId]);
    const currencySummaries = await allDb(db, `
      SELECT COALESCE(NULLIF(TRIM(currency), ''), 'GTQ') AS currency,
             COALESCE(SUM(investment_value), 0) AS invested,
             COALESCE(SUM(expected_profit), 0) AS expected_profit
      FROM floating_investments
      WHERE company_id = ?
      GROUP BY COALESCE(NULLIF(TRIM(currency), ''), 'GTQ')
      ORDER BY currency
    `, [companyId]);

    return res.render('floating-investments', viewLocals(res, {
      investments,
      summary: summary || {},
      currencySummaries,
      filters,
      statuses: STATUSES
    }));
  }));

  app.get('/floating-investments/new', createGuard, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const [customers, suppliers] = await Promise.all([
      getCustomers(db, companyId),
      getSuppliers(db, companyId)
    ]);
    return res.render('floating-investment-form', viewLocals(res, {
      investment: defaultInvestment(),
      lines: [defaultLine()],
      customers,
      suppliers,
      statuses: STATUSES,
      formAction: '/floating-investments/create',
      formTitle: 'Nueva inversion flotante'
    }));
  }));

  app.post('/floating-investments/create', createGuard, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getUserId(req);
    const data = normalizeInvestment(req.body);
    const lines = normalizeLines(req.body);
    const validation = validateInvestment(data, lines);
    if (validation) {
      setFlash(req, 'error', validation);
      return res.redirect('/floating-investments/new');
    }
    await assertCustomer(db, companyId, data.customer_id);
    await assertLineSuppliers(db, companyId, lines);
    const totals = lineTotals(lines);
    const providerSummary = summarizeProviders(lines);
    const result = await runDb(db, `
      INSERT INTO floating_investments (
        company_id, provider, description, investment_value, currency, customer_id,
        expected_profit, recovery_date, status, notes, created_by, updated_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      companyId,
      providerSummary,
      data.description,
      totals.investment,
      data.currency,
      data.customer_id,
      totals.profit,
      data.recovery_date,
      data.status,
      data.notes,
      userId,
      userId
    ]);
    await saveLines(db, companyId, result.lastID, lines);
    logAction(userId, 'floating_investment_created', JSON.stringify({ id: result.lastID }), companyId);
    setFlash(req, 'success', 'Inversion flotante registrada.');
    return res.redirect('/floating-investments');
  }));

  app.get('/floating-investments/:id/edit', editGuard, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const id = positiveInt(req.params.id);
    const investment = await getInvestment(db, companyId, id);
    if (!investment) return res.status(404).send('Inversion no encontrada');
    const [customers, suppliers, lines] = await Promise.all([
      getCustomers(db, companyId),
      getSuppliers(db, companyId),
      getLines(db, companyId, id)
    ]);
    return res.render('floating-investment-form', viewLocals(res, {
      investment,
      lines: lines.length ? lines : [defaultLine(investment)],
      customers,
      suppliers,
      statuses: STATUSES,
      formAction: `/floating-investments/${id}/update`,
      formTitle: 'Editar inversion flotante'
    }));
  }));

  app.post('/floating-investments/:id/update', editGuard, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const id = positiveInt(req.params.id);
    const existing = await getInvestment(db, companyId, id);
    if (!existing) return res.status(404).send('Inversion no encontrada');
    const data = normalizeInvestment(req.body);
    const lines = normalizeLines(req.body);
    const validation = validateInvestment(data, lines);
    if (validation) {
      setFlash(req, 'error', validation);
      return res.redirect(`/floating-investments/${id}/edit`);
    }
    await assertCustomer(db, companyId, data.customer_id);
    await assertLineSuppliers(db, companyId, lines);
    const totals = lineTotals(lines);
    const providerSummary = summarizeProviders(lines);
    await runDb(db, `
      UPDATE floating_investments
      SET provider = ?, description = ?, investment_value = ?, currency = ?, customer_id = ?,
          expected_profit = ?, recovery_date = ?, status = ?, notes = ?, updated_by = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND company_id = ?
    `, [
      providerSummary,
      data.description,
      totals.investment,
      data.currency,
      data.customer_id,
      totals.profit,
      data.recovery_date,
      data.status,
      data.notes,
      getUserId(req),
      id,
      companyId
    ]);
    await saveLines(db, companyId, id, lines);
    logAction(getUserId(req), 'floating_investment_updated', JSON.stringify({ id }), companyId);
    setFlash(req, 'success', 'Inversion flotante actualizada.');
    return res.redirect('/floating-investments');
  }));
}

async function ensureFloatingInvestmentSchema(db) {
  await runDb(db, `
    CREATE TABLE IF NOT EXISTS floating_investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      description TEXT NULL,
      investment_value REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'GTQ',
      customer_id INTEGER NULL,
      expected_profit REAL NOT NULL DEFAULT 0,
      recovery_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT NULL,
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_floating_investments_company ON floating_investments (company_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_floating_investments_recovery ON floating_investments (company_id, recovery_date)');
  await runDb(db, `
    CREATE TABLE IF NOT EXISTS floating_investment_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      investment_id INTEGER NOT NULL,
      supplier_id INTEGER NULL,
      supplier_name TEXT NULL,
      cost_center TEXT NULL,
      description TEXT NULL,
      investment_value REAL NOT NULL DEFAULT 0,
      expected_profit REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn(db, 'floating_investment_lines', 'supplier_id', 'INTEGER');
  await ensureColumn(db, 'floating_investment_lines', 'supplier_name', 'TEXT');
  await ensureColumn(db, 'floating_investment_lines', 'cost_center', 'TEXT');
  await ensureColumn(db, 'floating_investment_lines', 'description', 'TEXT');
  await ensureColumn(db, 'floating_investment_lines', 'investment_value', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn(db, 'floating_investment_lines', 'expected_profit', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn(db, 'floating_investment_lines', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_floating_investment_lines_parent ON floating_investment_lines (company_id, investment_id)');
  await backfillLegacyLines(db);
}

function viewLocals(res, extra) {
  return {
    lang: res.locals.lang,
    t: res.locals.t,
    flash: res.locals.flash,
    csrfToken: res.locals.csrfToken,
    currentModule: 'floating_investments',
    ...extra
  };
}

function defaultInvestment() {
  return {
    description: '',
    currency: 'GTQ',
    customer_id: '',
    recovery_date: '',
    status: 'active',
    notes: ''
  };
}

function defaultLine(investment = {}) {
  return {
    supplier_id: '',
    supplier_name: investment.provider || '',
    cost_center: '',
    description: investment.description || '',
    investment_value: investment.investment_value || '',
    expected_profit: investment.expected_profit || ''
  };
}

function normalizeInvestment(body) {
  return {
    description: clean(body.description),
    currency: clean(body.currency).toUpperCase() || 'GTQ',
    customer_id: positiveInt(body.customer_id),
    recovery_date: clean(body.recovery_date),
    status: STATUSES.some((status) => status.key === body.status) ? body.status : 'active',
    notes: clean(body.notes)
  };
}

function normalizeLines(body) {
  const supplierIds = asArray(body.line_supplier_id);
  const supplierNames = asArray(body.line_supplier_name);
  const costCenters = asArray(body.line_cost_center);
  const descriptions = asArray(body.line_description);
  const investments = asArray(body.line_investment_value);
  const profits = asArray(body.line_expected_profit);
  const max = Math.max(supplierIds.length, supplierNames.length, costCenters.length, descriptions.length, investments.length, profits.length);
  const lines = [];
  for (let index = 0; index < max; index += 1) {
    const line = {
      supplier_id: positiveInt(supplierIds[index]),
      supplier_name: clean(supplierNames[index]),
      cost_center: clean(costCenters[index]),
      description: clean(descriptions[index]),
      investment_value: money(investments[index]),
      expected_profit: money(profits[index])
    };
    const hasContent = line.supplier_id || line.supplier_name || line.cost_center || line.description || line.investment_value > 0 || line.expected_profit > 0;
    if (hasContent) lines.push(line);
  }
  return lines;
}

function validateInvestment(data, lines) {
  if (!data.customer_id) return 'Debe seleccionar un cliente.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.recovery_date || '')) return 'Fecha de recuperacion invalida.';
  if (!lines.length) return 'Agrega al menos una linea de inversion.';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.supplier_id && !line.supplier_name) return `Proveedor obligatorio en la linea ${index + 1}.`;
    if (!line.cost_center) return `Centro de costo obligatorio en la linea ${index + 1}.`;
    if (line.investment_value <= 0) return `La inversion debe ser mayor a cero en la linea ${index + 1}.`;
    if (line.expected_profit < 0) return `La ganancia no puede ser negativa en la linea ${index + 1}.`;
  }
  return null;
}

async function getCustomers(db, companyId) {
  return allDb(db, `
    SELECT id, name, customer_code
    FROM customers
    WHERE company_id = ? AND COALESCE(is_voided, 0) = 0
    ORDER BY name
  `, [companyId]);
}

async function getSuppliers(db, companyId) {
  const exists = await getDb(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'suppliers'");
  if (!exists) return [];
  return allDb(db, `
    SELECT id, code, trade_name
    FROM suppliers
    WHERE company_id = ? AND status NOT IN ('blocked', 'inactive')
    ORDER BY trade_name
  `, [companyId]);
}

async function assertCustomer(db, companyId, customerId) {
  const row = await getDb(db, 'SELECT id FROM customers WHERE id = ? AND company_id = ? AND COALESCE(is_voided, 0) = 0', [customerId, companyId]);
  if (!row) {
    const error = new Error('Cliente invalido.');
    error.status = 400;
    throw error;
  }
}

async function assertLineSuppliers(db, companyId, lines) {
  const ids = [...new Set(lines.map((line) => line.supplier_id).filter(Boolean))];
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await allDb(db, `SELECT id FROM suppliers WHERE company_id = ? AND id IN (${placeholders})`, [companyId, ...ids]);
  if (rows.length !== ids.length) {
    const error = new Error('Proveedor invalido en una linea.');
    error.status = 400;
    throw error;
  }
}

function getInvestment(db, companyId, id) {
  if (!id) return null;
  return getDb(db, 'SELECT * FROM floating_investments WHERE id = ? AND company_id = ?', [id, companyId]);
}

async function getLines(db, companyId, investmentId) {
  return allDb(db, `
    SELECT fil.*, s.code AS supplier_code, s.trade_name AS supplier_trade_name
    FROM floating_investment_lines fil
    LEFT JOIN suppliers s ON s.id = fil.supplier_id AND s.company_id = fil.company_id
    WHERE fil.company_id = ? AND fil.investment_id = ?
    ORDER BY fil.sort_order ASC, fil.id ASC
  `, [companyId, investmentId]);
}

async function saveLines(db, companyId, investmentId, lines) {
  await runDb(db, 'DELETE FROM floating_investment_lines WHERE company_id = ? AND investment_id = ?', [companyId, investmentId]);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await runDb(db, `
      INSERT INTO floating_investment_lines (
        company_id, investment_id, supplier_id, supplier_name, cost_center, description,
        investment_value, expected_profit, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      companyId,
      investmentId,
      line.supplier_id,
      line.supplier_name,
      line.cost_center,
      line.description,
      line.investment_value,
      line.expected_profit,
      index
    ]);
  }
}

function lineTotals(lines) {
  return lines.reduce((totals, line) => {
    totals.investment += Number(line.investment_value || 0);
    totals.profit += Number(line.expected_profit || 0);
    return totals;
  }, { investment: 0, profit: 0 });
}

function summarizeProviders(lines) {
  const names = [...new Set(lines.map((line) => line.supplier_name || (line.supplier_id ? `Proveedor ${line.supplier_id}` : '')).filter(Boolean))];
  if (!names.length) return 'Sin proveedor';
  if (names.length === 1) return names[0];
  return `${names.length} proveedores`;
}

async function backfillLegacyLines(db) {
  const rows = await allDb(db, `
    SELECT fi.*
    FROM floating_investments fi
    WHERE NOT EXISTS (
      SELECT 1 FROM floating_investment_lines fil
      WHERE fil.company_id = fi.company_id AND fil.investment_id = fi.id
    )
  `);
  for (const row of rows) {
    await runDb(db, `
      INSERT INTO floating_investment_lines (
        company_id, investment_id, supplier_name, cost_center, description,
        investment_value, expected_profit, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      row.company_id,
      row.id,
      row.provider || 'Proveedor legado',
      'General',
      row.description,
      money(row.investment_value),
      money(row.expected_profit)
    ]);
  }
}

function normalizeFilters(query) {
  return {
    q: clean(query.q),
    status: STATUSES.some((status) => status.key === query.status) ? query.status : ''
  };
}

function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function done(error) {
    if (error) reject(error);
    else resolve({ lastID: this.lastID, changes: this.changes });
  }));
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

function allDb(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

async function ensureColumn(db, table, column, type) {
  const columns = await allDb(db, `PRAGMA table_info(${table})`);
  if (columns.some((entry) => entry.name === column)) return;
  await runDb(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getUserId(req) {
  return req.session && req.session.user ? req.session.user.id : null;
}

module.exports = {
  registerFloatingInvestmentRoutes,
  ensureFloatingInvestmentSchema
};
