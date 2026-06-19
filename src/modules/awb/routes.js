const fs = require('fs');
const awbModel = require('./model');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function userId(req) {
  return req.session && req.session.user ? req.session.user.id : null;
}

function audit(logAction, req, companyId, action, details) {
  if (typeof logAction !== 'function') return;
  logAction(userId(req), `awb.${action}`, JSON.stringify(details || {}), companyId);
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

async function getCompanyBrand(db, getCompanyBrandById, companyId) {
  const company = await getDb(
    db,
    'SELECT id, name, legal_name, commercial_name, address, tax_address, nit, phone, email, logo FROM companies WHERE id = ?',
    [companyId]
  ).catch(() => null);
  const brand = await new Promise((resolve) => {
    if (typeof getCompanyBrandById !== 'function') return resolve(null);
    return getCompanyBrandById(companyId, (companyBrand) => resolve(companyBrand || null));
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

function emptyAwb(type = 'MAWB', parent = null) {
  return {
    tipo_awb: type,
    parent_awb_id: parent ? parent.id : null,
    parent_numero_awb: parent ? parent.numero_awb : null,
    fecha_emision: new Date().toISOString().slice(0, 10),
    estado: 'Borrador',
    currency: 'USD',
    cargo_items: [{ dimensions_rows: [{}] }]
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]);
  return [];
}

function filtersFromQuery(query) {
  return {
    numero_awb: query.numero_awb,
    tipo_awb: query.tipo_awb,
    parent_awb_id: query.parent_awb_id,
    shipper: query.shipper,
    consignee: query.consignee,
    airline: query.airline,
    flight: query.flight,
    airport_origin: query.airport_origin,
    airport_destination: query.airport_destination,
    fecha_desde: query.fecha_desde,
    fecha_hasta: query.fecha_hasta,
    estado: query.estado
  };
}

async function loadAwbOr404(db, companyId, id) {
  const awb = await awbModel.find(db, companyId, id);
  if (!awb) {
    const err = new Error('AWB no encontrada');
    err.status = 404;
    throw err;
  }
  return awb;
}

function ensureRows(awb) {
  const rawCargoItems = asArray(awb.cargo_items);
  const cargoItems = rawCargoItems.length ? rawCargoItems : [{ dimensions_rows: [{}] }];
  return {
    ...awb,
    cargo_items: cargoItems.map((item) => ({
      ...item,
      dimensions_rows: asArray(item.dimensions_rows).length ? asArray(item.dimensions_rows) : [{}]
    }))
  };
}

function renderForm(res, view, awb, error) {
  res.render(view, {
    awb: ensureRows(awb),
    types: awbModel.TYPES,
    statuses: awbModel.STATUSES,
    typeMeta: awbModel.TYPE_META,
    error: error || null,
    flash: res.locals.flash
  });
}

function validateForIssueFromBody(body) {
  const cargoItems = awbModel.normalizeCargoItems(body.cargo_items);
  return awbModel.validateForIssue(body, cargoItems);
}

function display(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function money(value, currency) {
  const num = Number(value || 0);
  return `${currency || ''} ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

function section(doc, title, x, y, w) {
  doc.rect(x, y, w, 18).fill('#e5e7eb');
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(7.5).text(title, x + 5, y + 5, { width: w - 10 });
  return y + 23;
}

function kv(doc, label, value, x, y, w) {
  doc.fillColor('#374151').font('Helvetica-Bold').fontSize(6.3).text(label, x, y, { width: w });
  doc.fillColor('#111827').font('Helvetica').fontSize(7.2).text(display(value), x, y + 9, { width: w, height: 23 });
}

function drawPdf(doc, awb, company) {
  const left = 28;
  const width = 556;
  doc.fillColor('#111827');
  if (company && company.logo_path && fs.existsSync(company.logo_path)) {
    try {
      doc.image(company.logo_path, left, 24, { fit: [90, 52] });
    } catch (err) {
      doc.font('Helvetica-Bold').fontSize(12).text(company.name || 'Empresa', left, 36, { width: 140 });
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(12).text((company && company.name) || 'Empresa', left, 36, { width: 150 });
  }

  doc.font('Helvetica-Bold').fontSize(20).text('AIR WAYBILL', 175, 26, { width: 245, align: 'center' });
  doc.font('Helvetica').fontSize(7).text([
    company && (company.legal_name || company.name),
    company && company.address,
    company && company.nit ? `NIT: ${company.nit}` : '',
    company && company.phone,
    company && company.email
  ].filter(Boolean).join('\n'), left, 82, { width: 260 });

  kv(doc, 'Tipo', `${awb.tipo_awb} - ${awb.type_label}`, 430, 28, 140);
  kv(doc, 'Numero AWB', awb.numero_awb, 430, 54, 140);
  kv(doc, 'Fecha / Estado', `${display(awb.fecha_emision)} / ${display(awb.estado)}`, 430, 80, 140);
  kv(doc, 'Referencia MAWB', awb.parent_numero_awb, 430, 106, 140);

  let y = 128;
  y = section(doc, '1. Shipper', left, y, 181);
  doc.font('Helvetica').fontSize(7).text([awb.shipper_nombre, awb.shipper_nit ? `NIT: ${awb.shipper_nit}` : '', awb.shipper_direccion, [awb.shipper_ciudad, awb.shipper_pais].filter(Boolean).join(', '), awb.shipper_telefono, awb.shipper_email, awb.shipper_contacto].filter(Boolean).join('\n'), left + 4, y, { width: 173, height: 62 });
  section(doc, '2. Consignee', left + 188, y - 23, 181);
  doc.font('Helvetica').fontSize(7).text([awb.consignee_nombre, awb.consignee_nit ? `NIT: ${awb.consignee_nit}` : '', awb.consignee_direccion, [awb.consignee_ciudad, awb.consignee_pais].filter(Boolean).join(', '), awb.consignee_telefono, awb.consignee_email, awb.consignee_contacto].filter(Boolean).join('\n'), left + 192, y, { width: 173, height: 62 });
  section(doc, '3. Notify Party', left + 376, y - 23, 180);
  doc.font('Helvetica').fontSize(7).text([awb.notify_nombre, awb.notify_direccion, awb.notify_telefono, awb.notify_email].filter(Boolean).join('\n'), left + 380, y, { width: 172, height: 62 });

  y += 73;
  y = section(doc, '4-9. Issuing Carrier Agent / Routing / Airline / Flight Information', left, y, width);
  [
    ['Agent', awb.agent_nombre], ['IATA', awb.agent_iata], ['Destination Agent', awb.destination_agent], ['Airline', `${display(awb.airline_name)} ${display(awb.airline_code)}`],
    ['Origin', awb.airport_origin], ['Destination', awb.airport_destination], ['Transit', [awb.airport_transit_1, awb.airport_transit_2, awb.airport_transit_3].filter(Boolean).join(' / ')],
    ['Flights', [awb.flight_number_1, awb.flight_number_2, awb.flight_number_3].filter(Boolean).join(' / ')],
    ['Flight Dates', [awb.flight_date_1, awb.flight_date_2, awb.flight_date_3].filter(Boolean).join(' / ')],
    ['Place of Issue', awb.lugar_emision], ['Currency', awb.currency], ['Insurance', money(awb.insurance_amount, awb.currency)]
  ].forEach(([label, value], index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    kv(doc, label, value, left + col * 139, y + row * 26, 132);
  });

  y += 84;
  y = section(doc, '10. Nature and Quantity of Goods', left, y, width);
  const headers = ['Pieces', 'Package Type', 'Description', 'Dimensions', 'Gross Weight', 'Vol. Weight', 'Chargeable', 'CBM', 'HS Code'];
  const xs = [left, 70, 132, 276, 350, 410, 468, 526, 554];
  const ws = [36, 58, 136, 68, 56, 54, 54, 26, 30];
  doc.font('Helvetica-Bold').fontSize(5.9);
  headers.forEach((header, index) => doc.text(header, xs[index], y, { width: ws[index] }));
  y += 12;
  doc.font('Helvetica').fontSize(6.2);
  (awb.cargo_items || []).slice(0, 10).forEach((row) => {
    [row.pieces, row.package_type, row.description_goods, row.dimensions, row.gross_weight, row.volume_weight, row.chargeable_weight, row.volume_cbm, row.hs_code]
      .forEach((value, index) => doc.text(display(value), xs[index], y, { width: ws[index], height: 27 }));
    y += 28;
  });

  y = Math.min(y + 6, 582);
  doc.font('Helvetica-Bold').fontSize(7.5).text(
    `Totals: Pieces ${awb.total_pieces || 0} | Gross ${awb.total_gross_weight || 0} | Volumetric ${awb.total_volume_weight || 0} | Chargeable ${awb.total_chargeable_weight || 0} | CBM ${awb.total_cbm || 0} | Declared ${money(awb.total_declared_value, awb.currency)}`,
    left,
    y,
    { width }
  );

  y += 18;
  y = section(doc, '11-15. Charges / Declared Value / Handling / Dangerous Goods / Conditions', left, y, width);
  kv(doc, 'Freight Prepaid', money(awb.freight_prepaid, awb.currency), left, y, 95);
  kv(doc, 'Freight Collect', money(awb.freight_collect, awb.currency), left + 102, y, 95);
  kv(doc, 'Other Charges', money(awb.other_charges, awb.currency), left + 204, y, 95);
  kv(doc, 'Handling Information', (awb.cargo_items || []).map((item) => item.handling_information).filter(Boolean).join(' / '), left + 306, y, 130);
  kv(doc, 'Dangerous Goods', (awb.cargo_items || []).some((item) => item.dangerous_goods) ? 'YES' : 'NO', left + 446, y, 90);
  kv(doc, 'Observations', awb.observaciones, left, y + 30, 170);
  kv(doc, 'Special Instructions', awb.instrucciones_especiales, left + 185, y + 30, 170);
  kv(doc, 'Transport Conditions', awb.condiciones_transporte, left + 370, y + 30, 170);

  y = 710;
  ['Shipper Signature', 'Carrier Signature', 'Authorized Signature', 'Date'].forEach((label, index) => {
    const x = left + index * 139;
    doc.moveTo(x, y).lineTo(x + 118, y).strokeColor('#111827').stroke();
    doc.fillColor('#111827').font('Helvetica').fontSize(7).text(label, x, y + 7, { width: 118, align: 'center' });
  });
}

function sendPdf(res, PDFDocument, awb, company) {
  const filename = `AWB_${awb.tipo_awb}_${awb.numero_awb}.pdf`;
  const doc = new PDFDocument({ size: 'LETTER', margin: 28 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  drawPdf(doc, awb, company);
  doc.end();
}

function registerAwbRoutes(app, deps) {
  const { db, requireAuth, requirePermission, hasPermission, getCompanyId, setFlash, logAction, getCompanyBrandById, PDFDocument } = deps;

  awbModel.ensureTables(db).catch((err) => console.error('[awb] ensure tables failed', err));

  app.get('/air-waybills', requireAuth, requirePermission('awb', 'ver'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const filters = filtersFromQuery(req.query || {});
    const awbs = await awbModel.list(db, companyId, filters);
    res.render('awb/index', { awbs, filters, types: awbModel.TYPES, statuses: awbModel.STATUSES, typeMeta: awbModel.TYPE_META, flash: res.locals.flash });
  }));

  app.get('/air-waybills/tree', requireAuth, requirePermission('awb', 'ver'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const tree = await awbModel.tree(db, companyId);
    res.render('awb/tree', { tree, typeMeta: awbModel.TYPE_META, flash: res.locals.flash });
  }));

  app.get('/air-waybills/new', requireAuth, requirePermission('awb', 'crear'), (req, res) => {
    renderForm(res, 'awb/new', emptyAwb('MAWB'), null);
  });

  app.post('/air-waybills', requireAuth, requirePermission('awb', 'crear'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const status = req.body.action === 'emitir' ? 'Emitida' : 'Borrador';
    if (status === 'Emitida') {
      const missing = validateForIssueFromBody(req.body);
      if (missing.length) return renderForm(res, 'awb/new', { ...req.body }, `No se puede emitir. Falta: ${missing.join(', ')}.`);
    }
    const id = await awbModel.create(db, companyId, userId(req), req.body, status);
    audit(logAction, req, companyId, status === 'Emitida' ? 'emision' : 'creacion', { id });
    setFlash(req, 'success', status === 'Emitida' ? 'AWB emitida.' : 'AWB guardada como borrador.');
    res.redirect(`/air-waybills/${id}`);
  }));

  app.get('/air-waybills/:id', requireAuth, requirePermission('awb', 'ver'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const awb = await loadAwbOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    res.render('awb/show', { awb, companyBrand, typeMeta: awbModel.TYPE_META, flash: res.locals.flash });
  }));

  app.get('/air-waybills/:id/edit', requireAuth, requirePermission('awb', 'editar'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const awb = await loadAwbOr404(db, companyId, Number(req.params.id));
    if (awb.estado !== 'Borrador') {
      setFlash(req, 'error', 'Una AWB emitida o anulada no puede editarse.');
      return res.redirect(`/air-waybills/${awb.id}`);
    }
    return renderForm(res, 'awb/edit', awb, null);
  }));

  app.post('/air-waybills/:id/update', requireAuth, requirePermission('awb', 'editar'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = Number(req.params.id);
    const current = await loadAwbOr404(db, companyId, id);
    const status = req.body.action === 'emitir' ? 'Emitida' : 'Borrador';
    if (status === 'Emitida') {
      const missing = validateForIssueFromBody({ ...req.body, tipo_awb: current.tipo_awb, parent_awb_id: current.parent_awb_id });
      if (missing.length) return renderForm(res, 'awb/edit', { ...current, ...req.body, id }, `No se puede emitir. Falta: ${missing.join(', ')}.`);
    }
    await awbModel.update(db, companyId, id, userId(req), req.body, status);
    audit(logAction, req, companyId, status === 'Emitida' ? 'emision' : 'edicion', { id });
    setFlash(req, 'success', status === 'Emitida' ? 'AWB emitida.' : 'AWB actualizada.');
    res.redirect(`/air-waybills/${id}`);
  }));

  app.post('/air-waybills/:id/void', requireAuth, requirePermission('awb', 'anular'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const awb = await loadAwbOr404(db, companyId, Number(req.params.id));
    await awbModel.setStatus(db, companyId, awb.id, userId(req), 'Anulada');
    audit(logAction, req, companyId, 'anulacion', { id: awb.id });
    setFlash(req, 'success', 'AWB anulada.');
    res.redirect(`/air-waybills/${awb.id}`);
  }));

  app.post('/air-waybills/:id/duplicate', requireAuth, requirePermission('awb', 'crear'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const source = await loadAwbOr404(db, companyId, Number(req.params.id));
    const id = await awbModel.duplicate(db, companyId, userId(req), source.id, req.body.with_children === '1');
    audit(logAction, req, companyId, req.body.with_children === '1' ? 'duplicacion_con_hijas' : 'duplicacion', { source_id: source.id, id });
    setFlash(req, 'success', req.body.with_children === '1' ? 'MAWB duplicada con HAWB.' : 'AWB duplicada.');
    res.redirect(`/air-waybills/${id}/edit`);
  }));

  app.post('/air-waybills/:id/create-child', requireAuth, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const parent = await loadAwbOr404(db, companyId, Number(req.params.id));
    if (parent.tipo_awb !== 'MAWB') {
      setFlash(req, 'error', 'Una HAWB no puede tener hijas.');
      return res.redirect(`/air-waybills/${parent.id}`);
    }
    if (!hasPermission(req.session.permissionMap, 'awb', 'crear_hija')) return res.status(403).send('Forbidden');
    const id = await awbModel.createChildDraft(db, companyId, userId(req), parent.id);
    audit(logAction, req, companyId, 'creacion_hawb', { parent_id: parent.id, id });
    setFlash(req, 'success', 'HAWB creada desde MAWB.');
    res.redirect(`/air-waybills/${id}/edit`);
  }));

  app.get('/air-waybills/:id/print', requireAuth, requirePermission('awb', 'imprimir'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const awb = await loadAwbOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    audit(logAction, req, companyId, 'impresion', { id: awb.id });
    res.render('awb/print', { awb, companyBrand, typeMeta: awbModel.TYPE_META, autoPrint: req.query.auto === '1' });
  }));

  app.get('/air-waybills/:id/pdf', requireAuth, requirePermission('awb', 'descargar_pdf'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const awb = await loadAwbOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    audit(logAction, req, companyId, 'descarga_pdf', { id: awb.id });
    sendPdf(res, PDFDocument, awb, companyBrand);
  }));
}

module.exports = {
  registerAwbRoutes
};
