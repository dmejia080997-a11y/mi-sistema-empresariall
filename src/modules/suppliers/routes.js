const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { STORAGE_UPLOADS_DIR } = require('../../core/storage-paths');

const SUPPLIER_STATUSES = [
  ['draft', 'Borrador'],
  ['pending_review', 'Pendiente de revision'],
  ['approved', 'Aprobado'],
  ['active', 'Activo'],
  ['suspended', 'Suspendido'],
  ['blocked', 'Bloqueado'],
  ['inactive', 'Inactivo']
];
const EVALUATION_STATUSES = ['recommended', 'observation', 'not_recommended', 'blocked'];
const UPLOAD_ROOT = path.join(STORAGE_UPLOADS_DIR, 'suppliers');
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.xls', '.xlsx', '.doc', '.docx']);

function registerSupplierRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    hasPermission,
    getCompanyId,
    csrfMiddleware,
    setFlash,
    logAction,
    buildFileUrl
  } = deps;

  ensureDir(UPLOAD_ROOT);
  const schemaReady = ensureSupplierSchema(db).catch((error) => {
    console.error('[suppliers] schema initialization failed', error);
    throw error;
  });
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const target = path.join(UPLOAD_ROOT, `company-${getCompanyId(req) || 'unknown'}`);
        ensureDir(target);
        cb(null, target);
      },
      filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExtension(file.originalname)}`);
      }
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_EXTENSIONS.has(safeExtension(file.originalname))) return cb(null, true);
      const error = new Error('SUPPLIER_FILETYPE');
      error.code = 'SUPPLIER_FILETYPE';
      return cb(error);
    }
  });

  app.get('/suppliers', requireAuth, requirePermission('suppliers', 'view'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const filters = normalizeFilters(req.query);
    const where = ['s.company_id = ?'];
    const params = [companyId];
    if (filters.q) {
      where.push('(s.code LIKE ? OR s.trade_name LIKE ? OR s.legal_name LIKE ? OR s.tax_id LIKE ?)');
      const term = `%${filters.q}%`;
      params.push(term, term, term, term);
    }
    if (filters.type) {
      where.push('s.supplier_type = ?');
      params.push(filters.type);
    }
    if (filters.status) {
      where.push('s.status = ?');
      params.push(filters.status);
    }
    if (filters.country) {
      where.push('s.country = ?');
      params.push(filters.country);
    }
    const suppliers = await allDb(db, `
      SELECT s.*,
             (SELECT COUNT(*) FROM supplier_contacts c WHERE c.supplier_id = s.id AND c.company_id = s.company_id AND c.status = 'active') AS contact_count,
             (SELECT ROUND(AVG(e.overall_rating), 1) FROM supplier_evaluations e WHERE e.supplier_id = s.id AND e.company_id = s.company_id AND e.status = 'active') AS rating
      FROM suppliers s
      WHERE ${where.join(' AND ')}
      ORDER BY s.updated_at DESC, s.id DESC
    `, params);
    const summary = await getDb(db, `
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN supplier_type = 'national' THEN 1 ELSE 0 END) AS national,
             SUM(CASE WHEN supplier_type = 'international' THEN 1 ELSE 0 END) AS international,
             SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
      FROM suppliers WHERE company_id = ?
    `, [companyId]);
    const countries = await allDb(db, 'SELECT DISTINCT country FROM suppliers WHERE company_id = ? AND country IS NOT NULL AND country <> ? ORDER BY country', [companyId, '']);
    return res.render('suppliers', supplierLocals(res, {
      suppliers,
      summary: summary || {},
      countries,
      filters,
      statuses: SUPPLIER_STATUSES
    }));
  }));

  app.get('/suppliers/new', requireAuth, requirePermission('suppliers', 'create'), asyncRoute(async (req, res) => {
    await schemaReady;
    return res.render('supplier-form', supplierLocals(res, {
      supplier: {},
      statuses: SUPPLIER_STATUSES,
      formAction: '/suppliers/create',
      formTitle: 'Registrar proveedor'
    }));
  }));

  app.get('/suppliers/reports', requireAuth, requirePermission('suppliers', 'reports'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const [summary, byCountry, byType, blocked, expiredDocuments, purchases, priceHistory, delivery, payables] = await Promise.all([
      getDb(db, `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM suppliers WHERE company_id = ?`, [companyId]),
      allDb(db, `SELECT COALESCE(country, 'Sin pais') AS label, COUNT(*) AS total FROM suppliers WHERE company_id = ? GROUP BY COALESCE(country, 'Sin pais') ORDER BY total DESC`, [companyId]),
      allDb(db, `SELECT supplier_type AS label, COUNT(*) AS total FROM suppliers WHERE company_id = ? GROUP BY supplier_type ORDER BY total DESC`, [companyId]),
      allDb(db, `SELECT id, code, trade_name, country FROM suppliers WHERE company_id = ? AND status = 'blocked' ORDER BY updated_at DESC`, [companyId]),
      allDb(db, `SELECT d.*, s.code, s.trade_name FROM supplier_documents d JOIN suppliers s ON s.id = d.supplier_id AND s.company_id = d.company_id WHERE d.company_id = ? AND d.expires_at IS NOT NULL AND d.expires_at < date('now') ORDER BY d.expires_at`, [companyId]),
      allDb(db, `SELECT s.id, s.code, s.trade_name, COUNT(po.id) AS order_count, COALESCE(SUM(po.total), 0) AS total FROM suppliers s LEFT JOIN supplier_purchase_orders po ON po.supplier_id = s.id AND po.company_id = s.company_id AND po.status <> 'inactive' WHERE s.company_id = ? GROUP BY s.id ORDER BY total DESC`, [companyId]),
      allDb(db, `SELECT s.id, s.code, s.trade_name, i.name AS item_name, sp.last_price, sp.currency, sp.updated_at FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id AND s.company_id = sp.company_id LEFT JOIN items i ON i.id = sp.item_id AND i.company_id = sp.company_id WHERE sp.company_id = ? AND sp.status = 'active' ORDER BY sp.updated_at DESC LIMIT 250`, [companyId]),
      allDb(db, `SELECT id, code, trade_name, average_delivery_days FROM suppliers WHERE company_id = ? AND average_delivery_days > 0 ORDER BY average_delivery_days DESC`, [companyId]),
      allDb(db, `SELECT s.id, s.code, s.trade_name, COUNT(b.id) AS bill_count, COALESCE(SUM(b.total), 0) AS total, COALESCE(SUM((SELECT SUM(bp.amount) FROM bill_payments bp WHERE bp.bill_id = b.id AND bp.company_id = b.company_id)), 0) AS paid FROM suppliers s LEFT JOIN bills b ON b.supplier_id = s.id AND b.company_id = s.company_id WHERE s.company_id = ? GROUP BY s.id ORDER BY total DESC`, [companyId]).catch(() => [])
    ]);
    return res.render('supplier-reports', supplierLocals(res, { summary: summary || {}, byCountry, byType, blocked, expiredDocuments, purchases, priceHistory, delivery, payables }));
  }));

  app.post('/suppliers/create', requireAuth, requirePermission('suppliers', 'create'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getUserId(req);
    const data = normalizeSupplier(req.body);
    if (['approved', 'active'].includes(data.status) && !hasPermission(req.session.permissionMap, 'suppliers', 'approve')) data.status = 'draft';
    if (data.status === 'blocked' && !hasPermission(req.session.permissionMap, 'suppliers', 'block')) data.status = 'draft';
    if (data.status === 'inactive' && !hasPermission(req.session.permissionMap, 'suppliers', 'delete')) data.status = 'draft';
    if (!hasPermission(req.session.permissionMap, 'suppliers', 'view_fiscal')) {
      data.tax_id = null;
      data.tax_address = null;
      data.tax_regime = null;
      data.withholding_isr = 0;
      data.withholding_iva = 0;
      data.electronic_invoice = 0;
      data.invoice_name = null;
    }
    if (!data.trade_name || !data.supplier_type) {
      setFlash(req, 'error', 'Tipo y nombre comercial son obligatorios.');
      return res.redirect('/suppliers/new');
    }
    const insert = await runDb(db, `
      INSERT INTO suppliers (
        company_id, code, supplier_type, trade_name, legal_name, tax_id, country, origin_country,
        tax_address, warehouse_address, phone, email, website, category, status, primary_currency,
        credit_days, credit_limit, payment_method, average_delivery_days, minimum_order, notes,
        tax_regime, withholding_isr, withholding_iva, electronic_invoice, invoice_name, frequent_incoterm,
        requires_import, frequent_documents, created_by, updated_by, created_at, updated_at
      ) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      companyId, data.supplier_type, data.trade_name, data.legal_name, data.tax_id, data.country, data.origin_country,
      data.tax_address, data.warehouse_address, data.phone, data.email, data.website, data.category, data.status,
      data.primary_currency, data.credit_days, data.credit_limit, data.payment_method, data.average_delivery_days,
      data.minimum_order, data.notes, data.tax_regime, data.withholding_isr, data.withholding_iva,
      data.electronic_invoice, data.invoice_name, data.frequent_incoterm, data.requires_import, data.frequent_documents,
      userId, userId
    ]);
    const code = `PROV-${String(insert.lastID).padStart(6, '0')}`;
    await runDb(db, 'UPDATE suppliers SET code = ? WHERE id = ? AND company_id = ?', [code, insert.lastID, companyId]);
    await auditSupplier(db, companyId, insert.lastID, userId, 'created', { code, trade_name: data.trade_name });
    logAction(userId, 'supplier_created', JSON.stringify({ id: insert.lastID, code }), companyId);
    setFlash(req, 'success', `Proveedor ${code} creado.`);
    return res.redirect(`/suppliers/${insert.lastID}`);
  }));

  app.get('/suppliers/:id', requireAuth, requirePermission('suppliers', 'view'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    const supplier = await scopedSupplier(db, companyId, supplierId);
    if (!supplier) return res.status(404).send('Proveedor no encontrado');
    const canFiscal = hasPermission(req.session.permissionMap, 'suppliers', 'view_fiscal');
    const canBank = hasPermission(req.session.permissionMap, 'suppliers', 'manage_bank');
    const [contacts, banks, documents, terms, evaluations, products, purchaseOrders, auditLogs, items, projects, bills, unlinkedBills, projectExpenses] = await Promise.all([
      allDb(db, 'SELECT * FROM supplier_contacts WHERE supplier_id = ? AND company_id = ? ORDER BY is_primary DESC, name', [supplierId, companyId]),
      canBank ? allDb(db, 'SELECT * FROM supplier_bank_accounts WHERE supplier_id = ? AND company_id = ? ORDER BY id DESC', [supplierId, companyId]) : [],
      allDb(db, 'SELECT * FROM supplier_documents WHERE supplier_id = ? AND company_id = ? ORDER BY updated_at DESC', [supplierId, companyId]),
      getDb(db, 'SELECT * FROM supplier_commercial_terms WHERE supplier_id = ? AND company_id = ? ORDER BY id DESC LIMIT 1', [supplierId, companyId]),
      allDb(db, 'SELECT e.*, u.username AS created_by_name FROM supplier_evaluations e LEFT JOIN users u ON u.id = e.created_by AND u.company_id = e.company_id WHERE e.supplier_id = ? AND e.company_id = ? ORDER BY e.created_at DESC', [supplierId, companyId]),
      allDb(db, 'SELECT sp.*, i.name AS item_name, i.sku FROM supplier_products sp LEFT JOIN items i ON i.id = sp.item_id AND i.company_id = sp.company_id WHERE sp.supplier_id = ? AND sp.company_id = ? ORDER BY i.name', [supplierId, companyId]),
      allDb(db, 'SELECT * FROM supplier_purchase_orders WHERE supplier_id = ? AND company_id = ? ORDER BY created_at DESC', [supplierId, companyId]),
      allDb(db, 'SELECT l.*, u.username FROM supplier_audit_logs l LEFT JOIN users u ON u.id = l.created_by AND u.company_id = l.company_id WHERE l.supplier_id = ? AND l.company_id = ? ORDER BY l.created_at DESC LIMIT 100', [supplierId, companyId]),
      allDb(db, 'SELECT id, name, sku FROM items WHERE company_id = ? ORDER BY name LIMIT 500', [companyId]),
      allDb(db, 'SELECT id, code, name FROM projects WHERE company_id = ? ORDER BY updated_at DESC LIMIT 100', [companyId]).catch(() => []),
      allDb(db, `SELECT b.*, COALESCE((SELECT SUM(bp.amount) FROM bill_payments bp WHERE bp.bill_id = b.id AND bp.company_id = b.company_id), 0) AS paid_total FROM bills b WHERE b.supplier_id = ? AND b.company_id = ? ORDER BY b.created_at DESC`, [supplierId, companyId]).catch(() => []),
      allDb(db, `SELECT id, vendor_name, total, currency, status, created_at FROM bills WHERE company_id = ? AND supplier_id IS NULL ORDER BY created_at DESC LIMIT 100`, [companyId]).catch(() => []),
      allDb(db, `SELECT pe.*, p.code AS project_code, p.name AS project_name FROM project_expenses pe JOIN projects p ON p.id = pe.project_id AND p.company_id = pe.company_id WHERE pe.supplier_id = ? AND pe.company_id = ? ORDER BY pe.created_at DESC`, [supplierId, companyId]).catch(() => [])
    ]);
    const safeSupplier = { ...supplier };
    if (!canFiscal) {
      ['tax_id', 'tax_regime', 'withholding_isr', 'withholding_iva', 'electronic_invoice', 'invoice_name', 'tax_address'].forEach((key) => {
        safeSupplier[key] = null;
      });
      for (let index = documents.length - 1; index >= 0; index -= 1) {
        if (isFiscalDocument(documents[index].document_type)) documents.splice(index, 1);
      }
    }
    documents.forEach((document) => {
      document.file_url = buildFileUrl ? buildFileUrl(document.file_path) : `/${String(document.file_path || '').replace(/\\/g, '/')}`;
    });
    return res.render('supplier-detail', supplierLocals(res, {
      supplier: safeSupplier,
      contacts,
      banks,
      documents,
      terms: terms || {},
      evaluations,
      products,
      purchaseOrders,
      auditLogs,
      items,
      projects,
      bills,
      unlinkedBills,
      projectExpenses,
      statuses: SUPPLIER_STATUSES,
      activeSection: normalizeSection(req.query.tab),
      canFiscal,
      canBank
    }));
  }));

  app.post('/suppliers/:id/update', requireAuth, requirePermission('suppliers', 'edit'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    const currentSupplier = await scopedSupplier(db, companyId, supplierId);
    if (!currentSupplier) return res.status(404).send('Proveedor no encontrado');
    const data = normalizeSupplier(req.body);
    if (!hasPermission(req.session.permissionMap, 'suppliers', 'view_fiscal')) {
      data.tax_id = currentSupplier.tax_id;
      data.tax_address = currentSupplier.tax_address;
      data.tax_regime = currentSupplier.tax_regime;
      data.withholding_isr = currentSupplier.withholding_isr;
      data.withholding_iva = currentSupplier.withholding_iva;
      data.electronic_invoice = currentSupplier.electronic_invoice;
      data.invoice_name = currentSupplier.invoice_name;
    }
    await runDb(db, `
      UPDATE suppliers SET supplier_type = ?, trade_name = ?, legal_name = ?, tax_id = ?, country = ?, origin_country = ?,
        tax_address = ?, warehouse_address = ?, phone = ?, email = ?, website = ?, category = ?, primary_currency = ?,
        credit_days = ?, credit_limit = ?, payment_method = ?, average_delivery_days = ?, minimum_order = ?, notes = ?,
        tax_regime = ?, withholding_isr = ?, withholding_iva = ?, electronic_invoice = ?, invoice_name = ?,
        frequent_incoterm = ?, requires_import = ?, frequent_documents = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND company_id = ?
    `, [
      data.supplier_type, data.trade_name, data.legal_name, data.tax_id, data.country, data.origin_country,
      data.tax_address, data.warehouse_address, data.phone, data.email, data.website, data.category, data.primary_currency,
      data.credit_days, data.credit_limit, data.payment_method, data.average_delivery_days, data.minimum_order, data.notes,
      data.tax_regime, data.withholding_isr, data.withholding_iva, data.electronic_invoice, data.invoice_name,
      data.frequent_incoterm, data.requires_import, data.frequent_documents, getUserId(req), supplierId, companyId
    ]);
    await auditSupplier(db, companyId, supplierId, getUserId(req), 'updated', { trade_name: data.trade_name });
    logAction(getUserId(req), 'supplier_updated', JSON.stringify({ id: supplierId }), companyId);
    setFlash(req, 'success', 'Proveedor actualizado.');
    return res.redirect(`/suppliers/${supplierId}?tab=general`);
  }));

  app.post('/suppliers/:id/status', requireAuth, requirePermission('suppliers', 'edit'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    const status = normalizeStatus(req.body.status);
    const permissionMap = req.session.permissionMap;
    if ((status === 'approved' || status === 'active') && !hasPermission(permissionMap, 'suppliers', 'approve')) return res.status(403).send('Forbidden');
    if (status === 'blocked' && !hasPermission(permissionMap, 'suppliers', 'block')) return res.status(403).send('Forbidden');
    if (status === 'inactive' && !hasPermission(permissionMap, 'suppliers', 'delete')) return res.status(403).send('Forbidden');
    const result = await runDb(db, 'UPDATE suppliers SET status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [status, getUserId(req), supplierId, companyId]);
    if (!result.changes) return res.status(404).send('Proveedor no encontrado');
    await auditSupplier(db, companyId, supplierId, getUserId(req), 'status_changed', { status, reason: clean(req.body.reason) });
    logAction(getUserId(req), 'supplier_status_changed', JSON.stringify({ id: supplierId, status }), companyId);
    setFlash(req, 'success', 'Estado actualizado.');
    return res.redirect(`/suppliers/${supplierId}`);
  }));

  app.post('/suppliers/:id/contacts', requireAuth, requirePermission('suppliers', 'edit'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    if (!await scopedSupplier(db, companyId, supplierId)) return res.status(404).send('Proveedor no encontrado');
    const userId = getUserId(req);
    const isPrimary = checkbox(req.body.is_primary);
    if (isPrimary) await runDb(db, "UPDATE supplier_contacts SET is_primary = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE supplier_id = ? AND company_id = ?", [userId, supplierId, companyId]);
    await runDb(db, `INSERT INTO supplier_contacts
      (company_id, supplier_id, name, position, phone, whatsapp, email, area, is_primary, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, supplierId, clean(req.body.name), clean(req.body.position), clean(req.body.phone), clean(req.body.whatsapp), clean(req.body.email), clean(req.body.area), isPrimary, userId, userId]);
    await auditSupplier(db, companyId, supplierId, userId, 'contact_added', { name: clean(req.body.name) });
    return res.redirect(`/suppliers/${supplierId}?tab=contacts`);
  }));

  app.post('/suppliers/:id/banks', requireAuth, requirePermission('suppliers', 'manage_bank'), upload.single('support_document'), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    if (!await scopedSupplier(db, companyId, supplierId)) return res.status(404).send('Proveedor no encontrado');
    const userId = getUserId(req);
    await runDb(db, `INSERT INTO supplier_bank_accounts
      (company_id, supplier_id, bank_name, account_name, account_number, account_type, currency, country, swift_aba_iban, notes, support_document_path, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, supplierId, clean(req.body.bank_name), clean(req.body.account_name), clean(req.body.account_number), clean(req.body.account_type), currency(req.body.currency), clean(req.body.country), clean(req.body.swift_aba_iban), clean(req.body.notes), relativeUploadPath(req.file), userId, userId]);
    await auditSupplier(db, companyId, supplierId, userId, 'bank_account_added', { bank: clean(req.body.bank_name) });
    return res.redirect(`/suppliers/${supplierId}?tab=banks`);
  }));

  app.post('/suppliers/:id/documents', requireAuth, requirePermission('suppliers', 'create'), upload.single('document'), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    if (!req.file || !await scopedSupplier(db, companyId, supplierId)) return res.status(400).send('Documento o proveedor invalido');
    if (isFiscalDocument(req.body.document_type) && !hasPermission(req.session.permissionMap, 'suppliers', 'view_fiscal')) return res.status(403).send('Forbidden');
    const userId = getUserId(req);
    await runDb(db, `INSERT INTO supplier_documents
      (company_id, supplier_id, document_type, document_name, file_path, mime_type, expires_at, notes, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, supplierId, clean(req.body.document_type), clean(req.body.document_name) || req.file.originalname, relativeUploadPath(req.file), req.file.mimetype, clean(req.body.expires_at), clean(req.body.notes), userId, userId]);
    await auditSupplier(db, companyId, supplierId, userId, 'document_added', { name: req.file.originalname });
    return res.redirect(`/suppliers/${supplierId}?tab=documents`);
  }));

  app.post('/suppliers/:id/terms', requireAuth, requirePermission('suppliers', 'edit'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    if (!await scopedSupplier(db, companyId, supplierId)) return res.status(404).send('Proveedor no encontrado');
    const userId = getUserId(req);
    await runDb(db, "UPDATE supplier_commercial_terms SET status = 'inactive', updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE supplier_id = ? AND company_id = ? AND status = 'active'", [userId, supplierId, companyId]);
    await runDb(db, `INSERT INTO supplier_commercial_terms
      (company_id, supplier_id, credit_days, credit_limit, currency, payment_method, delivery_days, minimum_order, special_discount, warranty, return_policy, notes, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, supplierId, number(req.body.credit_days), number(req.body.credit_limit), currency(req.body.currency), clean(req.body.payment_method), number(req.body.delivery_days), number(req.body.minimum_order), number(req.body.special_discount), clean(req.body.warranty), clean(req.body.return_policy), clean(req.body.notes), userId, userId]);
    await auditSupplier(db, companyId, supplierId, userId, 'commercial_terms_updated', {});
    return res.redirect(`/suppliers/${supplierId}?tab=general`);
  }));

  app.post('/suppliers/:id/evaluations', requireAuth, requirePermission('suppliers', 'evaluate'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    if (!await scopedSupplier(db, companyId, supplierId)) return res.status(404).send('Proveedor no encontrado');
    const userId = getUserId(req);
    const evaluationStatus = EVALUATION_STATUSES.includes(req.body.evaluation_status) ? req.body.evaluation_status : 'observation';
    await runDb(db, `INSERT INTO supplier_evaluations
      (company_id, supplier_id, product_quality, delivery_time, price, service, document_compliance, complaints, overall_rating, comments, evaluation_status, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, supplierId, rating(req.body.product_quality), rating(req.body.delivery_time), rating(req.body.price), rating(req.body.service), rating(req.body.document_compliance), clean(req.body.complaints), rating(req.body.overall_rating), clean(req.body.comments), evaluationStatus, userId, userId]);
    await auditSupplier(db, companyId, supplierId, userId, 'evaluated', { overall_rating: rating(req.body.overall_rating), evaluation_status: evaluationStatus });
    return res.redirect(`/suppliers/${supplierId}?tab=evaluation`);
  }));

  app.post('/suppliers/:id/products', requireAuth, requirePermission('suppliers', 'edit'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    const itemId = positiveInt(req.body.item_id);
    if (!await scopedSupplier(db, companyId, supplierId)) return res.status(404).send('Proveedor no encontrado');
    const item = await getDb(db, 'SELECT id FROM items WHERE id = ? AND company_id = ?', [itemId, companyId]);
    if (!item) return res.status(400).send('Producto invalido');
    const userId = getUserId(req);
    await runDb(db, `INSERT INTO supplier_products
      (company_id, supplier_id, item_id, supplier_sku, last_price, currency, lead_time_days, is_preferred, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(company_id, supplier_id, item_id) DO UPDATE SET supplier_sku = excluded.supplier_sku, last_price = excluded.last_price,
      currency = excluded.currency, lead_time_days = excluded.lead_time_days, is_preferred = excluded.is_preferred, status = 'active',
      updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [companyId, supplierId, itemId, clean(req.body.supplier_sku), number(req.body.last_price), currency(req.body.currency), number(req.body.lead_time_days), checkbox(req.body.is_preferred), userId, userId]);
    await auditSupplier(db, companyId, supplierId, userId, 'product_linked', { item_id: itemId });
    return res.redirect(`/suppliers/${supplierId}?tab=purchases`);
  }));

  app.post('/suppliers/:id/purchase-orders', requireAuth, requirePermission('suppliers', 'purchase'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    if (!await scopedSupplier(db, companyId, supplierId)) return res.status(404).send('Proveedor no encontrado');
    const userId = getUserId(req);
    const insert = await runDb(db, `INSERT INTO supplier_purchase_orders
      (company_id, supplier_id, order_number, order_date, expected_date, currency, total, notes, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, '', date('now'), ?, ?, ?, ?, 'draft', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, supplierId, clean(req.body.expected_date), currency(req.body.currency), number(req.body.total), clean(req.body.notes), userId, userId]);
    const orderNumber = `OC-${String(insert.lastID).padStart(6, '0')}`;
    await runDb(db, 'UPDATE supplier_purchase_orders SET order_number = ? WHERE id = ? AND company_id = ?', [orderNumber, insert.lastID, companyId]);
    await auditSupplier(db, companyId, supplierId, userId, 'purchase_order_created', { order_number: orderNumber });
    return res.redirect(`/suppliers/${supplierId}?tab=purchases`);
  }));

  app.post('/suppliers/:id/bills/link', requireAuth, requirePermission('accounting', 'manage'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const supplierId = positiveInt(req.params.id);
    const billId = positiveInt(req.body.bill_id);
    if (!await scopedSupplier(db, companyId, supplierId)) return res.status(404).send('Proveedor no encontrado');
    const result = await runDb(db, 'UPDATE bills SET supplier_id = ? WHERE id = ? AND company_id = ?', [supplierId, billId, companyId]);
    if (!result.changes) return res.status(404).send('Cuenta por pagar no encontrada');
    await auditSupplier(db, companyId, supplierId, getUserId(req), 'account_payable_linked', { bill_id: billId });
    return res.redirect(`/suppliers/${supplierId}?tab=payments`);
  }));
}

async function ensureSupplierSchema(db) {
  await runDb(db, `INSERT OR IGNORE INTO permission_modules (code, name, description) VALUES ('suppliers', 'Proveedores', 'Gestion de proveedores nacionales e internacionales')`);
  await runDb(db, `INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES
    ('view','Ver','Acceso de lectura'), ('create','Crear','Crear proveedores'), ('edit','Editar','Editar proveedores'),
    ('delete','Inactivar','Inactivar proveedores'), ('approve','Aprobar','Aprobar proveedores'), ('block','Bloquear','Bloquear proveedores'),
    ('view_fiscal','Ver datos fiscales','Acceso a datos fiscales sensibles'), ('manage_bank','Cuentas bancarias','Ver y administrar cuentas bancarias'),
    ('evaluate','Evaluar','Evaluar proveedores'), ('purchase','Compras','Crear ordenes de compra'), ('reports','Reportes','Ver reportes de proveedores')`);
  await runDb(db, `INSERT OR IGNORE INTO module_actions (module_id, action_id)
    SELECT pm.id, pa.id FROM permission_modules pm, permission_actions pa
    WHERE pm.code = 'suppliers' AND pa.code IN ('view','create','edit','delete','approve','block','view_fiscal','manage_bank','evaluate','purchase','reports')`);

  await runDb(db, `CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, code TEXT, supplier_type TEXT NOT NULL DEFAULT 'national',
    trade_name TEXT NOT NULL, legal_name TEXT, tax_id TEXT, country TEXT, origin_country TEXT, tax_address TEXT, warehouse_address TEXT,
    phone TEXT, email TEXT, website TEXT, category TEXT, status TEXT NOT NULL DEFAULT 'draft', primary_currency TEXT DEFAULT 'GTQ',
    credit_days INTEGER DEFAULT 0, credit_limit REAL DEFAULT 0, payment_method TEXT, average_delivery_days INTEGER DEFAULT 0,
    minimum_order REAL DEFAULT 0, notes TEXT, tax_regime TEXT, withholding_isr INTEGER DEFAULT 0, withholding_iva INTEGER DEFAULT 0,
    electronic_invoice INTEGER DEFAULT 0, invoice_name TEXT, frequent_incoterm TEXT, requires_import INTEGER DEFAULT 0,
    frequent_documents TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER, updated_by INTEGER, UNIQUE(company_id, code)
  )`);
  await createChildTables(db);
  await ensureColumn(db, 'bills', 'supplier_id', 'INTEGER');
  await ensureColumn(db, 'project_expenses', 'supplier_id', 'INTEGER');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_suppliers_company_status ON suppliers (company_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_suppliers_company_name ON suppliers (company_id, trade_name)');
  await appendModule(db, 'companies', 'allowed_modules', 'suppliers');
  await appendModule(db, 'business_activities', 'modules_json', 'suppliers');
}

async function createChildTables(db) {
  const common = `status TEXT NOT NULL DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by INTEGER, updated_by INTEGER`;
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, name TEXT NOT NULL, position TEXT,
    phone TEXT, whatsapp TEXT, email TEXT, area TEXT, is_primary INTEGER DEFAULT 0, ${common})`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, bank_name TEXT, account_name TEXT,
    account_number TEXT, account_type TEXT, currency TEXT, country TEXT, swift_aba_iban TEXT, notes TEXT, support_document_path TEXT, ${common})`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, document_type TEXT, document_name TEXT,
    file_path TEXT NOT NULL, mime_type TEXT, expires_at TEXT, notes TEXT, ${common})`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_commercial_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, credit_days INTEGER DEFAULT 0,
    credit_limit REAL DEFAULT 0, currency TEXT, payment_method TEXT, delivery_days INTEGER DEFAULT 0, minimum_order REAL DEFAULT 0,
    special_discount REAL DEFAULT 0, warranty TEXT, return_policy TEXT, notes TEXT, ${common})`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, product_quality INTEGER DEFAULT 0,
    delivery_time INTEGER DEFAULT 0, price INTEGER DEFAULT 0, service INTEGER DEFAULT 0, document_compliance INTEGER DEFAULT 0,
    complaints TEXT, overall_rating INTEGER DEFAULT 0, comments TEXT, evaluation_status TEXT DEFAULT 'observation', ${common})`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
    supplier_sku TEXT, last_price REAL DEFAULT 0, currency TEXT, lead_time_days INTEGER DEFAULT 0, is_preferred INTEGER DEFAULT 0,
    ${common}, UNIQUE(company_id, supplier_id, item_id))`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, action TEXT NOT NULL, details TEXT,
    ${common})`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, order_number TEXT, order_date TEXT,
    expected_date TEXT, currency TEXT, total REAL DEFAULT 0, notes TEXT, ${common}, UNIQUE(company_id, order_number))`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS supplier_purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, purchase_order_id INTEGER NOT NULL,
    item_id INTEGER, description TEXT, qty REAL DEFAULT 0, unit_price REAL DEFAULT 0, total REAL DEFAULT 0, ${common})`);
  const tables = ['supplier_contacts', 'supplier_bank_accounts', 'supplier_documents', 'supplier_commercial_terms', 'supplier_evaluations', 'supplier_products', 'supplier_audit_logs', 'supplier_purchase_orders', 'supplier_purchase_order_items'];
  for (const table of tables) await runDb(db, `CREATE INDEX IF NOT EXISTS idx_${table}_scope ON ${table} (company_id, supplier_id)`);
}

function normalizeSupplier(body) {
  return {
    supplier_type: body.supplier_type === 'international' ? 'international' : 'national',
    trade_name: clean(body.trade_name), legal_name: clean(body.legal_name), tax_id: clean(body.tax_id),
    country: clean(body.country), origin_country: clean(body.origin_country), tax_address: clean(body.tax_address),
    warehouse_address: clean(body.warehouse_address), phone: clean(body.phone), email: clean(body.email),
    website: clean(body.website), category: clean(body.category), status: normalizeStatus(body.status),
    primary_currency: currency(body.primary_currency), credit_days: number(body.credit_days), credit_limit: number(body.credit_limit),
    payment_method: clean(body.payment_method), average_delivery_days: number(body.average_delivery_days),
    minimum_order: number(body.minimum_order), notes: clean(body.notes), tax_regime: clean(body.tax_regime),
    withholding_isr: checkbox(body.withholding_isr), withholding_iva: checkbox(body.withholding_iva),
    electronic_invoice: checkbox(body.electronic_invoice), invoice_name: clean(body.invoice_name),
    frequent_incoterm: clean(body.frequent_incoterm), requires_import: checkbox(body.requires_import),
    frequent_documents: clean(body.frequent_documents)
  };
}

function supplierLocals(res, extra) {
  return {
    lang: res.locals.lang,
    t: res.locals.t,
    csrfToken: res.locals.csrfToken,
    flash: res.locals.flash,
    currentModule: 'suppliers',
    ...extra
  };
}
function normalizeFilters(query) {
  return { q: clean(query.q), type: ['national', 'international'].includes(query.type) ? query.type : '', status: SUPPLIER_STATUSES.some(([key]) => key === query.status) ? query.status : '', country: clean(query.country) };
}
function normalizeSection(value) {
  const allowed = ['general', 'contacts', 'fiscal', 'banks', 'documents', 'purchases', 'payments', 'evaluation', 'audit'];
  return allowed.includes(value) ? value : 'general';
}
function normalizeStatus(value) { return SUPPLIER_STATUSES.some(([key]) => key === value) ? value : 'draft'; }
function isFiscalDocument(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('fiscal') || normalized.includes('rtu') || normalized.includes('patente') || normalized.includes('dpi');
}
function scopedSupplier(db, companyId, supplierId) { return getDb(db, 'SELECT * FROM suppliers WHERE id = ? AND company_id = ?', [supplierId, companyId]); }
async function auditSupplier(db, companyId, supplierId, userId, action, details) {
  await runDb(db, `INSERT INTO supplier_audit_logs (company_id, supplier_id, action, details, status, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [companyId, supplierId, action, JSON.stringify(details || {}), userId, userId]);
}
async function appendModule(db, table, column, moduleCode) {
  const exists = await getDb(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  if (!exists) return;
  const rows = await allDb(db, `SELECT rowid AS row_id, ${column} AS modules_json FROM ${table}`);
  for (const row of rows) {
    let modules = [];
    try { modules = JSON.parse(row.modules_json || '[]'); } catch (error) { modules = []; }
    if (!Array.isArray(modules) || !modules.length || modules.includes(moduleCode)) continue;
    modules.push(moduleCode);
    await runDb(db, `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, [JSON.stringify(modules), row.row_id]);
  }
}
async function ensureColumn(db, table, column, type) {
  const exists = await getDb(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  if (!exists) return;
  const columns = await allDb(db, `PRAGMA table_info(${table})`);
  if (columns.some((entry) => entry.name === column)) return;
  await runDb(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
function runDb(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function done(error) { if (error) reject(error); else resolve({ lastID: this.lastID, changes: this.changes }); })); }
function getDb(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null))); }
function allDb(db, sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []))); }
function clean(value) { const text = String(value == null ? '' : value).trim(); return text || null; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }
function positiveInt(value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }
function checkbox(value) { return value === '1' || value === 'on' || value === true ? 1 : 0; }
function currency(value) { return String(value || 'GTQ').trim().toUpperCase().slice(0, 8) || 'GTQ'; }
function rating(value) { return Math.min(5, Math.max(1, Math.round(number(value) || 1))); }
function getUserId(req) { return req.session && req.session.user ? req.session.user.id : null; }
function ensureDir(target) { if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true }); }
function safeExtension(name) { return path.extname(String(name || '')).toLowerCase(); }
function relativeUploadPath(file) {
  return file ? path.relative(STORAGE_UPLOADS_DIR, file.path).replace(/\\/g, '/') : null;
}

module.exports = { registerSupplierRoutes, ensureSupplierSchema };
