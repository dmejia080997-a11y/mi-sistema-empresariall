function registerMasterRoutes(app, deps) {
  const scope = { app, ...deps };
  with (scope) {
app.get('/master', requireMaster, (req, res) => {
  db.all(
    `SELECT companies.*, COUNT(users.id) AS users_count
     FROM companies
     LEFT JOIN users ON users.company_id = companies.id
     GROUP BY companies.id
     ORDER BY companies.created_at DESC`,
    (err, companies) => {
    if (err) {
      console.log(err);
    }
    const tempReset = req.session ? req.session.master_reset_password : null;
    if (req.session && req.session.master_reset_password) {
      delete req.session.master_reset_password;
    }
    const mapped = (companies || []).map((company) => ({
      ...company,
      status: buildCompanyStatus(company)
    }));
    res.render('master', { companies: mapped, tempReset });
  });
});

  }
}

module.exports = {
  registerMasterRoutes
};
