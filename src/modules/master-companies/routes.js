const crypto = require('crypto');

function registerMasterCompanyRoutes(app, deps) {
  const {
    db,
    bcrypt,
    requireMaster,
    loadBusinessActivities,
    buildFileUrl,
    buildCompanyStatus,
    setFlash,
    parseJsonList,
    normalizeAllowedModules,
    getPermissionMap,
    parseCurrencyList,
    resolveCompanyActiveWindow,
    resolveCompanyDisplayName,
    createCompanySlug,
    seedAccountingCategories,
    seedNifCatalog,
    companyDatabaseService,
    runWithTenantDatabase,
    masterSaasService,
    getClientIp,
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
          "INSERT OR IGNORE INTO users (username, password_hash, role, company_id, chat_presence_status) VALUES ('admin', ?, 'admin', ?, 'offline')",
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

  async function createTenantAdminIfAvailable({ companyId, passwordHash }) {
    if (!companyDatabaseService || typeof companyDatabaseService.getCompanyDatabase !== 'function') return;
    const tenantDb = await companyDatabaseService.getCompanyDatabase(companyId);
    await tenantDb.query(
      `INSERT INTO users (username, password_hash, role, company_id, is_active, chat_presence_status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      ['admin', passwordHash, 'admin', companyId, 1, 'offline']
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

    Promise.resolve()
      .then(() => {
        if (!companyDatabaseService || typeof companyDatabaseService.createCompanyDatabase !== 'function') {
          throw new Error('El servicio de base de datos por empresa no esta disponible.');
        }
        return companyDatabaseService.createCompanyDatabase({ name });
      })
      .then((databaseConfig) => {
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
          if (databaseConfig && databaseConfig.database_name && companyDatabaseService.dropPhysicalDatabase) {
            companyDatabaseService.dropPhysicalDatabase(databaseConfig.database_name).catch((dropErr) => {
              console.error('[master/create-company] tenant database cleanup after insert failed', dropErr);
            });
          }
          return res.status(400).send(res.locals.t('errors.company_create_failed'));
        }

        const companyId = this.lastID;
        if (masterSaasService) {
          masterSaasService.logGlobalAudit(db, {
            company_id: companyId,
            user_name: req.session && req.session.masterUser ? req.session.masterUser.username : 'master',
            action: 'create_company',
            module: 'companies',
            description: `Empresa creada: ${name}`,
            ip_address: typeof getClientIp === 'function' ? getClientIp(req) : req.ip
          });
        }
        const rollbackCreatedCompany = async (error) => {
          console.error('[master/create-company] provisioning finalize failed', error);
          try {
            await new Promise((resolve) => db.run('DELETE FROM companies WHERE id = ?', [companyId], () => resolve()));
          } catch (cleanupErr) {
            console.error('[master/create-company] company cleanup failed', cleanupErr);
          }
          try {
            if (databaseConfig && databaseConfig.database_name && companyDatabaseService.dropPhysicalDatabase) {
              await companyDatabaseService.dropPhysicalDatabase(databaseConfig.database_name);
            }
          } catch (dropErr) {
            console.error('[master/create-company] tenant database cleanup failed', dropErr);
          }
          return res.status(400).send(res.locals.t('errors.company_create_failed'));
        };
        Promise.resolve()
          .then(() => companyDatabaseService.saveCompanyDatabaseConfig(companyId, databaseConfig))
          .then(() => companyDatabaseService.auditCompanyDatabaseCreated(companyId, databaseConfig, req.session && req.session.user ? req.session.user.id : null))
          .then(() => createTenantAdminIfAvailable({ companyId, passwordHash }))
          .then(() => {
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
          })
          .catch(rollbackCreatedCompany);
      }
    );
      })
      .catch((provisionErr) => {
        console.error('[master/create-company] tenant provisioning failed', provisionErr);
        return res.status(400).send(res.locals.t('errors.company_create_failed'));
      });
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
      const loadTenantUsers = () => {
        if (!companyDatabaseService || typeof companyDatabaseService.getCompanyDatabase !== 'function') {
          return Promise.resolve([]);
        }
        return companyDatabaseService.getCompanyDatabase(id)
          .then((tenantDb) => new Promise((resolve) => {
            tenantDb.all(
              'SELECT id, username, role, created_at FROM users WHERE company_id = ? ORDER BY created_at DESC',
              [id],
              (usersErr, users) => resolve(usersErr ? [] : users || [])
            );
          }))
          .catch(() => []);
      };
      loadTenantUsers().then((users) => {
          const safeUsers = users || [];
          const status = buildCompanyStatus(company);
          db.all(
            'SELECT note_text, created_at FROM company_inactivation_notes WHERE company_id = ? ORDER BY created_at DESC, id DESC',
            [id],
            (notesErr, notes) => {
              const safeNotes = notesErr ? [] : notes;
              loadBusinessActivities((activities) => {
                res.render('master-company', {
                  company,
                  companyLogoUrl: buildFileUrl ? buildFileUrl(company.logo || null) : null,
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
      });
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
      Promise.resolve()
        .then(() => {
          if (!companyDatabaseService || typeof companyDatabaseService.getCompanyDatabase !== 'function') {
            throw new Error('El servicio de base de datos por empresa no esta disponible.');
          }
          return companyDatabaseService.getCompanyDatabase(company.id);
        })
        .then((tenantDb) => {
          tenantDb.get(
            "SELECT * FROM users WHERE company_id = ? AND role = 'admin' ORDER BY id ASC LIMIT 1",
            [id],
            (userErr, user) => {
              if (userErr || !user) {
                if (userErr) console.error('[master enter] tenant admin lookup error', userErr);
                return res.redirect('/master');
              }
          const companyName = typeof company.name === 'string' ? company.name.trim() : '';
          const companySlug = createCompanySlug(companyName);
          req.session.company_id = company.id;
          req.session.company_name = companyName;
          req.session.company_slug = companySlug;
          req.session.company = {
            id: company.id,
            name: companyName,
            slug: companySlug,
            commercial_name: company.commercial_name || null,
            legal_name: company.legal_name || null,
            display_name: resolveCompanyDisplayName(company),
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
            theme_background_color: company.theme_background_color || null,
            theme_title_color: company.theme_title_color || null,
            theme_text_color: company.theme_text_color || null,
            theme_font_family: company.theme_font_family || null,
            theme_logo_size: company.theme_logo_size || null,
            theme_icon_size: company.theme_icon_size || null,
            phone: company.phone || null,
            country: company.country || null,
            accounting_method: company.accounting_method || null,
            activity_id: company.activity_id || null,
            default_launcher: company.default_launcher || null,
            database_name: company.database_name || null,
            database_type: company.database_type || null,
            database_status: company.database_status || null,
            license_plan: company.license_plan || 'Basico',
            license_max_users: company.license_max_users || 5,
            license_status: company.license_status || 'active',
            license_ends_at: company.license_ends_at || null,
            allowed_modules: (() => {
              const raw = parseJsonList(company.allowed_modules);
              return raw.length ? normalizeAllowedModules(raw) : null;
            })()
          };
          req.session.user = user;
          req.session.companyId = company.id;
          const allowedModulesValue = req.session.company.allowed_modules || null;
          const loadPermissions = () => getPermissionMap(user.id, company.id, allowedModulesValue, (permErr, permissionMap) => {
            if (permErr) {
              console.error('[master enter] permissions error', permErr);
              req.session.permissionMap = { isAdmin: true, modules: {}, allowedModules: allowedModulesValue };
            } else {
              req.session.permissionMap = permissionMap;
            }
            return res.redirect('/dashboard');
          });
              if (typeof runWithTenantDatabase === 'function') {
                return runWithTenantDatabase(tenantDb, company.id, loadPermissions);
              }
              return loadPermissions();
            }
          );
        })
        .catch((dbErr) => {
          console.error('[master enter] company database error', dbErr);
          setFlash(req, 'error', 'No se pudo conectar a la base PostgreSQL de esta empresa.');
          return res.redirect('/master');
        });
    });
  });

  app.post('/master/companies/:id/reset-credentials', requireMaster, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect('/master');
    }
    const tempPassword = `TMP-${require('crypto').randomBytes(4).toString('hex')}`;
    const passwordHash = bcrypt.hashSync(tempPassword, 10);
    db.run('UPDATE companies SET password_hash = ? WHERE id = ?', [passwordHash, id], (companyErr) => {
      if (companyErr) {
        console.error('[master/reset-credentials] update company password failed', companyErr);
        return res.redirect('/master');
      }
      if (!companyDatabaseService || typeof companyDatabaseService.getCompanyDatabase !== 'function') {
        console.error('[master/reset-credentials] tenant database service unavailable');
        return res.redirect('/master');
      }
      return companyDatabaseService.getCompanyDatabase(id)
        .then((tenantDb) => {
          tenantDb.run(
            "UPDATE users SET password_hash = ? WHERE company_id = ? AND role = 'admin'",
            [passwordHash, id],
            (err) => {
              if (err) {
                console.error('[master/reset-credentials] update tenant admin password failed', {
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
        })
        .catch((err) => {
          console.error('[master/reset-credentials] tenant database error', err);
          return res.redirect('/master');
        });
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
        if (masterSaasService) {
          masterSaasService.logGlobalAudit(db, {
            company_id: id,
            user_name: req.session && req.session.masterUser ? req.session.masterUser.username : 'master',
            action: 'change_license',
            module: 'licenses',
            description: `Vigencia renovada: ${active_from || '-'} a ${active_until || '-'}`,
            ip_address: typeof getClientIp === 'function' ? getClientIp(req) : req.ip
          });
        }
        setFlash(req, 'success', 'Empresa renovada correctamente.');
        return res.redirect(`/master/companies/${id}`);
      }
    );
  });

  app.post('/master/companies/:id/license', requireMaster, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.redirect('/master');
    const plan = ['Basico', 'Profesional', 'Empresarial'].includes(req.body.license_plan)
      ? req.body.license_plan
      : 'Basico';
    const startsAt = req.body.license_starts_at || null;
    const endsAt = req.body.license_ends_at || null;
    const maxUsers = Math.max(1, Number(req.body.license_max_users || 5));
    const allowedModules = String(req.body.license_allowed_modules || '').trim() || null;
    const status = ['active', 'suspended'].includes(req.body.license_status)
      ? req.body.license_status
      : 'active';
    const isActive = status === 'suspended' ? 0 : 1;
    db.run(
      `UPDATE companies
       SET license_plan = ?,
           license_starts_at = ?,
           license_ends_at = ?,
           license_max_users = ?,
           license_allowed_modules = ?,
           license_status = ?,
           is_active = ?
       WHERE id = ?`,
      [plan, startsAt, endsAt, maxUsers, allowedModules, status, isActive, id],
      (err) => {
        if (err) {
          setFlash(req, 'error', 'No se pudo actualizar la licencia.');
        } else {
          setFlash(req, 'success', 'Licencia actualizada.');
          if (masterSaasService) {
            masterSaasService.logGlobalAudit(db, {
              company_id: id,
              user_name: req.session && req.session.masterUser ? req.session.masterUser.username : 'master',
              action: 'change_license',
              module: 'licenses',
              description: `Plan=${plan}, estado=${status}, max_users=${maxUsers}, vence=${endsAt || '-'}`,
              ip_address: typeof getClientIp === 'function' ? getClientIp(req) : req.ip
            });
          }
        }
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
            if (masterSaasService) {
              masterSaasService.logGlobalAudit(db, {
                company_id: id,
                user_name: req.session && req.session.masterUser ? req.session.masterUser.username : 'master',
                action: 'suspend_company',
                module: 'licenses',
                description: `Empresa suspendida: ${reason}`,
                ip_address: typeof getClientIp === 'function' ? getClientIp(req) : req.ip
              });
            }
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
        if (masterSaasService) {
          masterSaasService.logGlobalAudit(db, {
            company_id: id,
            user_name: req.session && req.session.masterUser ? req.session.masterUser.username : 'master',
            action: 'reactivate_company',
            module: 'licenses',
            description: 'Empresa reactivada',
            ip_address: typeof getClientIp === 'function' ? getClientIp(req) : req.ip
          });
        }
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
    if (!companyDatabaseService || typeof companyDatabaseService.getCompanyDatabase !== 'function') {
      return res.redirect('/master');
    }
    return companyDatabaseService.getCompanyDatabase(companyId)
      .then((tenantDb) => {
        tenantDb.run(
          'UPDATE users SET password_hash = ? WHERE company_id = ? AND username = ?',
          [passwordHash, companyId, username],
          () => res.redirect('/master')
        );
      })
      .catch(() => res.redirect('/master'));
  });
}

module.exports = {
  registerMasterCompanyRoutes
};
