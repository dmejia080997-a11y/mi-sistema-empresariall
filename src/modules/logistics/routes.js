function registerLogisticsRoutes(app, deps) {
  const scope = { app, ...deps };
  with (scope) {
app.get('/cuscar', requireAuth, requirePermission('cuscar', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  db.all(
    `SELECT status, COUNT(*) AS count
     FROM cuscar_manifests
     WHERE company_id = ?
     GROUP BY status`,
    [companyId],
    (err, rows) => {
      const stats = {
        total: 0,
        draft: 0,
        closed: 0,
        ready_to_generate: 0,
        generated: 0,
        transmitted: 0,
        error: 0,
        pending_transmission: 0
      };
      (rows || []).forEach((row) => {
        const key = row.status;
        if (Object.prototype.hasOwnProperty.call(stats, key)) {
          stats[key] = Number(row.count || 0);
        }
        stats.total += Number(row.count || 0);
      });
      stats.pending_transmission = Number(stats.ready_to_generate || 0) + Number(stats.generated || 0);
      res.render('cuscar-dashboard', { stats, flash: res.locals.flash });
    }
  );
});

app.get('/cuscar/catalogs/:type', requireAuth, requirePermission('cuscar', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const type = req.params.type;
  const catalog = CUSCAR_CATALOGS[type];
  if (!catalog) return res.redirect('/cuscar');
  if (!catalog.allowCreate) {
    setFlash(req, 'error', res.locals.t('cuscar.errors.catalog_create_failed'));
    return res.redirect(`/cuscar/catalogs/${type}`);
  }
  const filters = {
    q: normalizeString(req.query.q),
    status: normalizeString(req.query.status)
  };
  const params = [];
  const clauses = [];
  if (catalog.scope === 'global') {
    clauses.push('company_id = 0');
  } else if (catalog.scope === 'company') {
    clauses.push('company_id = ?');
    params.push(companyId);
  } else {
    clauses.push('company_id IN (0, ?)');
    params.push(companyId);
  }
  if (filters.q) {
    clauses.push('(name LIKE ? OR code LIKE ?)');
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  if (filters.status && filters.status !== 'all') {
    clauses.push('is_active = ?');
    params.push(filters.status === 'inactive' ? 0 : 1);
  }
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  db.all(
    `SELECT id, company_id, code, name, description, is_active, source, sort_order, created_at, updated_at
     FROM ${catalog.table}
     ${whereClause}
     ORDER BY sort_order ASC, name ASC`,
    params,
    (err, rows) => {
      res.render('cuscar-catalog', {
        catalog,
        catalogs: CUSCAR_CATALOG_LIST,
        items: err ? [] : rows || [],
        filters,
        error: err ? res.locals.t('errors.server_try_again') : null,
        success: null,
        flash: res.locals.flash
      });
    }
  );
});

app.post('/cuscar/catalogs/:type/create', requireAuth, requirePermission('cuscar', 'manage_catalogs'), (req, res) => {
  const companyId = getCompanyId(req);
  const type = req.params.type;
  const catalog = CUSCAR_CATALOGS[type];
  if (!catalog) return res.redirect('/cuscar');
  const name = normalizeString(req.body.name);
  const code = normalizeString(req.body.code);
  const description = normalizeString(req.body.description);
  const isActive = Number(req.body.is_active) === 0 ? 0 : 1;
  const sortOrder = Number(req.body.sort_order || 0);
  if (!name) {
    setFlash(req, 'error', res.locals.t('cuscar.errors.catalog_name_required'));
    return res.redirect(`/cuscar/catalogs/${type}`);
  }
  if (!code) {
    setFlash(req, 'error', res.locals.t('cuscar.errors.catalog_code_required'));
    return res.redirect(`/cuscar/catalogs/${type}`);
  }
  const targetCompanyId = catalog.scope === 'global' ? 0 : companyId;
  const source = 'manual';
  db.run(
    `INSERT INTO ${catalog.table} (company_id, code, name, description, is_active, source, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [targetCompanyId, code, name, description || null, isActive, source, Number.isFinite(sortOrder) ? sortOrder : 0],
    (err) => {
      if (err) {
        const message = /unique|constraint/i.test(err.message || '')
          ? res.locals.t('cuscar.errors.catalog_duplicate_code')
          : res.locals.t('cuscar.errors.catalog_create_failed');
        setFlash(req, 'error', message);
      } else {
        setFlash(req, 'success', res.locals.t('cuscar.catalog.saved'));
        logAction(req.session.user.id, 'cuscar_catalog_created', JSON.stringify({ type, name }), companyId);
      }
      return res.redirect(`/cuscar/catalogs/${type}`);
    }
  );
});

app.post('/cuscar/catalogs/:type/:id/update', requireAuth, requirePermission('cuscar', 'manage_catalogs'), (req, res) => {
  const companyId = getCompanyId(req);
  const type = req.params.type;
  const catalog = CUSCAR_CATALOGS[type];
  const id = Number(req.params.id);
  if (!catalog || !Number.isInteger(id) || id <= 0) return res.redirect('/cuscar');
  const name = normalizeString(req.body.name);
  const code = normalizeString(req.body.code);
  const description = normalizeString(req.body.description);
  const isActive = Number(req.body.is_active) === 0 ? 0 : 1;
  const sortOrder = Number(req.body.sort_order || 0);
  if (!name) {
    setFlash(req, 'error', res.locals.t('cuscar.errors.catalog_name_required'));
    return res.redirect(`/cuscar/catalogs/${type}`);
  }
  if (!code) {
    setFlash(req, 'error', res.locals.t('cuscar.errors.catalog_code_required'));
    return res.redirect(`/cuscar/catalogs/${type}`);
  }
  let scopeClause = '';
  const params = [name, code, description || null, isActive, Number.isFinite(sortOrder) ? sortOrder : 0, id];
  if (catalog.scope === 'global') {
    scopeClause = 'company_id = 0';
  } else if (catalog.scope === 'company') {
    scopeClause = 'company_id = ?';
    params.push(companyId);
  } else {
    scopeClause = 'company_id IN (0, ?)';
    params.push(companyId);
  }
  db.run(
    `UPDATE ${catalog.table}
     SET name = ?, code = ?, description = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND ${scopeClause}`,
    params,
    (err) => {
      if (err) {
        const message = /unique|constraint/i.test(err.message || '')
          ? res.locals.t('cuscar.errors.catalog_duplicate_code')
          : res.locals.t('cuscar.errors.catalog_update_failed');
        setFlash(req, 'error', message);
      } else {
        setFlash(req, 'success', res.locals.t('cuscar.catalog.saved'));
        logAction(req.session.user.id, 'cuscar_catalog_updated', JSON.stringify({ type, id }), companyId);
      }
      return res.redirect(`/cuscar/catalogs/${type}`);
    }
  );
});

app.post('/cuscar/catalogs/:type/:id/delete', requireAuth, requirePermission('cuscar', 'manage_catalogs'), (req, res) => {
  const companyId = getCompanyId(req);
  const type = req.params.type;
  const catalog = CUSCAR_CATALOGS[type];
  const id = Number(req.params.id);
  if (!catalog || !Number.isInteger(id) || id <= 0) return res.redirect('/cuscar');
  let scopeClause = '';
  const params = [id];
  if (catalog.scope === 'global') {
    scopeClause = 'company_id = 0';
  } else if (catalog.scope === 'company') {
    scopeClause = 'company_id = ?';
    params.push(companyId);
  } else {
    scopeClause = 'company_id IN (0, ?)';
    params.push(companyId);
  }
  db.run(`DELETE FROM ${catalog.table} WHERE id = ? AND ${scopeClause}`, params, (err) => {
    if (err) {
      setFlash(req, 'error', res.locals.t('cuscar.errors.catalog_delete_failed'));
    } else {
      setFlash(req, 'success', res.locals.t('cuscar.catalog.deleted'));
      logAction(req.session.user.id, 'cuscar_catalog_deleted', JSON.stringify({ type, id }), companyId);
    }
    return res.redirect(`/cuscar/catalogs/${type}`);
  });
});

app.post('/cuscar/catalogs/:type/reload', requireAuth, requirePermission('cuscar', 'manage_catalogs'), (req, res) => {
  const type = req.params.type;
  const catalog = CUSCAR_CATALOGS[type];
  if (!catalog || !catalog.seedKey) return res.redirect('/cuscar');
  seedCuscarBaseCatalogs({ type }, () => {
    setFlash(req, 'success', res.locals.t('cuscar.catalog.reloaded'));
    return res.redirect(`/cuscar/catalogs/${type}`);
  });
});

app.get('/cuscar/manifests', requireAuth, requirePermission('cuscar', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  db.all(
    `SELECT m.*,
        COUNT(mi.id) AS item_count
     FROM cuscar_manifests m
     LEFT JOIN cuscar_manifest_items mi ON mi.manifest_id = m.id AND mi.company_id = m.company_id
     WHERE m.company_id = ?
     GROUP BY m.id
     ORDER BY m.created_at DESC`,
    [companyId],
    (err, manifests) => {
      res.render('cuscar-manifests', {
        manifests: err ? [] : manifests || [],
        flash: res.locals.flash
      });
    }
  );
});

app.get('/cuscar/manifests/new', requireAuth, requirePermission('cuscar', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  loadCuscarCatalogs(companyId, (catalogs) =>
    res.render('cuscar-manifest-new', {
      catalogs,
      values: {},
      error: null,
      success: null
    })
  );
});

app.post('/cuscar/manifests/create', requireAuth, requirePermission('cuscar', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const userId = req.session.user ? req.session.user.id : null;
  const payload = {
    internal_number: normalizeString(req.body.internal_number),
    master_airway_bill: normalizeString(req.body.master_airway_bill),
    flight_number: normalizeString(req.body.flight_number),
    flight_date: normalizeString(req.body.flight_date),
    airline_id: Number(req.body.airline_id),
    transport_mode_id: Number(req.body.transport_mode_id),
    transport_means_id: Number(req.body.transport_means_id),
    message_type_id: Number(req.body.message_type_id),
    message_function_id: Number(req.body.message_function_id),
    message_responsible_id: Number(req.body.message_responsible_id),
    reference_qualifier_id: Number(req.body.reference_qualifier_id),
    transport_id_agency_id: Number(req.body.transport_id_agency_id),
    origin_airport_id: Number(req.body.origin_airport_id),
    origin_port_id: Number(req.body.origin_port_id),
    destination_airport_id: Number(req.body.destination_airport_id),
    destination_port_id: Number(req.body.destination_port_id),
    customs_port_id: Number(req.body.customs_port_id),
    customs_office_id: Number(req.body.customs_office_id),
    transporter_id: Number(req.body.transporter_id),
    observations: normalizeString(req.body.observations)
  };
  const requiredKeys = [
    'internal_number',
    'master_airway_bill',
    'flight_number',
    'flight_date',
    'airline_id',
    'transport_mode_id',
    'transport_means_id',
    'message_type_id',
    'message_function_id',
    'message_responsible_id',
    'reference_qualifier_id',
    'transport_id_agency_id',
    'customs_office_id',
    'transporter_id'
  ];
  const missing = requiredKeys.find((key) => !payload[key] || payload[key] === 0);
  const hasOrigin = Number(payload.origin_airport_id) > 0 || Number(payload.origin_port_id) > 0;
  const hasDestination = Number(payload.destination_airport_id) > 0 || Number(payload.destination_port_id) > 0;
  if (missing) {
    return loadCuscarCatalogs(companyId, (catalogs) =>
      res.render('cuscar-manifest-new', {
        catalogs,
        values: payload,
        error: res.locals.t('cuscar.errors.required_fields'),
        success: null
      })
    );
  }
  if (!hasOrigin || !hasDestination) {
    const errorKey = !hasOrigin ? 'cuscar.errors.origin_required' : 'cuscar.errors.destination_required';
    return loadCuscarCatalogs(companyId, (catalogs) =>
      res.render('cuscar-manifest-new', {
        catalogs,
        values: payload,
        error: res.locals.t(errorKey),
        success: null
      })
    );
  }
  db.get(
    'SELECT id FROM cuscar_manifests WHERE company_id = ? AND internal_number = ?',
    [companyId, payload.internal_number],
    (dupErr, row) => {
      if (row) {
        return loadCuscarCatalogs(companyId, (catalogs) =>
          res.render('cuscar-manifest-new', {
            catalogs,
            values: payload,
            error: res.locals.t('cuscar.errors.duplicate_internal_number'),
            success: null
          })
        );
      }
      db.run(
        `INSERT INTO cuscar_manifests
         (company_id, internal_number, master_airway_bill, flight_number, flight_date, airline_id,
          transport_mode_id, transport_means_id, message_type_id, message_function_id, message_responsible_id,
          reference_qualifier_id, transport_id_agency_id, origin_airport_id, origin_port_id, destination_airport_id,
          destination_port_id, customs_port_id, customs_office_id, transporter_id, observations, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
        [
          companyId,
          payload.internal_number,
          payload.master_airway_bill,
          payload.flight_number,
          payload.flight_date,
          payload.airline_id,
          payload.transport_mode_id,
          payload.transport_means_id,
          payload.message_type_id,
          payload.message_function_id,
          payload.message_responsible_id,
          payload.reference_qualifier_id,
          payload.transport_id_agency_id,
          payload.origin_airport_id || 0,
          payload.origin_port_id || 0,
          payload.destination_airport_id || 0,
          payload.destination_port_id || 0,
          payload.customs_port_id || 0,
          payload.customs_office_id || 0,
          payload.transporter_id,
          payload.observations || null,
          userId
        ],
        function onInsert(err) {
          if (err) {
            return loadCuscarCatalogs(companyId, (catalogs) =>
              res.render('cuscar-manifest-new', {
                catalogs,
                values: payload,
                error: res.locals.t('cuscar.errors.manifest_create_failed'),
                success: null
              })
            );
          }
          logAction(userId, 'cuscar_manifest_created', JSON.stringify({ id: this.lastID }), companyId);
          return res.redirect(`/cuscar/manifests/${this.lastID}`);
        }
      );
    }
  );
});

app.get('/cuscar/manifests/:id', requireAuth, requirePermission('cuscar', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/cuscar/manifests');
  fetchCuscarManifestDetail(manifestId, companyId, (err, manifest, items) => {
    if (err || !manifest) return res.redirect('/cuscar/manifests');
    db.all(
      `SELECT ct.*, cr.response_code, cr.response_message, ce.error_message
       FROM cuscar_transmissions ct
       LEFT JOIN cuscar_transmission_responses cr ON cr.transmission_id = ct.id
       LEFT JOIN cuscar_transmission_errors ce ON ce.transmission_id = ct.id
       WHERE ct.manifest_id = ? AND ct.company_id = ?
       ORDER BY ct.created_at DESC
       LIMIT 5`,
      [manifestId, companyId],
      (txErr, transmissions) => {
        const canTransmit = hasPermission(req.session.permissionMap || null, 'cuscar', 'transmit_cuscar');
        loadCuscarCatalogs(companyId, (catalogs) =>
          res.render('cuscar-manifest-detail', {
            manifest,
            items,
            catalogs,
            transmissions: txErr ? [] : transmissions || [],
            isEditable: manifest.status === 'draft',
            isAdmin: req.session.permissionMap ? req.session.permissionMap.isAdmin : false,
            canEdit: hasPermission(req.session.permissionMap || null, 'cuscar', 'edit'),
            canClose: hasPermission(req.session.permissionMap || null, 'cuscar', 'close_manifest'),
            canPreview: hasPermission(req.session.permissionMap || null, 'cuscar', 'preview_cuscar'),
            canTransmit,
            satEnv: SAT_ENV,
            flash: res.locals.flash
          })
        );
      }
    );
  });
});

app.post('/cuscar/manifests/:id/update', requireAuth, requirePermission('cuscar', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const userId = req.session.user ? req.session.user.id : null;
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/cuscar/manifests');
  db.get('SELECT status FROM cuscar_manifests WHERE id = ? AND company_id = ?', [manifestId, companyId], (err, row) => {
    if (err || !row) return res.redirect('/cuscar/manifests');
    if (row.status !== 'draft') {
      setFlash(req, 'error', res.locals.t('cuscar.errors.manifest_closed_no_edit'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    const payload = {
      internal_number: normalizeString(req.body.internal_number),
      master_airway_bill: normalizeString(req.body.master_airway_bill),
      flight_number: normalizeString(req.body.flight_number),
      flight_date: normalizeString(req.body.flight_date),
      airline_id: Number(req.body.airline_id),
      transport_mode_id: Number(req.body.transport_mode_id),
      transport_means_id: Number(req.body.transport_means_id),
      message_type_id: Number(req.body.message_type_id),
      message_function_id: Number(req.body.message_function_id),
      message_responsible_id: Number(req.body.message_responsible_id),
      reference_qualifier_id: Number(req.body.reference_qualifier_id),
      transport_id_agency_id: Number(req.body.transport_id_agency_id),
      origin_airport_id: Number(req.body.origin_airport_id),
      origin_port_id: Number(req.body.origin_port_id),
      destination_airport_id: Number(req.body.destination_airport_id),
      destination_port_id: Number(req.body.destination_port_id),
      customs_port_id: Number(req.body.customs_port_id),
      customs_office_id: Number(req.body.customs_office_id),
      transporter_id: Number(req.body.transporter_id),
      observations: normalizeString(req.body.observations)
    };
    const requiredKeys = [
      'internal_number',
      'master_airway_bill',
      'flight_number',
      'flight_date',
      'airline_id',
      'transport_mode_id',
      'transport_means_id',
      'message_type_id',
      'message_function_id',
      'message_responsible_id',
      'reference_qualifier_id',
      'transport_id_agency_id',
      'customs_office_id',
      'transporter_id'
    ];
    const missing = requiredKeys.find((key) => !payload[key] || payload[key] === 0);
    const hasOrigin = Number(payload.origin_airport_id) > 0 || Number(payload.origin_port_id) > 0;
    const hasDestination = Number(payload.destination_airport_id) > 0 || Number(payload.destination_port_id) > 0;
    if (missing) {
      setFlash(req, 'error', res.locals.t('cuscar.errors.required_fields'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    if (!hasOrigin || !hasDestination) {
      const errorKey = !hasOrigin ? 'cuscar.errors.origin_required' : 'cuscar.errors.destination_required';
      setFlash(req, 'error', res.locals.t(errorKey));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    db.run(
      `UPDATE cuscar_manifests
       SET internal_number = ?, master_airway_bill = ?, flight_number = ?, flight_date = ?, airline_id = ?,
           transport_mode_id = ?, transport_means_id = ?, message_type_id = ?, message_function_id = ?,
           message_responsible_id = ?, reference_qualifier_id = ?, transport_id_agency_id = ?,
           origin_airport_id = ?, origin_port_id = ?, destination_airport_id = ?, destination_port_id = ?,
           customs_port_id = ?, customs_office_id = ?, transporter_id = ?, observations = ?,
           preview_text = NULL, preview_generated_at = NULL, preview_generated_by = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.internal_number,
        payload.master_airway_bill,
        payload.flight_number,
        payload.flight_date,
        payload.airline_id,
        payload.transport_mode_id,
        payload.transport_means_id,
        payload.message_type_id,
        payload.message_function_id,
        payload.message_responsible_id,
        payload.reference_qualifier_id,
        payload.transport_id_agency_id,
        payload.origin_airport_id || 0,
        payload.origin_port_id || 0,
        payload.destination_airport_id || 0,
        payload.destination_port_id || 0,
        payload.customs_port_id || 0,
        payload.customs_office_id || 0,
        payload.transporter_id,
        payload.observations || null,
        manifestId,
        companyId
      ],
      (updateErr) => {
        if (updateErr) {
          setFlash(req, 'error', res.locals.t('cuscar.errors.manifest_update_failed'));
        } else {
          setFlash(req, 'success', res.locals.t('cuscar.manifest.saved'));
          logAction(userId, 'cuscar_manifest_updated', JSON.stringify({ id: manifestId }), companyId);
        }
        return res.redirect(`/cuscar/manifests/${manifestId}`);
      }
    );
  });
});

app.post('/cuscar/manifests/:id/items/create', requireAuth, requirePermission('cuscar', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const userId = req.session.user ? req.session.user.id : null;
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/cuscar/manifests');
  db.get('SELECT status FROM cuscar_manifests WHERE id = ? AND company_id = ?', [manifestId, companyId], (err, row) => {
    if (err || !row) return res.redirect('/cuscar/manifests');
    if (row.status !== 'draft') {
      setFlash(req, 'error', res.locals.t('cuscar.errors.manifest_closed_no_edit'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    const payload = {
      hawb_number: normalizeString(req.body.hawb_number),
      shipper_id: Number(req.body.shipper_id),
      consignee_id: Number(req.body.consignee_id),
      goods_description: normalizeString(req.body.goods_description),
      package_qty: Number(req.body.package_qty || 0),
      package_type_id: Number(req.body.package_type_id),
      weight_unit_id: Number(req.body.weight_unit_id),
      gross_weight: Number(req.body.gross_weight || 0),
      net_weight: Number(req.body.net_weight || 0),
      declared_value: Number(req.body.declared_value || 0),
      origin_country_id: Number(req.body.origin_country_id),
      observations: normalizeString(req.body.observations)
    };
    if (
      !payload.hawb_number ||
      !payload.shipper_id ||
      !payload.consignee_id ||
      !payload.goods_description ||
      !payload.package_type_id ||
      !payload.weight_unit_id ||
      !payload.origin_country_id
    ) {
      setFlash(req, 'error', res.locals.t('cuscar.errors.item_required_fields'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    if (payload.package_qty < 0 || payload.gross_weight < 0 || payload.net_weight < 0 || payload.declared_value < 0) {
      setFlash(req, 'error', res.locals.t('cuscar.errors.item_non_negative'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    db.run(
      `INSERT INTO cuscar_manifest_items
       (manifest_id, company_id, hawb_number, shipper_id, consignee_id, goods_description, package_qty, package_type_id, weight_unit_id, gross_weight, net_weight, declared_value, origin_country_id, observations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        manifestId,
        companyId,
        payload.hawb_number,
        payload.shipper_id,
        payload.consignee_id,
        payload.goods_description,
        payload.package_qty,
        payload.package_type_id,
        payload.weight_unit_id,
        payload.gross_weight,
        payload.net_weight,
        payload.declared_value,
        payload.origin_country_id,
        payload.observations || null
      ],
      (insertErr) => {
        if (insertErr) {
          setFlash(req, 'error', res.locals.t('cuscar.errors.item_create_failed'));
        } else {
          setFlash(req, 'success', res.locals.t('cuscar.item.saved'));
          logAction(userId, 'cuscar_item_created', JSON.stringify({ manifest_id: manifestId }), companyId);
        }
        return res.redirect(`/cuscar/manifests/${manifestId}`);
      }
    );
  });
});

app.post('/cuscar/manifests/:id/items/:itemId/update', requireAuth, requirePermission('cuscar', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const userId = req.session.user ? req.session.user.id : null;
  if (!Number.isInteger(manifestId) || !Number.isInteger(itemId) || manifestId <= 0 || itemId <= 0) {
    return res.redirect('/cuscar/manifests');
  }
  db.get('SELECT status FROM cuscar_manifests WHERE id = ? AND company_id = ?', [manifestId, companyId], (err, row) => {
    if (err || !row) return res.redirect('/cuscar/manifests');
    if (row.status !== 'draft') {
      setFlash(req, 'error', res.locals.t('cuscar.errors.manifest_closed_no_edit'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    const payload = {
      hawb_number: normalizeString(req.body.hawb_number),
      shipper_id: Number(req.body.shipper_id),
      consignee_id: Number(req.body.consignee_id),
      goods_description: normalizeString(req.body.goods_description),
      package_qty: Number(req.body.package_qty || 0),
      package_type_id: Number(req.body.package_type_id),
      weight_unit_id: Number(req.body.weight_unit_id),
      gross_weight: Number(req.body.gross_weight || 0),
      net_weight: Number(req.body.net_weight || 0),
      declared_value: Number(req.body.declared_value || 0),
      origin_country_id: Number(req.body.origin_country_id),
      observations: normalizeString(req.body.observations)
    };
    if (
      !payload.hawb_number ||
      !payload.shipper_id ||
      !payload.consignee_id ||
      !payload.goods_description ||
      !payload.package_type_id ||
      !payload.weight_unit_id ||
      !payload.origin_country_id
    ) {
      setFlash(req, 'error', res.locals.t('cuscar.errors.item_required_fields'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    if (payload.package_qty < 0 || payload.gross_weight < 0 || payload.net_weight < 0 || payload.declared_value < 0) {
      setFlash(req, 'error', res.locals.t('cuscar.errors.item_non_negative'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    db.run(
      `UPDATE cuscar_manifest_items
       SET hawb_number = ?, shipper_id = ?, consignee_id = ?, goods_description = ?, package_qty = ?, package_type_id = ?, weight_unit_id = ?, gross_weight = ?, net_weight = ?, declared_value = ?, origin_country_id = ?, observations = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND manifest_id = ? AND company_id = ?`,
      [
        payload.hawb_number,
        payload.shipper_id,
        payload.consignee_id,
        payload.goods_description,
        payload.package_qty,
        payload.package_type_id,
        payload.weight_unit_id,
        payload.gross_weight,
        payload.net_weight,
        payload.declared_value,
        payload.origin_country_id,
        payload.observations || null,
        itemId,
        manifestId,
        companyId
      ],
      (updateErr) => {
        if (updateErr) {
          setFlash(req, 'error', res.locals.t('cuscar.errors.item_update_failed'));
        } else {
          setFlash(req, 'success', res.locals.t('cuscar.item.saved'));
          logAction(userId, 'cuscar_item_updated', JSON.stringify({ id: itemId, manifest_id: manifestId }), companyId);
        }
        return res.redirect(`/cuscar/manifests/${manifestId}`);
      }
    );
  });
});

app.post('/cuscar/manifests/:id/items/:itemId/delete', requireAuth, requirePermission('cuscar', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const userId = req.session.user ? req.session.user.id : null;
  if (!Number.isInteger(manifestId) || !Number.isInteger(itemId) || manifestId <= 0 || itemId <= 0) {
    return res.redirect('/cuscar/manifests');
  }
  db.get('SELECT status FROM cuscar_manifests WHERE id = ? AND company_id = ?', [manifestId, companyId], (err, row) => {
    if (err || !row) return res.redirect('/cuscar/manifests');
    if (row.status !== 'draft') {
      setFlash(req, 'error', res.locals.t('cuscar.errors.manifest_closed_no_edit'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    db.run(
      'DELETE FROM cuscar_manifest_items WHERE id = ? AND manifest_id = ? AND company_id = ?',
      [itemId, manifestId, companyId],
      (delErr) => {
        if (delErr) {
          setFlash(req, 'error', res.locals.t('cuscar.errors.item_delete_failed'));
        } else {
          setFlash(req, 'success', res.locals.t('cuscar.item.deleted'));
          logAction(userId, 'cuscar_item_deleted', JSON.stringify({ id: itemId, manifest_id: manifestId }), companyId);
        }
        return res.redirect(`/cuscar/manifests/${manifestId}`);
      }
    );
  });
});

app.post('/cuscar/manifests/:id/close', requireAuth, requirePermission('cuscar', 'close_manifest'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const userId = req.session.user ? req.session.user.id : null;
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/cuscar/manifests');
  validateCuscarManifestForClose(manifestId, companyId, res.locals.t, (errors) => {
    if (errors && errors.length > 0) {
      setFlash(req, 'error', errors.join(' '));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    db.run(
      "UPDATE cuscar_manifests SET status = 'closed', closed_by = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
      [userId, manifestId, companyId],
      (err) => {
        if (err) {
          setFlash(req, 'error', res.locals.t('cuscar.errors.manifest_close_failed'));
        } else {
          setFlash(req, 'success', res.locals.t('cuscar.manifest.closed'));
          logAction(userId, 'cuscar_manifest_closed', JSON.stringify({ id: manifestId }), companyId);
        }
        return res.redirect(`/cuscar/manifests/${manifestId}`);
      }
    );
  });
});

app.post('/cuscar/manifests/:id/reopen', requireAuth, requirePermission('cuscar', 'reopen_manifest'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const userId = req.session.user ? req.session.user.id : null;
  const isAdmin = req.session.permissionMap ? req.session.permissionMap.isAdmin : false;
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/cuscar/manifests');
  if (!isAdmin) {
    setFlash(req, 'error', res.locals.t('cuscar.errors.reopen_admin_only'));
    return res.redirect(`/cuscar/manifests/${manifestId}`);
  }
  db.run(
    "UPDATE cuscar_manifests SET status = 'draft', closed_by = NULL, closed_at = NULL, preview_text = NULL, preview_generated_at = NULL, preview_generated_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
    [manifestId, companyId],
    (err) => {
      if (err) {
        setFlash(req, 'error', res.locals.t('cuscar.errors.reopen_failed'));
      } else {
        setFlash(req, 'success', res.locals.t('cuscar.manifest.reopened'));
        logAction(userId, 'cuscar_manifest_reopened', JSON.stringify({ id: manifestId }), companyId);
      }
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
  );
});

app.get('/cuscar/manifests/:id/preview', requireAuth, requirePermission('cuscar', 'preview_cuscar'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/cuscar/manifests');
  fetchCuscarManifestDetail(manifestId, companyId, (err, manifest, items) => {
    if (err || !manifest) return res.redirect('/cuscar/manifests');
    res.render('cuscar-manifest-preview', {
      manifest,
      items,
      previewText: manifest.preview_text || '',
      flash: res.locals.flash
    });
  });
});

app.post('/cuscar/manifests/:id/preview/generate', requireAuth, requirePermission('cuscar', 'preview_cuscar'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const userId = req.session.user ? req.session.user.id : null;
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/cuscar/manifests');
  db.get('SELECT status FROM cuscar_manifests WHERE id = ? AND company_id = ?', [manifestId, companyId], (err, row) => {
    if (err || !row) return res.redirect('/cuscar/manifests');
    if (row.status === 'draft') {
      setFlash(req, 'error', res.locals.t('cuscar.errors.preview_requires_closed'));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    validateCuscarManifestForClose(manifestId, companyId, res.locals.t, (errors) => {
      if (errors && errors.length > 0) {
        setFlash(req, 'error', errors.join(' '));
        return res.redirect(`/cuscar/manifests/${manifestId}`);
      }
      fetchCuscarManifestDetail(manifestId, companyId, (detailErr, manifest, items) => {
        if (detailErr || !manifest) {
          setFlash(req, 'error', res.locals.t('cuscar.errors.manifest_not_found'));
          return res.redirect(`/cuscar/manifests/${manifestId}`);
        }
        const previewText = buildCuscarPreviewText(manifest, items);
        db.run(
          `UPDATE cuscar_manifests
           SET preview_text = ?, preview_generated_at = CURRENT_TIMESTAMP, preview_generated_by = ?, status = CASE WHEN status IN ('closed','ready_to_generate','error') THEN 'generated' ELSE status END, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND company_id = ?`,
          [previewText, userId, manifestId, companyId],
          (updateErr) => {
            if (updateErr) {
              setFlash(req, 'error', res.locals.t('cuscar.errors.preview_failed'));
              return res.redirect(`/cuscar/manifests/${manifestId}`);
            }
            logAction(userId, 'cuscar_preview_generated', JSON.stringify({ id: manifestId }), companyId);
            return res.redirect(`/cuscar/manifests/${manifestId}/preview`);
          }
        );
      });
    });
  });
});

app.post('/cuscar/manifests/:id/transmit', requireAuth, requirePermission('cuscar', 'transmit_cuscar'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const userId = req.session.user ? req.session.user.id : null;
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/cuscar/manifests');
  validateCuscarManifestForClose(manifestId, companyId, res.locals.t, (errors) => {
    if (errors && errors.length > 0) {
      setFlash(req, 'error', errors.join(' '));
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    }
    logAction(userId, 'cuscar_transmission_attempt', JSON.stringify({ id: manifestId, env: SAT_ENV }), companyId);
    transmitCuscarManifest(manifestId, companyId, userId, (txErr, result) => {
      if (txErr) {
        setFlash(req, 'error', res.locals.t('cuscar.errors.transmit_failed'));
        logAction(userId, 'cuscar_transmission_error', JSON.stringify({ id: manifestId, error: String(txErr.message || txErr) }), companyId);
        return res.redirect(`/cuscar/manifests/${manifestId}`);
      }
      if (result && result.ok === false) {
        setFlash(req, 'error', res.locals.t('cuscar.errors.transmit_sim_error'));
        logAction(userId, 'cuscar_transmission_error', JSON.stringify({ id: manifestId, simulated: true }), companyId);
        return res.redirect(`/cuscar/manifests/${manifestId}`);
      }
      setFlash(req, 'success', res.locals.t('cuscar.transmit.success'));
      logAction(userId, 'cuscar_transmission_success', JSON.stringify({ id: manifestId, simulated: SAT_ENV === 'simulation' }), companyId);
      return res.redirect(`/cuscar/manifests/${manifestId}`);
    });
  });
});

app.get('/manifests', requireAuth, requirePermission('manifests', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  db.all(
    `SELECT m.*,
            (SELECT COUNT(*) FROM manifest_pieces mp WHERE mp.manifest_id = m.id) AS piece_count,
            (SELECT COUNT(*)
             FROM manifest_piece_packages mpp
             JOIN manifest_pieces mp ON mp.id = mpp.manifest_piece_id
             WHERE mp.manifest_id = m.id) AS package_count
     FROM manifests m
     WHERE m.company_id = ?
     ORDER BY m.created_at DESC`,
    [companyId],
    (err, manifests) => {
      res.render('manifests', {
        manifests: err ? [] : manifests || [],
        error: null,
        success: null
      });
    }
  );
});

app.get('/manifests/new', requireAuth, requirePermission('manifests', 'create'), (req, res) => {
  res.render('manifests-new', { error: null, success: null });
});

app.post('/manifests/create', requireAuth, requirePermission('manifests', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const airwayBillNumber = normalizeString(req.body.airway_bill_number) || null;
  const notes = normalizeString(req.body.notes) || null;

  db.run(
    'INSERT INTO manifests (company_id, airway_bill_number, notes, status, created_by) VALUES (?, ?, ?, ?, ?)',
    [companyId, airwayBillNumber, notes, 'open', req.session && req.session.user ? req.session.user.id : null],
    function (err) {
      if (err) return res.render('manifests-new', { error: res.locals.t('errors.server_try_again'), success: null });
      return res.redirect(`/manifests/${this.lastID}`);
    }
  );
});

app.get('/manifests/:id', requireAuth, requirePermission('manifests', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/manifests');

  buildManifestDetailData(manifestId, companyId, true, (err, data) => {
    if (err || !data) return res.redirect('/manifests');
    const lastScanPieceId = req.session ? req.session.manifest_last_piece_id : null;
    if (req.session) req.session.manifest_last_piece_id = null;

    res.render('manifest-detail', {
      manifest: data.manifest,
      pieces: data.pieces,
      availablePackages: data.availablePackages,
      summary: data.summary,
      lastScanPieceId,
      canEditManifest: hasPermission(req.session.permissionMap || null, 'manifests', 'edit'),
      isAdmin: req.session && req.session.user && req.session.user.role === 'admin',
      error: null,
      success: null
    });
  });
});

app.post('/manifests/:id/airway-bill', requireAuth, requirePermission('manifests', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const airwayBillNumber = normalizeString(req.body.airway_bill_number) || null;
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/manifests');

  db.run(
    'UPDATE manifests SET airway_bill_number = ? WHERE id = ? AND company_id = ?',
    [airwayBillNumber, manifestId, companyId],
    () => res.redirect(`/manifests/${manifestId}`)
  );
});

app.post('/manifests/:id/notes', requireAuth, requirePermission('manifests', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const notes = normalizeString(req.body.notes) || null;
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/manifests');

  db.run(
    'UPDATE manifests SET notes = ? WHERE id = ? AND company_id = ?',
    [notes, manifestId, companyId],
    () => res.redirect(`/manifests/${manifestId}`)
  );
});

app.post('/manifests/:id/pieces', requireAuth, requirePermission('manifests', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  if (!Number.isInteger(manifestId) || manifestId <= 0) return res.redirect('/manifests');

  db.get('SELECT MAX(piece_number) AS max_piece FROM manifest_pieces WHERE manifest_id = ?', [manifestId], (err, row) => {
    const nextNumber = row && row.max_piece ? Number(row.max_piece) + 1 : 1;
    db.run(
      'INSERT INTO manifest_pieces (manifest_id, piece_number) VALUES (?, ?)',
      [manifestId, nextNumber],
      () => res.redirect(`/manifests/${manifestId}`)
    );
  });
});

app.post('/manifests/:id/packages/scan', requireAuth, requirePermission('manifests', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const pieceId = Number(req.body.piece_id || 0);
  const scanValue = normalizeString(req.body.scan_value);
  if (!Number.isInteger(manifestId) || manifestId <= 0 || !pieceId || !scanValue) {
    return res.redirect(`/manifests/${manifestId}`);
  }

  findPackagesTable((table) => {
    if (!table) return res.redirect(`/manifests/${manifestId}`);
    db.get(
      `SELECT id FROM ${table} WHERE company_id = ? AND (internal_code = ? OR tracking_number = ?) LIMIT 1`,
      [companyId, scanValue, scanValue],
      (pkgErr, pkg) => {
        if (pkgErr || !pkg) return res.redirect(`/manifests/${manifestId}`);
        db.run(
          'INSERT OR IGNORE INTO manifest_piece_packages (manifest_piece_id, package_id) VALUES (?, ?)',
          [pieceId, pkg.id],
          () => {
            updatePackageStatusWithHistory(
              companyId,
              pkg.id,
              'Cargado a vuelo',
              req.session && req.session.user ? req.session.user.id : null,
              `Asignado al manifiesto #${manifestId}`
            );
            if (req.session) req.session.manifest_last_piece_id = pieceId;
            return res.redirect(`/manifests/${manifestId}`);
          }
        );
      }
    );
  });
});

app.post('/manifests/:id/pieces/:pieceId/packages', requireAuth, requirePermission('manifests', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  const pieceId = Number(req.params.pieceId);
  const packageId = Number(req.body.package_id || 0);
  if (!manifestId || !pieceId || !packageId) return res.redirect('/manifests');

  db.run(
    'INSERT OR IGNORE INTO manifest_piece_packages (manifest_piece_id, package_id) VALUES (?, ?)',
    [pieceId, packageId],
    () => {
      updatePackageStatusWithHistory(
        companyId,
        packageId,
        'Cargado a vuelo',
        req.session && req.session.user ? req.session.user.id : null,
        `Asignado al manifiesto #${manifestId}`
      );
      return res.redirect(`/manifests/${manifestId}`);
    }
  );
});

app.post('/manifests/:id/pieces/:pieceId/packages/:packageId/delete', requireAuth, requirePermission('manifests', 'edit'), (req, res) => {
  const manifestId = Number(req.params.id);
  const pieceId = Number(req.params.pieceId);
  const packageId = Number(req.params.packageId);
  if (!manifestId || !pieceId || !packageId) return res.redirect('/manifests');

  db.run(
    'DELETE FROM manifest_piece_packages WHERE manifest_piece_id = ? AND package_id = ?',
    [pieceId, packageId],
    () => res.redirect(`/manifests/${manifestId}`)
  );
});

app.post('/manifests/:id/close', requireAuth, requirePermission('manifests', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  if (!manifestId) return res.redirect('/manifests');

  db.run(
    "UPDATE manifests SET status = 'closed', closed_by = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
    [req.session && req.session.user ? req.session.user.id : null, manifestId, companyId],
    () => res.redirect(`/manifests/${manifestId}`)
  );
});

app.post('/manifests/:id/reopen', requireAuth, requirePermission('manifests', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  if (!manifestId) return res.redirect('/manifests');

  db.run(
    "UPDATE manifests SET status = 'open', closed_by = NULL, closed_at = NULL WHERE id = ? AND company_id = ?",
    [manifestId, companyId],
    () => res.redirect(`/manifests/${manifestId}`)
  );
});

app.get('/manifests/:id/export/pdf', requireAuth, requirePermission('manifests', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  if (!manifestId) return res.redirect('/manifests');

  buildManifestDetailData(manifestId, companyId, false, (err, data) => {
    if (err || !data) return res.redirect('/manifests');
    const doc = new PDFDocument({ margin: 24 });
    res.setHeader('Content-Type', 'application/pdf');
    doc.fontSize(16).text('Manifest', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Airway Bill: ${data.manifest.airway_bill_number || '-'}`);
    doc.text(`Status: ${data.manifest.status}`);
    doc.text(`Pieces: ${data.summary.totalPieces}`);
    doc.text(`Packages: ${data.summary.totalPackages}`);
    doc.text(`Weight: ${Number(data.summary.totalWeight || 0).toFixed(2)}`);
    doc.moveDown();
    data.pieces.forEach((piece) => {
      doc.fontSize(12).text(`Piece #${piece.piece_number}`);
      (piece.packages || []).forEach((pkg) => {
        doc.fontSize(10).text(`- ${pkg.internal_code || pkg.tracking_number || pkg.id}`);
      });
      doc.moveDown(0.5);
    });
    doc.end();
  });
});

app.get('/manifests/:id/export/excel', requireAuth, requirePermission('manifests', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const manifestId = Number(req.params.id);
  if (!manifestId) return res.redirect('/manifests');

  buildManifestDetailData(manifestId, companyId, false, (err, data) => {
    if (err || !data) return res.redirect('/manifests');
    const rows = [];
    data.pieces.forEach((piece) => {
      (piece.packages || []).forEach((pkg) => {
        rows.push({
          piece_number: piece.piece_number,
          internal_code: pkg.internal_code || '',
          tracking_number: pkg.tracking_number || '',
          customer_code: pkg.customer_code || '',
          customer_name: pkg.customer_name || '',
          status: pkg.status || '',
          weight_lbs: pkg.weight_lbs || ''
        });
      });
    });
    const csv = stringify(rows, {
      header: true,
      columns: [
        { key: 'piece_number', header: 'piece_number' },
        { key: 'internal_code', header: 'internal_code' },
        { key: 'tracking_number', header: 'tracking_number' },
        { key: 'customer_code', header: 'customer_code' },
        { key: 'customer_name', header: 'customer_name' },
        { key: 'status', header: 'status' },
        { key: 'weight_lbs', header: 'weight_lbs' }
      ]
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="manifest.csv"');
    return res.send(csv);
  });
});

app.get('/manifests/:id/pieces/:pieceId/sticker/pdf', requireAuth, requirePermission('manifests', 'export'), (req, res) => {
  const manifestId = Number(req.params.id);
  const pieceId = Number(req.params.pieceId);
  if (!manifestId || !pieceId) return res.redirect('/manifests');

  db.get('SELECT piece_number FROM manifest_pieces WHERE id = ? AND manifest_id = ?', [pieceId, manifestId], (err, piece) => {
    if (err || !piece) return res.redirect(`/manifests/${manifestId}`);
    const doc = new PDFDocument({ size: [288, 180], margin: 20 });
    res.setHeader('Content-Type', 'application/pdf');
    doc.fontSize(18).text('Manifest Piece', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Manifest: #${manifestId}`);
    doc.fontSize(14).text(`Piece: ${piece.piece_number}`);
    doc.end();
  });
});
app.get('/airway-bills', requireAuth, requirePermission('airway_bills', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  db.all(
    'SELECT id, awb_number, awb_type, shipper_name, consignee_name, status, created_at FROM awbs WHERE company_id = ? ORDER BY created_at DESC',
    [companyId],
    (err, awbs) => {
      res.render('awbs', {
        awbs: err ? [] : awbs || [],
        error: null,
        success: null
      });
    }
  );
});

app.get('/airway-bills/new', requireAuth, requirePermission('airway_bills', 'create'), (req, res) => {
  res.render('awb-new', { error: null, success: null, items: [{}, {}, {}] });
});

app.post('/airway-bills/create', requireAuth, requirePermission('airway_bills', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbNumber = normalizeString(req.body.awb_number);
  if (!awbNumber) return res.render('awb-new', { error: res.locals.t('errors.required_fields'), success: null, items: [{}, {}, {}] });

  const payload = {
    awb_type: normalizeString(req.body.awb_type) || null,
    awb_number: awbNumber,
    awb_date: normalizeString(req.body.awb_date) || null,
    issuing_carrier: normalizeString(req.body.issuing_carrier) || null,
    agent_name: normalizeString(req.body.agent_name) || null,
    agent_iata_code: normalizeString(req.body.agent_iata_code) || null,
    agent_cass_code: normalizeString(req.body.agent_cass_code) || null,
    shipper_name: normalizeString(req.body.shipper_name) || null,
    shipper_address: normalizeString(req.body.shipper_address) || null,
    consignee_name: normalizeString(req.body.consignee_name) || null,
    consignee_address: normalizeString(req.body.consignee_address) || null,
    accounting_information: normalizeString(req.body.accounting_information) || null,
    reference_number: normalizeString(req.body.reference_number) || null,
    optional_shipping_info_1: normalizeString(req.body.optional_shipping_info_1) || null,
    optional_shipping_info_2: normalizeString(req.body.optional_shipping_info_2) || null,
    airport_of_departure: normalizeString(req.body.airport_of_departure) || null,
    airport_of_destination: normalizeString(req.body.airport_of_destination) || null,
    carrier_code: normalizeString(req.body.carrier_code) || null,
    flight_number: normalizeString(req.body.flight_number) || null,
    departure_airport: normalizeString(req.body.departure_airport) || null,
    departure_date: normalizeString(req.body.departure_date) || null,
    arrival_airport: normalizeString(req.body.arrival_airport) || null,
    arrival_date: normalizeString(req.body.arrival_date) || null,
    currency: normalizeString(req.body.currency) || null,
    charges_code: normalizeString(req.body.charges_code) || null,
    weight_valuation_charge_type: normalizeString(req.body.weight_valuation_charge_type) || null,
    other_charges_type: normalizeString(req.body.other_charges_type) || null,
    declared_value_carriage: normalizeString(req.body.declared_value_carriage) || null,
    declared_value_customs: normalizeString(req.body.declared_value_customs) || null,
    insurance_amount: toNumberOrNull(req.body.insurance_amount),
    handling_information: normalizeString(req.body.handling_information) || null,
    special_handling_details: normalizeString(req.body.special_handling_details) || null,
    ssr: normalizeString(req.body.ssr) || null,
    osi: normalizeString(req.body.osi) || null,
    total_pieces: toNumberOrNull(req.body.total_pieces),
    gross_weight: toNumberOrNull(req.body.gross_weight),
    chargeable_weight: toNumberOrNull(req.body.chargeable_weight),
    goods_description: normalizeString(req.body.goods_description) || null
  };

  const items = parseAwbItemsFromBody(req.body);

  db.run(
    `INSERT INTO awbs
     (company_id, awb_type, awb_number, awb_date, issuing_carrier, agent_name, agent_iata_code, agent_cass_code,
      shipper_name, shipper_address, consignee_name, consignee_address, accounting_information, reference_number,
      optional_shipping_info_1, optional_shipping_info_2, airport_of_departure, airport_of_destination, carrier_code,
      flight_number, departure_airport, departure_date, arrival_airport, arrival_date, currency, charges_code,
      weight_valuation_charge_type, other_charges_type, declared_value_carriage, declared_value_customs,
      insurance_amount, handling_information, special_handling_details, ssr, osi, total_pieces, gross_weight,
      chargeable_weight, goods_description, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
    [
      companyId,
      payload.awb_type,
      payload.awb_number,
      payload.awb_date,
      payload.issuing_carrier,
      payload.agent_name,
      payload.agent_iata_code,
      payload.agent_cass_code,
      payload.shipper_name,
      payload.shipper_address,
      payload.consignee_name,
      payload.consignee_address,
      payload.accounting_information,
      payload.reference_number,
      payload.optional_shipping_info_1,
      payload.optional_shipping_info_2,
      payload.airport_of_departure,
      payload.airport_of_destination,
      payload.carrier_code,
      payload.flight_number,
      payload.departure_airport,
      payload.departure_date,
      payload.arrival_airport,
      payload.arrival_date,
      payload.currency,
      payload.charges_code,
      payload.weight_valuation_charge_type,
      payload.other_charges_type,
      payload.declared_value_carriage,
      payload.declared_value_customs,
      payload.insurance_amount,
      payload.handling_information,
      payload.special_handling_details,
      payload.ssr,
      payload.osi,
      payload.total_pieces,
      payload.gross_weight,
      payload.chargeable_weight,
      payload.goods_description,
      req.session && req.session.user ? req.session.user.id : null
    ],
    function (err) {
      if (err) return res.render('awb-new', { error: res.locals.t('errors.server_try_again'), success: null, items: [{}, {}, {}] });
      const awbId = this.lastID;
      if (!items.length) return res.redirect(`/airway-bills/${awbId}`);

      const stmt = db.prepare(
        `INSERT INTO awb_items
         (awb_id, pieces, gross_weight, dimensions, goods_description, rate_class, chargeable_weight, rate, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      items.forEach((item) => {
        stmt.run(
          awbId,
          item.pieces,
          item.gross_weight,
          item.dimensions,
          item.goods_description,
          item.rate_class,
          item.chargeable_weight,
          item.rate,
          item.total
        );
      });
      stmt.finalize(() => res.redirect(`/airway-bills/${awbId}`));
    }
  );
});

app.get('/airway-bills/:id', requireAuth, requirePermission('airway_bills', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  fetchAwbById(awbId, companyId, (awbErr, awb) => {
    if (awbErr || !awb) return res.redirect('/airway-bills');
    fetchAwbItems(awbId, (items) => {
      fetchAwbLinkedManifests(awbId, companyId, (linkedManifests) => {
        const manifestTotals = computeManifestTotals(linkedManifests);
        res.render('awb-detail', {
          awb,
          items,
          linkedManifests,
          manifestTotals,
          canEdit: hasPermission(req.session.permissionMap || null, 'airway_bills', 'edit'),
          isAdmin: req.session && req.session.user && req.session.user.role === 'admin',
          error: null,
          success: null
        });
      });
    });
  });
});

app.get('/airway-bills/:id/edit', requireAuth, requirePermission('airway_bills', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  fetchAwbById(awbId, companyId, (awbErr, awb) => {
    if (awbErr || !awb) return res.redirect('/airway-bills');
    fetchAwbItems(awbId, (items) => {
      fetchAwbLinkedManifests(awbId, companyId, (linkedManifests) => {
        fetchAvailableManifestsForAwb(awbId, companyId, (availableManifests) => {
          const manifestTotals = computeManifestTotals(linkedManifests);
          res.render('awb-edit', {
            awb,
            items: items.length ? items : [{}, {}, {}],
            linkedManifests,
            availableManifests,
            manifestTotals,
            error: null,
            success: null
          });
        });
      });
    });
  });
});

app.post('/airway-bills/:id/update', requireAuth, requirePermission('airway_bills', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  const items = parseAwbItemsFromBody(req.body);

  db.run(
    `UPDATE awbs
     SET awb_type = ?, awb_number = ?, awb_date = ?, issuing_carrier = ?, agent_name = ?, agent_iata_code = ?,
         agent_cass_code = ?, shipper_name = ?, shipper_address = ?, consignee_name = ?, consignee_address = ?,
         accounting_information = ?, reference_number = ?, optional_shipping_info_1 = ?, optional_shipping_info_2 = ?,
         airport_of_departure = ?, airport_of_destination = ?, carrier_code = ?, flight_number = ?, departure_airport = ?,
         departure_date = ?, arrival_airport = ?, arrival_date = ?, currency = ?, charges_code = ?,
         weight_valuation_charge_type = ?, other_charges_type = ?, declared_value_carriage = ?, declared_value_customs = ?,
         insurance_amount = ?, handling_information = ?, special_handling_details = ?, ssr = ?, osi = ?, total_pieces = ?,
         gross_weight = ?, chargeable_weight = ?, goods_description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [
      normalizeString(req.body.awb_type) || null,
      normalizeString(req.body.awb_number) || null,
      normalizeString(req.body.awb_date) || null,
      normalizeString(req.body.issuing_carrier) || null,
      normalizeString(req.body.agent_name) || null,
      normalizeString(req.body.agent_iata_code) || null,
      normalizeString(req.body.agent_cass_code) || null,
      normalizeString(req.body.shipper_name) || null,
      normalizeString(req.body.shipper_address) || null,
      normalizeString(req.body.consignee_name) || null,
      normalizeString(req.body.consignee_address) || null,
      normalizeString(req.body.accounting_information) || null,
      normalizeString(req.body.reference_number) || null,
      normalizeString(req.body.optional_shipping_info_1) || null,
      normalizeString(req.body.optional_shipping_info_2) || null,
      normalizeString(req.body.airport_of_departure) || null,
      normalizeString(req.body.airport_of_destination) || null,
      normalizeString(req.body.carrier_code) || null,
      normalizeString(req.body.flight_number) || null,
      normalizeString(req.body.departure_airport) || null,
      normalizeString(req.body.departure_date) || null,
      normalizeString(req.body.arrival_airport) || null,
      normalizeString(req.body.arrival_date) || null,
      normalizeString(req.body.currency) || null,
      normalizeString(req.body.charges_code) || null,
      normalizeString(req.body.weight_valuation_charge_type) || null,
      normalizeString(req.body.other_charges_type) || null,
      normalizeString(req.body.declared_value_carriage) || null,
      normalizeString(req.body.declared_value_customs) || null,
      toNumberOrNull(req.body.insurance_amount),
      normalizeString(req.body.handling_information) || null,
      normalizeString(req.body.special_handling_details) || null,
      normalizeString(req.body.ssr) || null,
      normalizeString(req.body.osi) || null,
      toNumberOrNull(req.body.total_pieces),
      toNumberOrNull(req.body.gross_weight),
      toNumberOrNull(req.body.chargeable_weight),
      normalizeString(req.body.goods_description) || null,
      awbId,
      companyId
    ],
    (err) => {
      if (err) return res.redirect(`/airway-bills/${awbId}/edit`);
      db.run('DELETE FROM awb_items WHERE awb_id = ?', [awbId], () => {
        if (!items.length) return res.redirect(`/airway-bills/${awbId}`);
        const stmt = db.prepare(
          `INSERT INTO awb_items
           (awb_id, pieces, gross_weight, dimensions, goods_description, rate_class, chargeable_weight, rate, total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        items.forEach((item) => {
          stmt.run(
            awbId,
            item.pieces,
            item.gross_weight,
            item.dimensions,
            item.goods_description,
            item.rate_class,
            item.chargeable_weight,
            item.rate,
            item.total
          );
        });
        stmt.finalize(() => res.redirect(`/airway-bills/${awbId}`));
      });
    }
  );
});

app.post('/airway-bills/:id/close', requireAuth, requirePermission('airway_bills', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  db.run(
    "UPDATE awbs SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
    [awbId, companyId],
    () => res.redirect(`/airway-bills/${awbId}`)
  );
});

app.post('/airway-bills/:id/issue', requireAuth, requirePermission('airway_bills', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  db.run(
    "UPDATE awbs SET status = 'issued', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
    [awbId, companyId],
    () => res.redirect(`/airway-bills/${awbId}`)
  );
});

app.post('/airway-bills/:id/reopen', requireAuth, requirePermission('airway_bills', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  db.run(
    "UPDATE awbs SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
    [awbId, companyId],
    () => res.redirect(`/airway-bills/${awbId}`)
  );
});

app.post('/airway-bills/:id/manifests', requireAuth, requirePermission('airway_bills', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  const manifestId = Number(req.body.manifest_id || 0);
  if (!awbId || !manifestId) return res.redirect(`/airway-bills/${awbId}/edit`);

  db.get('SELECT id FROM manifests WHERE id = ? AND company_id = ?', [manifestId, companyId], (err, row) => {
    if (err || !row) return res.redirect(`/airway-bills/${awbId}/edit`);
    db.run(
      'INSERT OR IGNORE INTO awb_manifests (awb_id, manifest_id) VALUES (?, ?)',
      [awbId, manifestId],
      () => res.redirect(`/airway-bills/${awbId}/edit`)
    );
  });
});

app.post('/airway-bills/:id/manifests/:manifestId/delete', requireAuth, requirePermission('airway_bills', 'edit'), (req, res) => {
  const awbId = Number(req.params.id);
  const manifestId = Number(req.params.manifestId);
  if (!awbId || !manifestId) return res.redirect('/airway-bills');

  db.run(
    'DELETE FROM awb_manifests WHERE awb_id = ? AND manifest_id = ?',
    [awbId, manifestId],
    () => res.redirect(`/airway-bills/${awbId}/edit`)
  );
});

app.get('/airway-bills/:id/preview', requireAuth, requirePermission('airway_bills', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  fetchAwbById(awbId, companyId, (awbErr, awb) => {
    if (awbErr || !awb) return res.redirect('/airway-bills');
    fetchAwbItems(awbId, (items) => {
      fetchAwbLinkedManifests(awbId, companyId, (linkedManifests) => {
        const manifestTotals = computeManifestTotals(linkedManifests);
        res.render('awb-preview', { awb, items, manifestTotals });
      });
    });
  });
});

app.get('/airway-bills/:id/print', requireAuth, requirePermission('airway_bills', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  fetchAwbById(awbId, companyId, (awbErr, awb) => {
    if (awbErr || !awb) return res.redirect('/airway-bills');
    fetchAwbItems(awbId, (items) => {
      fetchAwbLinkedManifests(awbId, companyId, (linkedManifests) => {
        const manifestTotals = computeManifestTotals(linkedManifests);
        res.render('awb-print', { awb, items, manifestTotals });
      });
    });
  });
});

app.get('/airway-bills/:id/export/pdf/view', requireAuth, requirePermission('airway_bills', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  fetchAwbById(awbId, companyId, (awbErr, awb) => {
    if (awbErr || !awb) return res.redirect('/airway-bills');
    res.render('awb-pdf-view', { awb });
  });
});

app.get('/airway-bills/:id/export/pdf', requireAuth, requirePermission('airway_bills', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const awbId = Number(req.params.id);
  if (!awbId) return res.redirect('/airway-bills');

  fetchAwbById(awbId, companyId, (awbErr, awb) => {
    if (awbErr || !awb) return res.redirect('/airway-bills');
    fetchAwbItems(awbId, (items) => {
      fetchAwbLinkedManifests(awbId, companyId, (linkedManifests) => {
        const manifestTotals = computeManifestTotals(linkedManifests);
        const doc = new PDFDocument({ margin: 24 });
        res.setHeader('Content-Type', 'application/pdf');
        if (req.query.download === '1') {
          res.setHeader('Content-Disposition', `attachment; filename="awb-${awb.awb_number || awb.id}.pdf"`);
        }
        doc.fontSize(16).text('Air Waybill', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`AWB: ${awb.awb_number || '-'}`);
        doc.text(`Type: ${awb.awb_type || '-'}`);
        doc.text(`Shipper: ${awb.shipper_name || '-'}`);
        doc.text(`Consignee: ${awb.consignee_name || '-'}`);
        doc.text(`Pieces: ${manifestTotals.totalPieces || awb.total_pieces || 0}`);
        doc.text(`Weight: ${Number(manifestTotals.totalWeight || awb.gross_weight || 0).toFixed(2)}`);
        doc.moveDown();
        doc.text('Items');
        (items || []).forEach((item, idx) => {
          doc.text(`${idx + 1}. ${item.goods_description || '-'} (${item.pieces || 0} pcs)`);
        });
        doc.end();
      });
    });
  });
});

  }
}
module.exports = {
  registerLogisticsRoutes
};
