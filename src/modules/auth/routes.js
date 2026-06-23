function registerAuthRoutes(app, deps) {
  const {
    db,
    bcrypt,
    normalizeString,
    getClientIp,
    isCompanyExpired,
    parseJsonList,
    normalizeAllowedModules,
    getPermissionMap,
    verifyFileToken,
    rateLimiter,
    loginRateLimit,
    masterLoginRateLimit,
    AUTH_LIMIT_WINDOW_MS,
    LOGIN_LIMIT_MAX,
    MASTER_LOGIN_LIMIT_MAX,
    MASTER_USER,
    MASTER_PASS,
    resolveCompanyDisplayName,
    createCompanySlug,
    DEFAULT_LANG,
    SUPPORTED_LANGS,
    SESSION_COOKIE_NAME,
    buildFileUrl,
    companyDatabaseService,
    runWithTenantDatabase,
    masterSaasService,
    masterDb
  } = deps;

  function normalizeCompanyNit(value) {
    return normalizeString(value).replace(/[\s-]/g, '').toUpperCase();
  }

  function buildLoginCompany(company) {
    if (!company) return null;
    const primaryColor = company.primary_color || '#d97757';
    const secondaryColor = company.secondary_color || '#3d7b6f';
    const backgroundColor = company.theme_background_color || '#f8f5ee';
    const titleColor = company.theme_title_color || '#1c1b1a';
    const textColor = company.theme_text_color || '#1c1b1a';
    return {
      id: company.id,
      name: resolveCompanyDisplayName(company),
      nit: company.nit || null,
      logo: typeof buildFileUrl === 'function' ? buildFileUrl(company.logo || null) : null,
      primary_color: primaryColor,
      secondary_color: secondaryColor,
      background_color: backgroundColor,
      title_color: titleColor,
      text_color: textColor,
      font_family: company.theme_font_family || 'space-grotesk',
      theme_style: [
        `--accent:${primaryColor}`,
        `--accent-2:${secondaryColor}`,
        `--bg:${backgroundColor}`,
        `--ink:${textColor}`,
        `--title-color:${titleColor}`
      ].join(';')
    };
  }

  function renderLogin(res, options = {}) {
    return res.render('login', {
      error: options.error || null,
      loginCompany: options.loginCompany || null
    });
  }

  function loadLoginCompanyById(id, callback) {
    return db.get(
      `SELECT id, name, legal_name, commercial_name, nit, logo, primary_color, secondary_color,
              theme_background_color, theme_title_color, theme_text_color, theme_font_family
       FROM companies
       WHERE id = ?
       LIMIT 1`,
      [id],
      callback
    );
  }

  function loadDefaultLoginCompany(callback) {
    return db.get(
      `SELECT id, name, legal_name, commercial_name, nit, logo, primary_color, secondary_color,
              theme_background_color, theme_title_color, theme_text_color, theme_font_family
       FROM companies
       WHERE COALESCE(is_active, 1) != 0
         AND COALESCE(TRIM(nit), '') != ''
       ORDER BY id DESC
       LIMIT 1`,
      callback
    );
  }

  function ensureCompanyDatabaseReady(company, callback) {
    if (!company || company.database_type !== 'postgresql' || !company.database_name) {
      return callback(new Error('La empresa no tiene base PostgreSQL tenant provisionada.'));
    }
    if (!companyDatabaseService || typeof companyDatabaseService.getCompanyDatabase !== 'function') {
      return callback(new Error('El servicio de base de datos por empresa no esta disponible.'));
    }
    return companyDatabaseService.getCompanyDatabase(company.id)
      .then((tenantDb) => callback(null, tenantDb))
      .catch(callback);
  }

  app.get('/', (req, res) => {
    if (req.session && req.session.master) return res.redirect('/master');
    if (req.session && req.session.user) {
      const companySlug = createCompanySlug(req.session.company_slug || (req.session.company && req.session.company.slug) || req.session.company_name);
      return res.redirect(companySlug ? `/${companySlug}/panel` : '/login');
    }
    return res.redirect('/login');
  });

  app.get('/login', (req, res) => {
    if (req.session && req.session.master) return res.redirect('/master');
    if (req.session && req.session.user) {
      const companySlug = createCompanySlug(req.session.company_slug || (req.session.company && req.session.company.slug) || req.session.company_name);
      return res.redirect(companySlug ? `/${companySlug}/panel` : '/login');
    }
    if (req.session && req.session.login_company_id) {
      return loadLoginCompanyById(req.session.login_company_id, (err, company) => {
          if (err || !company) {
            delete req.session.login_company_id;
            return loadDefaultLoginCompany((defaultErr, defaultCompany) => {
              if (!defaultErr && defaultCompany) {
                req.session.login_company_id = defaultCompany.id;
                return renderLogin(res, { loginCompany: buildLoginCompany(defaultCompany) });
              }
              return renderLogin(res);
            });
          }
          return renderLogin(res, { loginCompany: buildLoginCompany(company) });
        }
      );
    }
    if (req.session && req.session.skip_default_login_company) {
      delete req.session.skip_default_login_company;
      return renderLogin(res);
    }
    return loadDefaultLoginCompany((err, company) => {
      if (!err && company) {
        req.session.login_company_id = company.id;
        return renderLogin(res, { loginCompany: buildLoginCompany(company) });
      }
      return renderLogin(res);
    });
  });

  app.post('/login', (req, res) => {
    if (req.session && req.session.master && !req.session.user) {
      req.session.master = false;
    }
    const companyNit = normalizeCompanyNit(req.body.company_nit || req.body.company_username);
    const username = normalizeString(req.body.username);
    const password = normalizeString(req.body.password);
    const loginCompanyId = req.session && req.session.login_company_id ? Number(req.session.login_company_id) : null;
    const now = Date.now();

    if (companyNit && (!username || !password)) {
      return db.get(
        `SELECT *
         FROM companies
         WHERE REPLACE(REPLACE(UPPER(COALESCE(nit, '')), '-', ''), ' ', '') = ?
         LIMIT 1`,
        [companyNit],
        (compErr, company) => {
          if (compErr) {
            return renderLogin(res, { error: res.locals.t('errors.server_try_again') });
          }
          if (!company) {
            return renderLogin(res, { error: res.locals.t('errors.invalid_nit') });
          }
          if (company.is_active === 0 || company.is_active === '0') {
            return renderLogin(res, { error: res.locals.t('errors.company_inactive') });
          }
          if (isCompanyExpired(company)) {
            return renderLogin(res, { error: res.locals.t('errors.company_expired') });
          }
          delete req.session.skip_default_login_company;
          req.session.login_company_id = company.id;
          return renderLogin(res, { loginCompany: buildLoginCompany(company) });
        }
      );
    }

    if ((!loginCompanyId && !companyNit) || !username || !password) {
      return renderLogin(res, { error: res.locals.t('errors.username_password_required') });
    }

    const loginKey = `${getClientIp(req)}|${String(loginCompanyId || companyNit || '').toLowerCase()}|${String(username || '').toLowerCase()}`;
    if (!rateLimiter.hit(loginRateLimit, loginKey, AUTH_LIMIT_WINDOW_MS, LOGIN_LIMIT_MAX, now)) {
      return renderLogin(res, { error: res.locals.t('errors.invalid_credentials') });
    }

    const companySql = loginCompanyId
      ? 'SELECT * FROM companies WHERE id = ? LIMIT 1'
      : `SELECT * FROM companies
         WHERE REPLACE(REPLACE(UPPER(COALESCE(nit, '')), '-', ''), ' ', '') = ?
         LIMIT 1`;
    const companyParams = [loginCompanyId || companyNit];

    db.get(companySql, companyParams, (compErr, company) => {
      const loginCompany = buildLoginCompany(company);
      if (compErr) {
        console.log('[login] usuario encontrado=false company_id=null role=null redirect=null');
        return renderLogin(res, { error: res.locals.t('errors.server_try_again') });
      }
      if (!company) {
        console.log('[login] usuario encontrado=false company_id=null role=null redirect=null');
        return renderLogin(res, { error: res.locals.t('errors.invalid_nit') });
      }
      if (!loginCompanyId) {
        req.session.login_company_id = company.id;
      }
      if (company.is_active === 0 || company.is_active === '0') {
        return renderLogin(res, { error: res.locals.t('errors.company_inactive'), loginCompany });
      }
      if (isCompanyExpired(company)) {
        return renderLogin(res, { error: res.locals.t('errors.company_expired'), loginCompany });
      }

      ensureCompanyDatabaseReady(company, (dbReadyErr, tenantDb) => {
        if (dbReadyErr) {
          console.error('[login] company database error', dbReadyErr);
          return renderLogin(res, { error: 'No se pudo conectar a la base PostgreSQL de la empresa.', loginCompany });
        }

      tenantDb.get(
        'SELECT * FROM users WHERE username = ? AND company_id = ? LIMIT 1',
        [username, company.id],
        (userErr, user) => {
          if (userErr || !user || !user.password_hash) {
            console.log(`[login] usuario encontrado=false company_id=${company.id} role=null redirect=null`);
            return renderLogin(res, { error: res.locals.t('errors.invalid_credentials'), loginCompany });
          }
          if (user.is_active === 0) {
            console.log(`[login] usuario encontrado=true company_id=${company.id} role=${user.role || null} redirect=null`);
            return renderLogin(res, { error: res.locals.t('errors.invalid_credentials'), loginCompany });
          }
          const ok = bcrypt.compareSync(password, user.password_hash);
          if (!ok) {
            console.log(`[login] usuario encontrado=true company_id=${company.id} role=${user.role || null} redirect=null`);
            return renderLogin(res, { error: res.locals.t('errors.invalid_credentials'), loginCompany });
          }
          loginRateLimit.delete(loginKey);
          const previousLang = req.session && req.session.lang ? req.session.lang : DEFAULT_LANG;
          req.session.regenerate((regenErr) => {
            if (regenErr) {
              console.error('[login] session regenerate failed', regenErr);
              return renderLogin(res, { error: res.locals.t('errors.server_try_again'), loginCompany });
            }
            req.session.lang = SUPPORTED_LANGS[previousLang] ? previousLang : DEFAULT_LANG;
            const companyName = typeof company.name === 'string' ? company.name.trim() : '';
            const companySlug = createCompanySlug(companyName);
            const baseCurrency = String(company.base_currency || company.currency || 'GTQ').toUpperCase();
            const allowedCurrencies = company.allowed_currencies || baseCurrency;
            const rawAllowedModules = parseJsonList(company.allowed_modules);
            const allowedModulesValue = rawAllowedModules.length ? normalizeAllowedModules(rawAllowedModules) : null;
            req.session.user = {
              id: user.id,
              username: user.username,
              role: user.role,
              is_active: user.is_active,
              company_id: company.id,
              launcher_type: user.launcher_type || null,
              chat_display_name: user.chat_display_name || null,
              chat_presence_status: user.chat_presence_status || 'online',
              chat_profile_photo_path: user.chat_profile_photo_path || null,
              chat_profile_completed_at: user.chat_profile_completed_at || null
            };
            req.session.company_id = company.id;
            req.session.companyId = company.id;
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
              nit: company.nit || null,
              currency: company.currency,
              base_currency: baseCurrency,
              allowed_currencies: allowedCurrencies,
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
              allowed_modules: allowedModulesValue
            };
            req.session.customer = null;

            const loadPermissions = () => getPermissionMap(user.id, company.id, allowedModulesValue, (permErr, permissionMap) => {
              if (permErr) {
                console.error('[login] permission map error', permErr);
                req.session.permissionMap = {
                  isAdmin: user.role === 'admin',
                  modules: {},
                  allowedModules: allowedModulesValue
                };
              } else {
                req.session.permissionMap = permissionMap;
              }
              const redirectTarget = companySlug ? `/${companySlug}/panel` : '/login';
              if (masterSaasService && masterDb) {
                masterSaasService.logGlobalAudit(masterDb, {
                  company_id: company.id,
                  user_id: user.id,
                  user_name: user.username,
                  action: 'login',
                  module: 'auth',
                  description: 'Login de usuario',
                  ip_address: getClientIp(req)
                });
              }
              console.log(`[login] usuario encontrado=true company_id=${company.id} role=${user.role || null} redirect=${redirectTarget}`);
              return res.redirect(redirectTarget);
            });
            if (typeof runWithTenantDatabase === 'function') {
              return runWithTenantDatabase(tenantDb, company.id, loadPermissions);
            }
            return loadPermissions();
          });
        }
      );
      });
    });
  });

  app.post('/login/company/reset', (req, res) => {
    if (req.session) {
      delete req.session.login_company_id;
      req.session.skip_default_login_company = true;
    }
    return res.redirect('/login');
  });

  app.get('/logout', (req, res) => {
    if (!req.session) {
      return res.redirect('/login');
    }
    const auditUser = req.session.user;
    if (masterSaasService && masterDb && auditUser) {
      masterSaasService.logGlobalAudit(masterDb, {
        company_id: auditUser.company_id,
        user_id: auditUser.id,
        user_name: auditUser.username,
        action: 'logout',
        module: 'auth',
        description: 'Logout de usuario',
        ip_address: getClientIp(req)
      });
    }
    return req.session.destroy((err) => {
      if (err) {
        console.error('[logout] session destroy failed', err);
      }
      res.clearCookie(SESSION_COOKIE_NAME);
      return res.redirect('/login');
    });
  });

  app.post('/language', (req, res) => {
    const lang = normalizeString(req.body.lang) || DEFAULT_LANG;
    if (req.session && SUPPORTED_LANGS[lang]) {
      req.session.lang = lang;
    }
    const companySlug = createCompanySlug(req.session && (req.session.company_slug || (req.session.company && req.session.company.slug) || req.session.company_name));
    const fallback = req.session && req.session.user && companySlug ? `/${companySlug}/panel` : '/login';
    const referer = req.get('referer');
    if (referer && referer.startsWith(req.protocol + '://' + req.get('host'))) {
      return res.redirect(referer);
    }
    if (referer && referer.startsWith('/')) {
      return res.redirect(referer);
    }
    return res.redirect(fallback);
  });

  app.get('/files/:token', (req, res) => {
    const filePath = verifyFileToken(req.params.token);
    if (!filePath) return res.status(404).send('Not found');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    return res.sendFile(filePath);
  });

}

module.exports = {
  registerAuthRoutes
};
