function registerCarrierReceptionRoutes(app, deps) {
  const {
    stringify,
    requireAuth,
    requirePermission,
    getCompanyId,
    normalizeString,
    fetchCarrierReceptionStats,
    fetchCarrierReceptionList,
    getCarrierOptions
  } = deps;
app.get('/carrier-reception', requireAuth, requirePermission('carrier_reception', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const filters = {
    tracking: normalizeString(req.query.tracking),
    carrier: normalizeString(req.query.carrier),
    status: normalizeString(req.query.status),
    date: normalizeString(req.query.date)
  };
  const message = req.session ? req.session.reception_message : null;
  if (req.session) req.session.reception_message = null;

  fetchCarrierReceptionStats(companyId, (summary) => {
    fetchCarrierReceptionList(companyId, filters, (receptions) => {
      getCarrierOptions(companyId, (carrierOptions) => {
        res.render('carrier-reception', {
          companyId,
          stats: summary.stats,
          carrierTotals: summary.carrierTotals,
          carrierTodayTotals: summary.carrierTodayTotals,
          carrierOptions,
          receptions,
          filters,
          message,
          user: req.session ? req.session.user : null
        });
      });
    });
  });
});

app.get('/carrier-reception/quick', requireAuth, requirePermission('carrier_reception', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const filters = {
    tracking: normalizeString(req.query.tracking),
    carrier: normalizeString(req.query.carrier),
    status: normalizeString(req.query.status),
    date: normalizeString(req.query.date)
  };
  const message = req.session ? req.session.reception_message : null;
  if (req.session) req.session.reception_message = null;

  fetchCarrierReceptionStats(companyId, (summary) => {
    fetchCarrierReceptionList(companyId, filters, (receptions) => {
      getCarrierOptions(companyId, (carrierOptions) => {
        res.render('carrier-reception-quick', {
          activeReceptionTab: 'quick',
          companyId,
          stats: summary.stats,
          carrierTotals: summary.carrierTotals,
          carrierTodayTotals: summary.carrierTodayTotals,
          carrierOptions,
          receptions,
          filters,
          message,
          user: req.session ? req.session.user : null
        });
      });
    });
  });
});

app.get('/carrier-reception/summary', requireAuth, requirePermission('carrier_reception', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  fetchCarrierReceptionStats(companyId, (summary) => {
    res.render('carrier-reception-summary', {
      activeReceptionTab: 'summary',
      stats: summary.stats,
      carrierTotals: summary.carrierTotals
    });
  });
});

app.get('/carrier-reception/list', requireAuth, requirePermission('carrier_reception', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const filters = {
    tracking: normalizeString(req.query.tracking),
    carrier: normalizeString(req.query.carrier),
    status: normalizeString(req.query.status),
    date: normalizeString(req.query.date)
  };
  const params = new URLSearchParams();
  Object.keys(filters).forEach((key) => {
    if (filters[key]) params.set(key, filters[key]);
  });
  const exportUrl = params.toString() ? `/carrier-reception/export?${params.toString()}` : '/carrier-reception/export';
  const message = req.session ? req.session.reception_message : null;
  if (req.session) req.session.reception_message = null;

  fetchCarrierReceptionList(companyId, filters, (receptions) => {
    res.render('carrier-reception-list', {
      activeReceptionTab: 'list',
      receptions,
      filters,
      exportUrl,
      message
    });
  });
});

app.get('/carrier-reception/export', requireAuth, requirePermission('carrier_reception', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const filters = {
    tracking: normalizeString(req.query.tracking),
    carrier: normalizeString(req.query.carrier),
    status: normalizeString(req.query.status),
    date: normalizeString(req.query.date)
  };
  fetchCarrierReceptionList(companyId, filters, (receptions) => {
    const csv = stringify(receptions || [], {
      header: true,
      columns: [
        { key: 'tracking_number', header: 'tracking_number' },
        { key: 'carrier', header: 'carrier' },
        { key: 'received_at', header: 'received_at' },
        { key: 'received_by', header: 'received_by' },
        { key: 'status', header: 'status' },
        { key: 'notes', header: 'notes' }
      ]
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="carrier-reception.csv"');
    return res.send(csv);
  });
});

app.post('/carrier-reception', requireAuth, requirePermission('carrier_reception', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const trackingNumber = normalizeString(req.body.tracking_number);
  const carrier = normalizeString(req.body.carrier);
  const receivedBy = normalizeString(req.body.received_by) || (req.session && req.session.user ? req.session.user.username : null);
  const notes = normalizeString(req.body.notes);

  if (!trackingNumber || !carrier) {
    if (req.session) {
      req.session.reception_message = {
        type: 'error',
        text: res.locals.t('reception.errors.required')
      };
    }
    return res.redirect('/carrier-reception/quick');
  }

  db.run(
    `INSERT INTO carrier_receptions
     (company_id, tracking_number, carrier, received_by, notes, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [companyId, trackingNumber, carrier, receivedBy, notes || null],
    (err) => {
      if (req.session) {
        req.session.reception_message = err
          ? { type: 'error', text: res.locals.t('errors.server_try_again') }
          : { type: 'success', text: res.locals.t('reception.success') };
      }
      return res.redirect('/carrier-reception/quick');
    }
  );
});

app.get('/carrier-reception/:id', requireAuth, requirePermission('carrier_reception', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const receptionId = Number(req.params.id);
  if (!Number.isInteger(receptionId) || receptionId <= 0) return res.redirect('/carrier-reception/list');

  db.get(
    'SELECT * FROM carrier_receptions WHERE id = ? AND company_id = ?',
    [receptionId, companyId],
    (err, reception) => {
      if (err || !reception) return res.redirect('/carrier-reception/list');
      res.render('carrier-reception-detail', { reception });
    }
  );
});

app.post('/carrier-reception/:id/cancel', requireAuth, requirePermission('carrier_reception', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const receptionId = Number(req.params.id);
  if (!Number.isInteger(receptionId) || receptionId <= 0) return res.redirect('/carrier-reception/list');

  db.run(
    "UPDATE carrier_receptions SET status = 'cancelled' WHERE id = ? AND company_id = ?",
    [receptionId, companyId],
    () => res.redirect('/carrier-reception/list')
  );
});


}
module.exports = {
  registerCarrierReceptionRoutes
};
