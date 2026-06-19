const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { STORAGE_UPLOADS_DIR } = require('../../core/storage-paths');

function registerSalesRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    getCompanyId,
    normalizeString,
    csrfMiddleware,
    buildFileUrl,
    enqueueDbTransaction,
    commitTransaction,
    rollbackTransaction,
    logAction
  } = deps;

  const quoteUpload = buildQuoteUpload();
  const schemaReady = ensureSalesSchema(db).catch((error) => {
    console.error('[sales] schema initialization failed', error);
    throw error;
  });

  const asyncRoute = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

  app.get(
    '/sales',
    requireAuth,
    requirePermission('sales', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = getSessionUserId(req);
      const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
      const viewModel = await buildSalesViewModel(db, companyId, userId, access, req.query, res.locals.flash);
      viewModel.lang = res.locals.lang;
      viewModel.csrfToken = res.locals.csrfToken;
      return res.render('sales', viewModel);
    })
  );

  app.get('/sales/:id', requireAuth, requirePermission('sales', 'view'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const sale = await fetchSaleBundle(db, companyId, parseId(req.params.id), access);
    if (!sale) return res.redirect('/sales?section=sales');
    return res.render('sales-detail', {
      lang: res.locals.lang,
      csrfToken: res.locals.csrfToken,
      sale,
      currentModule: 'sales',
      moduleTabs: buildSalesModuleTabs('sales')
    });
  }));

  app.get('/sales/quotes/:id/print', requireAuth, requirePermission('sales', 'view'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const quote = await fetchQuoteBundle(db, companyId, parseId(req.params.id), access, buildFileUrl);
    if (!quote) return res.redirect('/sales?section=quotes');
    return res.render('sales-quote-print', {
      lang: res.locals.lang,
      csrfToken: res.locals.csrfToken,
      quote,
      currentModule: 'sales',
      moduleTabs: buildSalesModuleTabs('quotes')
    });
  }));

  app.post('/sales/prospects/create', requireAuth, requirePermission('sales', 'create'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getSessionUserId(req);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const assignedUserId = normalizeAssignableSeller(req.body.assigned_user_id, userId, access);
    const name = clean(req.body.name, normalizeString);
    if (!name) return res.redirect('/sales?section=clients&error=prospect_name_required');
    await runDb(
      db,
      `INSERT INTO sales_prospects
       (company_id, assigned_user_id, name, contact_name, email, phone, source, status, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        assignedUserId,
        name,
        clean(req.body.contact_name, normalizeString) || null,
        clean(req.body.email, normalizeString) || null,
        clean(req.body.phone, normalizeString) || null,
        clean(req.body.source, normalizeString) || null,
        clean(req.body.status, normalizeString) || 'prospecto',
        clean(req.body.notes, normalizeString) || null,
        userId
      ]
    );
    setSalesFlash(req, 'info', 'Prospecto creado.');
    return res.redirect('/sales?section=clients');
  }));

  app.post('/sales/opportunities/create', requireAuth, requirePermission('sales', 'create'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getSessionUserId(req);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const sellerId = normalizeAssignableSeller(req.body.seller_user_id, userId, access);
    const title = clean(req.body.title, normalizeString);
    if (!title) return res.redirect('/sales?section=opportunities&error=opportunity_title_required');
    await runDb(
      db,
      `INSERT INTO sales_opportunities
       (company_id, prospect_id, customer_id, seller_user_id, title, stage, probability, expected_amount, expected_close_date, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        parseId(req.body.prospect_id),
        parseId(req.body.customer_id),
        sellerId,
        title,
        normalizeOpportunityStage(req.body.stage),
        toNumber(req.body.probability, 25),
        toNumber(req.body.expected_amount, 0),
        clean(req.body.expected_close_date, normalizeString) || null,
        clean(req.body.notes, normalizeString) || null,
        userId
      ]
    );
    setSalesFlash(req, 'info', 'Oportunidad creada.');
    return res.redirect('/sales?section=opportunities');
  }));

  app.post('/sales/quotes/create', requireAuth, requirePermission('sales', 'create'), quoteUpload.array('quote_attachments', 10), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getSessionUserId(req);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const sellerId = normalizeAssignableSeller(req.body.seller_user_id, userId, access);
    const lines = await parseCommercialLines(db, companyId, req.body);
    if (!lines.length) {
      cleanupUploadedFiles(req.files);
      return res.redirect('/sales?section=quotes&error=quote_line_required');
    }
    const totals = computeTotals(lines, req.body.discount, req.body.tax_rate);
    const insert = await withTransaction(db, enqueueDbTransaction, commitTransaction, rollbackTransaction, async () => {
      const quote = await runDb(
        db,
        `INSERT INTO sales_quotes
         (company_id, opportunity_id, customer_id, prospect_id, seller_user_id, quote_number, status, subtotal, discount, tax, total, valid_until, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          companyId,
          parseId(req.body.opportunity_id),
          parseId(req.body.customer_id),
          parseId(req.body.prospect_id),
          sellerId,
          '',
          normalizeCommercialStatus(req.body.status, 'borrador'),
          totals.subtotal,
          totals.discount,
          totals.tax,
          totals.total,
          clean(req.body.valid_until, normalizeString) || null,
          clean(req.body.notes, normalizeString) || null,
          userId
        ]
      );
      const number = buildSequence('COT', quote.lastID);
      await runDb(db, 'UPDATE sales_quotes SET quote_number = ? WHERE id = ? AND company_id = ?', [number, quote.lastID, companyId]);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        await insertSalesLine(db, 'sales_quote_lines', quote.lastID, companyId, line, index + 1);
      }
      await insertQuoteAttachments(db, companyId, quote.lastID, req.files, userId);
      return { id: quote.lastID, number };
    });
    setSalesFlash(req, 'info', `Cotizacion ${insert.number} creada.`);
    return res.redirect('/sales?section=quotes');
  }));

  app.post('/sales/quotes/:id/attachments', requireAuth, requirePermission('sales', 'edit'), quoteUpload.array('quote_attachments', 10), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const quoteId = parseId(req.params.id);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const quote = await fetchScopedRow(db, 'sales_quotes', companyId, quoteId, access);
    if (!quote) {
      cleanupUploadedFiles(req.files);
      return res.redirect('/sales?section=quotes');
    }
    await insertQuoteAttachments(db, companyId, quote.id, req.files, getSessionUserId(req));
    setSalesFlash(req, 'info', 'Soportes adjuntados a la cotizacion.');
    return res.redirect(`/sales/quotes/${quote.id}/print`);
  }));

  app.post('/sales/quotes/:id/order', requireAuth, requirePermission('sales', 'create'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getSessionUserId(req);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const quote = await fetchScopedRow(db, 'sales_quotes', companyId, parseId(req.params.id), access);
    if (!quote) return res.redirect('/sales?section=quotes');
    const lines = await allDb(db, 'SELECT * FROM sales_quote_lines WHERE quote_id = ? AND company_id = ? ORDER BY sort_order, id', [quote.id, companyId]);
    const insert = await withTransaction(db, enqueueDbTransaction, commitTransaction, rollbackTransaction, async () => {
      const order = await runDb(
        db,
        `INSERT INTO sales_orders
         (company_id, quote_id, opportunity_id, customer_id, prospect_id, seller_user_id, order_number, status, subtotal, discount, tax, total, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [companyId, quote.id, quote.opportunity_id, quote.customer_id, quote.prospect_id, quote.seller_user_id, '', 'pedido', quote.subtotal, quote.discount, quote.tax, quote.total, clean(req.body.notes, normalizeString) || quote.notes, userId]
      );
      const number = buildSequence('PED', order.lastID);
      await runDb(db, 'UPDATE sales_orders SET order_number = ? WHERE id = ? AND company_id = ?', [number, order.lastID, companyId]);
      for (let index = 0; index < lines.length; index += 1) {
        await insertSalesLine(db, 'sales_order_lines', order.lastID, companyId, mapStoredLine(lines[index]), index + 1);
      }
      await runDb(db, "UPDATE sales_quotes SET status = 'convertida', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?", [quote.id, companyId]);
      return { id: order.lastID, number };
    });
    setSalesFlash(req, 'info', `Pedido ${insert.number} creado desde cotizacion.`);
    return res.redirect('/sales?section=orders');
  }));

  app.post('/sales/orders/:id/close', requireAuth, requirePermission('sales', 'create'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getSessionUserId(req);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const order = await fetchScopedRow(db, 'sales_orders', companyId, parseId(req.params.id), access);
    if (!order) return res.redirect('/sales?section=orders');
    const lines = (await allDb(db, 'SELECT * FROM sales_order_lines WHERE order_id = ? AND company_id = ? ORDER BY sort_order, id', [order.id, companyId])).map(mapStoredLine);
    try {
      const closed = await createClosedSaleFromSource({
        db,
        companyId,
        userId,
        source: order,
        sourceType: 'order',
        lines,
        commissionRate: toNumber(req.body.commission_rate, 0),
        notes: clean(req.body.notes, normalizeString),
        tx: { enqueueDbTransaction, commitTransaction, rollbackTransaction }
      });
      setSalesFlash(req, 'info', `Venta ${closed.saleNumber} cerrada y factura generada.`);
      return res.redirect(`/sales/${closed.saleId}`);
    } catch (error) {
      setSalesFlash(req, 'error', error.message || 'No se pudo cerrar la venta.');
      return res.redirect('/sales?section=orders');
    }
  }));

  app.post('/sales/direct/create', requireAuth, requirePermission('sales', 'create'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getSessionUserId(req);
    const access = await resolveSalesAccess(db, companyId, req.session.user, req.session.permissionMap);
    const sellerId = normalizeAssignableSeller(req.body.seller_user_id, userId, access);
    const lines = await parseCommercialLines(db, companyId, req.body);
    if (!lines.length) return res.redirect('/sales?section=sales&error=sale_line_required');
    const totals = computeTotals(lines, req.body.discount, req.body.tax_rate);
    try {
      const closed = await createClosedSaleFromSource({
        db,
        companyId,
        userId,
        source: {
          id: null,
          customer_id: parseId(req.body.customer_id),
          prospect_id: parseId(req.body.prospect_id),
          seller_user_id: sellerId,
          subtotal: totals.subtotal,
          discount: totals.discount,
          tax: totals.tax,
          total: totals.total,
          notes: clean(req.body.notes, normalizeString)
        },
        sourceType: 'direct',
        lines,
        commissionRate: toNumber(req.body.commission_rate, 0),
        notes: clean(req.body.notes, normalizeString),
        tx: { enqueueDbTransaction, commitTransaction, rollbackTransaction }
      });
      setSalesFlash(req, 'info', `Venta ${closed.saleNumber} cerrada.`);
      return res.redirect(`/sales/${closed.saleId}`);
    } catch (error) {
      setSalesFlash(req, 'error', error.message || 'No se pudo crear la venta.');
      return res.redirect('/sales?section=sales');
    }
  }));

  app.post('/sales/goals/create', requireAuth, requirePermission('sales', 'manage'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const sellerId = parseId(req.body.seller_user_id);
    if (!sellerId) return res.redirect('/sales?section=goals');
    await runDb(
      db,
      `INSERT INTO sales_goals (company_id, seller_user_id, period_start, period_end, target_amount, target_count, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        sellerId,
        clean(req.body.period_start, normalizeString) || todayMonthStart(),
        clean(req.body.period_end, normalizeString) || todayMonthEnd(),
        toNumber(req.body.target_amount, 0),
        Math.max(0, Math.round(toNumber(req.body.target_count, 0))),
        getSessionUserId(req)
      ]
    );
    return res.redirect('/sales?section=goals');
  }));

  app.post('/sales/team/update', requireAuth, requirePermission('sales', 'manage'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = parseId(req.body.user_id);
    if (!userId) return res.redirect('/sales?section=team');
    await runDb(
      db,
      `INSERT INTO sales_user_profiles (company_id, user_id, commercial_role, supervisor_user_id, commission_rate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(company_id, user_id) DO UPDATE SET
         commercial_role = excluded.commercial_role,
         supervisor_user_id = excluded.supervisor_user_id,
         commission_rate = excluded.commission_rate,
         updated_at = CURRENT_TIMESTAMP`,
      [
        companyId,
        userId,
        normalizeCommercialRole(req.body.commercial_role),
        parseId(req.body.supervisor_user_id),
        toNumber(req.body.commission_rate, 0)
      ]
    );
    return res.redirect('/sales?section=team');
  }));
}

async function ensureSalesSchema(db) {
  await ensureSalesPermissionData(db);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    commercial_role TEXT NOT NULL DEFAULT 'seller',
    supervisor_user_id INTEGER NULL,
    commission_rate REAL NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, user_id)
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_prospects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    assigned_user_id INTEGER NULL,
    name TEXT NOT NULL,
    contact_name TEXT NULL,
    email TEXT NULL,
    phone TEXT NULL,
    source TEXT NULL,
    status TEXT NOT NULL DEFAULT 'prospecto',
    notes TEXT NULL,
    converted_customer_id INTEGER NULL,
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    prospect_id INTEGER NULL,
    customer_id INTEGER NULL,
    seller_user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'prospecto',
    probability REAL NOT NULL DEFAULT 0,
    expected_amount REAL NOT NULL DEFAULT 0,
    expected_close_date TEXT NULL,
    notes TEXT NULL,
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME NULL
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    opportunity_id INTEGER NULL,
    customer_id INTEGER NULL,
    prospect_id INTEGER NULL,
    seller_user_id INTEGER NOT NULL,
    quote_number TEXT NULL,
    status TEXT NOT NULL DEFAULT 'borrador',
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    valid_until TEXT NULL,
    notes TEXT NULL,
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_quote_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    quote_id INTEGER NOT NULL,
    line_type TEXT NOT NULL DEFAULT 'product',
    item_id INTEGER NULL,
    description TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_quote_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    quote_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT NULL,
    mime_type TEXT NULL,
    file_size INTEGER NULL,
    uploaded_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    quote_id INTEGER NULL,
    opportunity_id INTEGER NULL,
    customer_id INTEGER NULL,
    prospect_id INTEGER NULL,
    seller_user_id INTEGER NOT NULL,
    order_number TEXT NULL,
    status TEXT NOT NULL DEFAULT 'pedido',
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    notes TEXT NULL,
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME NULL
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    line_type TEXT NOT NULL DEFAULT 'product',
    item_id INTEGER NULL,
    description TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    cliente_id INTEGER NULL,
    prospect_id INTEGER NULL,
    seller_user_id INTEGER NOT NULL,
    opportunity_id INTEGER NULL,
    quote_id INTEGER NULL,
    order_id INTEGER NULL,
    invoice_header_id INTEGER NULL,
    sale_number TEXT NULL,
    sale_type TEXT NOT NULL DEFAULT 'producto',
    status TEXT NOT NULL DEFAULT 'cerrada',
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    commission REAL NOT NULL DEFAULT 0,
    commission_rate REAL NOT NULL DEFAULT 0,
    notes TEXT NULL,
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME NULL
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    sale_id INTEGER NOT NULL,
    line_type TEXT NOT NULL DEFAULT 'product',
    item_id INTEGER NULL,
    description TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    sale_id INTEGER NOT NULL,
    seller_user_id INTEGER NOT NULL,
    base_amount REAL NOT NULL DEFAULT 0,
    rate REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pendiente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME NULL
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    seller_user_id INTEGER NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    target_amount REAL NOT NULL DEFAULT 0,
    target_count INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS sales_inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    sale_id INTEGER NOT NULL,
    sale_line_id INTEGER NULL,
    item_id INTEGER NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    stock_before REAL NOT NULL DEFAULT 0,
    stock_after REAL NOT NULL DEFAULT 0,
    movement_type TEXT NOT NULL DEFAULT 'sale',
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureInvoiceSupport(db);
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_sales_company_seller ON sales (company_id, seller_user_id, created_at)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_sales_opportunities_scope ON sales_opportunities (company_id, seller_user_id, stage)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_sales_quotes_scope ON sales_quotes (company_id, seller_user_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_sales_quote_attachments ON sales_quote_attachments (company_id, quote_id, created_at)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_sales_orders_scope ON sales_orders (company_id, seller_user_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_sales_commissions_seller ON sales_commissions (company_id, seller_user_id, status)');
}

async function ensureSalesPermissionData(db) {
  await runDb(db, `INSERT OR IGNORE INTO permission_modules (code, name, description)
    VALUES ('sales', 'Ventas / CRM', 'CRM comercial, oportunidades, cotizaciones, pedidos, ventas, comisiones y metas')`);
  await runDb(db, `INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES
    ('view','Ver','Acceso de lectura'),
    ('create','Crear','Crear registros'),
    ('edit','Editar','Editar registros'),
    ('delete','Eliminar','Eliminar registros'),
    ('export','Exportar','Exportar informacion'),
    ('manage','Administrar','Administrar equipos, metas y configuracion comercial')`);
  await runDb(db, `INSERT OR IGNORE INTO module_actions (module_id, action_id)
    SELECT pm.id, pa.id
    FROM permission_modules pm, permission_actions pa
    WHERE pm.code = 'sales' AND pa.code IN ('view','create','edit','delete','export','manage')`);
}

async function ensureInvoiceSupport(db) {
  await runDb(db, `CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    subtotal REAL,
    tax_rate REAL,
    tax_amount REAL,
    discount_type TEXT,
    discount_value REAL,
    discount_amount REAL,
    total REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    company_id INTEGER,
    currency TEXT,
    exchange_rate REAL DEFAULT 1,
    subtotal_base REAL DEFAULT 0,
    tax_amount_base REAL DEFAULT 0,
    discount_amount_base REAL DEFAULT 0,
    total_base REAL DEFAULT 0
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS invoice_headers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_invoice_id INTEGER NULL,
    company_id INTEGER NOT NULL,
    invoice_number TEXT NULL,
    invoice_type TEXT NOT NULL DEFAULT 'standard',
    source TEXT NOT NULL DEFAULT 'sales_crm',
    customer_id INTEGER NULL,
    customer_name_snapshot TEXT NULL,
    issue_date TEXT NULL,
    status TEXT NOT NULL DEFAULT 'issued',
    subtotal REAL NOT NULL DEFAULT 0,
    tax_total REAL NOT NULL DEFAULT 0,
    discount_total REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    paid_total REAL NOT NULL DEFAULT 0,
    balance_due REAL NOT NULL DEFAULT 0,
    notes TEXT NULL,
    currency TEXT NULL,
    exchange_rate REAL NOT NULL DEFAULT 1,
    subtotal_base REAL NOT NULL DEFAULT 0,
    tax_amount_base REAL NOT NULL DEFAULT 0,
    discount_amount_base REAL NOT NULL DEFAULT 0,
    total_base REAL NOT NULL DEFAULT 0,
    created_by INTEGER NULL,
    updated_by INTEGER NULL,
    stock_applied INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    emitted_at DATETIME NULL
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER,
    header_id INTEGER NULL,
    item_id INTEGER,
    qty REAL,
    unit_price REAL,
    line_total REAL,
    company_id INTEGER,
    line_type TEXT NOT NULL DEFAULT 'inventory',
    description TEXT NULL,
    tax_rate REAL NOT NULL DEFAULT 0,
    tax_amount REAL NOT NULL DEFAULT 0,
    discount_type TEXT NOT NULL DEFAULT 'amount',
    discount_value REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS invoice_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_header_id INTEGER NOT NULL,
    company_id INTEGER NOT NULL,
    from_status TEXT NULL,
    to_status TEXT NULL,
    notes TEXT NULL,
    changed_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS invoice_inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_header_id INTEGER NOT NULL,
    invoice_item_id INTEGER NULL,
    item_id INTEGER NOT NULL,
    company_id INTEGER NOT NULL,
    movement_type TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    stock_before REAL NOT NULL DEFAULT 0,
    stock_after REAL NOT NULL DEFAULT 0,
    notes TEXT NULL,
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function createClosedSaleFromSource({ db, companyId, userId, source, sourceType, lines, commissionRate, notes, tx }) {
  if (!lines.length) throw new Error('La venta debe incluir al menos una linea.');
  const stockErrors = await validateStock(db, companyId, lines);
  if (stockErrors.length) throw new Error(stockErrors.join(' '));
  const totals = computeTotals(lines, source.discount, 0, source.tax);
  const saleType = resolveSaleType(lines);
  const rate = commissionRate || await resolveSellerCommissionRate(db, companyId, source.seller_user_id);
  const commission = round2(totals.total * (rate / 100));
  const currency = await resolveCompanyBaseCurrency(db, companyId);
  return withTransaction(db, tx.enqueueDbTransaction, tx.commitTransaction, tx.rollbackTransaction, async () => {
    const legacyInvoice = await runDb(
      db,
      `INSERT INTO invoices
       (customer_id, subtotal, tax_rate, tax_amount, discount_type, discount_value, discount_amount, total, company_id, currency, exchange_rate, subtotal_base, tax_amount_base, discount_amount_base, total_base)
       VALUES (?, ?, ?, ?, 'amount', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [source.customer_id || null, totals.subtotal, 0, totals.tax, totals.discount, totals.discount, totals.total, companyId, currency, totals.subtotal, totals.tax, totals.discount, totals.total]
    );
    const header = await runDb(
      db,
      `INSERT INTO invoice_headers
       (legacy_invoice_id, company_id, invoice_number, invoice_type, source, customer_id, customer_name_snapshot, issue_date, status,
        subtotal, tax_total, discount_total, total, paid_total, balance_due, notes, currency, exchange_rate, subtotal_base, tax_amount_base, discount_amount_base, total_base, created_by, updated_by, emitted_at)
       VALUES (?, ?, ?, 'standard', 'sales_crm', ?, ?, date('now'), 'issued', ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        legacyInvoice.lastID,
        companyId,
        '',
        source.customer_id || null,
        await resolveCustomerName(db, companyId, source.customer_id),
        totals.subtotal,
        totals.tax,
        totals.discount,
        totals.total,
        totals.total,
        notes || source.notes || null,
        currency,
        totals.subtotal,
        totals.tax,
        totals.discount,
        totals.total,
        userId,
        userId
      ]
    );
    const invoiceNumber = buildSequence('FAC', header.lastID);
    await runDb(db, 'UPDATE invoice_headers SET invoice_number = ? WHERE id = ? AND company_id = ?', [invoiceNumber, header.lastID, companyId]);
    const saleInsert = await runDb(
      db,
      `INSERT INTO sales
       (company_id, cliente_id, prospect_id, seller_user_id, opportunity_id, quote_id, order_id, invoice_header_id, sale_number, sale_type, status,
        subtotal, discount, tax, total, commission, commission_rate, notes, created_by, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cerrada', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        source.customer_id || null,
        source.prospect_id || null,
        source.seller_user_id,
        source.opportunity_id || null,
        source.quote_id || null,
        sourceType === 'order' ? source.id : null,
        header.lastID,
        '',
        saleType,
        totals.subtotal,
        totals.discount,
        totals.tax,
        totals.total,
        commission,
        rate,
        notes || source.notes || null,
        userId
      ]
    );
    const saleNumber = buildSequence('VEN', saleInsert.lastID);
    await runDb(db, 'UPDATE sales SET sale_number = ? WHERE id = ? AND company_id = ?', [saleNumber, saleInsert.lastID, companyId]);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const saleLine = await insertSalesLine(db, 'sales_lines', saleInsert.lastID, companyId, line, index + 1);
      const invoiceItem = await runDb(
        db,
        `INSERT INTO invoice_items
         (invoice_id, header_id, item_id, qty, unit_price, line_total, company_id, line_type, description, tax_amount, subtotal, total, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [legacyInvoice.lastID, header.lastID, line.itemId || null, line.qty, line.unitPrice, line.total, companyId, line.lineType === 'product' ? 'inventory' : 'manual', line.description, line.tax, line.subtotal, line.total, index + 1]
      );
      if (line.lineType === 'product') {
        await applyProductStock(db, companyId, line.itemId, line.qty, saleInsert.lastID, saleLine.lastID, invoiceItem.lastID, header.lastID, userId);
      }
    }
    await runDb(db, `INSERT INTO invoice_status_history (invoice_header_id, company_id, from_status, to_status, notes, changed_by, created_at)
      VALUES (?, ?, NULL, 'issued', 'Factura generada desde Ventas / CRM', ?, CURRENT_TIMESTAMP)`, [header.lastID, companyId, userId]);
    await runDb(db, `INSERT INTO sales_commissions (company_id, sale_id, seller_user_id, base_amount, rate, amount, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pendiente', CURRENT_TIMESTAMP)`, [companyId, saleInsert.lastID, source.seller_user_id, totals.total, rate, commission]);
    if (sourceType === 'order') {
      await runDb(db, "UPDATE sales_orders SET status = 'cerrado', closed_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?", [source.id, companyId]);
    }
    if (source.opportunity_id) {
      await runDb(db, "UPDATE sales_opportunities SET stage = 'cerrada_ganada', closed_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?", [source.opportunity_id, companyId]);
    }
    return { saleId: saleInsert.lastID, saleNumber, invoiceHeaderId: header.lastID };
  });
}

async function buildSalesViewModel(db, companyId, userId, access, query, flash) {
  const section = normalizeSection(query.section);
  const prospectScope = buildSellerScope('p.assigned_user_id', access, companyId);
  const opportunityScope = buildSellerScope('o.seller_user_id', access, companyId);
  const quoteScope = buildSellerScope('q.seller_user_id', access, companyId);
  const orderScope = buildSellerScope('o.seller_user_id', access, companyId);
  const saleScope = buildSellerScope('s.seller_user_id', access, companyId);
  const commissionScope = buildSellerScope('sc.seller_user_id', access, companyId);
  const goalScope = buildSellerScope('g.seller_user_id', access, companyId);
  const [
    customers,
    prospects,
    opportunities,
    quotes,
    orders,
    salesRows,
    commissions,
    goals,
    users,
    items,
    stats
  ] = await Promise.all([
    allDb(db, 'SELECT id, name, customer_code, email, phone FROM customers WHERE company_id = ? AND COALESCE(is_voided, 0) = 0 ORDER BY name LIMIT 300', [companyId]),
    allDb(db, `SELECT p.*, u.username AS assigned_name FROM sales_prospects p LEFT JOIN users u ON u.id = p.assigned_user_id AND u.company_id = p.company_id WHERE ${prospectScope.where} ORDER BY p.created_at DESC LIMIT 300`, prospectScope.params),
    allDb(db, `SELECT o.*, c.name AS customer_name, p.name AS prospect_name, u.username AS seller_name FROM sales_opportunities o LEFT JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id LEFT JOIN sales_prospects p ON p.id = o.prospect_id AND p.company_id = o.company_id LEFT JOIN users u ON u.id = o.seller_user_id AND u.company_id = o.company_id WHERE ${opportunityScope.where} ORDER BY o.created_at DESC LIMIT 300`, opportunityScope.params),
    allDb(db, `SELECT q.*, c.name AS customer_name, p.name AS prospect_name, u.username AS seller_name FROM sales_quotes q LEFT JOIN customers c ON c.id = q.customer_id AND c.company_id = q.company_id LEFT JOIN sales_prospects p ON p.id = q.prospect_id AND p.company_id = q.company_id LEFT JOIN users u ON u.id = q.seller_user_id AND u.company_id = q.company_id WHERE ${quoteScope.where} ORDER BY q.created_at DESC LIMIT 300`, quoteScope.params),
    allDb(db, `SELECT o.*, c.name AS customer_name, p.name AS prospect_name, u.username AS seller_name FROM sales_orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id LEFT JOIN sales_prospects p ON p.id = o.prospect_id AND p.company_id = o.company_id LEFT JOIN users u ON u.id = o.seller_user_id AND u.company_id = o.company_id WHERE ${orderScope.where} ORDER BY o.created_at DESC LIMIT 300`, orderScope.params),
    allDb(db, `SELECT s.*, c.name AS customer_name, p.name AS prospect_name, u.username AS seller_name, ih.invoice_number FROM sales s LEFT JOIN customers c ON c.id = s.cliente_id AND c.company_id = s.company_id LEFT JOIN sales_prospects p ON p.id = s.prospect_id AND p.company_id = s.company_id LEFT JOIN users u ON u.id = s.seller_user_id AND u.company_id = s.company_id LEFT JOIN invoice_headers ih ON ih.id = s.invoice_header_id AND ih.company_id = s.company_id WHERE ${saleScope.where} ORDER BY s.created_at DESC LIMIT 300`, saleScope.params),
    allDb(db, `SELECT sc.*, s.sale_number, u.username AS seller_name FROM sales_commissions sc JOIN sales s ON s.id = sc.sale_id AND s.company_id = sc.company_id LEFT JOIN users u ON u.id = sc.seller_user_id AND u.company_id = sc.company_id WHERE ${commissionScope.where} ORDER BY sc.created_at DESC LIMIT 300`, commissionScope.params),
    allDb(db, `SELECT g.*, u.username AS seller_name FROM sales_goals g LEFT JOIN users u ON u.id = g.seller_user_id AND u.company_id = g.company_id WHERE ${goalScope.where} ORDER BY g.period_start DESC LIMIT 100`, goalScope.params),
    allDb(db, 'SELECT u.id, u.username, COALESCE(sp.commercial_role, u.role) AS commercial_role, sp.supervisor_user_id, sp.commission_rate FROM users u LEFT JOIN sales_user_profiles sp ON sp.user_id = u.id AND sp.company_id = u.company_id WHERE u.company_id = ? ORDER BY u.username', [companyId]),
    allDb(db, 'SELECT id, name, sku, qty, price FROM items WHERE company_id = ? ORDER BY name LIMIT 500', [companyId]),
    fetchSalesStats(db, companyId, access)
  ]);
  return {
    lang: 'es',
    csrfToken: '',
    currentModule: 'sales',
    moduleTabs: buildSalesModuleTabs(section),
    activeSection: section,
    access,
    userId,
    customers,
    prospects,
    opportunities,
    quotes,
    orders,
    salesRows,
    commissions,
    goals,
    users,
    items,
    stats,
    flash
  };
}

function buildSalesModuleTabs(active) {
  return [
    { key: 'dashboard', label: 'Panel', href: '/sales' },
    { key: 'clients', label: 'Clientes y prospectos', href: '/sales?section=clients' },
    { key: 'opportunities', label: 'Oportunidades', href: '/sales?section=opportunities' },
    { key: 'quotes', label: 'Cotizaciones', href: '/sales?section=quotes' },
    { key: 'orders', label: 'Pedidos', href: '/sales?section=orders' },
    { key: 'sales', label: 'Ventas', href: '/sales?section=sales' },
    { key: 'commissions', label: 'Comisiones', href: '/sales?section=commissions' },
    { key: 'goals', label: 'Metas', href: '/sales?section=goals' },
    { key: 'reports', label: 'Reportes', href: '/sales?section=reports' },
    { key: 'team', label: 'Equipo', href: '/sales?section=team' }
  ].map((tab) => ({ ...tab, active: tab.key === active }));
}

async function fetchSalesStats(db, companyId, access) {
  const scope = buildSellerScope('seller_user_id', access, companyId);
  const sales = await getDb(db, `SELECT COUNT(1) AS count, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(commission), 0) AS commission FROM sales WHERE ${scope.where}`, scope.params);
  const opportunities = await getDb(db, `SELECT COUNT(1) AS count, COALESCE(SUM(expected_amount), 0) AS amount FROM sales_opportunities WHERE ${scope.where}`, scope.params);
  const quotes = await getDb(db, `SELECT COUNT(1) AS count, COALESCE(SUM(total), 0) AS total FROM sales_quotes WHERE ${scope.where}`, scope.params);
  const orders = await getDb(db, `SELECT COUNT(1) AS count, COALESCE(SUM(total), 0) AS total FROM sales_orders WHERE ${scope.where}`, scope.params);
  return { sales, opportunities, quotes, orders };
}

async function fetchSaleBundle(db, companyId, saleId, access) {
  if (!saleId) return null;
  const scope = buildSellerScope('s.seller_user_id', access, companyId);
  const sale = await getDb(db, `SELECT s.*, c.name AS customer_name, p.name AS prospect_name, u.username AS seller_name, ih.invoice_number
    FROM sales s
    LEFT JOIN customers c ON c.id = s.cliente_id AND c.company_id = s.company_id
    LEFT JOIN sales_prospects p ON p.id = s.prospect_id AND p.company_id = s.company_id
    LEFT JOIN users u ON u.id = s.seller_user_id AND u.company_id = s.company_id
    LEFT JOIN invoice_headers ih ON ih.id = s.invoice_header_id AND ih.company_id = s.company_id
    WHERE s.id = ? AND ${scope.where}`, [saleId, ...scope.params]);
  if (!sale) return null;
  sale.lines = await allDb(db, 'SELECT * FROM sales_lines WHERE sale_id = ? AND company_id = ? ORDER BY sort_order, id', [sale.id, companyId]);
  sale.movements = await allDb(db, 'SELECT sim.*, i.name AS item_name, i.sku FROM sales_inventory_movements sim LEFT JOIN items i ON i.id = sim.item_id AND i.company_id = sim.company_id WHERE sim.sale_id = ? AND sim.company_id = ? ORDER BY sim.created_at DESC', [sale.id, companyId]);
  return sale;
}

async function fetchQuoteBundle(db, companyId, quoteId, access, buildFileUrl) {
  if (!quoteId) return null;
  const scope = buildSellerScope('q.seller_user_id', access, companyId);
  const quote = await getDb(db, `SELECT q.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
      p.name AS prospect_name, p.email AS prospect_email, p.phone AS prospect_phone,
      u.username AS seller_name, o.title AS opportunity_title
    FROM sales_quotes q
    LEFT JOIN customers c ON c.id = q.customer_id AND c.company_id = q.company_id
    LEFT JOIN sales_prospects p ON p.id = q.prospect_id AND p.company_id = q.company_id
    LEFT JOIN users u ON u.id = q.seller_user_id AND u.company_id = q.company_id
    LEFT JOIN sales_opportunities o ON o.id = q.opportunity_id AND o.company_id = q.company_id
    WHERE q.id = ? AND ${scope.where}`, [quoteId, ...scope.params]);
  if (!quote) return null;
  quote.lines = await allDb(db, 'SELECT * FROM sales_quote_lines WHERE quote_id = ? AND company_id = ? ORDER BY sort_order, id', [quote.id, companyId]);
  const attachments = await allDb(db, `SELECT *
    FROM sales_quote_attachments
    WHERE quote_id = ? AND company_id = ?
    ORDER BY created_at ASC, id ASC`, [quote.id, companyId]);
  quote.attachments = attachments.map((attachment) => ({
    ...attachment,
    file_url: typeof buildFileUrl === 'function' ? buildFileUrl(attachment.file_path) : null,
    is_image: Boolean(attachment.mime_type && attachment.mime_type.startsWith('image/'))
  }));
  return quote;
}

async function fetchScopedRow(db, table, companyId, id, access) {
  if (!id) return null;
  const scope = buildSellerScope('seller_user_id', access, companyId);
  return getDb(db, `SELECT * FROM ${table} WHERE id = ? AND ${scope.where}`, [id, ...scope.params]);
}

async function parseCommercialLines(db, companyId, body) {
  const lineType = normalizeLineType(body.line_type);
  const qty = Math.max(0, toNumber(body.qty, 1));
  const unitPrice = Math.max(0, toNumber(body.unit_price, 0));
  if (!qty || !unitPrice) return [];
  if (lineType === 'product') {
    const itemId = parseId(body.item_id);
    if (!itemId) return [];
    const item = await getDb(db, 'SELECT id, name, sku, price, qty FROM items WHERE id = ? AND company_id = ?', [itemId, companyId]);
    if (!item) return [];
    const subtotal = round2(qty * unitPrice);
    return [{ lineType, itemId, description: item.name, qty, unitPrice, subtotal, tax: 0, total: subtotal }];
  }
  const description = clean(body.description, (v) => String(v || '').trim());
  if (!description) return [];
  const subtotal = round2(qty * unitPrice);
  return [{ lineType: 'service', itemId: null, description, qty, unitPrice, subtotal, tax: 0, total: subtotal }];
}

function computeTotals(lines, discountInput, taxRateInput, fixedTax) {
  const subtotal = round2((lines || []).reduce((sum, line) => sum + toNumber(line.subtotal, 0), 0));
  const discount = Math.min(subtotal, Math.max(0, round2(toNumber(discountInput, 0))));
  const tax = fixedTax !== undefined ? round2(toNumber(fixedTax, 0)) : round2(Math.max(0, subtotal - discount) * (Math.max(0, toNumber(taxRateInput, 0)) / 100));
  return { subtotal, discount, tax, total: round2(subtotal - discount + tax) };
}

async function validateStock(db, companyId, lines) {
  const errors = [];
  for (const line of lines) {
    if (line.lineType !== 'product') continue;
    const item = await getDb(db, 'SELECT name, qty FROM items WHERE id = ? AND company_id = ?', [line.itemId, companyId]);
    if (!item) errors.push(`Producto no encontrado: ${line.description}.`);
    if (item && toNumber(item.qty, 0) < toNumber(line.qty, 0)) {
      errors.push(`Stock insuficiente para ${item.name}. Disponible: ${item.qty}.`);
    }
  }
  return errors;
}

async function applyProductStock(db, companyId, itemId, qty, saleId, saleLineId, invoiceItemId, invoiceHeaderId, userId) {
  const item = await getDb(db, 'SELECT qty FROM items WHERE id = ? AND company_id = ?', [itemId, companyId]);
  const before = toNumber(item && item.qty, 0);
  const after = round2(before - qty);
  if (after < 0) throw new Error('Stock insuficiente durante el cierre de venta.');
  await runDb(db, 'UPDATE items SET qty = ? WHERE id = ? AND company_id = ?', [after, itemId, companyId]);
  await runDb(db, `INSERT INTO sales_inventory_movements (company_id, sale_id, sale_line_id, item_id, qty, stock_before, stock_after, movement_type, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sale', ?, CURRENT_TIMESTAMP)`, [companyId, saleId, saleLineId, itemId, qty, before, after, userId]);
  await runDb(db, `INSERT INTO invoice_inventory_movements (invoice_header_id, invoice_item_id, item_id, company_id, movement_type, qty, stock_before, stock_after, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, 'Descuento por venta CRM', ?, CURRENT_TIMESTAMP)`, [invoiceHeaderId, invoiceItemId, itemId, companyId, qty, before, after, userId]);
}

async function insertSalesLine(db, table, parentId, companyId, line, sortOrder) {
  const foreignKey = table === 'sales_quote_lines' ? 'quote_id' : table === 'sales_order_lines' ? 'order_id' : 'sale_id';
  return runDb(
    db,
    `INSERT INTO ${table} (company_id, ${foreignKey}, line_type, item_id, description, qty, unit_price, subtotal, tax, total, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, parentId, line.lineType, line.itemId || null, line.description, line.qty, line.unitPrice, line.subtotal, line.tax || 0, line.total, sortOrder]
  );
}

async function insertQuoteAttachments(db, companyId, quoteId, files, userId) {
  const attachments = Array.isArray(files) ? files : [];
  for (const file of attachments) {
    if (!file || !file.path) continue;
    await runDb(
      db,
      `INSERT INTO sales_quote_attachments
       (company_id, quote_id, file_path, original_name, mime_type, file_size, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [companyId, quoteId, file.path, file.originalname || null, file.mimetype || null, file.size || null, userId || null]
    );
  }
}

function buildQuoteUpload() {
  const uploadDir = path.resolve(path.join(STORAGE_UPLOADS_DIR, 'sales', 'quotes'));
  ensureDir(uploadDir);
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: (req, file, cb) => {
        const ext = safeExtension(file.originalname);
        const token = crypto.randomBytes(8).toString('hex');
        cb(null, `${Date.now()}-${token}${ext}`);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, isAllowedQuoteAttachment(file))
  });
}

function isAllowedQuoteAttachment(file) {
  const allowedMime = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv'
  ]);
  const allowedExt = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.webp']);
  if (file && file.mimetype && file.mimetype.startsWith('image/')) return true;
  return allowedMime.has(file && file.mimetype) || allowedExt.has(safeExtension(file && file.originalname));
}

function safeExtension(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return /^[.][a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanupUploadedFiles(files) {
  (Array.isArray(files) ? files : []).forEach((file) => {
    if (!file || !file.path) return;
    fs.unlink(file.path, () => {});
  });
}

async function resolveSalesAccess(db, companyId, user, permissionMap) {
  const userId = user && parseId(user.id);
  const profile = userId ? await getDb(db, 'SELECT * FROM sales_user_profiles WHERE company_id = ? AND user_id = ?', [companyId, userId]) : null;
  const rawRole = normalizeCommercialRole((profile && profile.commercial_role) || (user && user.role));
  const isAdmin = Boolean(permissionMap && permissionMap.isAdmin) || rawRole === 'admin';
  const role = isAdmin ? 'admin' : rawRole;
  if (role === 'manager') return { role, sellerIds: [], unrestricted: true };
  if (role === 'admin') return { role, sellerIds: [], unrestricted: true };
  if (role === 'supervisor') {
    const rows = await allDb(db, 'SELECT user_id FROM sales_user_profiles WHERE company_id = ? AND supervisor_user_id = ? AND is_active = 1', [companyId, userId]);
    return { role, sellerIds: [userId, ...rows.map((row) => row.user_id).filter(Boolean)], unrestricted: false };
  }
  return { role: 'seller', sellerIds: [userId], unrestricted: false };
}

function buildSellerScope(column, access, companyId) {
  const companyColumn = column.includes('.') ? `${column.split('.')[0]}.company_id` : 'company_id';
  if (access && access.unrestricted) return { where: `${companyColumn} = ?`, params: [companyId] };
  const ids = access && access.sellerIds && access.sellerIds.length ? access.sellerIds : [0];
  return { where: `${companyColumn} = ? AND ${column} IN (${ids.map(() => '?').join(',')})`, params: [companyId, ...ids] };
}

function normalizeAssignableSeller(input, fallbackUserId, access) {
  const requested = parseId(input);
  if (access && access.unrestricted && requested) return requested;
  if (access && access.sellerIds && requested && access.sellerIds.includes(requested)) return requested;
  return fallbackUserId;
}

async function resolveSellerCommissionRate(db, companyId, sellerId) {
  const row = await getDb(db, 'SELECT commission_rate FROM sales_user_profiles WHERE company_id = ? AND user_id = ?', [companyId, sellerId]);
  return row ? toNumber(row.commission_rate, 0) : 0;
}

async function resolveCompanyBaseCurrency(db, companyId) {
  const row = await getDb(db, 'SELECT base_currency, currency FROM companies WHERE id = ?', [companyId]);
  return String((row && (row.base_currency || row.currency)) || 'GTQ').trim().toUpperCase() || 'GTQ';
}

async function resolveCustomerName(db, companyId, customerId) {
  if (!customerId) return null;
  const row = await getDb(db, 'SELECT name FROM customers WHERE id = ? AND company_id = ?', [customerId, companyId]);
  return row ? row.name : null;
}

function mapStoredLine(row) {
  return {
    lineType: normalizeLineType(row.line_type),
    itemId: parseId(row.item_id),
    description: row.description,
    qty: toNumber(row.qty, 0),
    unitPrice: toNumber(row.unit_price, 0),
    subtotal: toNumber(row.subtotal, 0),
    tax: toNumber(row.tax, 0),
    total: toNumber(row.total, 0)
  };
}

function resolveSaleType(lines) {
  const hasProduct = lines.some((line) => line.lineType === 'product');
  const hasService = lines.some((line) => line.lineType === 'service');
  if (hasProduct && hasService) return 'mixto';
  return hasService ? 'servicio' : 'producto';
}

function normalizeCommercialRole(value) {
  const text = String(value || '').toLowerCase().trim();
  if (['admin', 'administrador'].includes(text)) return 'admin';
  if (['manager', 'gerente', 'gerente_ventas', 'gerente de ventas'].includes(text)) return 'manager';
  if (['supervisor', 'supervisor_ventas', 'supervisor de ventas'].includes(text)) return 'supervisor';
  return 'seller';
}

function normalizeOpportunityStage(value) {
  const text = String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return ['prospecto', 'oportunidad', 'cotizacion', 'pedido', 'factura', 'cerrada_ganada', 'cerrada_perdida'].includes(text) ? text : 'oportunidad';
}

function normalizeCommercialStatus(value, fallback) {
  const text = String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return text || fallback;
}

function normalizeLineType(value) {
  return String(value || '').toLowerCase() === 'service' || String(value || '').toLowerCase() === 'servicio' ? 'service' : 'product';
}

function normalizeSection(value) {
  const text = String(value || 'dashboard').toLowerCase().trim();
  return ['dashboard', 'clients', 'opportunities', 'quotes', 'orders', 'sales', 'commissions', 'goals', 'reports', 'team'].includes(text) ? text : 'dashboard';
}

function parseId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value) {
  return Math.round((toNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function clean(value, normalizer) {
  if (typeof normalizer === 'function') return normalizer(value);
  return String(value || '').trim();
}

function getSessionUserId(req) {
  return req.session && req.session.user ? parseId(req.session.user.id) : null;
}

function buildSequence(prefix, id) {
  return `${prefix}-${String(id || 0).padStart(6, '0')}`;
}

function todayMonthStart() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function todayMonthEnd() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
}

function setSalesFlash(req, type, message) {
  if (!req.session) return;
  req.session.flash = { type, message };
}

function withTransaction(db, enqueueDbTransaction, commitTransaction, rollbackTransaction, work) {
  return new Promise((resolve, reject) => {
    enqueueDbTransaction((finish) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        Promise.resolve()
          .then(work)
          .then((result) => {
            commitTransaction(finish, (commitError) => {
              if (commitError) return reject(commitError);
              return resolve(result);
            });
          })
          .catch((error) => rollbackTransaction(finish, () => reject(error)));
      });
    });
  });
}

function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      return resolve(row || null);
    });
  });
}

function allDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      return resolve(rows || []);
    });
  });
}

module.exports = {
  registerSalesRoutes
};
