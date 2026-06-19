const transportModel = require('../../models/transport-documents/model');

const TYPE_LABELS = {
  CARTA_PORTE: 'Carta Porte',
  BL: 'Bill of Lading',
  MAWB: 'Guia Aerea / AWB'
};

const STATUS_LABELS = {
  draft: 'Borrador',
  issued: 'Emitido',
  voided: 'Anulado'
};

function text(value) {
  return String(value || '').trim();
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]);
  return [];
}

function stripEmptyRows(rows) {
  return asArray(rows).filter((row) => Object.values(row || {}).some((value) => text(value)));
}

function pickData(body) {
  const excluded = new Set(['_csrf', 'type', 'document_number', 'status', 'issue_date', 'client_name', 'shipper', 'consignee', 'origin', 'destination', 'items', 'charges', 'merchandise']);
  const data = {};
  Object.keys(body || {}).forEach((key) => {
    if (!excluded.has(key)) data[key] = body[key];
  });
  return data;
}

function buildPayload(body) {
  return {
    type: text(body.type || 'MAWB').toUpperCase(),
    document_number: text(body.document_number),
    status: text(body.status || 'draft').toLowerCase(),
    issue_date: text(body.issue_date),
    client_name: text(body.client_name),
    shipper: text(body.shipper),
    consignee: text(body.consignee),
    origin: text(body.origin),
    destination: text(body.destination),
    data: pickData(body),
    items: stripEmptyRows(body.items),
    charges: stripEmptyRows(body.charges),
    merchandise: stripEmptyRows(body.merchandise)
  };
}

function hasPrintableContent(document) {
  if (!document) return false;
  const important = [
    document.document_number,
    document.client_name,
    document.shipper,
    document.consignee,
    document.origin,
    document.destination,
    ...Object.values(document.data || {})
  ];
  const childCount = (document.items || []).length + (document.charges || []).length + (document.merchandise || []).length;
  return childCount > 0 || important.some((value) => text(value));
}

function getPrintView(document) {
  if (document.type === 'CARTA_PORTE') return 'pdf-carta-porte';
  if (document.type === 'BL') return 'pdf-bl';
  return 'pdf-mawb';
}

function validatePayload(payload) {
  if (!['MAWB', 'CARTA_PORTE', 'BL'].includes(payload.type)) return 'Seleccione un tipo de documento valido.';
  if (!payload.document_number) return 'Ingrese el numero de documento.';
  if (!payload.issue_date) return 'Ingrese la fecha de emision.';
  if (!payload.client_name && !payload.shipper && !payload.consignee) {
    return 'Ingrese al menos cliente, shipper o consignee.';
  }
  return null;
}

function renderForm(res, view, document, error) {
  res.render(view, {
    document,
    typeLabels: TYPE_LABELS,
    statusLabels: STATUS_LABELS,
    error,
    flash: res.locals.flash
  });
}

function fetchOrRedirect(req, res, deps, callback) {
  const id = Number(req.params.id || 0);
  const companyId = deps.getCompanyId(req);
  if (!Number.isInteger(id) || id <= 0 || !companyId) return res.redirect('/transport-documents');
  transportModel.getDocument(deps.db, companyId, id, (err, document) => {
    if (err || !document) {
      deps.setFlash(req, 'error', 'Documento de transporte no encontrado.');
      return res.redirect('/transport-documents');
    }
    return callback(document, companyId);
  });
}

function registerTransportDocumentRoutes(app, deps) {
  transportModel.ensureTransportDocumentTables(deps.db);
  const requireTransportPermission = (action) =>
    typeof deps.requirePermission === 'function'
      ? deps.requirePermission('transport_documents', action)
      : deps.requireAuth;

  app.get('/transport-documents', requireTransportPermission('view'), (req, res) => {
    const companyId = deps.getCompanyId(req);
    const filters = {
      type: text(req.query.type || 'all'),
      status: text(req.query.status || 'all'),
      client: text(req.query.client),
      issue_date: text(req.query.issue_date)
    };
    transportModel.listDocuments(deps.db, companyId, filters, (err, documents) => {
      res.render('transport-documents/index', {
        documents: err ? [] : documents,
        filters,
        typeLabels: TYPE_LABELS,
        statusLabels: STATUS_LABELS,
        error: err ? 'No se pudo cargar el listado.' : null,
        flash: res.locals.flash
      });
    });
  });

  app.get('/transport-documents/new', requireTransportPermission('create'), (req, res) => {
    renderForm(res, 'transport-documents/new', {
      type: text(req.query.type || 'MAWB').toUpperCase(),
      status: 'draft',
      issue_date: new Date().toISOString().slice(0, 10),
      data: {},
      items: [{}, {}, {}],
      charges: [{}, {}, {}],
      merchandise: [{}, {}, {}]
    });
  });

  app.post('/transport-documents', requireTransportPermission('create'), (req, res) => {
    const companyId = deps.getCompanyId(req);
    const payload = buildPayload(req.body || {});
    const error = validatePayload(payload);
    if (error) return renderForm(res, 'transport-documents/new', payload, error);
    transportModel.createDocument(deps.db, companyId, req.session.user && req.session.user.id, payload, (err, id) => {
      if (err) return renderForm(res, 'transport-documents/new', payload, 'No se pudo guardar el documento.');
      deps.setFlash(req, 'success', 'Documento de transporte guardado.');
      return res.redirect(`/transport-documents/${id}`);
    });
  });

  app.get('/transport-documents/:id', requireTransportPermission('view'), (req, res) => {
    fetchOrRedirect(req, res, deps, (document) => {
      res.render('transport-documents/show', { document, typeLabels: TYPE_LABELS, statusLabels: STATUS_LABELS, flash: res.locals.flash });
    });
  });

  app.get('/transport-documents/:id/edit', requireTransportPermission('edit'), (req, res) => {
    fetchOrRedirect(req, res, deps, (document) => {
      if (document.status === 'voided') {
        deps.setFlash(req, 'error', 'No se puede editar un documento anulado.');
        return res.redirect(`/transport-documents/${document.id}`);
      }
      return renderForm(res, 'transport-documents/edit', document);
    });
  });

  app.post('/transport-documents/:id/update', requireTransportPermission('edit'), (req, res) => {
    fetchOrRedirect(req, res, deps, (document, companyId) => {
      if (document.status === 'voided') {
        deps.setFlash(req, 'error', 'No se puede editar un documento anulado.');
        return res.redirect(`/transport-documents/${document.id}`);
      }
      const payload = buildPayload(req.body || {});
      const error = validatePayload(payload);
      if (error) {
        payload.id = document.id;
        return renderForm(res, 'transport-documents/edit', payload, error);
      }
      return transportModel.updateDocument(deps.db, companyId, document.id, payload, (err) => {
        if (err) return renderForm(res, 'transport-documents/edit', { ...payload, id: document.id }, 'No se pudo actualizar el documento.');
        deps.setFlash(req, 'success', 'Documento de transporte actualizado.');
        return res.redirect(`/transport-documents/${document.id}`);
      });
    });
  });

  app.post('/transport-documents/:id/duplicate', requireTransportPermission('create'), (req, res) => {
    fetchOrRedirect(req, res, deps, (document, companyId) => {
      const copy = {
        ...document,
        document_number: `${document.document_number || document.id}-COPIA`,
        status: 'draft',
        data: { ...(document.data || {}) },
        items: document.items || [],
        charges: document.charges || [],
        merchandise: document.merchandise || []
      };
      transportModel.createDocument(deps.db, companyId, req.session.user && req.session.user.id, copy, (err, id) => {
        if (err) {
          deps.setFlash(req, 'error', 'No se pudo duplicar el documento.');
          return res.redirect(`/transport-documents/${document.id}`);
        }
        deps.setFlash(req, 'success', 'Documento duplicado como borrador.');
        return res.redirect(`/transport-documents/${id}/edit`);
      });
    });
  });

  app.post('/transport-documents/:id/void', requireTransportPermission('edit'), (req, res) => {
    fetchOrRedirect(req, res, deps, (document, companyId) => {
      transportModel.voidDocument(deps.db, companyId, document.id, () => {
        deps.setFlash(req, 'success', 'Documento anulado.');
        res.redirect(`/transport-documents/${document.id}`);
      });
    });
  });

  app.get('/transport-documents/:id/print', requireTransportPermission('export'), (req, res) => {
    fetchOrRedirect(req, res, deps, (document) => {
      if (!hasPrintableContent(document)) {
        deps.setFlash(req, 'error', 'No se puede imprimir un documento vacio.');
        return res.redirect(`/transport-documents/${document.id}`);
      }
      return res.render(`transport-documents/${getPrintView(document)}`, { document, typeLabels: TYPE_LABELS, statusLabels: STATUS_LABELS, autoPrint: req.query.auto === '1' });
    });
  });

  app.get('/transport-documents/:id/pdf', requireTransportPermission('export'), (req, res) => {
    fetchOrRedirect(req, res, deps, (document) => {
      if (!hasPrintableContent(document)) {
        deps.setFlash(req, 'error', 'No se puede generar PDF de un documento vacio.');
        return res.redirect(`/transport-documents/${document.id}`);
      }
      return res.render(`transport-documents/${getPrintView(document)}`, { document, typeLabels: TYPE_LABELS, statusLabels: STATUS_LABELS, autoPrint: true });
    });
  });
}

module.exports = {
  registerTransportDocumentRoutes
};
