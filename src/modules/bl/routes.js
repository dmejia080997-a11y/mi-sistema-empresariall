const fs = require('fs');
const blModel = require('./model');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function userId(req) {
  return req.session && req.session.user ? req.session.user.id : null;
}

function audit(logAction, req, companyId, action, details) {
  if (typeof logAction !== 'function') return;
  logAction(userId(req), `bl.${action}`, JSON.stringify(details || {}), companyId);
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function getCompanyBrand(db, getCompanyBrandById, companyId) {
  const company = await getDb(
    db,
    'SELECT id, name, legal_name, commercial_name, address, tax_address, nit, phone, email, logo FROM companies WHERE id = ?',
    [companyId]
  ).catch(() => null);
  const brand = await new Promise((resolve) => {
    if (typeof getCompanyBrandById !== 'function') return resolve(null);
    getCompanyBrandById(companyId, (companyBrand) => resolve(companyBrand || null));
  });
  return {
    ...(company || {}),
    ...(brand || {}),
    name: (company && (company.commercial_name || company.name || company.legal_name)) || (brand && brand.name) || 'Empresa',
    address: (company && (company.address || company.tax_address)) || (brand && brand.address) || null,
    nit: (company && company.nit) || (brand && brand.nit) || null,
    phone: (company && company.phone) || (brand && brand.phone) || null,
    email: (company && company.email) || (brand && brand.email) || null
  };
}

function emptyBl(level = 'MASTER', parent = null) {
  return {
    nivel_bl: level,
    parent_bl_id: parent ? parent.id : null,
    parent_numero_bl: parent ? parent.numero_bl : null,
    fecha_emision: new Date().toISOString().slice(0, 10),
    estado: 'Borrador',
    modalidad: 'FCL',
    moneda: 'USD',
    freight_terms: 'PREPAID',
    containers: [{}],
    cargo_items: [{}]
  };
}

function filtersFromQuery(query) {
  return {
    numero_bl: query.numero_bl,
    nivel_bl: query.nivel_bl,
    parent_bl_id: query.parent_bl_id,
    shipper: query.shipper,
    consignee: query.consignee,
    vessel: query.vessel,
    voyage: query.voyage,
    port_of_loading: query.port_of_loading,
    port_of_discharge: query.port_of_discharge,
    fecha_desde: query.fecha_desde,
    fecha_hasta: query.fecha_hasta,
    estado: query.estado
  };
}

async function loadBlOr404(db, companyId, id) {
  const bl = await blModel.find(db, companyId, id);
  if (!bl) {
    const err = new Error('BL no encontrado');
    err.status = 404;
    throw err;
  }
  return bl;
}

function renderForm(res, view, bl, error) {
  res.render(view, {
    bl: {
      ...bl,
      containers: Array.isArray(bl.containers) && bl.containers.length ? bl.containers : [{}],
      cargo_items: Array.isArray(bl.cargo_items) && bl.cargo_items.length ? bl.cargo_items : [{}]
    },
    levels: blModel.LEVELS,
    statuses: blModel.STATUSES,
    modalities: blModel.MODALITIES,
    freightTerms: blModel.FREIGHT_TERMS,
    levelMeta: blModel.LEVEL_META,
    error: error || null,
    flash: res.locals.flash
  });
}

function validateForIssueFromBody(body) {
  const containers = blModel.normalizeContainers(body.containers);
  const cargoItems = blModel.normalizeCargoItems(body.cargo_items);
  return blModel.validateForIssue(body, containers, cargoItems);
}

function display(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function money(value, currency) {
  const num = Number(value || 0);
  return `${currency || ''} ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

function drawSection(doc, title, x, y, w) {
  doc.rect(x, y, w, 18).fill('#e5e7eb');
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(8).text(title, x + 5, y + 5, { width: w - 10 });
  return y + 23;
}

function drawKeyValue(doc, label, value, x, y, w) {
  doc.fillColor('#374151').font('Helvetica-Bold').fontSize(6.5).text(label, x, y, { width: w });
  doc.fillColor('#111827').font('Helvetica').fontSize(7.5).text(display(value), x, y + 9, { width: w, height: 24 });
}

function drawPdf(doc, bl, company) {
  const left = 32;
  const width = 548;
  doc.fillColor('#111827');
  if (company && company.logo_path && fs.existsSync(company.logo_path)) {
    try {
      doc.image(company.logo_path, left, 26, { fit: [92, 54] });
    } catch (err) {
      doc.font('Helvetica-Bold').fontSize(12).text(company.name || 'Empresa', left, 38, { width: 130 });
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(12).text((company && company.name) || 'Empresa', left, 38, { width: 150 });
  }

  doc.font('Helvetica-Bold').fontSize(18).text('BILL OF LADING', 165, 28, { width: 260, align: 'center' });
  doc.font('Helvetica').fontSize(7).text([
    company && (company.legal_name || company.name),
    company && company.address,
    company && company.nit ? `NIT: ${company.nit}` : '',
    company && company.phone,
    company && company.email
  ].filter(Boolean).join('\n'), left, 84, { width: 260 });

  drawKeyValue(doc, 'Tipo de BL', bl.type_label, 420, 28, 145);
  drawKeyValue(doc, 'Numero de BL', bl.numero_bl, 420, 54, 145);
  drawKeyValue(doc, 'Fecha / Estado', `${display(bl.fecha_emision)} / ${display(bl.estado)}`, 420, 80, 145);
  drawKeyValue(doc, 'BL padre', bl.parent_numero_bl, 420, 106, 145);

  let y = 126;
  y = drawSection(doc, '1. Shipper / Exporter', left, y, 178);
  doc.font('Helvetica').fontSize(7).text([bl.shipper_nombre, bl.shipper_nit ? `NIT: ${bl.shipper_nit}` : '', bl.shipper_direccion, bl.shipper_telefono, bl.shipper_email, bl.shipper_contacto].filter(Boolean).join('\n'), left + 4, y, { width: 170, height: 54 });
  drawSection(doc, '2. Consignee', left + 185, y - 23, 178);
  doc.font('Helvetica').fontSize(7).text([bl.consignee_nombre, bl.consignee_nit ? `NIT: ${bl.consignee_nit}` : '', bl.consignee_direccion, bl.consignee_telefono, bl.consignee_email, bl.consignee_contacto].filter(Boolean).join('\n'), left + 189, y, { width: 170, height: 54 });
  drawSection(doc, '3. Notify Party', left + 370, y - 23, 178);
  doc.font('Helvetica').fontSize(7).text([bl.notify_nombre, bl.notify_nit ? `NIT: ${bl.notify_nit}` : '', bl.notify_direccion, bl.notify_telefono, bl.notify_email, bl.notify_contacto].filter(Boolean).join('\n'), left + 374, y, { width: 170, height: 54 });

  y += 66;
  y = drawSection(doc, '4. Forwarder / Agent', left, y, width);
  drawKeyValue(doc, 'Agente', bl.forwarder_nombre, left, y, 145);
  drawKeyValue(doc, 'NIT', bl.forwarder_nit, left + 150, y, 80);
  drawKeyValue(doc, 'Telefono', bl.forwarder_telefono, left + 235, y, 90);
  drawKeyValue(doc, 'Correo', bl.forwarder_email, left + 330, y, 120);
  drawKeyValue(doc, 'Direccion', bl.forwarder_direccion, left + 455, y, 90);

  y += 38;
  y = drawSection(doc, '5. Vessel and Voyage / Routing', left, y, width);
  [
    ['Carrier', bl.carrier], ['Vessel', bl.vessel], ['Voyage', bl.voyage], ['Receipt', bl.place_of_receipt],
    ['Loading', bl.port_of_loading], ['Discharge', bl.port_of_discharge], ['Delivery', bl.place_of_delivery], ['Final Dest.', bl.final_destination],
    ['ETD', bl.etd], ['ETA', bl.eta], ['Freight', bl.freight_terms], ['Payable at', bl.freight_payable_at]
  ].forEach(([label, value], index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    drawKeyValue(doc, label, value, left + col * 137, y + row * 27, 130);
  });

  y += 88;
  y = drawSection(doc, '12. Containers', left, y, width);
  const containerHeaders = ['Container No.', 'Seal No.', 'Type', 'Packages', 'Package Type', 'Gross Weight', 'Net Weight', 'CBM', 'Marks'];
  const cx = [left, 101, 165, 212, 260, 326, 393, 455, 500];
  const cw = [65, 58, 42, 44, 62, 62, 58, 40, 78];
  doc.font('Helvetica-Bold').fontSize(6.4);
  containerHeaders.forEach((header, index) => doc.text(header, cx[index], y, { width: cw[index] }));
  y += 12;
  doc.font('Helvetica').fontSize(6.3);
  (bl.containers || []).slice(0, 7).forEach((row) => {
    [row.container_number, row.seal_number, row.container_type, row.package_quantity, row.package_type, row.gross_weight, row.net_weight, row.volume_cbm, row.marks_numbers]
      .forEach((value, index) => doc.text(display(value), cx[index], y, { width: cw[index], height: 20 }));
    y += 21;
  });

  y += 5;
  y = drawSection(doc, '13-16. Marks, Description of Goods, Gross Weight, Measurement / CBM', left, y, width);
  const cargoHeaders = ['Quantity', 'Package Type', 'Description', 'HS Code', 'Gross Weight', 'Net Weight', 'CBM', 'Marks/Numbers'];
  const gx = [left, 82, 150, 318, 366, 430, 486, 528];
  const gw = [45, 60, 160, 44, 58, 52, 36, 52];
  doc.font('Helvetica-Bold').fontSize(6.4);
  cargoHeaders.forEach((header, index) => doc.text(header, gx[index], y, { width: gw[index] }));
  y += 12;
  doc.font('Helvetica').fontSize(6.3);
  (bl.cargo_items || []).slice(0, 8).forEach((row) => {
    [row.quantity, row.package_type, row.description, row.hs_code, row.gross_weight, row.net_weight, row.volume_cbm, row.marks_numbers]
      .forEach((value, index) => doc.text(display(value), gx[index], y, { width: gw[index], height: 26 }));
    y += 27;
  });

  y = Math.min(y + 8, 615);
  doc.font('Helvetica-Bold').fontSize(8).text(
    `Totales: Contenedores ${bl.total_containers || 0} | Bultos ${bl.total_packages || 0} | Peso bruto ${bl.total_gross_weight || 0} | Peso neto ${bl.total_net_weight || 0} | CBM ${bl.total_cbm || 0} | Valor ${money(bl.total_declared_value, bl.moneda)}`,
    left,
    y,
    { width }
  );

  y += 20;
  drawKeyValue(doc, '17. Number of Originals', bl.number_of_originals, left, y, 120);
  drawKeyValue(doc, '18. Observations', bl.observaciones, left + 130, y, 190);
  drawKeyValue(doc, '19. Terms and Conditions', bl.condiciones_transporte, left + 330, y, 220);

  y = 710;
  ['Carrier / Agent Signature', 'Shipper Signature', 'Authorized Signature', 'Date'].forEach((label, index) => {
    const x = left + index * 137;
    doc.moveTo(x, y).lineTo(x + 115, y).strokeColor('#111827').stroke();
    doc.fillColor('#111827').font('Helvetica').fontSize(7).text(label, x, y + 7, { width: 115, align: 'center' });
  });
}

function sendPdf(res, PDFDocument, bl, company) {
  const filename = `BL_${bl.numero_bl}.pdf`;
  const doc = new PDFDocument({ size: 'LETTER', margin: 32 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  drawPdf(doc, bl, company);
  doc.end();
}

function registerBlRoutes(app, deps) {
  const { db, requireAuth, requirePermission, getCompanyId, setFlash, logAction, getCompanyBrandById, PDFDocument } = deps;

  blModel.ensureTables(db).catch((err) => console.error('[bl] ensure tables failed', err));

  app.get('/bill-of-lading', requireAuth, requirePermission('bl', 'ver'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const filters = filtersFromQuery(req.query || {});
    const bls = await blModel.list(db, companyId, filters);
    res.render('bl/index', { bls, filters, levels: blModel.LEVELS, statuses: blModel.STATUSES, levelMeta: blModel.LEVEL_META, flash: res.locals.flash });
  }));

  app.get('/bill-of-lading/tree', requireAuth, requirePermission('bl', 'ver'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const tree = await blModel.tree(db, companyId);
    res.render('bl/tree', { tree, levelMeta: blModel.LEVEL_META, flash: res.locals.flash });
  }));

  app.get('/bill-of-lading/new', requireAuth, requirePermission('bl', 'crear'), (req, res) => {
    renderForm(res, 'bl/new', emptyBl('MASTER'), null);
  });

  app.post('/bill-of-lading', requireAuth, requirePermission('bl', 'crear'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const status = req.body.action === 'emitir' ? 'Emitido' : 'Borrador';
    if (status === 'Emitido') {
      const missing = validateForIssueFromBody(req.body);
      if (missing.length) return renderForm(res, 'bl/new', { ...req.body }, `No se puede emitir. Falta: ${missing.join(', ')}.`);
    }
    const id = await blModel.create(db, companyId, userId(req), req.body, status);
    audit(logAction, req, companyId, status === 'Emitido' ? 'emision' : 'creacion', { id });
    setFlash(req, 'success', status === 'Emitido' ? 'BL emitido.' : 'BL guardado como borrador.');
    res.redirect(`/bill-of-lading/${id}`);
  }));

  app.get('/bill-of-lading/:id', requireAuth, requirePermission('bl', 'ver'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const bl = await loadBlOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    res.render('bl/show', { bl, companyBrand, levelMeta: blModel.LEVEL_META, flash: res.locals.flash });
  }));

  app.get('/bill-of-lading/:id/edit', requireAuth, requirePermission('bl', 'editar'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const bl = await loadBlOr404(db, companyId, Number(req.params.id));
    if (bl.estado !== 'Borrador') {
      setFlash(req, 'error', 'Un BL emitido o anulado no puede editarse.');
      return res.redirect(`/bill-of-lading/${bl.id}`);
    }
    return renderForm(res, 'bl/edit', bl, null);
  }));

  app.post('/bill-of-lading/:id/update', requireAuth, requirePermission('bl', 'editar'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = Number(req.params.id);
    const current = await loadBlOr404(db, companyId, id);
    const status = req.body.action === 'emitir' ? 'Emitido' : 'Borrador';
    if (status === 'Emitido') {
      const missing = validateForIssueFromBody({ ...req.body, nivel_bl: current.nivel_bl, parent_bl_id: current.parent_bl_id });
      if (missing.length) return renderForm(res, 'bl/edit', { ...current, ...req.body, id }, `No se puede emitir. Falta: ${missing.join(', ')}.`);
    }
    await blModel.update(db, companyId, id, userId(req), req.body, status);
    audit(logAction, req, companyId, status === 'Emitido' ? 'emision' : 'edicion', { id });
    setFlash(req, 'success', status === 'Emitido' ? 'BL emitido.' : 'BL actualizado.');
    res.redirect(`/bill-of-lading/${id}`);
  }));

  app.post('/bill-of-lading/:id/void', requireAuth, requirePermission('bl', 'anular'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const bl = await loadBlOr404(db, companyId, Number(req.params.id));
    await blModel.setStatus(db, companyId, bl.id, userId(req), 'Anulado');
    audit(logAction, req, companyId, 'anulacion', { id: bl.id });
    setFlash(req, 'success', 'BL anulado.');
    res.redirect(`/bill-of-lading/${bl.id}`);
  }));

  app.post('/bill-of-lading/:id/duplicate', requireAuth, requirePermission('bl', 'crear'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = await blModel.duplicate(db, companyId, userId(req), Number(req.params.id), req.body.with_children === '1');
    audit(logAction, req, companyId, req.body.with_children === '1' ? 'duplicacion_con_hijos' : 'duplicacion', { source_id: Number(req.params.id), id });
    setFlash(req, 'success', req.body.with_children === '1' ? 'BL duplicado con hijos.' : 'BL duplicado.');
    res.redirect(`/bill-of-lading/${id}/edit`);
  }));

  app.post('/bill-of-lading/:id/create-child', requireAuth, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const parent = await loadBlOr404(db, companyId, Number(req.params.id));
    const childLevel = parent.nivel_bl === 'MASTER' ? 'HOUSE' : 'SUB_HOUSE';
    if (parent.nivel_bl === 'SUB_HOUSE') {
      setFlash(req, 'error', 'Un Sub House BL no puede tener hijos.');
      return res.redirect(`/bill-of-lading/${parent.id}`);
    }
    const permission = childLevel === 'HOUSE' ? 'crear_hijo' : 'crear_nieto';
    if (!deps.hasPermission(req.session.permissionMap, 'bl', permission)) return res.status(403).send('Forbidden');
    const id = await blModel.createChildDraft(db, companyId, userId(req), parent.id, childLevel);
    audit(logAction, req, companyId, childLevel === 'HOUSE' ? 'creacion_hijo' : 'creacion_nieto', { parent_id: parent.id, id });
    setFlash(req, 'success', childLevel === 'HOUSE' ? 'BL hijo creado.' : 'BL nieto creado.');
    res.redirect(`/bill-of-lading/${id}/edit`);
  }));

  app.get('/bill-of-lading/:id/print', requireAuth, requirePermission('bl', 'imprimir'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const bl = await loadBlOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    audit(logAction, req, companyId, 'impresion', { id: bl.id });
    res.render('bl/print', { bl, companyBrand, levelMeta: blModel.LEVEL_META, autoPrint: req.query.auto === '1' });
  }));

  app.get('/bill-of-lading/:id/pdf', requireAuth, requirePermission('bl', 'descargar_pdf'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const bl = await loadBlOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    audit(logAction, req, companyId, 'descarga_pdf', { id: bl.id });
    sendPdf(res, PDFDocument, bl, companyBrand);
  }));
}

module.exports = {
  registerBlRoutes
};
