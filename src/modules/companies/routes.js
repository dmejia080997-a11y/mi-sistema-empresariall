const crypto = require('crypto');

function registerCompanyRoutes(app, deps) {
  const {
    db,
    bcrypt,
    requireMaster,
    companyLogoUpload,
    csrfMiddleware,
    loadBusinessActivities,
    buildCompanyStatus,
    setFlash,
    parseJsonList,
    normalizeAllowedModules,
    getPermissionMap,
    normalizeString,
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


  app.get('/companies', requireMaster, (req, res) => {
    loadBusinessActivities((activities) => {
      res.render('companies', { formData: {}, errors: null, activities });
    });
  });

  app.post('/companies/create', requireMaster, companyLogoUpload.single('logo_file'), csrfMiddleware, (req, res) => {
    loadBusinessActivities((activities) => {
      const {
        name,
        legal_name,
        address,
        tax_address,
        nit,
        employees,
        business_type,
        currency,
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
        primary_color,
        secondary_color,
        status,
        active_from,
        active_until,
        active_mode,
        activity_id
      } = req.body;

      const formData = {
        name,
        legal_name,
        address,
        tax_address,
        nit,
        employees,
        business_type,
        currency,
        email,
        phone,
        username,
        primary_color,
        secondary_color,
        status,
        active_from,
        active_until,
        active_mode,
        activity_id,
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
        contact_ops_position
      };

      const errors = [];
      const normalizedName = normalizeString(name);
      const normalizedUsernameInput = normalizeString(username);
      const normalizedEmail = normalizeString(email);
      const normalizedPhone = normalizeString(phone);
      const normalizedNit = normalizeString(nit);
      const normalizedCurrency = normalizeString(currency).toUpperCase();
      const employeeCount = employees !== undefined && employees !== null && employees !== '' ? Number(employees) : null;
      const activityId = Number(activity_id);
      const activityMap = new Map((activities || []).map((row) => [Number(row.id), row]));
      const selectedActivity = activityMap.get(activityId);

      if (!normalizedName) errors.push('El nombre de la empresa es obligatorio.');
      if (!normalizeString(address)) errors.push('La direcciÃ³n es obligatoria.');
      if (!normalizedNit) errors.push('El NIT es obligatorio.');
      if (!normalizeString(business_type)) errors.push('El giro de la empresa es obligatorio.');
      if (!normalizedCurrency) {
        errors.push('Selecciona una moneda.');
      } else if (!['GTQ', 'USD'].includes(normalizedCurrency)) {
        errors.push('La moneda seleccionada no es vÃ¡lida.');
      }
      if (!normalizedEmail || !normalizedEmail.includes('@')) errors.push('El correo electrÃ³nico es invÃ¡lido.');
      if (!normalizedPhone) errors.push('El telÃ©fono es obligatorio.');
      if (!Number.isFinite(employeeCount) || employeeCount < 1) errors.push('La cantidad de empleados es invÃ¡lida.');
      if (!Number.isInteger(activityId) || activityId <= 0 || !selectedActivity) {
        errors.push('Selecciona una actividad vÃ¡lida.');
      }

      const activeWindow = resolveCompanyActiveWindow({
        activeMode: active_mode,
        activeFrom: active_from,
        activeUntil: active_until
      });
      if (activeWindow.invalid) {
        errors.push('La fecha de vigencia no es vÃ¡lida.');
      }

      if (errors.length > 0) {
        return res.status(400).render('companies', { formData, errors, activities });
      }

      const allowedModulesRaw = selectedActivity ? parseJsonList(selectedActivity.modules_json) : [];
      const allowedModules = normalizeAllowedModules(allowedModulesRaw);
      if (!allowedModules.length) {
        return res.status(400).render('companies', {
          formData,
          errors: ['La actividad seleccionada no tiene mÃ³dulos habilitados.'],
          activities
        });
      }

      const resolveUsername = (callback) => {
        if (normalizedUsernameInput) return callback(null, normalizedUsernameInput);
        return callback(null, normalizedNit);
      };

      resolveUsername((usernameErr, resolvedUsername) => {
        if (usernameErr) {
          console.error('[companies/create] username resolve failed', usernameErr);
          return res.status(400).render('companies', {
            formData,
            errors: ['No se pudo generar el usuario de la empresa. Intenta nuevamente.'],
            activities
          });
        }

        db.get(
          'SELECT id, nit FROM companies WHERE lower(nit) = lower(?) LIMIT 1',
          [normalizedNit],
          (nitErr, nitRow) => {
            if (nitErr) {
              console.error('[companies/create] nit check failed', nitErr);
              return res.status(400).render('companies', {
                formData,
                errors: ['No se pudo validar el NIT. Intenta nuevamente.'],
                activities
              });
            }
            if (nitRow) {
              return res.status(400).render('companies', {
                formData,
                errors: ['El NIT/TAX ID ya existe. Verifica el dato.'],
                activities
              });
            }

            const validateUsername = (cb) => {
              if (!normalizedUsernameInput) return cb(null);
              db.get(
                'SELECT id FROM companies WHERE lower(username) = lower(?) LIMIT 1',
                [resolvedUsername],
                (dupErr, dupRow) => {
                  if (dupErr) return cb(dupErr);
                  if (dupRow) return cb(new Error('duplicate-username'));
                  return cb(null);
                }
              );
            };

            validateUsername((dupErr) => {
              if (dupErr) {
                if (dupErr.message === 'duplicate-username') {
                  return res.status(400).render('companies', {
                    formData,
                    errors: ['El usuario de la empresa ya existe. Elige otro.'],
                    activities
                  });
                }
                console.error('[companies/create] username check failed', dupErr);
                return res.status(400).render('companies', {
                  formData,
                  errors: ['No se pudo validar el usuario. Intenta nuevamente.'],
                  activities
                });
              }

              const tempPassword = !password ? `TMP-${crypto.randomBytes(4).toString('hex')}` : null;
              const passwordToUse = password || tempPassword;
              const passwordHash = bcrypt.hashSync(passwordToUse, 10);
              const baseCurrency = normalizedCurrency || 'GTQ';
              const allowedCurrencies = parseCurrencyList(baseCurrency === 'GTQ' ? 'GTQ,USD' : 'USD,GTQ', baseCurrency).join(',');
              const isActive = status === 'inactive' ? 0 : 1;
              const resolvedLogo = req.file ? req.file.path : null;

              db.run(
                `
              INSERT INTO companies
              (name, legal_name, address, tax_address, nit, employees, business_type, currency, base_currency, allowed_currencies, email, phone, logo, username, password_hash,
               activity_id, allowed_modules,
               contact_general_first_name, contact_general_last_name, contact_general_phone, contact_general_mobile, contact_general_email, contact_general_position,
               contact_payments_first_name, contact_payments_last_name, contact_payments_phone, contact_payments_mobile, contact_payments_email, contact_payments_position,
               contact_ops_first_name, contact_ops_last_name, contact_ops_phone, contact_ops_mobile, contact_ops_email, contact_ops_position,
               primary_color, secondary_color, active_from, active_until, admin_name, admin_position, active_mode, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?,
                      ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?)
              `,
                [
                  normalizedName,
                  legal_name || null,
                  address,
                  tax_address || null,
                  normalizedNit,
                  employeeCount,
                  business_type,
                  baseCurrency,
                  baseCurrency,
                  allowedCurrencies,
                  normalizedEmail,
                  normalizedPhone,
                  resolvedLogo,
                  resolvedUsername,
                  passwordHash,
                  activityId,
                  JSON.stringify(allowedModules),
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
                  primary_color || null,
                  secondary_color || null,
                  activeWindow.activeFrom,
                  activeWindow.activeUntil,
                  admin_name || null,
                  admin_position || null,
                  activeWindow.activeMode,
                  isActive
                ],
                function (err) {
                  if (err) {
                    console.error('[companies/create] insert failed', err);
                    return res.status(400).render('companies', {
                      formData,
                      errors: ['No se pudo crear la empresa. Intenta nuevamente.'],
                      activities
                    });
                  }
                  const companyId = this.lastID;
                  return createCompanyAdminIfMissing({
                    companyId,
                    tempPassword,
                    passwordHash,
                    req,
                    onSuccess: () => {
                      setFlash(req, 'success', 'Empresa creada correctamente.');
                      return res.redirect('/master');
                    },
                    onError: () => {
                      setFlash(req, 'error', 'No se pudo crear la empresa.');
                      return res.redirect('/master');
                    }
                  });
                }
              );
            });
          }
        );
      });
    });
  });


  app.post('/companies/:id/update', requireMaster, (req, res) => {
    const id = req.params.id;
    loadBusinessActivities((activities) => {
      const {
        name, legal_name, address, tax_address, phone, nit, employees, business_type, activity_id, country, base_currency, allowed_currencies,
        tax_rate, tax_name, costing_method, multi_currency_enabled, currency, username, primary_color, secondary_color, active_from, active_until,
        contact_general_first_name, contact_general_last_name, contact_general_phone, contact_general_mobile, contact_general_email, contact_general_position,
        contact_payments_first_name, contact_payments_last_name, contact_payments_phone, contact_payments_mobile, contact_payments_email, contact_payments_position,
        contact_ops_first_name, contact_ops_last_name, contact_ops_phone, contact_ops_mobile, contact_ops_email, contact_ops_position
      } = req.body;

      if (!name || !username) return res.redirect('/master');

      const activityId = Number(activity_id);
      const activityMap = new Map((activities || []).map((row) => [Number(row.id), row]));
      const selectedActivity = activityMap.get(activityId);
      if (!Number.isInteger(activityId) || activityId <= 0 || !selectedActivity) {
        setFlash(req, 'error', 'Selecciona una actividad valida.');
        return res.redirect(`/master/companies/${id}`);
      }
      const allowedModules = normalizeAllowedModules(parseJsonList(selectedActivity.modules_json));
      if (!allowedModules.length) {
        setFlash(req, 'error', 'La actividad seleccionada no tiene modulos habilitados.');
        return res.redirect(`/master/companies/${id}`);
      }

      const baseCurrency = base_currency || currency || 'GTQ';
      const allowedCurrencies = parseCurrencyList(allowed_currencies, baseCurrency).join(',');
      const taxRateValue = Number.isFinite(Number(tax_rate)) ? Number(tax_rate) : null;
      const taxNameValue = tax_name || null;
      const costingMethodValue = costing_method || null;
      const multiCurrencyValue = multi_currency_enabled ? 1 : 1;
      const accountingMethodValue = 'accrual';
      const currencyLegacy = baseCurrency;

      db.run(
        `
      UPDATE companies
      SET name = ?, legal_name = ?, address = ?, tax_address = ?, phone = ?, nit = ?, employees = ?, business_type = ?, activity_id = ?, allowed_modules = ?, country = ?, base_currency = ?, allowed_currencies = ?, tax_rate = ?, tax_name = ?, costing_method = ?, multi_currency_enabled = ?, accounting_method = ?, currency = ?,
          username = ?, primary_color = ?, secondary_color = ?, active_from = ?, active_until = ?,
          contact_general_first_name = ?, contact_general_last_name = ?, contact_general_phone = ?, contact_general_mobile = ?, contact_general_email = ?, contact_general_position = ?,
          contact_payments_first_name = ?, contact_payments_last_name = ?, contact_payments_phone = ?, contact_payments_mobile = ?, contact_payments_email = ?, contact_payments_position = ?,
          contact_ops_first_name = ?, contact_ops_last_name = ?, contact_ops_phone = ?, contact_ops_mobile = ?, contact_ops_email = ?, contact_ops_position = ?
      WHERE id = ?
      `,
        [
          name, legal_name || null, address, tax_address || null, phone, nit, employees, business_type, activityId, JSON.stringify(allowedModules),
          country, baseCurrency, allowedCurrencies, taxRateValue, taxNameValue, costingMethodValue, multiCurrencyValue, accountingMethodValue, currencyLegacy,
          username, primary_color, secondary_color, active_from || null, active_until || null,
          contact_general_first_name || null, contact_general_last_name || null, contact_general_phone || null, contact_general_mobile || null, contact_general_email || null, contact_general_position || null,
          contact_payments_first_name || null, contact_payments_last_name || null, contact_payments_phone || null, contact_payments_mobile || null, contact_payments_email || null, contact_payments_position || null,
          contact_ops_first_name || null, contact_ops_last_name || null, contact_ops_phone || null, contact_ops_mobile || null, contact_ops_email || null, contact_ops_position || null,
          id
        ],
        (err) => {
          if (err) setFlash(req, 'error', 'No se pudo guardar la empresa.');
          else setFlash(req, 'success', 'Cambios guardados correctamente.');
          return res.redirect(`/master/companies/${id}`);
        }
      );
    });
  });

  app.post('/companies/:id/reset-password', requireMaster, (req, res) => {
    const id = req.params.id;
    const { password } = req.body;
    if (!password) return res.redirect('/master');
    const passwordHash = bcrypt.hashSync(password, 10);
    db.serialize(() => {
      db.run('UPDATE companies SET password_hash = ? WHERE id = ?', [passwordHash, id]);
      db.run(
        "UPDATE users SET password_hash = ? WHERE company_id = ? AND role = 'admin'",
        [passwordHash, id],
        () => res.redirect('/master')
      );
    });
  });

}

module.exports = {
  registerCompanyRoutes
};
