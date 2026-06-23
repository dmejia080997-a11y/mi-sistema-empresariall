const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { STORAGE_UPLOADS_DIR } = require('../../core/storage-paths');

const PRODUCTION_STATUSES = ['draft', 'pending', 'in_production', 'paused', 'finished', 'cancelled'];
const PRODUCT_TYPES = ['raw_material', 'supply', 'packaging', 'work_in_process', 'finished_good'];
const WASTE_REASONS = ['Corte incorrecto', 'Dano de material', 'Producto defectuoso', 'Ajuste normal', 'Otro'];
const OVERHEAD_METHODS = ['order', 'unit', 'percentage', 'manual'];
const DEFAULT_PRODUCTION_UNITS = ['Litro', 'Tabla', 'Regla', 'Hoja'];
const PRODUCTION_UPLOAD_DIR = path.join(STORAGE_UPLOADS_DIR, 'production', 'products');
const PRODUCT_ATTACHMENT_FIELDS = [
  { name: 'product_photo', maxCount: 1 },
  { name: 'product_support', maxCount: 1 }
];

function ensureProductionUploadDir() {
  if (!fs.existsSync(PRODUCTION_UPLOAD_DIR)) {
    fs.mkdirSync(PRODUCTION_UPLOAD_DIR, { recursive: true });
  }
}

const productionProductUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureProductionUploadDir();
      cb(null, PRODUCTION_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const token = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${token}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'product_photo') {
      return cb(null, Boolean(file.mimetype && file.mimetype.startsWith('image/')));
    }
    if (file.fieldname === 'product_support') {
      const allowed = (file.mimetype && file.mimetype.startsWith('image/')) || file.mimetype === 'application/pdf';
      return cb(null, Boolean(allowed));
    }
    return cb(null, false);
  }
});

let productionBuildFileUrl = null;

function registerProductionRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    getCompanyId,
    normalizeString,
    logAction,
    buildFileUrl
  } = deps;
  productionBuildFileUrl = typeof buildFileUrl === 'function' ? buildFileUrl : null;

  app.set('db', db);
  ensureProductionSchema(db).catch((err) => console.error('[production] schema initialization failed', err));

  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.get('/production', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const dashboard = await buildDashboard(db, companyId);
    const orders = await getOrders(db, companyId, {}, 8);
    res.render('production/index', baseView(req, 'dashboard', { dashboard, orders }));
  }));

  app.get('/production/orders', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const filters = normalizeOrderFilters(req.query);
    if (!filters.status) filters.statuses = ['draft', 'pending', 'paused'];
    const orders = await getOrders(db, companyId, filters, 300);
    const products = await getProducts(db, companyId);
    const users = await allDb(db, 'SELECT id, username FROM users WHERE company_id = ? ORDER BY username', [companyId]);
    res.render('production/index', baseView(req, 'orders', { orders, filters, products, users }));
  }));

  app.post('/production/orders/bulk-status', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const ids = arrayOf(req.body.order_id).map(toId).filter(Boolean);
    const status = enumValue(req.body.status, ['cancelled', 'in_production', 'paused', 'finished'], '');
    if (ids.length && status) {
      await updateOrdersBulkStatus(db, req, companyId, ids, status);
    }
    const returnTo = clean(req.body.return_to);
    if (returnTo === 'wip') return res.redirect('/production/work-in-process');
    if (returnTo === 'finished') return res.redirect('/production/finished-goods');
    return res.redirect('/production/orders');
  }));

  app.get('/production/orders/new', requireAuth, requirePermission('production', 'create_order'), asyncRoute(async (req, res) => {
    res.render('production/index', await orderFormView(req, null, null));
  }));

  app.post('/production/orders/create', requireAuth, requirePermission('production', 'create_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const userId = currentUserId(req);
    const lines = await parseOrderBomLines(db, companyId, req.body);
    if (!lines.length) return res.render('production/index', await orderFormView(req, null, 'Debe agregar al menos una BOM con cantidad mayor a cero.'));
    if (lines.some((line) => !line.items.length)) return res.render('production/index', await orderFormView(req, null, 'Todas las BOM seleccionadas deben tener materiales.'));
    const orderNumber = await nextOrderNumber(db, companyId);
    const estimatedCost = lines.reduce((sum, line) => sum + line.estimatedCost, 0);
    const firstLine = lines[0];
    const totalPlanned = lines.reduce((sum, line) => sum + line.quantity, 0);
    const inserted = await runDb(
      db,
      `INSERT INTO production_orders
       (company_id, order_number, product_id, bom_id, quantity_planned, quantity_finished, status, estimated_start_date, estimated_end_date, estimated_cost, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'draft', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [companyId, orderNumber, firstLine.bom.finished_product_id, firstLine.bom.id, totalPlanned, cleanDate(req.body.estimated_start_date), cleanDate(req.body.estimated_end_date), estimatedCost, normalizeString(req.body.notes), userId]
    );
    const materials = buildOrderMaterials(lines);
    for (const line of lines) {
      await runDb(
        db,
        `INSERT INTO production_order_boms
         (company_id, production_order_id, bom_id, product_id, quantity_planned, quantity_finished, estimated_cost, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`,
        [companyId, inserted.lastID, line.bom.id, line.bom.finished_product_id, line.quantity, line.estimatedCost]
      );
    }
    for (const material of materials) {
      await runDb(
        db,
        `INSERT INTO production_order_materials
         (company_id, production_order_id, product_id, quantity_required, quantity_reserved, quantity_consumed, unit_cost, total_cost, waste_percentage, created_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [companyId, inserted.lastID, material.productId, material.quantityRequired, material.unitCost, material.totalCost, material.wastePercentage]
      );
    }
    await auditProduction(db, req, 'create_order', 'production_orders', inserted.lastID, null, { order_number: orderNumber, boms: lines.map((line) => ({ bom_id: line.bom.id, quantity: line.quantity })) });
    logAction(userId, 'production.create_order', orderNumber, companyId);
    res.redirect(`/production/orders/${inserted.lastID}`);
  }));

  app.get('/production/orders/:id', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const data = await orderDetailData(req, db);
    if (!data.order) return res.status(404).send('Orden no encontrada');
    res.render('production/index', baseView(req, 'order_detail', data));
  }));

  app.get('/production/orders/:id/edit', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [toId(req.params.id), companyId]);
    if (!order) return res.status(404).send('Orden no encontrada');
    if (order.status === 'finished' && !isAdmin(req)) return res.status(403).send('No se puede editar una orden finalizada.');
    res.render('production/index', await orderFormView(req, order, null));
  }));

  app.post('/production/orders/:id/update', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!order) return res.status(404).send('Orden no encontrada');
    if (order.status === 'finished' && !isAdmin(req)) return res.status(403).send('No se puede editar una orden finalizada.');
    await runDb(
      db,
      `UPDATE production_orders
       SET estimated_start_date = ?, estimated_end_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [cleanDate(req.body.estimated_start_date), cleanDate(req.body.estimated_end_date), normalizeString(req.body.notes), id, companyId]
    );
    await auditProduction(db, req, 'edit_order', 'production_orders', id, order, req.body);
    res.redirect(`/production/orders/${id}`);
  }));

  app.post('/production/orders/:id/submit', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    await changeOrderStatus(db, req, 'pending');
    res.redirect(`/production/orders/${toId(req.params.id)}`);
  }));

  app.post('/production/orders/:id/reserve', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!order || !['draft', 'pending'].includes(order.status)) return res.redirect(`/production/orders/${id}`);
    const validation = await validateMaterials(db, companyId, id);
    if (!validation.ok) return res.render('production/index', baseView(req, 'order_detail', { ...(await orderDetailData(req, db)), error: validation.message }));
    const materials = await allDb(db, 'SELECT * FROM production_order_materials WHERE production_order_id = ? AND company_id = ?', [id, companyId]);
    for (const mat of materials) {
      const qty = Number(mat.quantity_required || 0);
      await runDb(db, 'UPDATE production_order_materials SET quantity_reserved = ? WHERE id = ? AND company_id = ?', [qty, mat.id, companyId]);
      await insertMovement(db, req, 'production_reserve', mat.product_id, qty, 0, 0, `Reserva ${order.order_number}`, id);
    }
    await runDb(db, "UPDATE production_orders SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?", [id, companyId]);
    await auditProduction(db, req, 'reserve_materials', 'production_orders', id, null, { order_number: order.order_number });
    res.redirect(`/production/orders/${id}`);
  }));

  app.get('/production/orders/:id/start', requireAuth, requirePermission('production', 'start_production'), asyncRoute(async (req, res) => {
    const data = await orderDetailData(req, db);
    if (!data.order) return res.status(404).send('Orden no encontrada');
    res.render('production/index', baseView(req, 'order_start', data));
  }));

  app.post('/production/orders/:id/start', requireAuth, requirePermission('production', 'start_production'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!order || !['pending', 'draft', 'paused'].includes(order.status)) return res.redirect(`/production/orders/${id}`);
    const validation = await validateMaterials(db, companyId, id);
    if (!validation.ok) return res.render('production/index', baseView(req, 'order_start', { ...(await orderDetailData(req, db)), error: validation.message }));
    const materials = await allDb(db, 'SELECT * FROM production_order_materials WHERE production_order_id = ? AND company_id = ?', [id, companyId]);
    for (const mat of materials) {
      const qty = Number(mat.quantity_required || 0) - Number(mat.quantity_consumed || 0);
      if (qty <= 0) continue;
      const item = await getDb(db, 'SELECT qty, average_cost, last_cost, price FROM items WHERE id = ? AND company_id = ?', [mat.product_id, companyId]);
      const before = Number(item.qty || 0);
      const after = before - qty;
      await runDb(db, 'UPDATE items SET qty = ? WHERE id = ? AND company_id = ?', [after, mat.product_id, companyId]);
      await runDb(db, 'UPDATE production_order_materials SET quantity_consumed = quantity_consumed + ?, quantity_reserved = MAX(quantity_reserved, ?) WHERE id = ? AND company_id = ?', [qty, Number(mat.quantity_required || 0), mat.id, companyId]);
      await insertMovement(db, req, 'production_consume', mat.product_id, qty, before, after, `Consumo produccion ${order.order_number}`, id, Number(mat.unit_cost || item.average_cost || item.last_cost || item.price || 0));
    }
    await runDb(db, "UPDATE production_orders SET status = 'in_production', real_start_date = COALESCE(real_start_date, DATE('now')), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?", [id, companyId]);
    await auditProduction(db, req, 'start_production', 'production_orders', id, order, { status: 'in_production' });
    res.redirect(`/production/orders/${id}`);
  }));

  app.post('/production/orders/:id/labor', requireAuth, requirePermission('production', 'record_labor'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const employeeId = toId(req.body.employee_id) || null;
    let hourlyCost = positiveNumber(req.body.hourly_cost);
    let workerName = normalizeString(req.body.worker_name);
    if (employeeId) {
      const employee = await getEmployee(db, companyId, employeeId);
      if (employee) {
        workerName = employee.full_name || employee.name || workerName;
        hourlyCost = Number(employee.monthly_salary || employee.salary || 0) / 30 / 8;
      }
    }
    const hours = positiveNumber(req.body.hours);
    const total = hours * hourlyCost;
    if (!workerName || hours <= 0) return res.redirect(`/production/orders/${id}`);
    await runDb(db, `INSERT INTO production_labor (company_id, production_order_id, employee_id, worker_name, hours, hourly_cost, total_cost, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [companyId, id, employeeId, workerName, hours, hourlyCost, total, normalizeString(req.body.notes), currentUserId(req)]);
    await recalcOrderCosts(db, companyId, id);
    await auditProduction(db, req, 'record_labor', 'production_labor', id, null, { worker_name: workerName, total_cost: total });
    res.redirect(`/production/orders/${id}`);
  }));

  app.post('/production/orders/:id/overhead', requireAuth, requirePermission('production', 'edit_costs'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const amount = positiveNumber(req.body.amount);
    if (!amount) return res.redirect(`/production/orders/${id}`);
    await runDb(db, `INSERT INTO production_overhead (company_id, production_order_id, cost_type, description, amount, distribution_method, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [companyId, id, normalizeString(req.body.cost_type), normalizeString(req.body.description), amount, enumValue(req.body.distribution_method, OVERHEAD_METHODS, 'order'), currentUserId(req)]);
    await recalcOrderCosts(db, companyId, id);
    await auditProduction(db, req, 'record_overhead', 'production_overhead', id, null, { amount });
    res.redirect(`/production/orders/${id}`);
  }));

  app.post('/production/orders/:id/waste', requireAuth, requirePermission('production', 'record_waste'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const productId = toId(req.body.product_id);
    const qty = positiveNumber(req.body.quantity);
    const item = productId ? await getDb(db, 'SELECT qty, average_cost, last_cost, price FROM items WHERE id = ? AND company_id = ?', [productId, companyId]) : null;
    if (!item || qty <= 0) return res.redirect(`/production/orders/${id}`);
    const unitCost = Number(item.average_cost || item.last_cost || item.price || 0);
    const before = Number(item.qty || 0);
    const after = Math.max(0, before - qty);
    await runDb(db, `INSERT INTO production_waste (company_id, production_order_id, product_id, quantity, reason, cost, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [companyId, id, productId, qty, enumValue(req.body.reason, WASTE_REASONS, 'Otro'), unitCost * qty, normalizeString(req.body.notes), currentUserId(req)]);
    await runDb(db, 'UPDATE items SET qty = ? WHERE id = ? AND company_id = ?', [after, productId, companyId]);
    await insertMovement(db, req, 'production_waste', productId, qty, before, after, `Merma produccion OP-${id}`, id, unitCost);
    await recalcOrderCosts(db, companyId, id);
    await auditProduction(db, req, 'record_waste', 'production_waste', id, null, { product_id: productId, quantity: qty });
    res.redirect(`/production/orders/${id}`);
  }));

  app.get('/production/orders/:id/finish', requireAuth, requirePermission('production', 'finish_production'), asyncRoute(async (req, res) => {
    const data = await orderDetailData(req, db);
    if (!data.order) return res.status(404).send('Orden no encontrada');
    res.render('production/index', baseView(req, 'order_finish', data));
  }));

  app.post('/production/orders/:id/finish', requireAuth, requirePermission('production', 'finish_production'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!order || !['in_production', 'paused', 'pending'].includes(order.status)) return res.redirect(`/production/orders/${id}`);
    const orderBoms = await getOrderBomLines(db, companyId, id);
    if (orderBoms.length) {
      const submittedLineIds = arrayOf(req.body.order_bom_id);
      const submittedQuantities = arrayOf(req.body.quantity_finished);
      const producedByLine = new Map();
      submittedLineIds.forEach((lineId, index) => {
        const parsedId = toId(lineId);
        const produced = positiveNumber(submittedQuantities[index]);
        if (parsedId && produced > 0) producedByLine.set(parsedId, produced);
      });
      if (!producedByLine.size) return res.render('production/index', baseView(req, 'order_finish', { ...(await orderDetailData(req, db)), error: 'Debe ingresar al menos una cantidad producida mayor a cero.' }));

      const totals = await productionTotals(db, companyId, id);
      const totalEstimated = orderBoms.reduce((sum, line) => sum + Number(line.estimated_cost || 0), 0);
      let producedTotal = 0;
      for (const line of orderBoms) {
        const produced = producedByLine.get(line.id) || 0;
        if (produced <= 0) continue;
        producedTotal += produced;
        const lineShare = totalEstimated > 0 ? Number(line.estimated_cost || 0) / totalEstimated : 1 / orderBoms.length;
        const lineCost = totals.total * lineShare;
        const newFinishedLine = Number(line.quantity_finished || 0) + produced;
        const unitCost = lineCost / Math.max(newFinishedLine, produced, 1);
        const item = await getDb(db, 'SELECT qty, average_cost, last_cost FROM items WHERE id = ? AND company_id = ?', [line.product_id, companyId]);
        const before = Number(item ? item.qty : 0);
        const after = before + produced;
        const averageCost = after > 0 ? (((before * Number(item.average_cost || item.last_cost || 0)) + (produced * unitCost)) / after) : unitCost;
        await runDb(db, 'UPDATE items SET qty = ?, average_cost = ?, last_cost = ?, production_type = ? WHERE id = ? AND company_id = ?', [after, averageCost, unitCost, 'finished_good', line.product_id, companyId]);
        await insertMovement(db, req, 'production_finish', line.product_id, produced, before, after, `Entrada produccion ${order.order_number} - ${line.bom_code}`, id, unitCost);
        await runDb(db, 'UPDATE production_order_boms SET quantity_finished = ?, unit_cost = ? WHERE id = ? AND company_id = ?', [newFinishedLine, unitCost, line.id, companyId]);
      }
      const refreshedLines = await getOrderBomLines(db, companyId, id);
      const newFinished = refreshedLines.reduce((sum, line) => sum + Number(line.quantity_finished || 0), 0);
      const isComplete = refreshedLines.every((line) => Number(line.quantity_finished || 0) >= Number(line.quantity_planned || 0));
      const orderUnitCost = totals.total / Math.max(newFinished, 1);
      await runDb(
        db,
        `UPDATE production_orders
         SET quantity_finished = ?, status = ?, real_end_date = CASE WHEN ? = 1 THEN DATE('now') ELSE real_end_date END, real_cost = ?, unit_cost = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ?`,
        [newFinished, isComplete ? 'finished' : 'in_production', isComplete ? 1 : 0, totals.total, orderUnitCost, id, companyId]
      );
      await auditProduction(db, req, isComplete ? 'finish_order' : 'partial_finish', 'production_orders', id, order, { quantity_finished: newFinished, produced: producedTotal });
      return res.redirect(`/production/orders/${id}`);
    }

    const produced = positiveNumber(req.body.quantity_finished);
    if (produced <= 0) return res.render('production/index', baseView(req, 'order_finish', { ...(await orderDetailData(req, db)), error: 'Debe ingresar una cantidad producida mayor a cero.' }));
    const totals = await productionTotals(db, companyId, id);
    const newFinished = Number(order.quantity_finished || 0) + produced;
    const isComplete = newFinished >= Number(order.quantity_planned || 0);
    const unitCost = totals.total / Math.max(newFinished, produced, 1);
    const item = await getDb(db, 'SELECT qty, average_cost, last_cost FROM items WHERE id = ? AND company_id = ?', [order.product_id, companyId]);
    const before = Number(item ? item.qty : 0);
    const after = before + produced;
    const averageCost = after > 0 ? (((before * Number(item.average_cost || item.last_cost || 0)) + (produced * unitCost)) / after) : unitCost;
    await runDb(db, 'UPDATE items SET qty = ?, average_cost = ?, last_cost = ?, production_type = ? WHERE id = ? AND company_id = ?', [after, averageCost, unitCost, 'finished_good', order.product_id, companyId]);
    await insertMovement(db, req, 'production_finish', order.product_id, produced, before, after, `Entrada produccion ${order.order_number}`, id, unitCost);
    await runDb(
      db,
      `UPDATE production_orders
       SET quantity_finished = ?, status = ?, real_end_date = CASE WHEN ? = 1 THEN DATE('now') ELSE real_end_date END, real_cost = ?, unit_cost = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [newFinished, isComplete ? 'finished' : 'in_production', isComplete ? 1 : 0, totals.total, unitCost, id, companyId]
    );
    await auditProduction(db, req, isComplete ? 'finish_order' : 'partial_finish', 'production_orders', id, order, { quantity_finished: newFinished, unit_cost: unitCost });
    res.redirect(`/production/orders/${id}`);
  }));

  app.post('/production/orders/:id/cancel', requireAuth, requirePermission('production', 'cancel_production'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!order || order.status === 'finished') return res.redirect(`/production/orders/${id}`);
    await runDb(db, `UPDATE production_order_materials SET quantity_reserved = 0 WHERE production_order_id = ? AND company_id = ?`, [id, companyId]);
    await runDb(db, `UPDATE production_orders SET status = 'cancelled', cancellation_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?`, [normalizeString(req.body.reason), id, companyId]);
    await auditProduction(db, req, 'cancel_order', 'production_orders', id, order, { reason: normalizeString(req.body.reason) });
    res.redirect(`/production/orders/${id}`);
  }));

  app.get('/production/bom', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const boms = await allDb(db, `SELECT b.*, p.name AS product_name, p.sku FROM production_boms b LEFT JOIN items p ON p.id = b.finished_product_id AND p.company_id = b.company_id WHERE b.company_id = ? ORDER BY b.created_at DESC`, [companyId]);
    res.render('production/index', baseView(req, 'bom', { boms }));
  }));

  app.get('/production/bom/new', requireAuth, requirePermission('production', 'create_order'), asyncRoute(async (req, res) => {
    res.render('production/index', await bomFormView(req, null, null));
  }));

  app.get('/production/bom/:id/edit', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const bom = await getDb(db, 'SELECT * FROM production_boms WHERE id = ? AND company_id = ?', [toId(req.params.id), companyId]);
    if (!bom) return res.status(404).send('Formula no encontrada');
    res.render('production/index', await bomFormView(req, bom, null));
  }));

  app.post('/production/bom/save', requireAuth, requirePermission('production', 'create_order'), asyncRoute(async (req, res) => saveBom(req, res, db, null)));
  app.post('/production/bom/:id/save', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => saveBom(req, res, db, toId(req.params.id))));

  app.get('/production/products', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const products = await getProductionProducts(db, companyId);
    res.render('production/index', baseView(req, 'products', { products }));
  }));

  app.get('/production/products/new', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    res.render('production/index', await productFormView(req, {}, null));
  }));

  app.post('/production/products/create', requireAuth, requirePermission('production', 'edit_order'), productionProductUpload.fields(PRODUCT_ATTACHMENT_FIELDS), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const name = clean(req.body.name);
    const sku = normalizeProductSku(req.body.sku) || await nextProductSku(db, companyId);
    const itemCode = normalizeProductCodeForName(req.body.item_code, name) || sku;
    const price = nonNegativeNumber(req.body.price);
    const laborCost = nonNegativeNumber(req.body.production_labor_cost);
    const days = nonNegativeNumber(req.body.production_days);
    const notes = clean(req.body.production_notes);
    const currency = resolveProductionCurrency(req, req.body.currency);

    if (!name) return res.render('production/index', await productFormView(req, req.body, 'El nombre del producto es obligatorio.'));
    const duplicate = await getDb(db, 'SELECT id FROM items WHERE sku = ? AND company_id = ?', [sku, companyId]);
    if (duplicate) return res.render('production/index', await productFormView(req, req.body, 'Ya existe un producto con ese SKU.'));

    const inserted = await runDb(
      db,
      `INSERT INTO items
       (name, sku, item_code, code_manual, qty, min_stock, price, currency, production_type, average_cost, last_cost, is_production_active, production_labor_cost, production_days, production_notes, production_photo_path, production_support_path, company_id)
       VALUES (?, ?, ?, 1, 0, 0, ?, ?, 'finished_good', 0, 0, 1, ?, ?, ?, ?, ?, ?)`,
      [name, sku, itemCode, price, currency, laborCost, days, notes, uploadedPath(req, 'product_photo'), uploadedPath(req, 'product_support'), companyId]
    );

    const bomId = await createBomFromProductForm(db, req, inserted.lastID, name, sku);
    await auditProduction(db, req, 'create_production_product', 'items', inserted.lastID, null, { name, sku, currency, bom_id: bomId, labor_cost: laborCost, days });
    res.redirect('/production/products');
  }));

  app.post('/production/products/:id/update', requireAuth, requirePermission('production', 'edit_order'), productionProductUpload.fields(PRODUCT_ATTACHMENT_FIELDS), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const product = await getDb(db, 'SELECT * FROM items WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!product) return res.status(404).send('Producto no encontrado');
    const photoPath = uploadedPath(req, 'product_photo') || product.production_photo_path || null;
    const supportPath = uploadedPath(req, 'product_support') || product.production_support_path || null;
    const notes = Object.prototype.hasOwnProperty.call(req.body, 'production_notes')
      ? clean(req.body.production_notes)
      : product.production_notes;
    await runDb(
      db,
      `UPDATE items
       SET production_labor_cost = ?, production_days = ?, production_notes = ?, is_production_active = ?, production_photo_path = ?, production_support_path = ?
       WHERE id = ? AND company_id = ?`,
      [nonNegativeNumber(req.body.production_labor_cost), nonNegativeNumber(req.body.production_days), notes, req.body.is_active ? 1 : 0, photoPath, supportPath, id, companyId]
    );
    await auditProduction(db, req, 'update_production_product', 'items', id, product, req.body);
    res.redirect('/production/products');
  }));

  app.post('/production/products/:id/delete', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = toId(req.params.id);
    const product = await getDb(db, 'SELECT * FROM items WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!product) return res.status(404).send('Producto no encontrado');
    await runDb(
      db,
      `UPDATE items
       SET production_type = 'supply', is_production_active = 0
       WHERE id = ? AND company_id = ?`,
      [id, companyId]
    );
    await auditProduction(db, req, 'delete_production_product', 'items', id, product, { production_type: 'supply', is_production_active: 0 });
    res.redirect('/production/products');
  }));

  app.get('/production/materials', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const filters = { category: normalizeString(req.query.category), q: normalizeString(req.query.q) };
    const params = [companyId];
    const where = ['i.company_id = ?'];
    if (filters.category) {
      where.push('i.production_type = ?');
      params.push(filters.category);
    }
    if (filters.q) {
      where.push('(i.name LIKE ? OR i.sku LIKE ? OR i.item_code LIKE ?)');
      params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
    }
    const materials = await allDb(db, `SELECT i.*, c.name AS category_name, COALESCE(r.reserved_qty, 0) AS reserved_qty
      FROM items i
      LEFT JOIN categories c ON c.id = i.category_id AND c.company_id = i.company_id
      LEFT JOIN (${reservedSql()}) r ON r.company_id = i.company_id AND r.product_id = i.id
      WHERE ${where.join(' AND ')}
      ORDER BY i.name`, params);
    res.render('production/index', baseView(req, 'materials', { materials, filters, productTypes: PRODUCT_TYPES }));
  }));

  app.get('/production/materials/new', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    res.render('production/index', await materialFormView(req, {}, null));
  }));

  app.post('/production/materials/create', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const name = clean(req.body.name);
    const sku = normalizeMaterialSku(req.body.sku) || await nextMaterialSku(db, companyId);
    const itemCode = clean(req.body.item_code) || sku;
    const qty = nonNegativeNumber(req.body.qty);
    const minStock = nonNegativeNumber(req.body.min_stock);
    const unitCost = nonNegativeNumber(req.body.unit_cost);
    const categoryId = toId(req.body.category_id);
    const brandId = toId(req.body.brand_id);
    const warehouseLocation = clean(req.body.warehouse_location);
    const barcode = clean(req.body.barcode);
    const notes = clean(req.body.notes);

    if (!name) {
      return res.render('production/index', await materialFormView(req, req.body, 'El nombre de la materia prima es obligatorio.'));
    }
    const duplicate = await getDb(db, 'SELECT id FROM items WHERE sku = ? AND company_id = ?', [sku, companyId]);
    if (duplicate) {
      return res.render('production/index', await materialFormView(req, req.body, 'Ya existe un producto con ese codigo SKU.'));
    }

    const inserted = await runDb(
      db,
      `INSERT INTO items
       (name, sku, item_code, code_manual, qty, min_stock, warehouse_location, barcode, price, production_type, average_cost, last_cost, is_production_active, category_id, brand_id, company_id)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'raw_material', ?, ?, 1, ?, ?, ?)`,
      [name, sku, itemCode, qty, minStock, warehouseLocation || null, barcode || null, unitCost, unitCost, unitCost, categoryId, brandId, companyId]
    );

    if (qty > 0) {
      await runDb(db, `INSERT INTO inventory_movements
        (company_id, product_id, movement_type, quantity, stock_before, stock_after, unit_cost, total_cost, reference_type, reference_id, notes, created_by, created_at)
        VALUES (?, ?, 'material_entry', ?, 0, ?, ?, ?, 'production_material', ?, ?, ?, CURRENT_TIMESTAMP)`,
        [companyId, inserted.lastID, qty, qty, unitCost, qty * unitCost, inserted.lastID, notes || 'Ingreso inicial de materia prima', currentUserId(req)]);
    }

    await auditProduction(db, req, 'create_raw_material', 'items', inserted.lastID, null, { name, sku, qty, unit_cost: unitCost });
    res.redirect('/production/materials');
  }));

  app.post('/production/materials/:id/classify', requireAuth, requirePermission('production', 'edit_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    await runDb(db, 'UPDATE items SET production_type = ?, is_production_active = ? WHERE id = ? AND company_id = ?', [enumValue(req.body.production_type, PRODUCT_TYPES, 'raw_material'), req.body.is_active ? 1 : 0, toId(req.params.id), companyId]);
    res.redirect('/production/materials');
  }));

  app.get('/production/work-in-process', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const orders = await getOrders(db, companyId, { status: 'in_production' }, 200);
    res.render('production/index', baseView(req, 'wip', { orders }));
  }));

  app.get('/production/finished-goods', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const orders = await getOrders(db, companyId, { status: 'finished' }, 300);
    const goods = await allDb(db, `SELECT i.*, COALESCE(SUM(po.quantity_finished), 0) AS produced_qty, COALESCE(AVG(po.unit_cost), i.average_cost, i.last_cost, i.price, 0) AS production_cost
      FROM items i
      LEFT JOIN production_orders po ON po.product_id = i.id AND po.company_id = i.company_id AND po.status = 'finished'
      WHERE i.company_id = ? AND i.production_type = 'finished_good'
      GROUP BY i.id
      ORDER BY i.name`, [companyId]);
    res.render('production/index', baseView(req, 'finished_goods', { orders, goods }));
  }));

  app.get('/production/waste', requireAuth, requirePermission('production', 'view'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const waste = await allDb(db, `SELECT w.*, po.order_number, i.name AS product_name
      FROM production_waste w
      LEFT JOIN production_orders po ON po.id = w.production_order_id AND po.company_id = w.company_id
      LEFT JOIN items i ON i.id = w.product_id AND i.company_id = w.company_id
      WHERE w.company_id = ?
      ORDER BY w.created_at DESC`, [companyId]);
    res.render('production/index', baseView(req, 'waste', { waste }));
  }));

  app.get('/production/reports', requireAuth, requirePermission('production', 'view_reports'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const byProduct = await allDb(db, `SELECT i.name AS product_name, COUNT(po.id) AS orders, SUM(po.quantity_finished) AS qty, SUM(po.real_cost) AS cost, AVG(po.unit_cost) AS unit_cost
      FROM production_orders po JOIN items i ON i.id = po.product_id AND i.company_id = po.company_id
      WHERE po.company_id = ? GROUP BY po.product_id ORDER BY cost DESC`, [companyId]);
    const byMaterial = await allDb(db, `SELECT i.name AS material_name, SUM(m.quantity_consumed) AS qty, SUM(m.quantity_consumed * m.unit_cost) AS cost
      FROM production_order_materials m JOIN items i ON i.id = m.product_id AND i.company_id = m.company_id
      WHERE m.company_id = ? GROUP BY m.product_id ORDER BY cost DESC`, [companyId]);
    const labor = await allDb(db, `SELECT po.order_number, SUM(l.hours) AS hours, SUM(l.total_cost) AS cost
      FROM production_labor l JOIN production_orders po ON po.id = l.production_order_id AND po.company_id = l.company_id
      WHERE l.company_id = ? GROUP BY l.production_order_id ORDER BY cost DESC`, [companyId]);
    const overhead = await allDb(db, `SELECT po.order_number, SUM(o.amount) AS cost
      FROM production_overhead o JOIN production_orders po ON po.id = o.production_order_id AND po.company_id = o.company_id
      WHERE o.company_id = ? GROUP BY o.production_order_id ORDER BY cost DESC`, [companyId]);
    res.render('production/index', baseView(req, 'reports', { reports: { byProduct, byMaterial, labor, overhead } }));
  }));
}

function baseView(req, activeTab, data = {}) {
  const companySettings = req.session && req.session.company ? req.session.company : {};
  const baseCurrency = String(companySettings.base_currency || companySettings.currency || 'GTQ').toUpperCase();
  const currencyOptions = productionCurrencyOptions(companySettings);
  return {
    activeTab,
    moduleTabs: productionTabs(),
    statusLabels: statusLabels(),
    productTypeLabels: productTypeLabels(),
    wasteReasons: WASTE_REASONS,
    overheadMethods: OVERHEAD_METHODS,
    canViewCosts: req.app.locals ? false : false,
    showCosts: typeof req.res?.locals?.can === 'function' ? req.res.locals.can('production', 'view_costs') : false,
    buildFileUrl: productionBuildFileUrl,
    productionUnits: DEFAULT_PRODUCTION_UNITS,
    baseCurrency,
    currencyOptions,
    error: null,
    ...data
  };
}

function productionCurrencyOptions(companySettings = {}) {
  const baseCurrency = String(companySettings.base_currency || companySettings.currency || 'GTQ').trim().toUpperCase() || 'GTQ';
  const configured = String(companySettings.allowed_currencies || '').split(',').map((value) => String(value || '').trim().toUpperCase()).filter(Boolean);
  return Array.from(new Set([baseCurrency, ...configured, 'GTQ', 'USD']));
}

function resolveProductionCurrency(req, value) {
  const companySettings = req.session && req.session.company ? req.session.company : {};
  const options = productionCurrencyOptions(companySettings);
  const requested = String(value || '').trim().toUpperCase();
  return options.includes(requested) ? requested : options[0];
}

function productionTabs() {
  return [
    { key: 'dashboard', label: 'Panel', href: '/production' },
    { key: 'orders', label: 'Ordenes', href: '/production/orders' },
    { key: 'products', label: 'Productos', href: '/production/products' },
    { key: 'bom', label: 'BOM', href: '/production/bom' },
    { key: 'materials', label: 'Materia prima', href: '/production/materials' },
    { key: 'wip', label: 'Procesos', href: '/production/work-in-process' },
    { key: 'finished_goods', label: 'Terminados', href: '/production/finished-goods' },
    { key: 'waste', label: 'Merma', href: '/production/waste' },
    { key: 'reports', label: 'Reportes', href: '/production/reports' }
  ];
}

async function orderFormView(req, order, error) {
  const companyId = getCompanyIdFromReq(req);
  const db = globalDbFallback(req);
  const products = await getProducts(req.app.locals.db || db, companyId);
  return baseView(req, order ? 'order_edit' : 'order_new', {
    order,
    products,
    orderBoms: order ? await getOrderBomLines(db, companyId, order.id) : [],
    boms: await allDb(db, 'SELECT b.*, i.name AS product_name, i.sku FROM production_boms b LEFT JOIN items i ON i.id = b.finished_product_id AND i.company_id = b.company_id WHERE b.company_id = ? AND b.status = ? ORDER BY b.name', [companyId, 'active']),
    error
  });
}

async function bomFormView(req, bom, error) {
  const db = globalDbFallback(req);
  const companyId = getCompanyIdFromReq(req);
  const products = await getProducts(db, companyId);
  const items = bom ? await allDb(db, 'SELECT * FROM production_bom_items WHERE bom_id = ? AND company_id = ? ORDER BY id', [bom.id, companyId]) : [];
  const productionUnits = await getProductionUnits(db, companyId, [
    bom && bom.unit,
    ...items.map((item) => item.unit)
  ]);
  return baseView(req, bom ? 'bom_edit' : 'bom_new', { bom, bomItems: items, products, productionUnits, error });
}

async function materialFormView(req, material, error) {
  const db = globalDbFallback(req);
  const companyId = getCompanyIdFromReq(req);
  const categories = await allDb(db, 'SELECT id, name FROM categories WHERE company_id = ? ORDER BY name', [companyId]);
  const brands = await allDb(db, 'SELECT id, name FROM brands WHERE company_id = ? ORDER BY name', [companyId]);
  const suggestedSku = await nextMaterialSku(db, companyId);
  return baseView(req, 'material_new', { material, categories, brands, suggestedSku, error });
}

async function productFormView(req, product, error) {
  const db = globalDbFallback(req);
  const companyId = getCompanyIdFromReq(req);
  const materials = await getProducts(db, companyId);
  const suggestedSku = await nextProductSku(db, companyId);
  const productionUnits = await getProductionUnits(db, companyId);
  return baseView(req, 'product_new', { product, materials, productionUnits, suggestedSku, error });
}

function globalDbFallback(req) {
  return req.app && req.app.get ? req.app.get('db') : null;
}

function getCompanyIdFromReq(req) {
  const raw = req.session && (req.session.company_id || (req.session.company && req.session.company.id));
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function saveBom(req, res, db, id) {
  const companyId = getCompanyIdFromReq(req);
  const finishedProductId = toId(req.body.finished_product_id);
  const code = normalizeCode(req.body.code);
  const name = clean(req.body.name);
  const baseQty = positiveNumber(req.body.base_quantity) || 1;
  if (!finishedProductId || !code || !name) return res.render('production/index', await bomFormView(req, id ? { id } : null, 'Producto terminado, codigo y nombre son obligatorios.'));
  let bomId = id;
  if (id) {
    await runDb(db, `UPDATE production_boms SET finished_product_id = ?, code = ?, name = ?, version = ?, base_quantity = ?, unit = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?`,
      [finishedProductId, code, name, clean(req.body.version) || '1', resolveProductionUnit(req.body.unit, req.body.unit_other), enumValue(req.body.status, ['active', 'inactive'], 'active'), clean(req.body.notes), id, companyId]);
    await runDb(db, 'DELETE FROM production_bom_items WHERE bom_id = ? AND company_id = ?', [id, companyId]);
  } else {
    const result = await runDb(db, `INSERT INTO production_boms (company_id, finished_product_id, code, name, version, base_quantity, unit, status, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [companyId, finishedProductId, code, name, clean(req.body.version) || '1', baseQty, resolveProductionUnit(req.body.unit, req.body.unit_other), enumValue(req.body.status, ['active', 'inactive'], 'active'), clean(req.body.notes), currentUserId(req)]);
    bomId = result.lastID;
  }
  const materialIds = arrayOf(req.body.material_product_id);
  const quantities = arrayOf(req.body.quantity);
  const units = arrayOf(req.body.unit_item);
  const unitOthers = arrayOf(req.body.unit_item_other);
  const wastes = arrayOf(req.body.waste_percentage);
  for (let index = 0; index < materialIds.length; index += 1) {
    const materialId = toId(materialIds[index]);
    const qty = positiveNumber(quantities[index]);
    if (!materialId || qty <= 0) continue;
    const item = await getDb(db, 'SELECT average_cost, last_cost, price FROM items WHERE id = ? AND company_id = ?', [materialId, companyId]);
    const unitCost = Number(item ? (item.average_cost || item.last_cost || item.price || 0) : 0);
    const waste = positiveNumber(wastes[index]);
    const total = qty * unitCost * (1 + waste / 100);
    await runDb(db, `INSERT INTO production_bom_items (company_id, bom_id, material_product_id, quantity, unit, waste_percentage, unit_cost, total_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [companyId, bomId, materialId, qty, resolveProductionUnit(units[index], unitOthers[index]), waste, unitCost, total]);
  }
  await auditProduction(db, req, id ? 'edit_bom' : 'create_bom', 'production_boms', bomId, null, { code, name });
  res.redirect('/production/bom');
}

async function orderDetailData(req, db) {
  const companyId = getCompanyIdFromReq(req);
  const id = toId(req.params.id);
  const order = await getDb(db, `SELECT po.*, p.name AS product_name, p.sku, b.name AS bom_name, b.code AS bom_code, u.username AS created_by_name
    FROM production_orders po
    LEFT JOIN items p ON p.id = po.product_id AND p.company_id = po.company_id
    LEFT JOIN production_boms b ON b.id = po.bom_id AND b.company_id = po.company_id
    LEFT JOIN users u ON u.id = po.created_by AND u.company_id = po.company_id
    WHERE po.id = ? AND po.company_id = ?`, [id, companyId]);
  if (!order) return { order: null };
  const orderBoms = await getOrderBomLines(db, companyId, id);
  const materials = await allDb(db, `SELECT m.*, i.name AS product_name, i.sku, i.qty AS stock_qty, COALESCE(r.reserved_qty, 0) AS reserved_total
    FROM production_order_materials m
    JOIN items i ON i.id = m.product_id AND i.company_id = m.company_id
    LEFT JOIN (${reservedSql()}) r ON r.company_id = m.company_id AND r.product_id = m.product_id
    WHERE m.production_order_id = ? AND m.company_id = ?
    ORDER BY i.name`, [id, companyId]);
  const labor = await allDb(db, 'SELECT * FROM production_labor WHERE production_order_id = ? AND company_id = ? ORDER BY created_at DESC', [id, companyId]);
  const overhead = await allDb(db, 'SELECT * FROM production_overhead WHERE production_order_id = ? AND company_id = ? ORDER BY created_at DESC', [id, companyId]);
  const waste = await allDb(db, `SELECT w.*, i.name AS product_name FROM production_waste w LEFT JOIN items i ON i.id = w.product_id AND i.company_id = w.company_id WHERE w.production_order_id = ? AND w.company_id = ? ORDER BY w.created_at DESC`, [id, companyId]);
  const movements = await allDb(db, `SELECT im.*, i.name AS product_name FROM inventory_movements im LEFT JOIN items i ON i.id = im.product_id AND i.company_id = im.company_id WHERE im.reference_id = ? AND im.company_id = ? ORDER BY im.created_at DESC`, [id, companyId]);
  const employees = await getEmployees(db, companyId);
  const products = await getProducts(db, companyId);
  const totals = await productionTotals(db, companyId, id);
  return { order, orderBoms, materials, labor, overhead, waste, movements, employees, products, totals };
}

async function buildDashboard(db, companyId) {
  const statuses = await allDb(db, 'SELECT status, COUNT(*) AS total FROM production_orders WHERE company_id = ? GROUP BY status', [companyId]);
  const map = Object.fromEntries(statuses.map((row) => [row.status, Number(row.total || 0)]));
  const reserved = await getDb(db, `SELECT SUM(MAX(quantity_reserved - quantity_consumed, 0) * unit_cost) AS total FROM production_order_materials WHERE company_id = ?`, [companyId]);
  const finished = await getDb(db, "SELECT SUM(quantity_finished) AS qty, SUM(real_cost) AS cost FROM production_orders WHERE company_id = ? AND status = 'finished' AND strftime('%Y-%m', COALESCE(real_end_date, created_at)) = strftime('%Y-%m', 'now')", [companyId]);
  const margin = await getDb(db, "SELECT SUM((i.price - po.unit_cost) * po.quantity_finished) AS profit FROM production_orders po JOIN items i ON i.id = po.product_id AND i.company_id = po.company_id WHERE po.company_id = ? AND po.status = 'finished'", [companyId]);
  const catalog = await getDb(db, `SELECT
      SUM(CASE WHEN production_type IN ('finished_good', 'work_in_process') AND is_production_active = 1 THEN 1 ELSE 0 END) AS active_products,
      SUM(CASE WHEN production_type IN ('raw_material', 'supply', 'packaging') AND is_production_active = 1 THEN 1 ELSE 0 END) AS active_materials,
      SUM(CASE WHEN production_type IN ('raw_material', 'supply', 'packaging') AND is_production_active = 1 AND qty <= min_stock THEN 1 ELSE 0 END) AS low_stock
    FROM items
    WHERE company_id = ?`, [companyId]);
  const bom = await getDb(db, "SELECT COUNT(*) AS active FROM production_boms WHERE company_id = ? AND status = 'active'", [companyId]);
  const materialDemand = await getDb(db, `SELECT
      SUM(CASE WHEN i.qty < m.quantity_required - m.quantity_consumed THEN 1 ELSE 0 END) AS shortage_lines,
      SUM(MAX(m.quantity_required - m.quantity_consumed, 0) * m.unit_cost) AS open_cost
    FROM production_order_materials m
    JOIN production_orders po ON po.id = m.production_order_id AND po.company_id = m.company_id
    JOIN items i ON i.id = m.product_id AND i.company_id = m.company_id
    WHERE m.company_id = ? AND po.status IN ('draft', 'pending', 'in_production', 'paused')`, [companyId]);
  const statusBreakdown = PRODUCTION_STATUSES
    .filter((status) => status !== 'cancelled' || map.cancelled)
    .map((status) => ({ status, total: map[status] || 0 }));
  const lowStockMaterials = await allDb(db, `SELECT name, sku, qty, min_stock, production_type
    FROM items
    WHERE company_id = ?
      AND production_type IN ('raw_material', 'supply', 'packaging')
      AND is_production_active = 1
      AND qty <= min_stock
    ORDER BY (qty - min_stock), name
    LIMIT 6`, [companyId]);
  const productMix = await allDb(db, `SELECT i.name, COALESCE(SUM(po.quantity_finished), 0) AS qty, COALESCE(SUM(po.real_cost), 0) AS cost
    FROM production_orders po
    JOIN items i ON i.id = po.product_id AND i.company_id = po.company_id
    WHERE po.company_id = ?
      AND po.status = 'finished'
      AND strftime('%Y-%m', COALESCE(po.real_end_date, po.created_at)) = strftime('%Y-%m', 'now')
    GROUP BY po.product_id
    ORDER BY qty DESC, i.name
    LIMIT 6`, [companyId]);
  const products = await allDb(db, `SELECT i.id, i.name, i.sku, i.item_code, i.production_photo_path, i.production_days, i.is_production_active,
      COALESCE(b.bom_count, 0) AS bom_count
    FROM items i
    LEFT JOIN (
      SELECT finished_product_id, company_id, COUNT(*) AS bom_count
      FROM production_boms
      WHERE status = 'active'
      GROUP BY finished_product_id, company_id
    ) b ON b.finished_product_id = i.id AND b.company_id = i.company_id
    WHERE i.company_id = ?
      AND i.production_type IN ('finished_good', 'work_in_process')
    ORDER BY i.is_production_active DESC, i.name
    LIMIT 12`, [companyId]);
  return {
    active: (map.in_production || 0) + (map.paused || 0),
    pending: map.pending || 0,
    finished: map.finished || 0,
    cancelled: map.cancelled || 0,
    reserved: Number(reserved && reserved.total || 0),
    finishedQty: Number(finished && finished.qty || 0),
    monthCost: Number(finished && finished.cost || 0),
    estimatedProfit: Number(margin && margin.profit || 0),
    activeProducts: Number(catalog && catalog.active_products || 0),
    activeMaterials: Number(catalog && catalog.active_materials || 0),
    lowStock: Number(catalog && catalog.low_stock || 0),
    activeBoms: Number(bom && bom.active || 0),
    shortageLines: Number(materialDemand && materialDemand.shortage_lines || 0),
    openMaterialCost: Number(materialDemand && materialDemand.open_cost || 0),
    statusBreakdown,
    lowStockMaterials,
    productMix,
    products
  };
}

async function getOrders(db, companyId, filters = {}, limit = 300) {
  const where = ['po.company_id = ?'];
  const params = [companyId];
  if (filters.status) {
    where.push('po.status = ?');
    params.push(filters.status);
  } else if (Array.isArray(filters.statuses) && filters.statuses.length) {
    where.push(`po.status IN (${filters.statuses.map(() => '?').join(',')})`);
    params.push(...filters.statuses);
  }
  if (filters.product_id) {
    where.push('(po.product_id = ? OR EXISTS (SELECT 1 FROM production_order_boms pob_filter WHERE pob_filter.production_order_id = po.id AND pob_filter.company_id = po.company_id AND pob_filter.product_id = ?))');
    params.push(filters.product_id, filters.product_id);
  }
  if (filters.user_id) {
    where.push('po.created_by = ?');
    params.push(filters.user_id);
  }
  if (filters.order) {
    where.push('po.order_number LIKE ?');
    params.push(`%${filters.order}%`);
  }
  if (filters.date_from) {
    where.push('date(po.created_at) >= date(?)');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push('date(po.created_at) <= date(?)');
    params.push(filters.date_to);
  }
  if (filters.cost_min) {
    where.push('COALESCE(po.real_cost, po.estimated_cost, 0) >= ?');
    params.push(filters.cost_min);
  }
  if (filters.cost_max) {
    where.push('COALESCE(po.real_cost, po.estimated_cost, 0) <= ?');
    params.push(filters.cost_max);
  }
  params.push(limit);
  return allDb(db, `SELECT po.*,
      COALESCE(NULLIF(os.products, ''), i.name) AS product_name,
      CASE WHEN os.line_count > 1 THEN '' ELSE i.sku END AS sku,
      COALESCE(os.quantity_planned, po.quantity_planned) AS quantity_planned,
      COALESCE(os.quantity_finished, po.quantity_finished) AS quantity_finished,
      u.username AS created_by_name
    FROM production_orders po
    LEFT JOIN items i ON i.id = po.product_id AND i.company_id = po.company_id
    LEFT JOIN (
      SELECT pob.production_order_id, pob.company_id, GROUP_CONCAT(it.name, ', ') AS products, COUNT(*) AS line_count,
        SUM(pob.quantity_planned) AS quantity_planned, SUM(pob.quantity_finished) AS quantity_finished
      FROM production_order_boms pob
      JOIN items it ON it.id = pob.product_id AND it.company_id = pob.company_id
      GROUP BY pob.production_order_id, pob.company_id
    ) os ON os.production_order_id = po.id AND os.company_id = po.company_id
    LEFT JOIN users u ON u.id = po.created_by AND u.company_id = po.company_id
    WHERE ${where.join(' AND ')}
    ORDER BY po.created_at DESC LIMIT ?`, params);
}

async function getOrderBomLines(db, companyId, orderId) {
  return allDb(db, `SELECT pob.*, b.code AS bom_code, b.name AS bom_name, b.base_quantity, b.unit, i.name AS product_name, i.sku
    FROM production_order_boms pob
    JOIN production_boms b ON b.id = pob.bom_id AND b.company_id = pob.company_id
    JOIN items i ON i.id = pob.product_id AND i.company_id = pob.company_id
    WHERE pob.company_id = ? AND pob.production_order_id = ?
    ORDER BY pob.id`, [companyId, orderId]);
}

async function parseOrderBomLines(db, companyId, body) {
  const bomIds = arrayOf(body.bom_id);
  const quantities = arrayOf(body.quantity_planned);
  const lines = [];
  for (let index = 0; index < bomIds.length; index += 1) {
    const bomId = toId(bomIds[index]);
    const quantity = positiveNumber(quantities[index]);
    if (!bomId || quantity <= 0) continue;
    const bom = await getDb(db, 'SELECT * FROM production_boms WHERE id = ? AND company_id = ? AND status = ?', [bomId, companyId, 'active']);
    if (!bom) continue;
    const items = await allDb(db, 'SELECT * FROM production_bom_items WHERE bom_id = ? AND company_id = ?', [bomId, companyId]);
    const estimatedCost = estimateBomLineCost(bom, items, quantity);
    lines.push({ bom, quantity, items, estimatedCost });
  }
  return lines;
}

function estimateBomLineCost(bom, items, quantity) {
  const scale = quantity / Math.max(Number(bom.base_quantity || 1), 1);
  return items.reduce((sum, item) => {
    const required = Number(item.quantity || 0) * scale;
    const waste = required * (Number(item.waste_percentage || 0) / 100);
    return sum + (required + waste) * Number(item.unit_cost || 0);
  }, 0);
}

function buildOrderMaterials(lines) {
  const materials = new Map();
  for (const line of lines) {
    const scale = line.quantity / Math.max(Number(line.bom.base_quantity || 1), 1);
    for (const item of line.items) {
      const productId = Number(item.material_product_id);
      const required = Number(item.quantity || 0) * scale;
      const wasteQty = required * (Number(item.waste_percentage || 0) / 100);
      const unitCost = Number(item.unit_cost || 0);
      const totalRequired = required + wasteQty;
      const existing = materials.get(productId) || { productId, quantityRequired: 0, unitCost, totalCost: 0, wasteValue: 0, baseRequired: 0 };
      existing.quantityRequired += totalRequired;
      existing.totalCost += totalRequired * unitCost;
      existing.wasteValue += wasteQty;
      existing.baseRequired += required;
      existing.unitCost = existing.quantityRequired > 0 ? existing.totalCost / existing.quantityRequired : unitCost;
      existing.wastePercentage = existing.baseRequired > 0 ? (existing.wasteValue / existing.baseRequired) * 100 : 0;
      materials.set(productId, existing);
    }
  }
  return Array.from(materials.values());
}

async function getProducts(db, companyId) {
  return allDb(db, `SELECT i.*, c.name AS category_name, COALESCE(r.reserved_qty, 0) AS reserved_qty
    FROM items i
    LEFT JOIN categories c ON c.id = i.category_id AND c.company_id = i.company_id
    LEFT JOIN (${reservedSql()}) r ON r.company_id = i.company_id AND r.product_id = i.id
    WHERE i.company_id = ?
    ORDER BY i.name`, [companyId]);
}

async function getProductionProducts(db, companyId) {
  return allDb(db, `SELECT i.*,
      COALESCE(b.bom_count, 0) AS bom_count,
      COALESCE(b.material_count, 0) AS material_count,
      b.first_bom_id,
      b.first_bom_code,
      b.material_names
    FROM items i
    LEFT JOIN (
      SELECT pb.finished_product_id, pb.company_id, COUNT(DISTINCT pb.id) AS bom_count, MIN(pb.id) AS first_bom_id, MIN(pb.code) AS first_bom_code,
        COUNT(DISTINCT pbi.material_product_id) AS material_count, GROUP_CONCAT(DISTINCT mi.name) AS material_names
      FROM production_boms pb
      LEFT JOIN production_bom_items pbi ON pbi.bom_id = pb.id AND pbi.company_id = pb.company_id
      LEFT JOIN items mi ON mi.id = pbi.material_product_id AND mi.company_id = pbi.company_id
      GROUP BY pb.finished_product_id, pb.company_id
    ) b ON b.finished_product_id = i.id AND b.company_id = i.company_id
    WHERE i.company_id = ? AND i.production_type IN ('finished_good', 'work_in_process')
    ORDER BY i.name`, [companyId]);
}

function uploadedPath(req, fieldName) {
  const files = req.files && req.files[fieldName];
  const file = Array.isArray(files) ? files[0] : null;
  return file && file.path ? file.path : null;
}

async function createBomFromProductForm(db, req, productId, productName, productSku) {
  const companyId = getCompanyIdFromReq(req);
  const materialIds = arrayOf(req.body.material_product_id);
  const quantities = arrayOf(req.body.quantity);
  const units = arrayOf(req.body.unit_item);
  const unitOthers = arrayOf(req.body.unit_item_other);
  const wastes = arrayOf(req.body.waste_percentage);
  const hasMaterials = materialIds.some((value, index) => toId(value) && positiveNumber(quantities[index]) > 0);
  if (!hasMaterials) return null;

  const code = await nextBomCode(db, companyId, productSku);
  const result = await runDb(db, `INSERT INTO production_boms (company_id, finished_product_id, code, name, version, base_quantity, unit, status, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, '1', 1, 'unidad', 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, productId, code, `BOM ${productName}`, clean(req.body.production_notes), currentUserId(req)]);
  for (let index = 0; index < materialIds.length; index += 1) {
    const materialId = toId(materialIds[index]);
    const qty = positiveNumber(quantities[index]);
    if (!materialId || qty <= 0) continue;
    const item = await getDb(db, 'SELECT average_cost, last_cost, price FROM items WHERE id = ? AND company_id = ?', [materialId, companyId]);
    const unitCost = Number(item ? (item.average_cost || item.last_cost || item.price || 0) : 0);
    const waste = positiveNumber(wastes[index]);
    await runDb(db, `INSERT INTO production_bom_items (company_id, bom_id, material_product_id, quantity, unit, waste_percentage, unit_cost, total_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [companyId, result.lastID, materialId, qty, resolveProductionUnit(units[index], unitOthers[index]), waste, unitCost, qty * unitCost * (1 + waste / 100)]);
  }
  return result.lastID;
}

async function getProductionUnits(db, companyId, extraUnits = []) {
  const rows = await allDb(db, `SELECT unit FROM production_boms WHERE company_id = ? AND TRIM(COALESCE(unit, '')) <> ''
    UNION
    SELECT unit FROM production_bom_items WHERE company_id = ? AND TRIM(COALESCE(unit, '')) <> ''
    ORDER BY unit`, [companyId, companyId]).catch(() => []);
  const units = new Map();
  [...DEFAULT_PRODUCTION_UNITS, ...rows.map((row) => row.unit), ...extraUnits]
    .map((unit) => clean(unit))
    .filter(Boolean)
    .forEach((unit) => units.set(unit.toLocaleLowerCase('es-GT'), unit));
  return Array.from(units.values()).sort((a, b) => a.localeCompare(b, 'es'));
}

function resolveProductionUnit(selected, other) {
  const selectedUnit = clean(selected);
  const otherUnit = clean(other);
  if (selectedUnit === '__other') return otherUnit || 'unidad';
  return selectedUnit || otherUnit || 'unidad';
}

async function nextBomCode(db, companyId, productSku) {
  const prefix = normalizeCode(productSku) || 'BOM';
  let next = 1;
  while (next < 1000) {
    const code = `${prefix}-BOM-${String(next).padStart(2, '0')}`;
    const exists = await getDb(db, 'SELECT id FROM production_boms WHERE code = ? AND company_id = ?', [code, companyId]);
    if (!exists) return code;
    next += 1;
  }
  return `${prefix}-BOM-${Date.now()}`;
}

async function getEmployees(db, companyId) {
  return allDb(db, 'SELECT id, COALESCE(full_name, first_name || " " || last_name, name, employee_code) AS full_name, COALESCE(monthly_salary, salary, 0) AS monthly_salary FROM hr_employees WHERE company_id = ? ORDER BY full_name', [companyId]).catch(() => []);
}

async function getEmployee(db, companyId, employeeId) {
  return getDb(db, 'SELECT id, COALESCE(full_name, first_name || " " || last_name, name, employee_code) AS full_name, COALESCE(monthly_salary, salary, 0) AS monthly_salary FROM hr_employees WHERE id = ? AND company_id = ?', [employeeId, companyId]).catch(() => null);
}

async function validateMaterials(db, companyId, orderId) {
  const rows = await allDb(db, `SELECT m.product_id, i.name, i.qty, m.quantity_required, COALESCE(r.reserved_qty, 0) AS reserved_qty
    FROM production_order_materials m
    JOIN items i ON i.id = m.product_id AND i.company_id = m.company_id
    LEFT JOIN (${reservedSql()}) r ON r.company_id = m.company_id AND r.product_id = m.product_id
    WHERE m.company_id = ? AND m.production_order_id = ?`, [companyId, orderId]);
  for (const row of rows) {
    const reservedOther = Math.max(0, Number(row.reserved_qty || 0) - Number(row.quantity_required || 0));
    const available = Number(row.qty || 0) - reservedOther;
    if (available < Number(row.quantity_required || 0)) {
      return { ok: false, message: `Materia prima insuficiente: ${row.name}. Disponible real ${available}, requerido ${row.quantity_required}.` };
    }
  }
  return { ok: true };
}

async function productionTotals(db, companyId, orderId) {
  const mat = await getDb(db, 'SELECT SUM(quantity_consumed * unit_cost) AS total FROM production_order_materials WHERE company_id = ? AND production_order_id = ?', [companyId, orderId]);
  const labor = await getDb(db, 'SELECT SUM(total_cost) AS total FROM production_labor WHERE company_id = ? AND production_order_id = ?', [companyId, orderId]);
  const overhead = await getDb(db, 'SELECT SUM(amount) AS total FROM production_overhead WHERE company_id = ? AND production_order_id = ?', [companyId, orderId]);
  const waste = await getDb(db, 'SELECT SUM(cost) AS total FROM production_waste WHERE company_id = ? AND production_order_id = ?', [companyId, orderId]);
  const materials = Number(mat && mat.total || 0);
  const laborTotal = Number(labor && labor.total || 0);
  const overheadTotal = Number(overhead && overhead.total || 0);
  const wasteTotal = Number(waste && waste.total || 0);
  return { materials, labor: laborTotal, overhead: overheadTotal, waste: wasteTotal, total: materials + laborTotal + overheadTotal + wasteTotal };
}

async function recalcOrderCosts(db, companyId, orderId) {
  const totals = await productionTotals(db, companyId, orderId);
  const order = await getDb(db, 'SELECT quantity_finished FROM production_orders WHERE id = ? AND company_id = ?', [orderId, companyId]);
  const qty = Math.max(Number(order && order.quantity_finished || 0), 1);
  await runDb(db, 'UPDATE production_orders SET real_cost = ?, unit_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [totals.total, totals.total / qty, orderId, companyId]);
}

async function changeOrderStatus(db, req, status) {
  const companyId = getCompanyIdFromReq(req);
  const id = toId(req.params.id);
  const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!order || !PRODUCTION_STATUSES.includes(status)) return;
  await runDb(db, 'UPDATE production_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [status, id, companyId]);
  await auditProduction(db, req, 'change_status', 'production_orders', id, { status: order.status }, { status });
}

async function updateOrdersBulkStatus(db, req, companyId, ids, status) {
  for (const id of ids) {
    const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!order || order.status === 'cancelled') continue;
    if (status === 'cancelled') {
      await runDb(db, `UPDATE production_order_materials SET quantity_reserved = 0 WHERE production_order_id = ? AND company_id = ?`, [id, companyId]);
      await runDb(db, `UPDATE production_orders SET status = 'cancelled', cancellation_reason = COALESCE(NULLIF(?, ''), cancellation_reason), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?`, [clean(req.body.reason), id, companyId]);
    } else if (status === 'in_production') {
      await runDb(db, `UPDATE production_orders SET status = 'in_production', real_start_date = COALESCE(real_start_date, DATE('now')), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?`, [id, companyId]);
    } else if (status === 'paused') {
      await runDb(db, `UPDATE production_orders SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?`, [id, companyId]);
    } else if (status === 'finished') {
      await runDb(db, `UPDATE production_order_boms SET quantity_finished = quantity_planned WHERE production_order_id = ? AND company_id = ? AND quantity_finished < quantity_planned`, [id, companyId]);
      const orderBoms = await getOrderBomLines(db, companyId, id);
      const finishedQty = orderBoms.length
        ? orderBoms.reduce((sum, line) => sum + Number(line.quantity_finished || line.quantity_planned || 0), 0)
        : Number(order.quantity_planned || 0);
      await runDb(db, `UPDATE production_orders SET status = 'finished', quantity_finished = ?, real_end_date = COALESCE(real_end_date, DATE('now')), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?`, [finishedQty, id, companyId]);
    }
    await auditProduction(db, req, 'bulk_change_status', 'production_orders', id, { status: order.status }, { status });
  }
}

async function nextOrderNumber(db, companyId) {
  const row = await getDb(db, "SELECT COUNT(*) AS total FROM production_orders WHERE company_id = ?", [companyId]);
  return `OP-${String(Number(row && row.total || 0) + 1).padStart(4, '0')}`;
}

async function insertMovement(db, req, type, productId, qty, before, after, reference, orderId, unitCost = 0) {
  const companyId = getCompanyIdFromReq(req);
  await runDb(db, `INSERT INTO inventory_movements (company_id, product_id, movement_type, quantity, stock_before, stock_after, unit_cost, total_cost, reference_type, reference_id, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'production_order', ?, ?, ?, CURRENT_TIMESTAMP)`, [companyId, productId, type, qty, before, after, unitCost, qty * unitCost, orderId, reference, currentUserId(req)]);
}

async function auditProduction(db, req, action, tableName, recordId, oldValue, newValue) {
  const companyId = getCompanyIdFromReq(req);
  await runDb(db, `INSERT INTO production_audit_logs (company_id, user_id, action, table_name, record_id, old_value, new_value, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [
    companyId,
    currentUserId(req),
    action,
    tableName,
    recordId || null,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null,
    req.ip || null
  ]);
}

async function ensureProductionSchema(db) {
  await runDb(db, `INSERT INTO permission_modules (code, name, description) VALUES ('production', 'Produccion y Manufactura', 'Ordenes de produccion, BOM, costos y producto terminado') ON CONFLICT (code) DO NOTHING`);
  await runDb(db, `INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES
    ('view','Ver','Acceso de lectura'),
    ('create_order','Crear orden','Crear ordenes de produccion'),
    ('edit_order','Editar orden','Editar ordenes y formulas'),
    ('start_production','Iniciar produccion','Consumir materiales e iniciar'),
    ('finish_production','Finalizar produccion','Ingresar producto terminado'),
    ('cancel_production','Cancelar produccion','Cancelar ordenes'),
    ('view_costs','Ver costos','Ver costos de produccion'),
    ('edit_costs','Editar costos','Registrar y editar costos'),
    ('record_labor','Registrar mano de obra','Agregar mano de obra'),
    ('record_waste','Registrar desperdicio','Registrar merma'),
    ('approve_production','Aprobar produccion','Aprobar procesos productivos'),
    ('view_reports','Ver reportes','Ver reportes de produccion')`);
  await runDb(db, `INSERT OR IGNORE INTO module_actions (module_id, action_id)
    SELECT pm.id, pa.id FROM permission_modules pm, permission_actions pa
    WHERE pm.code = 'production' AND pa.code IN ('view','create_order','edit_order','start_production','finish_production','cancel_production','view_costs','edit_costs','record_labor','record_waste','approve_production','view_reports')`);
  await addColumn(db, 'items', 'production_type', "TEXT NOT NULL DEFAULT 'supply'");
  await addColumn(db, 'items', 'currency', "TEXT NOT NULL DEFAULT 'GTQ'");
  await addColumn(db, 'items', 'average_cost', 'REAL NOT NULL DEFAULT 0');
  await addColumn(db, 'items', 'last_cost', 'REAL NOT NULL DEFAULT 0');
  await addColumn(db, 'items', 'is_production_active', 'INTEGER NOT NULL DEFAULT 1');
  await addColumn(db, 'items', 'production_labor_cost', 'REAL NOT NULL DEFAULT 0');
  await addColumn(db, 'items', 'production_days', 'REAL NOT NULL DEFAULT 0');
  await addColumn(db, 'items', 'production_notes', 'TEXT');
  await addColumn(db, 'items', 'production_photo_path', 'TEXT');
  await addColumn(db, 'items', 'production_support_path', 'TEXT');
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_boms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    finished_product_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    base_quantity REAL NOT NULL DEFAULT 1,
    unit TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_bom_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    bom_id INTEGER NOT NULL,
    material_product_id INTEGER NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT,
    waste_percentage REAL NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    order_number TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    bom_id INTEGER,
    quantity_planned REAL NOT NULL,
    quantity_finished REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    estimated_start_date TEXT,
    estimated_end_date TEXT,
    real_start_date TEXT,
    real_end_date TEXT,
    estimated_cost REAL NOT NULL DEFAULT 0,
    real_cost REAL NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    notes TEXT,
    cancellation_reason TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_order_boms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    production_order_id INTEGER NOT NULL,
    bom_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity_planned REAL NOT NULL DEFAULT 0,
    quantity_finished REAL NOT NULL DEFAULT 0,
    estimated_cost REAL NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_order_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    production_order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity_required REAL NOT NULL DEFAULT 0,
    quantity_reserved REAL NOT NULL DEFAULT 0,
    quantity_consumed REAL NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    waste_percentage REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_labor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    production_order_id INTEGER NOT NULL,
    employee_id INTEGER,
    worker_name TEXT,
    hours REAL NOT NULL DEFAULT 0,
    hourly_cost REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_overhead (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    production_order_id INTEGER NOT NULL,
    cost_type TEXT,
    description TEXT,
    amount REAL NOT NULL DEFAULT 0,
    distribution_method TEXT NOT NULL DEFAULT 'order',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_waste (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    production_order_id INTEGER,
    product_id INTEGER NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    reason TEXT,
    cost REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    movement_type TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    stock_before REAL NOT NULL DEFAULT 0,
    stock_after REAL NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    reference_type TEXT,
    reference_id INTEGER,
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, `CREATE TABLE IF NOT EXISTS production_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    user_id INTEGER,
    action TEXT NOT NULL,
    table_name TEXT,
    record_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runDb(db, 'CREATE UNIQUE INDEX IF NOT EXISTS ux_production_boms_company_code ON production_boms (company_id, code)');
  await runDb(db, 'CREATE UNIQUE INDEX IF NOT EXISTS ux_production_orders_company_number ON production_orders (company_id, order_number)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_production_orders_company_status ON production_orders (company_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_production_order_boms_order ON production_order_boms (company_id, production_order_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_production_order_boms_product ON production_order_boms (company_id, product_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_production_materials_order ON production_order_materials (company_id, production_order_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_inventory_movements_production ON inventory_movements (company_id, movement_type, reference_id)');
}

function reservedSql() {
  return `SELECT company_id, product_id, SUM(MAX(quantity_reserved - quantity_consumed, 0)) AS reserved_qty
    FROM production_order_materials
    WHERE production_order_id IN (SELECT id FROM production_orders WHERE status IN ('pending','in_production','paused'))
    GROUP BY company_id, product_id`;
}

function addColumn(db, table, column, type) {
  return runDb(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).catch((err) => {
    if (!err || !String(err.message || '').toLowerCase().includes('duplicate column')) throw err;
  });
}

function normalizeOrderFilters(query) {
  return {
    date_from: cleanDate(query.date_from),
    date_to: cleanDate(query.date_to),
    product_id: toId(query.product_id),
    status: PRODUCTION_STATUSES.includes(query.status) ? query.status : '',
    user_id: toId(query.user_id),
    order: clean(query.order),
    cost_min: positiveNumber(query.cost_min),
    cost_max: positiveNumber(query.cost_max)
  };
}

function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function allDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function arrayOf(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function currentUserId(req) {
  const id = Number(req.session && req.session.user && req.session.user.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isAdmin(req) {
  return Boolean(req.session && ((req.session.permissionMap && req.session.permissionMap.isAdmin) || (req.session.user && req.session.user.role === 'admin')));
}

function clean(value) {
  return String(value || '').trim();
}

function normalizeCode(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
}

function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function positiveNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function nonNegativeNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function normalizeMaterialSku(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
}

function normalizeProductSku(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
}

function productCodePrefix(name) {
  return clean(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 3);
}

function normalizeProductCodeForName(value, name) {
  const prefix = productCodePrefix(name);
  const code = clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 40);
  if (!prefix) return code;
  if (!code) return prefix;
  return code.startsWith(prefix) ? code : `${prefix}${code}`.slice(0, 40);
}

async function nextMaterialSku(db, companyId) {
  const row = await getDb(db, "SELECT COUNT(*) AS total FROM items WHERE company_id = ? AND production_type = 'raw_material'", [companyId]);
  let next = Number(row && row.total || 0) + 1;
  while (next < 100000) {
    const sku = `MP-${String(next).padStart(4, '0')}`;
    const exists = await getDb(db, 'SELECT id FROM items WHERE sku = ? AND company_id = ?', [sku, companyId]);
    if (!exists) return sku;
    next += 1;
  }
  return `MP-${Date.now()}`;
}

async function nextProductSku(db, companyId) {
  const row = await getDb(db, "SELECT COUNT(*) AS total FROM items WHERE company_id = ? AND production_type = 'finished_good'", [companyId]);
  let next = Number(row && row.total || 0) + 1;
  while (next < 100000) {
    const sku = `PT-${String(next).padStart(4, '0')}`;
    const exists = await getDb(db, 'SELECT id FROM items WHERE sku = ? AND company_id = ?', [sku, companyId]);
    if (!exists) return sku;
    next += 1;
  }
  return `PT-${Date.now()}`;
}

function cleanDate(value) {
  const text = clean(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function statusLabels() {
  return {
    draft: 'Borrador',
    pending: 'Pendiente',
    in_production: 'En produccion',
    paused: 'Pausada',
    finished: 'Finalizada',
    cancelled: 'Cancelada'
  };
}

function productTypeLabels() {
  return {
    raw_material: 'Materia prima',
    supply: 'Insumo',
    packaging: 'Material de empaque',
    work_in_process: 'Producto en proceso',
    finished_good: 'Producto terminado'
  };
}

module.exports = {
  registerProductionRoutes
};
