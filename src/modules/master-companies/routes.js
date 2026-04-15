const crypto = require('crypto');

function registerMasterCompanyRoutes(app, deps) {
  const {
    db,
    bcrypt,
    requireMaster,
    loadBusinessActivities,
    buildCompanyStatus,
    setFlash,
    parseJsonList,
    normalizeAllowedModules,
    getPermissionMap,
    parseCurrencyList,
    resolveCompanyActiveWindow,
    seedAccountingCategories,
    seedNifCatalog,
    getIsStartingUp
  } = deps;

  function createCompanyAdminIfMissing({ companyId, tempPassword, passwordHash, req, onSuccess, onError }) {
    if (getIsStartingUp()) {
      console.warn('[startup] blocked createCompanyAdminIfMissing during startup');
      if (onSuccess) return onSuccess();
      return;
    }
    console.log(`[createCompanyAdminIfMissing] check username=admin company_id=${companyId}`);
    db.get(
      "SELECT id FROM users WHERE company_id = ? AND username = 'admin'",
      [companyId],
      (userErr, existing) => {
        if (userErr) {
          console.error('[createCompanyAdminIfMissing] failed pre-check', {
            companyId,
            username: 'admin',
            error: userErr
          });
          return onError(userErr);
        }
        if (existing) {
          console.log('Usuario ya existe, no se vuelve a crear');
          console.log('User already exists, skipping');
          console.log('[user insert]', {
            block: 'createCompanyAdminIfMissing',
            companyId,
            username: 'admin',
            action: 'skipped'
          });
          console.log('[createCompanyAdminIfMissing] insert decision', {
            block: 'createCompanyAdminIfMissing',
            companyId,
            username: 'admin',
            action: 'skip'
          });
          console.log(`[createCompanyAdminIfMissing] skip username=admin company_id=${companyId}`);
          return onSuccess();
        }
        let issuedPassword = tempPassword || null;
        let adminPasswordHash = passwordHash || null;
        if (!adminPasswordHash) {
          issuedPassword = issuedPassword || `TMP-${crypto.randomBytes(8).toString('hex')}`;
          adminPasswordHash = bcrypt.hashSync(issuedPassword, 10);
        }
        console.log('[createCompanyAdminIfMissing] insert decision', {
          block: 'createCompanyAdminIfMissing',
          companyId,
          username: 'admin',
          action: 'execute'
        });
        console.log(`[createCompanyAdminIfMissing] insert username=admin company_id=${companyId}`);
        db.run(
          "INSERT OR IGNORE INTO users (username, password_hash, role, company_id) VALUES ('admin', ?, 'admin', ?)",
          [adminPasswordHash, companyId],
          function (insertErr) {
            if (insertErr) {
              console.error('[createCompanyAdminIfMissing] insert failed', {
                companyId,
                username: 'admin',
                error: insertErr
              });
              if (insertErr.code === 'SQLITE_CONSTRAINT') {
                return onSuccess();
              }
              return onError(insertErr);
            }
            const action = this.changes === 0 ? 'skipped' : 'inserted';
            console.log('[user insert]', {
              block: 'createCompanyAdminIfMissing',
              companyId,
              username: 'admin',
              action
            });
            if (this.changes === 0) {
              return onSuccess();
            }
            if (issuedPassword && req.session) {
              req.session.master_reset_password = {
                company_id: companyId,
                password: issuedPassword
              };
            }
            return onSuccess();
          }
        );
      }
    );
  }

  app.post('/master/create-company', requireMaster, (req, res) => {
    const {
      name,
      address,
      nit,
      employees,
      business_type,
      country,
      base_currency,
      allowed_currencies,
      tax_rate,
      tax_name,
      costing_method,
      multi_currency_enabled,
      currency,
      logo,
      primary_color,
      secondary_color,
      email,
      phone,
      username,
      password,
      admin_name,
      admin_position,
      contact_general_first_name,
      contact_general_last_name,
      contact_general_phone,
      contact_general_mobile,
      contact_general_email,
      contact_general_position,
      contact_payments_first_name,
      contact_payments_last_name,
      contact_payments_phone,
      contact_payments_mobile,
      contact_payments_email,
      contact_payments_position,
      contact_ops_first_name,
      contact_ops_last_name,
      contact_ops_phone,
      contact_ops_mobile,
      contact_ops_email,
      contact_ops_position,
      status,
      active_from,
      active_until,
      active_mode
    } = req.body;
    const resolvedPrimaryColor = primary_color || req.body.color_primary || null;
    const resolvedSecondaryColor = secondary_color || req.body.color_secondary || null;

    if (!name || !username) {
      return res.status(400).send(res.locals.t('errors.company_create_failed'));
    }

    const tempPassword = !password ? `TMP-${crypto.randomBytes(4).toString('hex')}` : null;
    const passwordToUse = password || tempPassword;
    const passwordHash = passwordToUse ? bcrypt.hashSync(passwordToUse, 10) : null;
    const activeWindow = resolveCompanyActiveWindow({
      activeMode: active_mode,
      activeFrom: active_from,
      activeUntil: active_until
    });
    if (activeWindow.invalid) {
      return res.status(400).send(res.locals.t('errors.company_create_failed'));
    }

    const baseCurrency = base_currency || currency || 'GTQ';
    const allowedCurrencies = parseCurrencyList(allowed_currencies, baseCurrency).join(',');
    const taxRateValue = Number.isFinite(Number(tax_rate)) ? Number(tax_rate) : null;
    const taxNameValue = tax_name || null;
    const costingMethodValue = costing_method || null;
    const multiCurrencyValue = multi_currency_enabled ? 1 : 1;
    const accountingMethodValue = 'accrual';
    const accountingFrameworkValue = 'NIF';
    const currencyLegacy = baseCurrency;
    const isActive = status === 'inactive' ? 0 : 1;

    db.run(
      `INSERT INTO companies 
    (name,address,nit,employees,business_type,country,base_currency,allowed_currencies,tax_rate,tax_name,costing_method,multi_currency_enabled,accounting_method,accounting_framework,currency,logo,primary_color,secondary_color,email,phone,username,password_hash,
     contact_general_first_name, contact_general_last_name, contact_general_phone, contact_general_mobile, contact_general_email, contact_general_position,
     contact_payments_first_name, contact_payments_last_name, contact_payments_phone, contact_payments_mobile, contact_payments_email, contact_payments_position,
     contact_ops_first_name, contact_ops_last_name, contact_ops_phone, contact_ops_mobile, contact_ops_email, contact_ops_position,
     active_from,active_until,admin_name,admin_position,active_mode,is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?)` ,
      [
        name,
        address,
        nit,
        employees,
        business_type,
        country,
        baseCurrency,
        allowedCurrencies,
        taxRateValue,
        taxNameValue,
        costingMethodValue,
        multiCurrencyValue,
        accountingMethodValue,
        accountingFrameworkValue,
        currencyLegacy,
        logo,
        resolvedPrimaryColor,
        resolvedSecondaryColor,
        email || null,
        phone || null,
        username,
        passwordHash,
        contact_general_first_name,
        contact_general_last_name,
        contact_general_phone,
        contact_general_mobile,
        contact_general_email,
        contact_general_position,
        contact_payments_first_name,
        contact_payments_last_name,
        contact_payments_phone,
        contact_payments_mobile,
        contact_payments_email,
        contact_payments_position,
        contact_ops_first_name,
        contact_ops_last_name,
        contact_ops_phone,
        contact_ops_mobile,
        contact_ops_email,
        contact_ops_position,
        activeWindow.activeFrom,
        activeWindow.activeUntil,
        admin_name || null,
        admin_position || null,
        activeWindow.activeMode,
        isActive
      ],
      function(err) {
        if (err) {
          console.log(err);
          return res.status(400).send(res.locals.t('errors.company_create_failed'));
        }

        const companyId = this.lastID;
        return seedAccountingCategories(companyId, () => {
          return seedNifCatalog(companyId, () => {
            return createCompanyAdminIfMissing({
              companyId,
              tempPassword,
              passwordHash,
              req,
              onSuccess: () => res.redirect("/master"),
              onError: (error) => {
                console.log(error);
                return res.status(400).send(res.locals.t('errors.company_create_failed'));
              }
            });
          });
        });
      }
    );
  });

  app.get('/master/companies/:id', requireMaster, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect('/master');
    }
    db.get('SELECT * FROM companies WHERE id = ?', [id], (companyErr, company) => {
      if (companyErr || !company) {
        return res.redirect('/master');
      }
      db.all(
        'SELECT id, username, role, created_at FROM users WHERE company_id = ? ORDER BY created_at DESC',
        [id],
        (usersErr, users) => {
          const safeUsers = usersErr ? [] : users;
          const status = buildCompanyStatus(company);
          db.all(
            'SELECT note_text, created_at FROM company_inactivation_notes WHERE company_id = ? ORDER BY created_at DESC, id DESC',
            [id],
            (notesErr, notes) => {
              const safeNotes = notesErr ? [] : notes;
              loadBusinessActivities((activities) => {
                res.render('master-company', {
                  company,
                  users: safeUsers,
                  status,
                  usersCount: safeUsers.length,
                  inactiveNotes: safeNotes,
                  activities,
                  flash: res.locals.flash
                });
              });
            }
          );
        }
      );
    });
  });

  app.post('/master/companies/:id/enter', requireMaster, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect('/master');
    }
    db.get('SELECT * FROM companies WHERE id = ?', [id], (companyErr, company) => {
      if (companyErr || !company) {
        return res.redirect('/master');
      }
      if (company.is_active === 0 || company.is_active === '0') {
        setFlash(req, 'error', 'La empresa esta inactiva y no puede ingresar.');
        return res.redirect('/master');
      }
      db.get(
        "SELECT * FROM users WHERE company_id = ? AND role = 'admin' ORDER BY id ASC LIMIT 1",
        [id],
        (userErr, user) => {
          if (userErr || !user) {
            return res.redirect('/master');
          }
          req.session.company_id = company.id;
          req.session.company = {
            id: company.id,
            name: company.name,
            username: company.username,
            currency: company.currency,
            base_currency: company.base_currency || company.currency,
            allowed_currencies: company.allowed_currencies || company.base_currency || company.currency,
            tax_rate: company.tax_rate || null,
            tax_name: company.tax_name || null,
            costing_method: company.costing_method || null,
            multi_currency_enabled: company.multi_currency_enabled,
            logo: company.logo || null,
            primary_color: company.primary_color || null,
            secondary_color: company.secondary_color || null,
            phone: company.phone || null,
            country: company.country || null,
            accounting_method: company.accounting_method || null,
            activity_id: company.activity_id || null,
            allowed_modules: (() => {
              const raw = parseJsonList(company.allowed_modules);
              return raw.length ? normalizeAllowedModules(raw) : null;
            })()
          };
          req.session.user = user;
          const allowedModulesValue = req.session.company.allowed_modules || null;
          getPermissionMap(user.id, company.id, allowedModulesValue, (permErr, permissionMap) => {
            if (permErr) {
              console.error('[master enter] permissions error', permErr);
              req.session.permissionMap = { isAdmin: true, modules: {}, allowedModules: allowedModulesValue };
            } else {
              req.session.permissionMap = permissionMap;
            }
            return res.redirect('/dashboard');
          });
        }
      );
    });
  });

  app.post('/master/companies/:id/reset-credentials', requireMaster, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect('/master');
    }
    const tempPassword = `TMP-${require('crypto').randomBytes(4).toString('hex')}`;
    const passwordHash = bcrypt.hashSync(tempPassword, 10);
    db.serialize(() => {
      db.run('UPDATE companies SET password_hash = ? WHERE id = ?', [passwordHash, id]);
      db.run(
        "UPDATE users SET password_hash = ? WHERE company_id = ? AND role = 'admin'",
        [passwordHash, id],
        (err) => {
          if (err) {
            console.error('[master/reset-credentials] update admin password failed', {
              companyId: id,
              error: err
            });
          }
          if (!err && req.session) {
            req.session.master_reset_password = {
              company_id: id,
              password: tempPassword
            };
          }
          return res.redirect('/master');
        }
      );
    });
  });

  app.post('/master/companies/:id/renew', requireMaster, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect('/master');
    }
    const active_from = req.body.active_from || null;
    const active_until = req.body.active_until || null;
    db.run(
      'UPDATE companies SET active_from = ?, active_until = ? WHERE id = ?',
      [active_from, active_until, id],
      () => {
        setFlash(req, 'success', 'Empresa renovada correctamente.');
        return res.redirect(`/master/companies/${id}`);
      }
    );
  });

  app.post('/master/companies/:id/deactivate', requireMaster, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect('/master');
    }
    const reason = String(req.body.inactive_reason || '').trim();
    const returnTo = String(req.body.return_to || '').trim() || '/master';
    const safeReturnTo = returnTo.startsWith('/master') ? returnTo : '/master';
    if (!reason) {
      setFlash(req, 'error', 'Debes indicar el motivo de la anulacion.');
      return res.redirect(safeReturnTo);
    }
    db.serialize(() => {
      db.run(
        'INSERT INTO company_inactivation_notes (company_id, note_text) VALUES (?, ?)',
        [id, reason]
      );
      db.run(
        'UPDATE companies SET is_active = 0, inactive_reason = ? WHERE id = ?',
        [reason, id],
        (err) => {
          if (err) {
            setFlash(req, 'error', 'No se pudo anular la empresa.');
          } else {
            setFlash(req, 'success', 'Empresa anulada. La informacion queda congelada.');
          }
          return res.redirect(safeReturnTo);
        }
      );
    });
  });

  app.post('/master/companies/:id/reactivate', requireMaster, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect('/master');
    }
    db.run('UPDATE companies SET is_active = 1 WHERE id = ?', [id], (err) => {
      if (err) {
        setFlash(req, 'error', 'No se pudo reactivar la empresa.');
      } else {
        setFlash(req, 'success', 'Empresa reactivada correctamente.');
      }
      return res.redirect(`/master/companies/${id}`);
    });
  });

  app.post('/master/reset-user-password', requireMaster, (req, res) => {
    const { company_id, username, password } = req.body;
    const companyId = Number(company_id);
    if (!Number.isInteger(companyId) || companyId <= 0 || !username || !password) {
      return res.redirect('/master');
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    db.run(
      'UPDATE users SET password_hash = ? WHERE company_id = ? AND username = ?',
      [passwordHash, companyId, username],
      () => res.redirect('/master')
    );
  });
}

module.exports = {
  registerMasterCompanyRoutes
};
