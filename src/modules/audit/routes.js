function registerAuditRoutes(app, deps) {
  const scope = { app, ...deps };
  with (scope) {
app.get('/audit', requireAuth, requirePermission('settings', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const companySettings = req.session ? req.session.company || {} : {};
  const baseCurrency = String(companySettings.base_currency || companySettings.currency || 'GTQ').toUpperCase();
  const allowedCurrencies = parseCurrencyList(companySettings.allowed_currencies, baseCurrency);
  const requestedCurrency = String(req.body.currency || '').trim().toUpperCase();
  const currency = allowedCurrencies.includes(requestedCurrency) ? requestedCurrency : baseCurrency;
  const exchangeRate = currency === baseCurrency ? 1 : Number(req.body.exchange_rate || 0);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return renderInvoices(req, res, res.locals.t('errors.exchange_rate_invalid'));
  }
  db.all(
    `SELECT audit_logs.id, audit_logs.action, audit_logs.details, audit_logs.created_at,
            users.username AS username
     FROM audit_logs
     LEFT JOIN users ON audit_logs.user_id = users.id
     WHERE audit_logs.company_id = ?
     ORDER BY audit_logs.created_at DESC
     LIMIT 200`,
    [companyId],
    (err, rows) => {
      const logs = err ? [] : rows;
      res.render('audit', { logs });
    }
  );
});

  }
}

module.exports = {
  registerAuditRoutes
};
