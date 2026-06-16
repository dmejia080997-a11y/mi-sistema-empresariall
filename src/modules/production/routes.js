const PRODUCTION_STATUSES = ['draft', 'pending', 'in_production', 'paused', 'finished', 'cancelled'];
const PRODUCT_TYPES = ['raw_material', 'supply', 'packaging', 'work_in_process', 'finished_good'];
const WASTE_REASONS = ['Corte incorrecto', 'Dano de material', 'Producto defectuoso', 'Ajuste normal', 'Otro'];
const OVERHEAD_METHODS = ['order', 'unit', 'percentage', 'manual'];

function registerProductionRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    getCompanyId,
    normalizeString,
    logAction
  } = deps;

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
    const orders = await getOrders(db, companyId, filters, 300);
    const products = await getProducts(db, companyId);
    const users = await allDb(db, 'SELECT id, username FROM users WHERE company_id = ? ORDER BY username', [companyId]);
    res.render('production/index', baseView(req, 'orders', { orders, filters, products, users }));
  }));

  app.get('/production/orders/new', requireAuth, requirePermission('production', 'create_order'), asyncRoute(async (req, res) => {
    res.render('production/index', await orderFormView(req, null, null));
  }));

  app.post('/production/orders/create', requireAuth, requirePermission('production', 'create_order'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const userId = currentUserId(req);
    const productId = toId(req.body.product_id);
    const bomId = toId(req.body.bom_id);
    const qty = positiveNumber(req.body.quantity_planned);
    if (!productId || !bomId || qty <= 0) return res.render('production/index', await orderFormView(req, null, 'Producto, BOM y cantidad son obligatorios.'));
    const bom = await getDb(db, 'SELECT * FROM production_boms WHERE id = ? AND company_id = ? AND finished_product_id = ?', [bomId, companyId, productId]);
    if (!bom) return res.render('production/index', await orderFormView(req, null, 'La formula seleccionada no corresponde al producto terminado.'));
    const items = await allDb(db, 'SELECT * FROM production_bom_items WHERE bom_id = ? AND company_id = ?', [bomId, companyId]);
    if (!items.length) return res.render('production/index', await orderFormView(req, null, 'La formula no tiene materiales.'));
    const orderNumber = await nextOrderNumber(db, companyId);
    const estimatedCost = items.reduce((sum, item) => {
      const scale = qty / Math.max(Number(bom.base_quantity || 1), 1);
      const required = Number(item.quantity || 0) * scale;
      const waste = required * (Number(item.waste_percentage || 0) / 100);
      return sum + (required + waste) * Number(item.unit_cost || 0);
    }, 0);
    const inserted = await runDb(
      db,
      `INSERT INTO production_orders
       (company_id, order_number, product_id, bom_id, quantity_planned, quantity_finished, status, estimated_start_date, estimated_end_date, estimated_cost, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'draft', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [companyId, orderNumber, productId, bomId, qty, cleanDate(req.body.estimated_start_date), cleanDate(req.body.estimated_end_date), estimatedCost, normalizeString(req.body.notes), userId]
    );
    for (const item of items) {
      const scale = qty / Math.max(Number(bom.base_quantity || 1), 1);
      const required = Number(item.quantity || 0) * scale;
      const wasteQty = required * (Number(item.waste_percentage || 0) / 100);
      const total = (required + wasteQty) * Number(item.unit_cost || 0);
      await runDb(
        db,
        `INSERT INTO production_order_materials
         (company_id, production_order_id, product_id, quantity_required, quantity_reserved, quantity_consumed, unit_cost, total_cost, waste_percentage, created_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [companyId, inserted.lastID, item.material_product_id, required, Number(item.unit_cost || 0), total, Number(item.waste_percentage || 0)]
      );
    }
    await auditProduction(db, req, 'create_order', 'production_orders', inserted.lastID, null, { order_number: orderNumber, quantity_planned: qty });
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
    const produced = positiveNumber(req.body.quantity_finished);
    if (produced <= 0) return res.render('production/index', baseView(req, 'order_finish', { ...(await orderDetailData(req, db)), error: 'Debe ingresar una cantidad producida mayor a cero.' }));
    const order = await getDb(db, 'SELECT * FROM production_orders WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!order || !['in_production', 'paused', 'pending'].includes(order.status)) return res.redirect(`/production/orders/${id}`);
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
    const goods = await allDb(db, `SELECT i.*, COALESCE(SUM(po.quantity_finished), 0) AS produced_qty, COALESCE(AVG(po.unit_cost), i.average_cost, i.last_cost, i.price, 0) AS production_cost
      FROM items i
      LEFT JOIN production_orders po ON po.product_id = i.id AND po.company_id = i.company_id AND po.status = 'finished'
      WHERE i.company_id = ? AND i.production_type = 'finished_good'
      GROUP BY i.id
      ORDER BY i.name`, [companyId]);
    res.render('production/index', baseView(req, 'finished_goods', { goods }));
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
  return {
    activeTab,
    moduleTabs: productionTabs(),
    statusLabels: statusLabels(),
    productTypeLabels: productTypeLabels(),
    wasteReasons: WASTE_REASONS,
    overheadMethods: OVERHEAD_METHODS,
    canViewCosts: req.app.locals ? false : false,
    showCosts: typeof req.res?.locals?.can === 'function' ? req.res.locals.can('production', 'view_costs') : false,
    error: null,
    ...data
  };
}

function productionTabs() {
  return [
    { key: 'dashboard', label: 'Panel', href: '/production' },
    { key: 'orders', label: 'Ordenes', href: '/production/orders' },
    { key: 'bom', label: 'Formulas o BOM', href: '/production/bom' },
    { key: 'materials', label: 'Materia prima', href: '/production/materials' },
    { key: 'wip', label: 'En proceso', href: '/production/work-in-process' },
    { key: 'finished_goods', label: 'Terminados', href: '/production/finished-goods' },
    { key: 'waste', label: 'Merma', href: '/production/waste' },
    { key: 'reports', label: 'Reportes', href: '/production/reports' }
  ];
}

async function orderFormView(req, order, error) {
  const companyId = getCompanyIdFromReq(req);
  const products = await getProducts(req.app.locals.db || globalDbFallback(req), companyId);
  return baseView(req, order ? 'order_edit' : 'order_new', {
    order,
    products,
    boms: await allDb(globalDbFallback(req), 'SELECT b.*, i.name AS product_name FROM production_boms b LEFT JOIN items i ON i.id = b.finished_product_id AND i.company_id = b.company_id WHERE b.company_id = ? AND b.status = ? ORDER BY b.name', [companyId, 'active']),
    error
  });
}

async function bomFormView(req, bom, error) {
  const db = globalDbFallback(req);
  const companyId = getCompanyIdFromReq(req);
  const products = await getProducts(db, companyId);
  const items = bom ? await allDb(db, 'SELECT * FROM production_bom_items WHERE bom_id = ? AND company_id = ? ORDER BY id', [bom.id, companyId]) : [];
  return baseView(req, bom ? 'bom_edit' : 'bom_new', { bom, bomItems: items, products, error });
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
      [finishedProductId, code, name, clean(req.body.version) || '1', baseQty, clean(req.body.unit) || 'unidad', enumValue(req.body.status, ['active', 'inactive'], 'active'), clean(req.body.notes), id, companyId]);
    await runDb(db, 'DELETE FROM production_bom_items WHERE bom_id = ? AND company_id = ?', [id, companyId]);
  } else {
    const result = await runDb(db, `INSERT INTO production_boms (company_id, finished_product_id, code, name, version, base_quantity, unit, status, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [companyId, finishedProductId, code, name, clean(req.body.version) || '1', baseQty, clean(req.body.unit) || 'unidad', enumValue(req.body.status, ['active', 'inactive'], 'active'), clean(req.body.notes), currentUserId(req)]);
    bomId = result.lastID;
  }
  const materialIds = arrayOf(req.body.material_product_id);
  const quantities = arrayOf(req.body.quantity);
  const units = arrayOf(req.body.unit_item);
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [companyId, bomId, materialId, qty, clean(units[index]) || 'unidad', waste, unitCost, total]);
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
  return { order, materials, labor, overhead, waste, movements, employees, products, totals };
}

async function buildDashboard(db, companyId) {
  const statuses = await allDb(db, 'SELECT status, COUNT(*) AS total FROM production_orders WHERE company_id = ? GROUP BY status', [companyId]);
  const map = Object.fromEntries(statuses.map((row) => [row.status, Number(row.total || 0)]));
  const reserved = await getDb(db, `SELECT SUM(MAX(quantity_reserved - quantity_consumed, 0) * unit_cost) AS total FROM production_order_materials WHERE company_id = ?`, [companyId]);
  const finished = await getDb(db, "SELECT SUM(quantity_finished) AS qty, SUM(real_cost) AS cost FROM production_orders WHERE company_id = ? AND status = 'finished' AND strftime('%Y-%m', COALESCE(real_end_date, created_at)) = strftime('%Y-%m', 'now')", [companyId]);
  const margin = await getDb(db, "SELECT SUM((i.price - po.unit_cost) * po.quantity_finished) AS profit FROM production_orders po JOIN items i ON i.id = po.product_id AND i.company_id = po.company_id WHERE po.company_id = ? AND po.status = 'finished'", [companyId]);
  return {
    active: (map.in_production || 0) + (map.paused || 0),
    pending: map.pending || 0,
    finished: map.finished || 0,
    cancelled: map.cancelled || 0,
    reserved: Number(reserved && reserved.total || 0),
    finishedQty: Number(finished && finished.qty || 0),
    monthCost: Number(finished && finished.cost || 0),
    estimatedProfit: Number(margin && margin.profit || 0)
  };
}

async function getOrders(db, companyId, filters = {}, limit = 300) {
  const where = ['po.company_id = ?'];
  const params = [companyId];
  if (filters.status) {
    where.push('po.status = ?');
    params.push(filters.status);
  }
  if (filters.product_id) {
    where.push('po.product_id = ?');
    params.push(filters.product_id);
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
  return allDb(db, `SELECT po.*, i.name AS product_name, i.sku, u.username AS created_by_name
    FROM production_orders po
    LEFT JOIN items i ON i.id = po.product_id AND i.company_id = po.company_id
    LEFT JOIN users u ON u.id = po.created_by AND u.company_id = po.company_id
    WHERE ${where.join(' AND ')}
    ORDER BY po.created_at DESC LIMIT ?`, params);
}

async function getProducts(db, companyId) {
  return allDb(db, `SELECT i.*, c.name AS category_name, COALESCE(r.reserved_qty, 0) AS reserved_qty
    FROM items i
    LEFT JOIN categories c ON c.id = i.category_id AND c.company_id = i.company_id
    LEFT JOIN (${reservedSql()}) r ON r.company_id = i.company_id AND r.product_id = i.id
    WHERE i.company_id = ?
    ORDER BY i.name`, [companyId]);
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
  await runDb(db, `INSERT OR IGNORE INTO permission_modules (code, name, description) VALUES ('production', 'Produccion y Manufactura', 'Ordenes de produccion, BOM, costos y producto terminado')`);
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
  await addColumn(db, 'items', 'average_cost', 'REAL NOT NULL DEFAULT 0');
  await addColumn(db, 'items', 'last_cost', 'REAL NOT NULL DEFAULT 0');
  await addColumn(db, 'items', 'is_production_active', 'INTEGER NOT NULL DEFAULT 1');
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
