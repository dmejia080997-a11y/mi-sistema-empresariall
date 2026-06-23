function registerMasterAuthRoutes(app, deps) {
  const {
    normalizeString,
    getClientIp,
    rateLimiter,
    masterLoginRateLimit,
    AUTH_LIMIT_WINDOW_MS,
    MASTER_LOGIN_LIMIT_MAX,
    MASTER_USER,
    MASTER_PASS,
    DEFAULT_LANG,
    SUPPORTED_LANGS,
    SESSION_COOKIE_NAME,
    db,
    masterSaasService
  } = deps;

  app.get('/master/login', (req, res) => {
    if (req.session && req.session.user && !req.session.master) {
      return res.status(403).send('Forbidden');
    }
    if (req.session && req.session.master) {
      return res.redirect('/master');
    }
    return res.render('master-login', { error: null });
  });

  app.post('/master/login', (req, res) => {
    if (req.session && req.session.user && !req.session.master) {
      return res.status(403).send('Forbidden');
    }
    if (!MASTER_USER || !MASTER_PASS) {
      return res.render('master-login', { error: res.locals.t('errors.master_login_disabled') });
    }
    const username = normalizeString(req.body.username);
    const password = normalizeString(req.body.password);
    const masterLoginKey = `${getClientIp(req)}|master|${String(username || '').toLowerCase()}`;
    if (!rateLimiter.hit(masterLoginRateLimit, masterLoginKey, AUTH_LIMIT_WINDOW_MS, MASTER_LOGIN_LIMIT_MAX, Date.now())) {
      return res.render('master-login', { error: res.locals.t('errors.master_invalid_credentials') });
    }
    if (username === MASTER_USER && password === MASTER_PASS) {
      masterLoginRateLimit.delete(masterLoginKey);
      const previousLang = req.session && req.session.lang ? req.session.lang : DEFAULT_LANG;
      return req.session.regenerate((regenErr) => {
        if (regenErr) {
          console.error('[master/login] session regenerate failed', regenErr);
          return res.render('master-login', { error: res.locals.t('errors.server_try_again') });
        }
        req.session.lang = SUPPORTED_LANGS[previousLang] ? previousLang : DEFAULT_LANG;
        req.session.master = true;
        req.session.masterUser = { username };
        if (masterSaasService && db) {
          masterSaasService.logGlobalAudit(db, {
            user_name: username,
            action: 'login',
            module: 'master',
            description: 'Login Master',
            ip_address: getClientIp(req)
          });
        }
        return res.redirect('/master');
      });
    }
    return res.render('master-login', { error: res.locals.t('errors.master_invalid_credentials') });
  });

  app.get('/master/logout', (req, res) => {
    if (req.session && req.session.user && !req.session.master) {
      return res.status(403).send('Forbidden');
    }
    if (!req.session) {
      return res.redirect('/master/login');
    }
    const userName = req.session.masterUser && req.session.masterUser.username ? req.session.masterUser.username : 'master';
    if (masterSaasService && db) {
      masterSaasService.logGlobalAudit(db, {
        user_name: userName,
        action: 'logout',
        module: 'master',
        description: 'Logout Master',
        ip_address: getClientIp(req)
      });
    }
    return req.session.destroy((err) => {
      if (err) {
        console.error('[master/logout] session destroy failed', err);
      }
      res.clearCookie(SESSION_COOKIE_NAME);
      return res.redirect('/master/login');
    });
  });
}

module.exports = {
  registerMasterAuthRoutes
};
