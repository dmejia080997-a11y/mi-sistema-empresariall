const PDFDocument = require('pdfkit');

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
    const investments = await getInvestments(db, companyId, filters);
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

  app.get('/floating-investments/pdf', viewGuard, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const filters = normalizeFilters(req.query);
    const [investments, company] = await Promise.all([
      getInvestments(db, companyId, filters),
      getCompanyBrand(db, companyId)
    ]);
    const fileName = `inversion-flotante-${dateStamp()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const doc = createFloatingPdfDocument();
    doc.pipe(res);
    renderInvestmentsListPdf(doc, investments, filters, company);
    finalizeFloatingPdf(doc, company);
    doc.end();
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

  app.get('/floating-investments/:id/pdf', viewGuard, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const id = positiveInt(req.params.id);
    const investment = await getInvestment(db, companyId, id);
    if (!investment) return res.status(404).send('Inversion no encontrada');
    const [customer, lines, company] = await Promise.all([
      investment.customer_id ? getDb(db, 'SELECT name, customer_code FROM customers WHERE id = ? AND company_id = ?', [investment.customer_id, companyId]) : null,
      getLines(db, companyId, id),
      getCompanyBrand(db, companyId)
    ]);
    const fileName = `inversion-flotante-${id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const doc = createFloatingPdfDocument();
    doc.pipe(res);
    renderInvestmentDetailPdf(doc, investment, customer, lines, company);
    finalizeFloatingPdf(doc, company);
    doc.end();
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
      id BIGSERIAL PRIMARY KEY,
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_floating_investments_company ON floating_investments (company_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_floating_investments_recovery ON floating_investments (company_id, recovery_date)');
  await runDb(db, `
    CREATE TABLE IF NOT EXISTS floating_investment_lines (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      investment_id INTEGER NOT NULL,
      supplier_id INTEGER NULL,
      supplier_name TEXT NULL,
      cost_center TEXT NULL,
      description TEXT NULL,
      investment_value REAL NOT NULL DEFAULT 0,
      expected_profit REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  const exists = await getDb(db, `SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name = 'suppliers'`);
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

function getInvestments(db, companyId, filters) {
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

  return allDb(db, `
    SELECT fi.*, c.name AS customer_name, c.customer_code,
           COUNT(fil.id) AS line_count,
           STRING_AGG(DISTINCT COALESCE(s.trade_name, fil.supplier_name), ',') AS line_suppliers,
           STRING_AGG(DISTINCT fil.cost_center, ',') AS cost_centers,
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

async function getCompanyBrand(db, companyId) {
  const company = await getDb(db, `
    SELECT name, address, nit, email, phone, currency, logo, primary_color, secondary_color
    FROM companies
    WHERE id = ?
  `, [companyId]);
  return {
    name: clean(company && company.name) || 'Empresa',
    nit: clean(company && company.nit),
    address: clean(company && company.address),
    email: clean(company && company.email),
    phone: clean(company && company.phone),
    currency: clean(company && company.currency) || 'GTQ',
    logoPath: clean(company && company.logo),
    primaryColor: normalizePdfColor(company && company.primary_color, '#24455d'),
    secondaryColor: normalizePdfColor(company && company.secondary_color, '#2d7c7a')
  };
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
  const columns = await allDb(db, `SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ?
    ORDER BY ordinal_position`, [table]);
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

function createFloatingPdfDocument() {
  return new PDFDocument({
    size: 'A4',
    margins: { top: 34, right: 28, bottom: 38, left: 28 },
    bufferPages: true
  });
}

function renderInvestmentsListPdf(doc, investments, filters, company) {
  const palette = floatingPdfPalette(company);
  let cursorY = drawFloatingHeader(doc, {
    company,
    title: 'Inversiones flotantes',
    documentLabel: 'REPORTE',
    documentNumber: dateStamp(),
    statusLabel: 'Control'
  });
  const totalsByCurrency = investments.reduce((totals, investment) => {
    const currency = investment.currency || 'GTQ';
    if (!totals[currency]) totals[currency] = { investment: 0, profit: 0 };
    totals[currency].investment += Number(investment.line_investment_value || investment.investment_value || 0);
    totals[currency].profit += Number(investment.line_expected_profit || investment.expected_profit || 0);
    return totals;
  }, {});
  const activeFilters = [];
  if (filters.q) activeFilters.push(`Busqueda: ${filters.q}`);
  if (filters.status) activeFilters.push(`Estado: ${statusLabel(filters.status)}`);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const summaryLines = Object.entries(totalsByCurrency).map(([currency, totals]) =>
    `${currency} invertido ${formatMoney(totals.investment)} | utilidad ${formatMoney(totals.profit)}`
  );
  const summaryText = summaryLines.length ? summaryLines.join('\n') : 'Sin movimientos.';
  drawFloatingPanel(doc, left, cursorY, contentWidth, 74, { accentBarColor: palette.accent });
  doc.fillColor(palette.accent).font('Helvetica-Bold').fontSize(8).text('RESUMEN', left + 20, cursorY + 16, { width: contentWidth - 40 });
  doc.fillColor(palette.ink).font('Helvetica-Bold').fontSize(11).text(summaryText, left + 18, cursorY + 32, { width: contentWidth - 36, lineGap: 2 });
  doc.fillColor(palette.muted).font('Helvetica').fontSize(8).text(activeFilters.length ? activeFilters.join(' | ') : 'Sin filtros aplicados', left + 18, cursorY + 58, { width: contentWidth - 36 });
  cursorY += 92;

  const columns = buildFloatingPdfColumns(left, contentWidth, [
    { label: 'Proveedor', width: 126 },
    { label: 'Cliente', width: 106 },
    { label: 'Inversion', width: 76, align: 'right' },
    { label: 'Utilidad', width: 76, align: 'right' },
    { label: 'Recuperacion', width: 70 },
    { label: 'Estado', width: 62 }
  ]);
  cursorY = drawFloatingTableHeader(doc, cursorY, columns, palette);
  investments.forEach((investment) => {
    if (cursorY + 48 > pageBottom(doc)) {
      doc.addPage();
      cursorY = drawFloatingContinuationHeader(doc, company, 'Inversiones flotantes', dateStamp());
      cursorY = drawFloatingTableHeader(doc, cursorY, columns, palette);
    }
    const values = [
      investment.line_suppliers || investment.provider || '-',
      investment.customer_name || '-',
      `${investment.currency || 'GTQ'} ${formatMoney(investment.line_investment_value || investment.investment_value)}`,
      `${investment.currency || 'GTQ'} ${formatMoney(investment.line_expected_profit || investment.expected_profit)}`,
      investment.recovery_date || '-',
      statusLabel(investment.status)
    ];
    cursorY = drawFloatingTableRow(doc, cursorY, columns, values, palette);
  });
  if (!investments.length) {
    drawFloatingPanel(doc, left, cursorY, contentWidth, 54, { fill: '#ffffff', stroke: palette.lineBorder });
    doc.fillColor(palette.muted).font('Helvetica').fontSize(10).text('No hay inversiones flotantes registradas.', left + 16, cursorY + 20, { width: contentWidth - 32 });
  }
}

function renderInvestmentDetailPdf(doc, investment, customer, lines, company) {
  const palette = floatingPdfPalette(company);
  const totals = lineTotals(lines.length ? lines : [defaultLine(investment)]);
  const currency = investment.currency || company.currency || 'GTQ';
  let cursorY = drawFloatingHeader(doc, {
    company,
    title: investment.description || `Inversion flotante #${investment.id}`,
    documentLabel: 'COTIZACION',
    documentNumber: `INV-${String(investment.id).padStart(5, '0')}`,
    statusLabel: statusLabel(investment.status)
  });
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const gap = 16;
  const customerWidth = Math.floor(contentWidth * 0.55);
  const metaWidth = contentWidth - customerWidth - gap;
  const customerText = [
    customer && customer.name ? customer.name : 'Cliente no definido',
    customer && customer.customer_code ? `Codigo: ${customer.customer_code}` : ''
  ].filter(Boolean).join('\n');
  drawFloatingPanel(doc, left, cursorY, customerWidth, 112, { accentBarColor: palette.accent });
  doc.fillColor(palette.accent).font('Helvetica-Bold').fontSize(8).text('CLIENTE', left + 20, cursorY + 16, { width: customerWidth - 34 });
  doc.fillColor(palette.ink).font('Helvetica-Bold').fontSize(13).text(customerText, left + 16, cursorY + 34, { width: customerWidth - 30, lineGap: 3 });
  if (investment.notes) {
    doc.fillColor(palette.muted).font('Helvetica').fontSize(8).text(investment.notes, left + 16, cursorY + 74, { width: customerWidth - 30, height: 26, ellipsis: true });
  }

  const metaX = left + customerWidth + gap;
  drawFloatingPanel(doc, metaX, cursorY, metaWidth, 112, { accentBarColor: palette.primary });
  const metaRows = [
    ['Emision', formatPdfDate(new Date())],
    ['Recuperacion', investment.recovery_date || '-'],
    ['Moneda', currency],
    ['Estado', statusLabel(investment.status)]
  ];
  doc.fillColor(palette.primary).font('Helvetica-Bold').fontSize(8).text('RESUMEN COMERCIAL', metaX + 20, cursorY + 16, { width: metaWidth - 34 });
  let metaY = cursorY + 34;
  metaRows.forEach(([label, value]) => {
    doc.fillColor(palette.muted).font('Helvetica').fontSize(8).text(label, metaX + 16, metaY, { width: 74 });
    doc.fillColor(palette.ink).font('Helvetica-Bold').fontSize(9).text(value, metaX + 92, metaY, { width: metaWidth - 108, align: 'right' });
    metaY += 17;
  });
  cursorY += 132;

  const columns = buildFloatingPdfColumns(left, contentWidth, [
    { label: 'Proveedor', width: 128 },
    { label: 'Centro costo', width: 94 },
    { label: 'Descripcion', width: 154 },
    { label: 'Inversion', width: 74, align: 'right' },
    { label: 'Utilidad', width: 76, align: 'right' }
  ]);
  cursorY = drawFloatingTableHeader(doc, cursorY, columns, palette);
  (lines.length ? lines : [defaultLine(investment)]).forEach((line) => {
    if (cursorY + 52 > pageBottom(doc)) {
      doc.addPage();
      cursorY = drawFloatingContinuationHeader(doc, company, 'Cotizacion de inversion flotante', `INV-${String(investment.id).padStart(5, '0')}`);
      cursorY = drawFloatingTableHeader(doc, cursorY, columns, palette);
    }
    cursorY = drawFloatingTableRow(doc, cursorY, columns, [
      line.supplier_trade_name || line.supplier_name || '-',
      line.cost_center || '-',
      line.description || '-',
      `${currency} ${formatMoney(line.investment_value)}`,
      `${currency} ${formatMoney(line.expected_profit)}`
    ], palette);
  });

  const totalsHeight = 92;
  if (cursorY + totalsHeight > pageBottom(doc)) {
    doc.addPage();
    cursorY = drawFloatingContinuationHeader(doc, company, 'Totales', `INV-${String(investment.id).padStart(5, '0')}`);
  }
  const totalsWidth = 210;
  const totalsX = right - totalsWidth;
  drawFloatingPanel(doc, totalsX, cursorY + 8, totalsWidth, totalsHeight - 8, { fill: '#ffffff', stroke: palette.lineBorder });
  const totalRows = [
    ['Total inversion', `${currency} ${formatMoney(totals.investment || investment.investment_value)}`],
    ['Utilidad esperada', `${currency} ${formatMoney(totals.profit || investment.expected_profit)}`],
    ['Total proyectado', `${currency} ${formatMoney((totals.investment || investment.investment_value || 0) + (totals.profit || investment.expected_profit || 0))}`]
  ];
  let totalY = cursorY + 24;
  totalRows.forEach(([label, value], index) => {
    if (index === totalRows.length - 1) {
      doc.roundedRect(totalsX + 10, totalY - 5, totalsWidth - 20, 24, 10).fill(palette.softAccent);
    }
    doc.fillColor(index === totalRows.length - 1 ? palette.primary : palette.muted).font('Helvetica-Bold').fontSize(index === totalRows.length - 1 ? 10 : 9).text(label, totalsX + 16, totalY, { width: 94 });
    doc.fillColor(index === totalRows.length - 1 ? palette.primary : palette.ink).font('Helvetica-Bold').fontSize(index === totalRows.length - 1 ? 10 : 9).text(value, totalsX + 104, totalY, { width: 90, align: 'right' });
    totalY += 24;
  });
}

function drawFloatingHeader(doc, { company, title, documentLabel, documentNumber, statusLabel: currentStatus }) {
  const palette = floatingPdfPalette(company);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const headerHeight = 126;
  doc.rect(0, 0, doc.page.width, headerHeight).fill(palette.primary);
  drawFloatingLogoBlock(doc, company, left, 28, 74, 58, palette);
  const companyX = left + 92;
  const companyWidth = contentWidth - 294;
  const companyLines = [
    { value: company.name || 'Empresa', size: 20, color: '#ffffff', font: 'Helvetica-Bold' },
    { value: company.nit ? `NIT: ${company.nit}` : '', size: 9, color: '#d7e1ea', font: 'Helvetica' },
    { value: [company.phone, company.email].filter(Boolean).join(' - '), size: 9, color: '#d7e1ea', font: 'Helvetica' },
    { value: company.address || '', size: 8, color: '#d7e1ea', font: 'Helvetica' }
  ].filter((line) => line.value);
  let y = 34;
  companyLines.forEach((line) => {
    doc.font(line.font).fillColor(line.color).fontSize(line.size).text(line.value, companyX, y, { width: companyWidth, height: line.size + 6, ellipsis: true });
    y += line.size + 8;
  });
  doc.font('Helvetica-Bold').fillColor('#ffffff').fontSize(13).text(title, companyX, 88, { width: companyWidth, height: 30, ellipsis: true });

  const cardWidth = 184;
  const cardX = right - cardWidth;
  drawFloatingPanel(doc, cardX, 26, cardWidth, 78, { fill: '#ffffff', stroke: '#dbe5ec' });
  doc.roundedRect(cardX + 18, 38, 88, 18, 9).fill(palette.accent);
  doc.font('Helvetica-Bold').fillColor('#ffffff').fontSize(8).text(String(currentStatus || '').toUpperCase(), cardX + 18, 43, { width: 88, align: 'center' });
  doc.fillColor(palette.primary).font('Helvetica-Bold').fontSize(10).text(documentLabel, cardX + 18, 63, { width: cardWidth - 36 });
  doc.fontSize(14).text(documentNumber, cardX + 18, 78, { width: cardWidth - 36 });
  return headerHeight + 20;
}

function drawFloatingContinuationHeader(doc, company, title, documentNumber) {
  const palette = floatingPdfPalette(company);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  drawFloatingPanel(doc, left, doc.page.margins.top, right - left, 58, {
    fill: '#ffffff',
    stroke: palette.lineBorder,
    accentBarColor: palette.accent
  });
  doc.fillColor(palette.primary).font('Helvetica-Bold').fontSize(11).text('INVERSION FLOTANTE', left + 18, doc.page.margins.top + 14, { width: 160 });
  doc.fontSize(15).text(documentNumber, left + 18, doc.page.margins.top + 28, { width: 200 });
  doc.fillColor(palette.muted).font('Helvetica').fontSize(9).text(title, right - 230, doc.page.margins.top + 20, { width: 212, align: 'right' });
  return doc.page.margins.top + 74;
}

function buildFloatingPdfColumns(left, contentWidth, definitions) {
  const gap = 8;
  const totalGap = gap * Math.max(0, definitions.length - 1);
  const targetWidth = definitions.reduce((sum, column) => sum + column.width, 0);
  const availableWidth = contentWidth - totalGap;
  const scale = targetWidth > availableWidth ? availableWidth / targetWidth : 1;
  let x = left;
  return definitions.map((column, index) => {
    const isLast = index === definitions.length - 1;
    const nextColumn = {
      ...column,
      x,
      width: isLast ? Math.max(1, left + contentWidth - x) : Math.floor(column.width * scale)
    };
    x += nextColumn.width + gap;
    return nextColumn;
  });
}

function drawFloatingTableHeader(doc, startY, columns, palette) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const padding = 6;
  doc.roundedRect(left, startY, right - left, 30, 10).fill(palette.primary);
  doc.font('Helvetica-Bold').fillColor('#ffffff').fontSize(8);
  columns.forEach((column) => {
    const textWidth = Math.max(1, column.width - padding * 2);
    doc.text(column.label, column.x + padding, startY + 10, {
      width: textWidth,
      align: column.align || 'left'
    });
  });
  return startY + 38;
}

function drawFloatingTableRow(doc, startY, columns, values, palette) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const padding = 6;
  let maxHeight = 0;
  doc.font('Helvetica').fontSize(8);
  values.forEach((value, index) => {
    const text = String(value == null || value === '' ? '-' : value);
    const textWidth = Math.max(1, columns[index].width - padding * 2);
    const height = doc.heightOfString(text, { width: textWidth });
    maxHeight = Math.max(maxHeight, height);
  });
  const rowHeight = Math.max(38, maxHeight + 18);
  drawFloatingPanel(doc, left, startY - 2, right - left, rowHeight, {
    fill: '#ffffff',
    stroke: '#edf2f7',
    radius: 10
  });
  doc.fillColor(palette.ink).font('Helvetica').fontSize(8);
  values.forEach((value, index) => {
    const column = columns[index];
    const textWidth = Math.max(1, column.width - padding * 2);
    doc.text(String(value == null || value === '' ? '-' : value), column.x + padding, startY + 10, {
      width: textWidth,
      align: column.align || 'left',
      height: rowHeight - 16,
      ellipsis: true
    });
  });
  return startY + rowHeight + 8;
}

function drawFloatingPanel(doc, x, y, width, height, options = {}) {
  const radius = options.radius || 14;
  doc.save();
  doc.roundedRect(x, y, width, height, radius).fill(options.fill || '#f8fafc');
  doc.restore();
  doc.save();
  doc.roundedRect(x, y, width, height, radius).lineWidth(1).strokeColor(options.stroke || '#d9e4ea').stroke();
  doc.restore();
  if (options.accentBarColor) {
    doc.save();
    doc.roundedRect(x + 10, y + 10, 4, Math.max(18, height - 20), 2).fill(options.accentBarColor);
    doc.restore();
  }
}

function drawFloatingLogoBlock(doc, company, x, y, width, height, palette) {
  drawFloatingPanel(doc, x, y, width, height, {
    fill: palette.accent,
    stroke: palette.softAccent,
    radius: 14
  });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text((company && company.name ? company.name : 'ER').slice(0, 2).toUpperCase(), x, y + 18, {
    width,
    align: 'center'
  });
}

function finalizeFloatingPdf(doc, company) {
  const palette = floatingPdfPalette(company);
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const footerY = doc.page.height - doc.page.margins.bottom + 4;
    const footerText = [
      company && company.name ? company.name : 'Empresa',
      company && company.email ? company.email : '',
      company && company.phone ? company.phone : '',
      company && company.address ? company.address : ''
    ].filter(Boolean).join(' - ');
    doc.moveTo(left, footerY).lineTo(right, footerY).strokeColor(palette.lineBorder).stroke();
    doc.fillColor(palette.muted).font('Helvetica').fontSize(8).text(footerText, left, footerY + 8, { width: right - left - 86 });
    doc.text(`Pagina ${index + 1} de ${range.count}`, right - 86, footerY + 8, { width: 86, align: 'right' });
  }
}

function pageBottom(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function floatingPdfPalette(company) {
  const primary = normalizePdfColor(company && company.primaryColor, '#24455d');
  const accent = normalizePdfColor(company && company.secondaryColor, '#2d7c7a');
  return {
    primary,
    accent,
    panelFill: '#f8fafc',
    lineBorder: '#d9e4ea',
    ink: '#24313f',
    muted: '#5f7283',
    softAccent: mixPdfColors(accent, '#ffffff', 0.86)
  };
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function formatPdfDate(value) {
  try {
    return new Intl.DateTimeFormat('es-GT', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  } catch (error) {
    return dateStamp();
  }
}

function normalizePdfColor(value, fallback) {
  const raw = clean(value);
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) return fallback || '#24455d';
  if (raw.length === 4) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  return raw.toLowerCase();
}

function mixPdfColors(source, target, ratio) {
  const from = normalizePdfColor(source, '#000000');
  const to = normalizePdfColor(target, '#ffffff');
  const weight = Math.max(0, Math.min(1, Number(ratio) || 0));
  const rgb = [0, 2, 4].map((offset) => {
    const start = parseInt(from.slice(1 + offset, 3 + offset), 16);
    const end = parseInt(to.slice(1 + offset, 3 + offset), 16);
    return Math.round(start + (end - start) * weight).toString(16).padStart(2, '0');
  });
  return `#${rgb.join('')}`;
}

function statusLabel(key) {
  const entry = STATUSES.find((status) => status.key === key);
  return entry ? entry.label : key || '-';
}

function dateStamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = {
  registerFloatingInvestmentRoutes,
  ensureFloatingInvestmentSchema
};
