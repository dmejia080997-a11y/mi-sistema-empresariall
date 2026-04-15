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
    DEFAULT_LANG,
    SUPPORTED_LANGS,
    SESSION_COOKIE_NAME
  } = deps;

  app.get('/', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/dashboard');
    if (req.session && req.session.master) return res.redirect('/master');
    return res.redirect('/login');
  });

  app.get('/login', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/dashboard');
    if (req.session && req.session.master) return res.redirect('/master');
    return res.render('login', { error: null });
  });

  app.post('/login', (req, res) => {
    if (req.session && req.session.master && !req.session.user) {
      req.session.master = false;
    }
    const companyUsername = normalizeString(req.body.company_username);
    const username = normalizeString(req.body.username);
    const password = normalizeString(req.body.password);
    const loginKey = `${getClientIp(req)}|${String(companyUsername || '').toLowerCase()}|${String(username || '').toLowerCase()}`;
    const now = Date.now();
    if (!companyUsername || !username || !password) {
      return res.render('login', { error: res.locals.t('errors.username_password_required') });
    }
    if (!rateLimiter.hit(loginRateLimit, loginKey, AUTH_LIMIT_WINDOW_MS, LOGIN_LIMIT_MAX, now)) {
      return res.render('login', { error: res.locals.t('errors.invalid_credentials') });
    }

    db.get('SELECT * FROM companies WHERE username = ? LIMIT 1', [companyUsername], (compErr, company) => {
      if (compErr || !company) {
        return res.render('login', { error: res.locals.t('errors.invalid_credentials') });
      }
      if (company.is_active === 0 || company.is_active === '0') {
        return res.render('login', { error: res.locals.t('errors.company_inactive') });
      }
      if (isCompanyExpired(company)) {
        return res.render('login', { error: res.locals.t('errors.company_expired') });
      }

      db.get(
        'SELECT * FROM users WHERE username = ? AND company_id = ? LIMIT 1',
        [username, company.id],
        (userErr, user) => {
          if (userErr || !user || !user.password_hash) {
            return res.render('login', { error: res.locals.t('errors.invalid_credentials') });
          }
          if (user.is_active === 0) {
            return res.render('login', { error: res.locals.t('errors.invalid_credentials') });
          }
          const ok = bcrypt.compareSync(password, user.password_hash);
          if (!ok) {
            return res.render('login', { error: res.locals.t('errors.invalid_credentials') });
          }
          loginRateLimit.delete(loginKey);
          const previousLang = req.session && req.session.lang ? req.session.lang : DEFAULT_LANG;
          req.session.regenerate((regenErr) => {
            if (regenErr) {
              console.error('[login] session regenerate failed', regenErr);
              return res.render('login', { error: res.locals.t('errors.server_try_again') });
            }
            req.session.lang = SUPPORTED_LANGS[previousLang] ? previousLang : DEFAULT_LANG;
            const baseCurrency = String(company.base_currency || company.currency || 'GTQ').toUpperCase();
            const allowedCurrencies = company.allowed_currencies || baseCurrency;
            const rawAllowedModules = parseJsonList(company.allowed_modules);
            const allowedModulesValue = rawAllowedModules.length ? normalizeAllowedModules(rawAllowedModules) : null;
            req.session.user = {
              id: user.id,
              username: user.username,
              role: user.role,
              is_active: user.is_active
            };
            req.session.company_id = company.id;
            req.session.company = {
              id: company.id,
              name: company.name,
              username: company.username,
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
              phone: company.phone || null,
              country: company.country || null,
              accounting_method: company.accounting_method || null,
              activity_id: company.activity_id || null,
              allowed_modules: allowedModulesValue
            };
            req.session.customer = null;

            getPermissionMap(user.id, company.id, allowedModulesValue, (permErr, permissionMap) => {
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
              return res.redirect('/dashboard');
            });
          });
        }
      );
    });
  });

  app.get('/logout', (req, res) => {
    if (!req.session) {
      return res.redirect('/login');
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
    const fallback = req.session && req.session.user ? '/dashboard' : '/login';
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
    return res.sendFile(filePath);
  });

}

module.exports = {
  registerAuthRoutes
};
