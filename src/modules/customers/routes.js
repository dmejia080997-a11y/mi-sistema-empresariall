function registerCustomerRoutes(app, deps) {
  const {
    db,
    path,
    parse,
    XLSX,
    upload,
    csrfMiddleware,
    bcrypt,
    requireAuth,
    requirePermission,
    requireCustomer,
    getCompanyId,
    normalizeString,
    normalizeDocumentType,
    resolveSatFields,
    parseCurrencyList,
    findPackagesTable,
    findCustomerTable,
    buildFileUrl,
    getClientIp,
    rateLimiter,
    trackingRateLimit,
    TRACKING_LIMIT_WINDOW_MS,
    TRACKING_LIMIT_MAX,
    customerPortalRateLimit,
    CUSTOMER_PORTAL_WINDOW_MS,
    CUSTOMER_PORTAL_MAX,
    PACKAGE_STATUSES,
    getCompanyBrandById,
    renderCustomers,
    buildCustomerListQuery,
    generatePortalCode,
    generatePortalPassword,
    generateCustomerCode,
    renderConsignatarios,
    resolveConsignatariosSort,
    buildConsignatariosListQuery,
    getCustomerStatusById,
    setFlash,
    logAction,
    formatSqliteError,
    requestSatLookup,
    SAT_PORTAL_URL,
    CUSTOMER_DOCUMENT_TYPES,
    COMPANY_COUNTRIES,
    PAYMENT_METHODS,
    COMMUNICATION_TYPES
  } = deps;
  const formatCustomerSaveError = (res, err, fallbackKey) => {
    if (!err) return res.locals.t(fallbackKey);
    const rawMessage = normalizeString(err.message || err);
    let detail = rawMessage;
    const code = normalizeString(err.code).toUpperCase();
    if (
      typeof formatSqliteError === 'function' &&
      (code.startsWith('SQLITE') || /sqlite|constraint|foreign key|unique|no such/i.test(rawMessage))
    ) {
      detail = formatSqliteError(err);
    }
    if (!detail) return res.locals.t(fallbackKey);
    return res.locals.t('errors.customer_save_detail', { detail });
  };
  const auditCustomerSaveFailure = (req, action, context = {}) => {
    if (typeof logAction !== 'function') return;
    const userId = req.session && req.session.user ? req.session.user.id : null;
    const companyId = getCompanyId(req);
    const payload = {
      stage: context.stage || 'unknown',
      customer_id: context.customerId || null,
      route: req.originalUrl || req.url || null,
      error_code: normalizeString(context.errorCode),
      error_message: normalizeString(context.errorMessage),
      input: {
        document_type: normalizeDocumentType(req.body.document_type),
        document_number: normalizeString(req.body.document_number),
        name: normalizeString(req.body.name),
        first_name: normalizeString(req.body.first_name),
        last_name: normalizeString(req.body.last_name),
        phone: normalizeString(req.body.phone),
        mobile: normalizeString(req.body.mobile),
        email: normalizeString(req.body.email),
        advisor: normalizeString(req.body.advisor),
        payment_method: normalizeString(req.body.payment_method),
        communication_type: normalizeString(req.body.communication_type),
        portal_code: normalizeString(req.body.portal_code).toUpperCase()
      }
    };
    logAction(userId, action, JSON.stringify(payload), companyId);
  };
app.get('/tracking', (req, res) => {
  const query = normalizeString(req.query.q);
  if (!query) {
    return res.render('tracking', {
      query: '',
      pkg: null,
      timeline: [],
      progressPercent: 0,
      latestStatusDate: null,
      photos: [],
      companyBrand: null,
      notFound: false,
      emptyState: true,
      error: null
    });
  }

  const now = Date.now();
  const clientKey = getClientIp(req);
  if (!rateLimiter.hit(trackingRateLimit, clientKey, TRACKING_LIMIT_WINDOW_MS, TRACKING_LIMIT_MAX, now)) {
    return res.render('tracking', {
      query,
      pkg: null,
      timeline: [],
      progressPercent: 0,
      latestStatusDate: null,
      photos: [],
      companyBrand: null,
      notFound: false,
      emptyState: false,
      error: 'rate_limit'
    });
  }

  findPackagesTable((table) => {
    if (!table) {
      return res.render('tracking', {
        query,
        pkg: null,
        timeline: [],
        progressPercent: 0,
        latestStatusDate: null,
        photos: [],
        companyBrand: null,
        notFound: true,
        emptyState: false,
        error: null
      });
    }

    const sql = `SELECT p.*, c.name AS customer_name, c.customer_code AS customer_code
                 FROM ${table} p
                 LEFT JOIN customers c ON c.id = p.customer_id AND c.company_id = p.company_id
                 WHERE p.internal_code = ? OR p.tracking_number = ? OR p.portal_code = ?
                 LIMIT 1`;
    db.get(sql, [query, query, query], (pkgErr, pkg) => {
      if (pkgErr || !pkg) {
        return res.render('tracking', {
          query,
          pkg: null,
          timeline: [],
          progressPercent: 0,
          latestStatusDate: null,
          photos: [],
          companyBrand: null,
          notFound: true,
          emptyState: false,
          error: null
        });
      }

      getCompanyBrandById(pkg.company_id, (companyBrand) => {
        db.all(
          'SELECT COALESCE(new_status, status) AS status, COALESCE(changed_at, created_at) AS status_at FROM package_status_history WHERE package_id = ? ORDER BY status_at ASC',
          [pkg.id],
          (histErr, historyRows) => {
            const history = histErr ? [] : historyRows || [];
            db.all(
              'SELECT file_path, COALESCE(created_at, uploaded_at) AS photo_at FROM package_photos WHERE package_id = ? ORDER BY photo_at DESC',
              [pkg.id],
              (photoErr, photoRows) => {
                const photos = (photoErr ? [] : photoRows || [])
                  .map((row) => ({
                    file_path: buildFileUrl(row.file_path)
                  }))
                  .filter((row) => row.file_path);

                const statusDates = {};
                history.forEach((row) => {
                  const status = normalizeString(row.status);
                  if (!status) return;
                  statusDates[status] = row.status_at || null;
                });

                let currentStatus = normalizeString(pkg.status) || PACKAGE_STATUSES[0];
                if (history.length > 0 && normalizeString(history[history.length - 1].status)) {
                  currentStatus = normalizeString(history[history.length - 1].status);
                }
                const currentIndex = PACKAGE_STATUSES.indexOf(currentStatus);
                const progressPercent = currentIndex >= 0
                  ? Math.round(((currentIndex + 1) / PACKAGE_STATUSES.length) * 100)
                  : 0;

                const timeline = PACKAGE_STATUSES.map((status, idx) => ({
                  status,
                  date: statusDates[status] || null,
                  completed: currentIndex >= 0 ? idx <= currentIndex : Boolean(statusDates[status]),
                  current: idx === currentIndex
                }));

                const latestStatusDate = history.length > 0
                  ? history[history.length - 1].status_at
                  : (pkg.received_at || null);

                return res.render('tracking', {
                  query,
                  pkg,
                  timeline,
                  progressPercent,
                  latestStatusDate,
                  photos,
                  companyBrand,
                  notFound: false,
                  emptyState: false,
                  error: null
                });
              }
            );
          }
        );
      });
    });
  });
});

app.get('/customer/login', (req, res) => {
  return res.render('customer-login', { error: null });
});

app.post('/customer/login', (req, res) => {
  const email = normalizeString(req.body.email).toLowerCase();
  const portalCode = normalizeString(req.body.portal_code).toUpperCase();
  const portalPassword = normalizeString(req.body.portal_password);
  if (!email || !portalCode || !portalPassword) {
    return res.render('customer-login', { error: res.locals.t('customer_portal.login_error') });
  }

  const now = Date.now();
  const clientKey = getClientIp(req);
  if (!rateLimiter.hit(customerPortalRateLimit, clientKey, CUSTOMER_PORTAL_WINDOW_MS, CUSTOMER_PORTAL_MAX, now)) {
    return res.render('customer-login', { error: res.locals.t('tracking.rate_limited') });
  }

  findCustomerTable((table) => {
    if (!table) {
      return res.render('customer-login', { error: res.locals.t('customer_portal.login_error') });
    }
    db.get(
      `SELECT * FROM ${table} WHERE lower(email) = ? AND portal_code = ? LIMIT 1`,
      [email, portalCode],
      (custErr, customer) => {
        if (custErr || !customer || !customer.portal_password_hash) {
          return res.render('customer-login', { error: res.locals.t('customer_portal.login_error') });
        }
        const ok = bcrypt.compareSync(portalPassword, customer.portal_password_hash);
        if (!ok) {
          return res.render('customer-login', { error: res.locals.t('customer_portal.login_error') });
        }

        req.session.customer = {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          company_id: customer.company_id,
          portal_code: customer.portal_code,
          portal_password_reset_required: Number(customer.portal_password_reset_required) === 1
        };
        if (req.session.customer.portal_password_reset_required) {
          return res.redirect('/customer/change-password');
        }
        return res.redirect('/customer/portal');
      }
    );
  });
});

app.get('/customer/change-password', requireCustomer, (req, res) => {
  const customer = req.session.customer;
  if (!customer || !customer.portal_password_reset_required) {
    return res.redirect('/customer/portal');
  }
  return res.render('customer-change-password', { error: null });
});

app.post('/customer/change-password', requireCustomer, (req, res) => {
  const customer = req.session.customer;
  if (!customer || !customer.portal_password_reset_required) {
    return res.redirect('/customer/portal');
  }
  const password = normalizeString(req.body.password);
  const confirm = normalizeString(req.body.confirm_password);
  if (!password) {
    return res.render('customer-change-password', { error: res.locals.t('customer_portal.change_error') });
  }
  if (password !== confirm) {
    return res.render('customer-change-password', { error: res.locals.t('customer_portal.change_mismatch') });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  db.run(
    'UPDATE customers SET portal_password_hash = ?, portal_password_reset_required = 0 WHERE id = ? AND company_id = ?',
    [passwordHash, customer.id, customer.company_id],
    (err) => {
      if (err) {
        return res.render('customer-change-password', { error: res.locals.t('customer_portal.change_error') });
      }
      req.session.customer.portal_password_reset_required = false;
      return res.redirect('/customer/portal');
    }
  );
});

app.get('/customer/portal', requireCustomer, (req, res) => {
  const customer = req.session.customer;
  if (customer && customer.portal_password_reset_required) {
    return res.redirect('/customer/change-password');
  }
  const companyId = customer.company_id;
  findPackagesTable((table) => {
    if (!table) {
      return res.render('customer-portal', {
        customer,
        packages: [],
        companyBrand: null
      });
    }
    db.all(
      `SELECT internal_code, tracking_number, description, weight_lbs, carrier, status, received_at
       FROM ${table}
       WHERE customer_id = ? AND company_id = ?
       ORDER BY received_at DESC`,
      [customer.id, companyId],
      (err, rows) => {
        const packages = err ? [] : rows;
        getCompanyBrandById(companyId, (companyBrand) => {
          return res.render('customer-portal', {
            customer,
            packages,
            companyBrand
          });
        });
      }
    );
  });
});

app.get('/customer/logout', (req, res) => {
  if (req.session) {
    req.session.customer = null;
  }
  return res.redirect('/customer/login');
});
app.get('/inventory', requireAuth, requirePermission('inventory', 'view'), (req, res) => {
  renderInventory(req, res, null);
});

app.get('/inventory/sku-preview', requireAuth, requirePermission('inventory', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const name = normalizeString(req.query.name);
  const categoryId = Number(req.query.category_id || 0);
  const brandId = Number(req.query.brand_id || 0);
  const codeMode = normalizeString(req.query.code_mode) || 'auto';
  const itemCode = normalizeString(req.query.item_code);
  if (!name || !categoryId || !brandId) {
    return res.json({ sku: '' });
  }
  buildItemSku({
    name,
    categoryId,
    brandId,
    companyId,
    codeMode,
    itemCode,
    excludeId: null
  }, (err, result) => {
    if (err || !result) return res.json({ sku: '' });
    return res.json({ sku: result.sku, item_code: result.itemCode });
  });
});


function parseConsignatarioPayload(req) {
  const documentType = normalizeDocumentType(req.body.document_type);
  const documentNumber = normalizeString(req.body.document_number);
  const name = normalizeString(req.body.name);
  const email = normalizeString(req.body.email);
  const phone = normalizeString(req.body.phone);
  const mobile = normalizeString(req.body.mobile);
  const country = normalizeString(req.body.country);
  const department = normalizeString(req.body.department);
  const municipality = normalizeString(req.body.municipality);
  const zone = normalizeString(req.body.zone);
  const fullAddress = normalizeString(req.body.full_address);
  const notes = normalizeString(req.body.notes);

  const satFields = resolveSatFields({
    documentType,
    satVerifiedInput: req.body.sat_verified,
    satNameInput: req.body.sat_name,
    satCheckedAtInput: req.body.sat_checked_at
  });

  return {
    documentType,
    documentNumber,
    name,
    email,
    phone,
    mobile,
    country,
    department,
    municipality,
    zone,
    fullAddress,
    notes,
    satFields
  };
}
app.post('/customers/:id/consignatarios/create', requireAuth, requirePermission('consignatarios', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) return res.redirect('/customers');

  const payload = parseConsignatarioPayload(req);
  if (!payload.name) return res.redirect(`/customers/${customerId}`);

  db.run(
    `INSERT INTO consignatarios
     (customer_id, company_id, document_type, document_number, name, email, phone, mobile, country, department, municipality, zone, full_address, notes,
      sat_verified, sat_name, sat_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      customerId,
      companyId,
      payload.documentType,
      payload.documentNumber || null,
      payload.name,
      payload.email || null,
      payload.phone || null,
      payload.mobile || null,
      payload.country || null,
      payload.department || null,
      payload.municipality || null,
      payload.zone || null,
      payload.fullAddress || null,
      payload.notes || null,
      payload.satFields.sat_verified,
      payload.satFields.sat_name,
      payload.satFields.sat_checked_at
    ],
    () => res.redirect(`/customers/${customerId}`)
  );
});

app.get('/consignatarios', requireAuth, requirePermission('consignatarios', 'view'), (req, res) => {
  renderConsignatarios(req, res, null);
});

app.get('/consignatarios/export', requireAuth, requirePermission('consignatarios', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const filters = {
    name: normalizeString(req.query.name),
    document_number: normalizeString(req.query.document_number),
    customer_id: Number(req.query.customer_id || 0)
  };
  const sort = resolveConsignatariosSort(req);
  const { query, params } = buildConsignatariosListQuery(companyId, filters, sort);

  db.all(query, params, (err, rows) => {
    if (err) return renderConsignatarios(req, res, res.locals.t('errors.export_failed'));
    const data = (rows || []).map((row) => [
      row.customer_code || '',
      row.portal_code || '',
      row.name || '',
      row.document_type || '',
      row.document_number || '',
      row.customer_name || '',
      row.phone || '',
      row.mobile || '',
      row.email || '',
      row.country || '',
      row.department || '',
      row.municipality || '',
      row.zone || '',
      row.full_address || '',
      row.notes || '',
      row.created_at || ''
    ]);

    const headers = [
      'customer_code',
      'portal_code',
      'name',
      'document_type',
      'document_number',
      'customer_name',
      'phone',
      'mobile',
      'email',
      'country',
      'department',
      'municipality',
      'zone',
      'full_address',
      'notes',
      'created_at'
    ];
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Consignatarios');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="consignatarios.xlsx"');
    return res.send(buffer);
  });
});

app.post('/consignatarios/create', requireAuth, requirePermission('consignatarios', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const customerId = Number(req.body.customer_id || 0);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return renderConsignatarios(req, res, res.locals.t('errors.consignatario_customer_required'));
  }

  const payload = parseConsignatarioPayload(req);
  if (!payload.name) {
    return renderConsignatarios(req, res, res.locals.t('errors.consignatario_name_required'));
  }

  getCustomerStatusById(customerId, companyId, (custErr, status) => {
    if (custErr || !status || !status.ok) {
      if (status && status.reason === 'voided') {
        return renderConsignatarios(req, res, res.locals.t('errors.customer_voided_not_allowed'));
      }
      return renderConsignatarios(req, res, res.locals.t('errors.consignatario_customer_required'));
    }
    db.run(
      `INSERT INTO consignatarios
       (customer_id, company_id, document_type, document_number, name, email, phone, mobile, country, department, municipality, zone, full_address, notes,
        sat_verified, sat_name, sat_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        status.id,
        companyId,
        payload.documentType,
        payload.documentNumber || null,
        payload.name,
        payload.email || null,
        payload.phone || null,
        payload.mobile || null,
        payload.country || null,
        payload.department || null,
        payload.municipality || null,
        payload.zone || null,
        payload.fullAddress || null,
        payload.notes || null,
        payload.satFields.sat_verified,
        payload.satFields.sat_name,
        payload.satFields.sat_checked_at
      ],
      (err) => {
        if (err) return renderConsignatarios(req, res, res.locals.t('errors.consignatario_create_failed'));
        return res.redirect(`/consignatarios?customer_id=${status.id}`);
      }
    );
  });
});

app.get('/consignatarios/:id', requireAuth, requirePermission('consignatarios', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/consignatarios');
  db.get(
    `SELECT consignatarios.*, customers.name AS customer_name, customers.customer_code AS customer_code
     FROM consignatarios
     LEFT JOIN customers ON consignatarios.customer_id = customers.id AND customers.company_id = ?
     WHERE consignatarios.id = ? AND consignatarios.company_id = ?`,
    [companyId, id, companyId],
    (err, consignatario) => {
      if (err || !consignatario) return res.redirect('/consignatarios');
      db.all(
        `SELECT id, internal_code, tracking_number, status
         FROM packages
         WHERE consignatario_id = ? AND company_id = ?
         ORDER BY created_at DESC`,
        [id, companyId],
        (pkgErr, packages) => {
          return res.render('consignatario-detail', {
            consignatario,
            packages: pkgErr ? [] : packages || [],
            documentTypes: CUSTOMER_DOCUMENT_TYPES,
            countries: COMPANY_COUNTRIES
          });
        }
      );
    }
  );
});

app.post('/consignatarios/:id/update', requireAuth, requirePermission('consignatarios', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/consignatarios');

  const payload = parseConsignatarioPayload(req);
  if (!payload.name) return res.redirect(`/consignatarios/${id}`);

  db.run(
    `UPDATE consignatarios
     SET document_type = ?, document_number = ?, name = ?, email = ?, phone = ?, mobile = ?, country = ?, department = ?, municipality = ?, zone = ?, full_address = ?, notes = ?,
         sat_verified = ?, sat_name = ?, sat_checked_at = ?
     WHERE id = ? AND company_id = ?`,
    [
      payload.documentType,
      payload.documentNumber || null,
      payload.name,
      payload.email || null,
      payload.phone || null,
      payload.mobile || null,
      payload.country || null,
      payload.department || null,
      payload.municipality || null,
      payload.zone || null,
      payload.fullAddress || null,
      payload.notes || null,
      payload.satFields.sat_verified,
      payload.satFields.sat_name,
      payload.satFields.sat_checked_at,
      id,
      companyId
    ],
    () => res.redirect(`/consignatarios/${id}`)
  );
});
app.get('/customers', requireAuth, requirePermission('customers', 'view'), (req, res) => {
  renderCustomers(req, res, null);
});

function normalizeImportHeader(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mapImportRow(row) {
  const mapped = {};
  Object.keys(row || {}).forEach((key) => {
    const normalized = normalizeImportHeader(key);
    if (normalized) mapped[normalized] = row[key];
  });
  return mapped;
}

function readImportField(row, keys) {
  for (const key of keys) {
    if (!key) continue;
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  }
  return '';
}

function resolvePortalCodeForImport(companyId, preferredCode, callback) {
  if (!preferredCode) return generatePortalCode(companyId, 0, callback);
  const code = preferredCode.toUpperCase();
  db.get('SELECT id FROM customers WHERE portal_code = ? AND company_id = ?', [code, companyId], (err, row) => {
    if (err) return callback(err);
    if (row) return generatePortalCode(companyId, 0, callback);
    return callback(null, code);
  });
}

function resolveCustomerCodeForImport(companyId, preferredCode, callback) {
  if (!preferredCode) return generateCustomerCode(companyId, 0, callback);
  const code = preferredCode.toUpperCase();
  db.get('SELECT id FROM customers WHERE customer_code = ? AND company_id = ?', [code, companyId], (err, row) => {
    if (err) return callback(err);
    if (row) return generateCustomerCode(companyId, 0, callback);
    return callback(null, code);
  });
}

function parseCustomersImportFile(file) {
  if (!file) return null;
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.csv') {
    return parse(file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames && workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  }
  return null;
}

app.get('/customers/export', requireAuth, requirePermission('customers', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const filters = {
    name: normalizeString(req.query.name),
    document_number: normalizeString(req.query.document_number),
    advisor: normalizeString(req.query.advisor),
    payment_method: normalizeString(req.query.payment_method),
    communication_type: normalizeString(req.query.communication_type)
  };
  const { query, params } = buildCustomerListQuery(companyId, filters, { voided: 0 });

  db.all(query, params, (err, rows) => {
    if (err) return renderCustomers(req, res, res.locals.t('errors.export_failed'));
    const data = (rows || []).map((row) => [
      row.name || '',
      row.document_type || '',
      row.document_number || '',
      row.phone || '',
      row.mobile || '',
      row.email || '',
      row.advisor || '',
      row.payment_method || '',
      row.communication_type || '',
      row.country || '',
      row.department || '',
      row.municipality || '',
      row.zone || '',
      row.address || '',
      row.full_address || '',
      row.house_number || '',
      row.street_number || '',
      row.notes || ''
    ]);

    const headers = [
      'name',
      'document_type',
      'document_number',
      'phone',
      'mobile',
      'email',
      'advisor',
      'payment_method',
      'communication_type',
      'country',
      'department',
      'municipality',
      'zone',
      'address',
      'full_address',
      'house_number',
      'street_number',
      'notes'
    ];
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Clientes');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="customers.xlsx"');
    return res.send(buffer);
  });
});

app.post('/customers/import', requireAuth, requirePermission('customers', 'create'), upload.single('file'), csrfMiddleware, (req, res) => {
  const companyId = getCompanyId(req);
  if (!req.file) return renderCustomers(req, res, res.locals.t('errors.import_file_required'));

  let records;
  try {
    records = parseCustomersImportFile(req.file);
  } catch (err) {
    return renderCustomers(req, res, res.locals.t('errors.invalid_import_file'));
  }

  if (!records) return renderCustomers(req, res, res.locals.t('errors.invalid_import_file'));
  if (!records || records.length === 0) return renderCustomers(req, res, res.locals.t('errors.import_empty'));

  const next = (index) => {
    if (index >= records.length) return res.redirect('/customers');
    const rawRow = records[index] || {};
    const row = mapImportRow(rawRow);

    const firstName = normalizeString(readImportField(row, ['first_name', 'nombres']));
    const lastName = normalizeString(readImportField(row, ['last_name', 'apellidos']));
    let name = normalizeString(readImportField(row, ['name', 'nombre', 'nombre_completo']));
    if (!name) name = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (!name) return next(index + 1);

    const documentType = normalizeDocumentType(readImportField(row, ['document_type', 'tipo_documento']));
    const documentNumber = normalizeString(readImportField(row, ['document_number', 'numero_documento', 'nit', 'documento']));
    const phone = normalizeString(readImportField(row, ['phone', 'telefono']));
    const mobile = normalizeString(readImportField(row, ['mobile', 'movil']));
    const email = normalizeString(readImportField(row, ['email', 'correo']));
    const address = normalizeString(readImportField(row, ['address', 'direccion']));
    const fullAddress = normalizeString(readImportField(row, ['full_address', 'direccion_completa']));
    const houseNumber = normalizeString(readImportField(row, ['house_number', 'numero_casa']));
    const streetNumber = normalizeString(readImportField(row, ['street_number', 'numero_calle']));
    const zone = normalizeString(readImportField(row, ['zone', 'zona']));
    const municipality = normalizeString(readImportField(row, ['municipality', 'municipio']));
    const department = normalizeString(readImportField(row, ['department', 'departamento']));
    const country = normalizeString(readImportField(row, ['country', 'pais']));
    const paymentMethod = normalizeString(readImportField(row, ['payment_method', 'metodo_pago']));
    const communicationType = normalizeString(readImportField(row, ['communication_type', 'tipo_comunicacion']));
    const advisor = normalizeString(readImportField(row, ['advisor', 'asesor']));
    const notes = normalizeString(readImportField(row, ['notes', 'notas']));
    const customerCodeInput = normalizeString(readImportField(row, ['customer_code', 'codigo_cliente', 'codigo'])).toUpperCase();
    const portalCodeInput = normalizeString(readImportField(row, ['portal_code', 'codigo_portal'])).toUpperCase();
    const portalPasswordInput = normalizeString(readImportField(row, ['portal_password', 'contrasena_portal']));

    resolveCustomerCodeForImport(companyId, customerCodeInput, (custErr, customerCode) => {
      if (custErr) return next(index + 1);
      resolvePortalCodeForImport(companyId, portalCodeInput, (codeErr, portalCode) => {
        if (codeErr) return next(index + 1);
        const portalPasswordPlain = portalPasswordInput || generatePortalPassword();
        const portalPasswordHash = bcrypt.hashSync(portalPasswordPlain, 10);
        db.run(
          `INSERT INTO customers
           (customer_code, document_type, document_number, name, first_name, last_name, phone, mobile, email, address, full_address, house_number, street_number,
            zone, municipality, department, country, payment_method, communication_type, advisor, notes,
            sat_verified, sat_name, sat_checked_at, portal_code, portal_password_hash, portal_password_reset_required, company_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            customerCode || null,
            documentType,
            documentNumber || null,
            name,
            firstName || null,
            lastName || null,
            phone || null,
            mobile || null,
            email || null,
            address || null,
            fullAddress || null,
            houseNumber || null,
            streetNumber || null,
            zone || null,
            municipality || null,
            department || null,
            country || null,
            paymentMethod || null,
            communicationType || null,
            advisor || null,
            notes || null,
            0,
            null,
            null,
            portalCode || null,
            portalPasswordHash,
            1,
            companyId
          ],
          () => next(index + 1)
        );
      });
    });
  };

  return next(0);
});

app.post('/customers/create', requireAuth, requirePermission('customers', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const documentType = normalizeDocumentType(req.body.document_type);
  const documentNumber = normalizeString(req.body.document_number);
  const firstName = normalizeString(req.body.first_name);
  const lastName = normalizeString(req.body.last_name);
  let name = normalizeString(req.body.name);
  if (!name) {
    name = [firstName, lastName].filter(Boolean).join(' ').trim();
  }
  const phone = normalizeString(req.body.phone);
  const mobile = normalizeString(req.body.mobile);
  const email = normalizeString(req.body.email);
  const address = normalizeString(req.body.address);
  const fullAddress = normalizeString(req.body.full_address);
  const houseNumber = normalizeString(req.body.house_number);
  const streetNumber = normalizeString(req.body.street_number);
  const zone = normalizeString(req.body.zone);
  const municipality = normalizeString(req.body.municipality);
  const department = normalizeString(req.body.department);
  const country = normalizeString(req.body.country);
  const paymentMethod = normalizeString(req.body.payment_method);
  const communicationType = normalizeString(req.body.communication_type);
  const advisor = normalizeString(req.body.advisor);
  const notes = normalizeString(req.body.notes);
  const portalCodeInput = normalizeString(req.body.portal_code).toUpperCase();
  const portalPasswordInput = normalizeString(req.body.portal_password);

  if (!name) {
    auditCustomerSaveFailure(req, 'customer_create_failed', {
      stage: 'validation',
      errorCode: 'CUSTOMER_NAME_REQUIRED',
      errorMessage: res.locals.t('errors.customer_name_required')
    });
    return renderCustomers(req, res, res.locals.t('errors.customer_name_required'));
  }

  const satFields = resolveSatFields({
    documentType,
    satVerifiedInput: req.body.sat_verified,
    satNameInput: req.body.sat_name,
    satCheckedAtInput: req.body.sat_checked_at
  });

  const insertCustomer = (portalCode, customerCode) => {
    const portalPasswordPlain = portalPasswordInput || generatePortalPassword();
    const portalPasswordHash = bcrypt.hashSync(portalPasswordPlain, 10);
    const portalResetRequired = 1;
    db.run(
      `INSERT INTO customers
       (customer_code, document_type, document_number, name, first_name, last_name, phone, mobile, email, address, full_address, house_number, street_number,
        zone, municipality, department, country, payment_method, communication_type, advisor, notes,
        sat_verified, sat_name, sat_checked_at, portal_code, portal_password_hash, portal_password_reset_required, company_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerCode || null,
        documentType,
        documentNumber || null,
        name,
        firstName || null,
        lastName || null,
        phone || null,
        mobile || null,
        email || null,
        address || null,
        fullAddress || null,
        houseNumber || null,
        streetNumber || null,
        zone || null,
        municipality || null,
        department || null,
        country || null,
        paymentMethod || null,
        communicationType || null,
        advisor || null,
        notes || null,
        satFields.sat_verified,
        satFields.sat_name,
        satFields.sat_checked_at,
        portalCode || null,
        portalPasswordHash,
        portalResetRequired,
        companyId
      ],
      function (err) {
        if (err) {
          auditCustomerSaveFailure(req, 'customer_create_failed', {
            stage: 'insert',
            errorCode: err.code,
            errorMessage: err.message
          });
          return renderCustomers(req, res, formatCustomerSaveError(res, err, 'errors.customer_create_failed'));
        }
        setFlash(
          req,
          'info',
          res.locals.t('customers.portal_created_flash', {
            portal_code: portalCode || '',
            portal_password: portalPasswordPlain
          })
        );
        return res.redirect('/customers');
      }
    );
  };

  const createWithPortalCode = (portalCode) => {
    generateCustomerCode(companyId, 0, (codeErr, customerCode) => {
      if (codeErr) {
        auditCustomerSaveFailure(req, 'customer_create_failed', {
          stage: 'customer_code_generation',
          errorCode: codeErr.code || codeErr.message,
          errorMessage: codeErr.message || String(codeErr)
        });
        return renderCustomers(req, res, formatCustomerSaveError(res, codeErr, 'errors.customer_create_failed'));
      }
      return insertCustomer(portalCode, customerCode);
    });
  };

  if (portalCodeInput) {
    db.get(
      'SELECT id FROM customers WHERE portal_code = ? AND company_id = ?',
      [portalCodeInput, companyId],
      (dupErr, dupRow) => {
        if (dupErr) {
          auditCustomerSaveFailure(req, 'customer_create_failed', {
            stage: 'portal_code_lookup',
            errorCode: dupErr.code,
            errorMessage: dupErr.message
          });
          return renderCustomers(req, res, formatCustomerSaveError(res, dupErr, 'errors.customer_create_failed'));
        }
        if (dupRow) {
          auditCustomerSaveFailure(req, 'customer_create_failed', {
            stage: 'portal_code_duplicate',
            errorCode: 'PORTAL_CODE_DUPLICATE',
            errorMessage: res.locals.t('errors.customer_portal_code_duplicate')
          });
          return renderCustomers(req, res, res.locals.t('errors.customer_portal_code_duplicate'));
        }
        return createWithPortalCode(portalCodeInput);
      }
    );
    return;
  }

  generatePortalCode(companyId, 0, (codeErr, portalCode) => {
    if (codeErr) {
      auditCustomerSaveFailure(req, 'customer_create_failed', {
        stage: 'portal_code_generation',
        errorCode: codeErr.code || codeErr.message,
        errorMessage: codeErr.message || String(codeErr)
      });
      return renderCustomers(req, res, formatCustomerSaveError(res, codeErr, 'errors.customer_create_failed'));
    }
    return createWithPortalCode(portalCode);
  });
});

app.get('/customers/:id', requireAuth, requirePermission('customers', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/customers');
  db.get('SELECT * FROM customers WHERE id = ? AND company_id = ?', [id, companyId], (err, customer) => {
    if (err || !customer) return res.redirect('/customers');
    if (customer.is_voided && !(res.locals.can && res.locals.can('customers', 'view_voided'))) {
      return res.redirect('/customers');
    }
    if (!customer.first_name && !customer.last_name && customer.name) {
      customer.first_name = customer.name;
      customer.last_name = '';
    }
    db.get(
      'SELECT COUNT(1) AS total FROM consignatarios WHERE customer_id = ? AND company_id = ?',
      [id, companyId],
      (consErr, row) => {
        res.render('customer-detail', {
          customer,
          consignatariosCount: consErr || !row ? 0 : row.total || 0,
          flash: res.locals.flash,
          documentTypes: CUSTOMER_DOCUMENT_TYPES,
          paymentMethods: PAYMENT_METHODS,
          communicationTypes: COMMUNICATION_TYPES
        });
      }
    );
  });
});

app.post('/customers/:id/void', requireAuth, requirePermission('customers', 'void'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/customers');
  const userId = req.session && req.session.user ? req.session.user.id : null;
  db.run(
    `UPDATE customers
     SET is_voided = 1,
         voided_at = CURRENT_TIMESTAMP,
         voided_by = ?
     WHERE id = ? AND company_id = ? AND is_voided = 0`,
    [userId || null, id, companyId],
    function (err) {
      if (err) return renderCustomers(req, res, res.locals.t('errors.customer_void_failed'));
      if (this.changes > 0) {
        logAction(userId, 'customer_void', `customer:${id}`, companyId);
        setFlash(req, 'info', res.locals.t('customers.void_success'));
      }
      const canViewVoided = res.locals.can ? res.locals.can('customers', 'view_voided') : false;
      return res.redirect(canViewVoided ? '/customers#clientes-anulados' : '/customers');
    }
  );
});

app.post('/customers/:id/update', requireAuth, requirePermission('customers', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const detailUrl = `/customers/${id}#editar`;
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/customers');

  const documentType = normalizeDocumentType(req.body.document_type);
  const documentNumber = normalizeString(req.body.document_number);
  const firstName = normalizeString(req.body.first_name);
  const lastName = normalizeString(req.body.last_name);
  let name = normalizeString(req.body.name);
  if (!name) {
    name = [firstName, lastName].filter(Boolean).join(' ').trim();
  }
  const phone = normalizeString(req.body.phone);
  const mobile = normalizeString(req.body.mobile);
  const email = normalizeString(req.body.email);
  const address = normalizeString(req.body.address);
  const fullAddress = normalizeString(req.body.full_address);
  const houseNumber = normalizeString(req.body.house_number);
  const streetNumber = normalizeString(req.body.street_number);
  const zone = normalizeString(req.body.zone);
  const municipality = normalizeString(req.body.municipality);
  const department = normalizeString(req.body.department);
  const country = normalizeString(req.body.country);
  const paymentMethod = normalizeString(req.body.payment_method);
  const communicationType = normalizeString(req.body.communication_type);
  const advisor = normalizeString(req.body.advisor);
  const notes = normalizeString(req.body.notes);
  const portalCodeInput = normalizeString(req.body.portal_code).toUpperCase();
  const portalPassword = normalizeString(req.body.portal_password);

  if (!name) {
    auditCustomerSaveFailure(req, 'customer_update_failed', {
      stage: 'validation',
      customerId: id,
      errorCode: 'CUSTOMER_NAME_REQUIRED',
      errorMessage: res.locals.t('errors.customer_name_required')
    });
    setFlash(req, 'error', res.locals.t('errors.customer_name_required'));
    return res.redirect(detailUrl);
  }

  const satFields = resolveSatFields({
    documentType,
    satVerifiedInput: req.body.sat_verified,
    satNameInput: req.body.sat_name,
    satCheckedAtInput: req.body.sat_checked_at
  });

  db.get(
    'SELECT portal_password_hash, portal_password_reset_required FROM customers WHERE id = ? AND company_id = ?',
    [id, companyId],
    (pwErr, row) => {
    if (pwErr || !row) {
      auditCustomerSaveFailure(req, 'customer_update_failed', {
        stage: 'load_existing',
        customerId: id,
        errorCode: pwErr && pwErr.code ? pwErr.code : 'CUSTOMER_NOT_FOUND',
        errorMessage: pwErr && pwErr.message ? pwErr.message : 'Customer not found for update.'
      });
      setFlash(req, 'error', formatCustomerSaveError(res, pwErr, 'errors.customer_update_failed'));
      return res.redirect(detailUrl);
    }
    const portalPasswordHash = portalPassword ? bcrypt.hashSync(portalPassword, 10) : row.portal_password_hash;
    const portalResetRequired = portalPassword ? 1 : Number(row.portal_password_reset_required) || 0;

    const updateCustomer = (portalCode) => {
      db.run(
        `UPDATE customers
         SET document_type = ?, document_number = ?, name = ?, first_name = ?, last_name = ?, phone = ?, mobile = ?, email = ?, address = ?, full_address = ?, house_number = ?, street_number = ?,
             zone = ?, municipality = ?, department = ?, country = ?, payment_method = ?, communication_type = ?, advisor = ?, notes = ?,
             sat_verified = ?, sat_name = ?, sat_checked_at = ?, portal_code = ?, portal_password_hash = ?, portal_password_reset_required = ?
         WHERE id = ? AND company_id = ?`,
        [
          documentType,
          documentNumber || null,
          name,
          firstName || null,
          lastName || null,
          phone || null,
          mobile || null,
          email || null,
          address || null,
          fullAddress || null,
          houseNumber || null,
          streetNumber || null,
          zone || null,
          municipality || null,
          department || null,
          country || null,
          paymentMethod || null,
          communicationType || null,
          advisor || null,
          notes || null,
          satFields.sat_verified,
          satFields.sat_name,
          satFields.sat_checked_at,
          portalCode || null,
          portalPasswordHash,
          portalResetRequired,
          id,
          companyId
        ],
        (err) => {
          if (err) {
            auditCustomerSaveFailure(req, 'customer_update_failed', {
              stage: 'update',
              customerId: id,
              errorCode: err.code,
              errorMessage: err.message
            });
            setFlash(req, 'error', formatCustomerSaveError(res, err, 'errors.customer_update_failed'));
            return res.redirect(detailUrl);
          }
          return res.redirect(`/customers/${id}`);
        }
      );
    };

    if (!portalCodeInput) return updateCustomer(null);

    db.get(
      'SELECT id FROM customers WHERE portal_code = ? AND company_id = ? AND id != ?',
      [portalCodeInput, companyId, id],
      (dupErr, dupRow) => {
        if (dupErr) {
          auditCustomerSaveFailure(req, 'customer_update_failed', {
            stage: 'portal_code_lookup',
            customerId: id,
            errorCode: dupErr.code,
            errorMessage: dupErr.message
          });
          setFlash(req, 'error', formatCustomerSaveError(res, dupErr, 'errors.customer_update_failed'));
          return res.redirect(detailUrl);
        }
        if (dupRow) {
          auditCustomerSaveFailure(req, 'customer_update_failed', {
            stage: 'portal_code_duplicate',
            customerId: id,
            errorCode: 'PORTAL_CODE_DUPLICATE',
            errorMessage: res.locals.t('errors.customer_portal_code_duplicate')
          });
          setFlash(req, 'error', res.locals.t('errors.customer_portal_code_duplicate'));
          return res.redirect(detailUrl);
        }
        return updateCustomer(portalCodeInput);
      }
    );
  });
});
app.post('/sat/verify', (req, res) => {
  if (!req.session || !req.session.user) return res.status(403).json({ ok: false });
  const map = req.session.permissionMap || null;
  if (!hasPermission(map, 'customers', 'create') && !hasPermission(map, 'customers', 'edit')) {
    return res.status(403).json({ ok: false });
  }
  const documentNumber = normalizeString(req.body.document_number);
  if (!documentNumber) return res.json({ ok: false, manual: true, message: res.locals.t('customers.sat_manual_query'), portal_url: SAT_PORTAL_URL });
  requestSatLookup(documentNumber, (err, data) => {
    if (err || !data) return res.json({ ok: false, manual: true, message: res.locals.t('customers.sat_manual_query'), portal_url: SAT_PORTAL_URL });
    return res.json(data);
  });
});


}
module.exports = {
  registerCustomerRoutes
};
