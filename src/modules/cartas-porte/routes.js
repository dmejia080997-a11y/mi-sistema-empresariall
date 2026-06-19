const fs = require('fs');
const cartasModel = require('./model');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function userId(req) {
  return req.session && req.session.user ? req.session.user.id : null;
}

function audit(logAction, req, companyId, action, details) {
  if (typeof logAction !== 'function') return;
  logAction(userId(req), `cartas_porte.${action}`, JSON.stringify(details || {}), companyId);
}

function filtersFromQuery(query) {
  return {
    numero: query.numero,
    remitente: query.remitente,
    destinatario: query.destinatario,
    fecha_desde: query.fecha_desde,
    fecha_hasta: query.fecha_hasta,
    estado: query.estado || 'Todos',
    placa: query.placa,
    conductor: query.conductor
  };
}

const PRINT_LABELS = {
  es: {
    documentTitle: 'CARTA PORTE',
    transportDocument: 'Documento de transporte terrestre',
    number: 'Numero',
    issueDate: 'Fecha de emision',
    status: 'Estado',
    sender: 'Datos del remitente',
    senderParty: 'remitente',
    recipient: 'Datos del destinatario',
    recipientParty: 'destinatario',
    carrierVehicle: 'Transportista, conductor y vehiculo',
    routeDates: 'Origen, destino y fechas',
    goods: 'Mercancias',
    name: 'Nombre',
    taxId: 'NIT',
    phone: 'Telefono',
    email: 'Email',
    address: 'Direccion',
    contact: 'Contacto',
    carrier: 'Transportista',
    carrierParty: 'transportista',
    driver: 'Conductor',
    driverIdLicense: 'DPI / Licencia',
    vehicle: 'Vehiculo',
    trailerContainerSeal: 'Remolque / Contenedor / Marchamo',
    origin: 'Origen',
    destination: 'Destino',
    pickup: 'Recoleccion',
    estimatedDelivery: 'Entrega estimada',
    serviceTransport: 'Servicio / transporte',
    qty: 'Cant.',
    packaging: 'Embalaje',
    description: 'Descripcion',
    grossWeight: 'P. bruto',
    netWeight: 'P. neto',
    volume: 'Vol.',
    value: 'Valor',
    marks: 'Marcas',
    totals: 'Totales',
    packages: 'bultos',
    transportConditions: 'Condiciones de transporte',
    notesInstructions: 'Observaciones / instrucciones',
    signaturePrefix: 'Firma y sello del',
    receptionDate: 'Fecha y hora de recepcion',
    receiverName: 'Nombre de quien recibe',
    receiverId: 'DPI de quien recibe',
    company: 'Empresa'
  },
  en: {
    documentTitle: 'BILL OF LADING',
    transportDocument: 'Ground transport document',
    number: 'Number',
    issueDate: 'Issue date',
    status: 'Status',
    sender: 'Shipper information',
    senderParty: 'shipper',
    recipient: 'Consignee information',
    recipientParty: 'consignee',
    carrierVehicle: 'Carrier, driver and vehicle',
    routeDates: 'Origin, destination and dates',
    goods: 'Goods',
    name: 'Name',
    taxId: 'Tax ID',
    phone: 'Phone',
    email: 'Email',
    address: 'Address',
    contact: 'Contact',
    carrier: 'Carrier',
    carrierParty: 'carrier',
    driver: 'Driver',
    driverIdLicense: 'ID / License',
    vehicle: 'Vehicle',
    trailerContainerSeal: 'Trailer / Container / Seal',
    origin: 'Origin',
    destination: 'Destination',
    pickup: 'Pickup',
    estimatedDelivery: 'Estimated delivery',
    serviceTransport: 'Service / transport',
    qty: 'Qty.',
    packaging: 'Packaging',
    description: 'Description',
    grossWeight: 'Gross wt.',
    netWeight: 'Net wt.',
    volume: 'Vol.',
    value: 'Value',
    marks: 'Marks',
    totals: 'Totals',
    packages: 'packages',
    transportConditions: 'Transport conditions',
    notesInstructions: 'Notes / special instructions',
    signaturePrefix: 'Signature and stamp of',
    receptionDate: 'Reception date and time',
    receiverName: 'Received by',
    receiverId: 'Receiver ID',
    company: 'Company'
  }
};

function printLabels(carta) {
  return PRINT_LABELS[cartasModel.normalizeLanguage(carta && carta.idioma)] || PRINT_LABELS.es;
}

function emptyCarta() {
  return {
    fecha_emision: new Date().toISOString().slice(0, 10),
    estado: 'Borrador',
    idioma: 'es',
    origen_pais: 'Guatemala',
    destino_pais: 'Guatemala',
    items: [{ moneda: 'USD' }]
  };
}

function validateForIssue(carta, items) {
  const required = [
    ['remitente_nombre', 'Remitente'],
    ['destinatario_nombre', 'Destinatario'],
    ['transportista_nombre', 'Transportista'],
    ['origen_direccion', 'Origen'],
    ['destino_direccion', 'Destino'],
    ['placa_vehiculo', 'Placa del vehiculo'],
    ['conductor_nombre', 'Nombre del conductor']
  ];
  const missing = required
    .filter(([field]) => !cartasModel.clean(carta[field]))
    .map(([, label]) => label);
  if (!items.length) missing.push('Al menos un item de mercancia');
  if (items.some((item) => Number(item.cantidad_bultos) <= 0)) missing.push('Cantidad de bultos');
  if (items.some((item) => Number(item.peso_bruto) <= 0)) missing.push('Peso bruto');
  return missing;
}

function renderForm(res, view, carta, error) {
  const items = Array.isArray(carta.items) && carta.items.length ? carta.items : [{ moneda: 'USD' }];
  res.render(view, {
    carta: { ...carta, items },
    statuses: cartasModel.STATUSES,
    error: error || null,
    flash: res.locals.flash
  });
}

async function loadCartaOr404(db, companyId, id) {
  const carta = await cartasModel.find(db, companyId, id);
  if (!carta) {
    const err = new Error('Carta Porte no encontrada');
    err.status = 404;
    throw err;
  }
  return carta;
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
    return getCompanyBrandById(companyId, (companyBrand) => resolve(companyBrand || null));
  });
  return {
    ...(company || {}),
    ...(brand || {}),
    address: (company && (company.address || company.tax_address)) || (brand && brand.address) || null,
    nit: (company && company.nit) || (brand && brand.nit) || null,
    phone: (company && company.phone) || (brand && brand.phone) || null,
    email: (company && company.email) || (brand && brand.email) || null
  };
}

function drawPdf(doc, carta, companyBrand) {
  const labels = printLabels(carta);
  const left = 40;
  const width = 532;
  const row = (label, value, x, y, w) => {
    doc.font('Helvetica-Bold').fontSize(7).text(label, x, y);
    doc.font('Helvetica').fontSize(8).text(value || '-', x, y + 10, { width: w });
  };
  const section = (title, y) => {
    doc.rect(left, y, width, 18).fill('#e5e7eb');
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9).text(title, left + 6, y + 5);
    return y + 24;
  };

  doc.fillColor('#111827');
  if (companyBrand && companyBrand.logo_path && fs.existsSync(companyBrand.logo_path)) {
    try {
      doc.image(companyBrand.logo_path, left, 28, { fit: [88, 56] });
    } catch (err) {
      doc.font('Helvetica-Bold').fontSize(11).text(companyBrand.name || labels.company, left, 40, { width: 120 });
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(11).text((companyBrand && companyBrand.name) || labels.company, left, 40, { width: 150 });
  }

  doc.font('Helvetica-Bold').fontSize(18).text(labels.documentTitle, 170, 30, { width: 220, align: 'center' });
  row(labels.number, carta.numero, 410, 30, 150);
  row(labels.issueDate, carta.fecha_emision, 410, 54, 150);
  row(labels.status, carta.estado, 410, 78, 150);
  doc.font('Helvetica').fontSize(8).text(
    [
      companyBrand && (companyBrand.legal_name || companyBrand.name),
      companyBrand && companyBrand.address,
      companyBrand && companyBrand.nit ? `NIT: ${companyBrand.nit}` : '',
      companyBrand && companyBrand.phone,
      companyBrand && companyBrand.email
    ].filter(Boolean).join('\n'),
    left,
    88,
    { width: 260 }
  );

  let y = 130;
  y = section(`1. ${labels.sender}`, y);
  row(labels.name, carta.remitente_nombre, left, y, 180);
  row(labels.taxId, carta.remitente_nit, 230, y, 90);
  row(labels.phone, carta.remitente_telefono, 330, y, 100);
  row(labels.email, carta.remitente_email, 440, y, 130);
  row(labels.address, carta.remitente_direccion, left, y + 26, 360);
  row(labels.contact, carta.remitente_contacto, 420, y + 26, 150);

  y += 58;
  y = section(`2. ${labels.recipient}`, y);
  row(labels.name, carta.destinatario_nombre, left, y, 180);
  row(labels.taxId, carta.destinatario_nit, 230, y, 90);
  row(labels.phone, carta.destinatario_telefono, 330, y, 100);
  row(labels.email, carta.destinatario_email, 440, y, 130);
  row(labels.address, carta.destinatario_direccion, left, y + 26, 360);
  row(labels.contact, carta.destinatario_contacto, 420, y + 26, 150);

  y += 58;
  y = section(`3. ${labels.carrierVehicle}`, y);
  row(labels.carrier, carta.transportista_nombre, left, y, 180);
  row(labels.taxId, carta.transportista_nit, 230, y, 90);
  row(labels.driver, carta.conductor_nombre, 330, y, 120);
  row(labels.driverIdLicense, [carta.conductor_dpi, carta.conductor_licencia].filter(Boolean).join(' / '), 460, y, 110);
  row(labels.vehicle, [carta.tipo_vehiculo, carta.marca_vehiculo, carta.placa_vehiculo].filter(Boolean).join(' / '), left, y + 26, 220);
  row(labels.trailerContainerSeal, [carta.placa_remolque, carta.numero_contenedor, carta.numero_marchamo].filter(Boolean).join(' / '), 300, y + 26, 270);

  y += 58;
  y = section(`4. ${labels.routeDates}`, y);
  row(labels.origin, [carta.origen_direccion, carta.origen_municipio, carta.origen_departamento, carta.origen_pais].filter(Boolean).join(', '), left, y, 250);
  row(labels.destination, [carta.destino_direccion, carta.destino_municipio, carta.destino_departamento, carta.destino_pais].filter(Boolean).join(', '), 310, y, 260);
  row(labels.pickup, [carta.fecha_recoleccion, carta.hora_recoleccion].filter(Boolean).join(' '), left, y + 30, 170);
  row(labels.estimatedDelivery, [carta.fecha_entrega_estimada, carta.hora_entrega_estimada].filter(Boolean).join(' '), 230, y + 30, 170);
  row(labels.serviceTransport, [carta.tipo_servicio, carta.tipo_transporte].filter(Boolean).join(' / '), 410, y + 30, 160);

  y += 66;
  y = section(`5. ${labels.goods}`, y);
  const headers = [labels.qty, labels.packaging, labels.description, labels.grossWeight, labels.netWeight, labels.volume, labels.value, 'HS', labels.marks];
  const cols = [40, 72, 85, 240, 292, 344, 394, 456, 492];
  const widths = [28, 48, 150, 46, 46, 42, 56, 32, 80];
  doc.font('Helvetica-Bold').fontSize(7);
  headers.forEach((h, i) => doc.text(h, cols[i], y, { width: widths[i] }));
  doc.moveTo(left, y + 12).lineTo(left + width, y + 12).strokeColor('#9ca3af').stroke();
  y += 16;
  doc.font('Helvetica').fontSize(7);
  (carta.items || []).slice(0, 8).forEach((item) => {
    const values = [item.cantidad_bultos, item.tipo_embalaje, item.descripcion_mercancia, item.peso_bruto, item.peso_neto, item.volumen, `${item.valor_declarado || ''} ${item.moneda || ''}`, item.hs_code, item.marcas_numeros];
    values.forEach((value, i) => doc.text(value || '', cols[i], y, { width: widths[i], height: 28 }));
    y += 30;
  });

  y += 4;
  doc.font('Helvetica-Bold').fontSize(8).text(
    `${labels.totals}: ${labels.packages} ${carta.total_bultos || 0} | ${labels.grossWeight} ${carta.total_peso_bruto || 0} | ${labels.netWeight} ${carta.total_peso_neto || 0} | ${labels.volume} ${carta.total_volumen || 0} | ${labels.value} ${carta.total_valor_declarado || 0}`,
    left,
    y,
    { width }
  );

  y += 24;
  row(labels.transportConditions, carta.condiciones_transporte, left, y, 250);
  row(labels.notesInstructions, [carta.observaciones, carta.instrucciones_especiales].filter(Boolean).join('\n'), 310, y, 260);

  y = 690;
  [labels.senderParty, labels.carrierParty, labels.recipientParty].forEach((label, index) => {
    const x = left + index * 178;
    doc.moveTo(x, y).lineTo(x + 150, y).strokeColor('#111827').stroke();
    doc.font('Helvetica').fontSize(8).text(`${labels.signaturePrefix} ${label.toLowerCase()}`, x, y + 6, { width: 150, align: 'center' });
  });
  row(labels.receptionDate, carta.fecha_hora_recepcion, left, 735, 170);
  row(labels.receiverName, carta.recibe_nombre, 230, 735, 170);
  row(labels.receiverId, carta.recibe_dpi, 420, 735, 150);
}

function sendPdf(res, PDFDocument, carta, companyBrand) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
  const filename = `Carta_Porte_${carta.numero}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  drawPdf(doc, carta, companyBrand);
  doc.end();
}

function registerCartasPorteRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    getCompanyId,
    setFlash,
    logAction,
    getCompanyBrandById,
    PDFDocument
  } = deps;

  cartasModel.ensureTables(db).catch((err) => console.error('[cartas-porte] ensure tables failed', err));

  async function renderList(req, res, archived) {
    const companyId = getCompanyId(req);
    const filters = { ...filtersFromQuery(req.query || {}), archived };
    const cartas = await cartasModel.list(db, companyId, filters);
    res.render('cartas-porte/index', {
      cartas,
      filters,
      statuses: archived ? ['Anulada'] : cartasModel.STATUSES.filter((status) => status !== 'Anulada'),
      archived,
      flash: res.locals.flash
    });
  }

  app.get('/cartas-porte', requireAuth, requirePermission('cartas_porte', 'ver'), asyncRoute(async (req, res) => {
    await renderList(req, res, false);
  }));

  app.get('/cartas-porte/archivados', requireAuth, requirePermission('cartas_porte', 'ver'), asyncRoute(async (req, res) => {
    await renderList(req, res, true);
  }));

  app.get('/cartas-porte/new', requireAuth, requirePermission('cartas_porte', 'crear'), (req, res) => {
    renderForm(res, 'cartas-porte/new', emptyCarta());
  });

  app.post('/cartas-porte', requireAuth, requirePermission('cartas_porte', 'crear'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const action = req.body.action === 'emitir' ? 'Emitida' : 'Borrador';
    const items = cartasModel.normalizeItems(req.body.items);
    if (action === 'Emitida') {
      const missing = validateForIssue(req.body, items);
      if (missing.length) return renderForm(res, 'cartas-porte/new', { ...req.body, items }, `No se puede emitir. Falta: ${missing.join(', ')}.`);
    }
    const id = await cartasModel.create(db, companyId, userId(req), req.body, req.body.items, action);
    audit(logAction, req, companyId, action === 'Emitida' ? 'emision' : 'creacion', { id });
    setFlash(req, 'success', action === 'Emitida' ? 'Carta Porte emitida.' : 'Carta Porte guardada como borrador.');
    res.redirect(`/cartas-porte/${id}`);
  }));

  app.get('/cartas-porte/:id', requireAuth, requirePermission('cartas_porte', 'ver'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const carta = await loadCartaOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    res.render('cartas-porte/show', { carta, companyBrand, flash: res.locals.flash });
  }));

  app.get('/cartas-porte/:id/edit', requireAuth, requirePermission('cartas_porte', 'editar'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const carta = await loadCartaOr404(db, companyId, Number(req.params.id));
    if (carta.estado !== 'Borrador') {
      setFlash(req, 'error', 'Una carta emitida o anulada no puede editarse.');
      return res.redirect(`/cartas-porte/${carta.id}`);
    }
    return renderForm(res, 'cartas-porte/edit', carta);
  }));

  app.post('/cartas-porte/:id/update', requireAuth, requirePermission('cartas_porte', 'editar'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = Number(req.params.id);
    const action = req.body.action === 'emitir' ? 'Emitida' : 'Borrador';
    const items = cartasModel.normalizeItems(req.body.items);
    if (action === 'Emitida') {
      const missing = validateForIssue(req.body, items);
      if (missing.length) return renderForm(res, 'cartas-porte/edit', { ...req.body, id, items }, `No se puede emitir. Falta: ${missing.join(', ')}.`);
    }
    await cartasModel.update(db, companyId, id, userId(req), req.body, req.body.items, action);
    audit(logAction, req, companyId, action === 'Emitida' ? 'emision' : 'edicion', { id });
    setFlash(req, 'success', action === 'Emitida' ? 'Carta Porte emitida.' : 'Carta Porte actualizada.');
    res.redirect(`/cartas-porte/${id}`);
  }));

  app.post('/cartas-porte/:id/void', requireAuth, requirePermission('cartas_porte', 'anular'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const id = Number(req.params.id);
    await loadCartaOr404(db, companyId, id);
    await cartasModel.setStatus(db, companyId, id, userId(req), 'Anulada');
    audit(logAction, req, companyId, 'anulacion', { id });
    setFlash(req, 'success', 'Carta Porte anulada y archivada.');
    res.redirect('/cartas-porte/archivados');
  }));

  app.post('/cartas-porte/:id/duplicate', requireAuth, requirePermission('cartas_porte', 'crear'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const source = await loadCartaOr404(db, companyId, Number(req.params.id));
    const id = await cartasModel.create(db, companyId, userId(req), { ...source, estado: 'Borrador' }, source.items, 'Borrador');
    audit(logAction, req, companyId, 'creacion', { id, duplicated_from: source.id });
    setFlash(req, 'success', 'Carta Porte duplicada como borrador.');
    res.redirect(`/cartas-porte/${id}/edit`);
  }));

  app.get('/cartas-porte/:id/print', requireAuth, requirePermission('cartas_porte', 'imprimir'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const carta = await loadCartaOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    audit(logAction, req, companyId, 'impresion', { id: carta.id });
    res.render('cartas-porte/print', { carta, companyBrand, labels: printLabels(carta), autoPrint: req.query.auto === '1' });
  }));

  app.get('/cartas-porte/:id/pdf', requireAuth, requirePermission('cartas_porte', 'descargar_pdf'), asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const carta = await loadCartaOr404(db, companyId, Number(req.params.id));
    const companyBrand = await getCompanyBrand(db, getCompanyBrandById, companyId);
    audit(logAction, req, companyId, 'descarga_pdf', { id: carta.id });
    sendPdf(res, PDFDocument, carta, companyBrand);
  }));
}

module.exports = {
  registerCartasPorteRoutes
};
