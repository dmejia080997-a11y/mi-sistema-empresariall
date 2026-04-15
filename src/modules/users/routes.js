function registerUserRoutes(app, deps) {
  const scope = { app, ...deps };
  with (scope) {
app.get('/users', requireAuth, requirePermission('users', 'view'), (req, res) => {
  renderUsers(req, res, null);
});

app.post('/users/create', requireAuth, requirePermission('users', 'create'), (req, res) => {
  const { username, password, role } = req.body;
  const safeUsername = typeof username === 'string' ? username.trim() : '';
  const rawPassword = typeof password === 'string' ? password.trim() : '';
  const tempPassword = rawPassword || 'temporal';
  const safeRole = role === 'admin' ? 'admin' : 'employee';
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
  const isActive = req.body.is_active ? 1 : 0;
  const permissionValues = Array.isArray(req.body.permissions) ? req.body.permissions : [];

  if (!safeUsername) {
    return renderUsers(req, res, res.locals.t('errors.username_required'));
  }

  if (getIsStartingUp()) {
    console.warn('[startup] blocked users/create insert during startup');
    return renderUsers(req, res, res.locals.t('errors.user_create_failed'));
  }

  const passwordHash = bcrypt.hashSync(tempPassword, 10);
  console.log(`[users/create] check username=${safeUsername} company_id=${companyId}`);
  db.get(
    'SELECT id FROM users WHERE company_id = ? AND username = ?',
    [companyId, safeUsername],
    (checkErr, existing) => {
      if (checkErr) {
        console.error('[users/create] failed pre-check', {
          companyId,
          username: safeUsername,
          error: checkErr
        });
        return renderUsers(req, res, res.locals.t('errors.user_create_failed'));
      }
      if (existing) {
        console.log('Usuario ya existe, no se vuelve a crear');
        console.log('User already exists, skipping');
        console.log('[user insert]', {
          block: 'users/create',
          companyId,
          username: safeUsername,
          action: 'skipped'
        });
        console.log('[users/create] insert decision', {
          block: 'users/create',
          companyId,
          username: safeUsername,
          action: 'skip'
        });
        console.log(`[users/create] skip username=${safeUsername} company_id=${companyId}`);
        return res.redirect('/users');
      }
      console.log('[users/create] insert decision', {
        block: 'users/create',
        companyId,
        username: safeUsername,
        action: 'execute'
      });
      console.log(`[users/create] insert username=${safeUsername} company_id=${companyId}`);
      db.run(
        'INSERT OR IGNORE INTO users (username, password_hash, role, company_id, is_active) VALUES (?, ?, ?, ?, ?)',
        [safeUsername, passwordHash, safeRole, companyId, isActive],
        function (err) {
          if (err) {
            console.error('[users/create] insert failed', {
              companyId,
              username: safeUsername,
              role: safeRole,
              error: err
            });
            if (err.code === 'SQLITE_CONSTRAINT') {
              return res.redirect('/users');
            }
            return renderUsers(req, res, res.locals.t('errors.user_create_failed'));
          }
          const action = this.changes === 0 ? 'skipped' : 'inserted';
          console.log('[user insert]', {
            block: 'users/create',
            companyId,
            username: safeUsername,
            action
          });
          if (this.changes === 0) {
            return res.redirect('/users');
          }
          const newUserId = this.lastID;

          const finalizeCreatedUser = () => {
            logAction(
              req.session.user.id,
              'user_created',
              JSON.stringify({ id: newUserId, username: safeUsername, role: safeRole }),
              companyId
            );
            return res.render('users-created', {
              createdUser: {
                username: safeUsername,
                password: tempPassword,
                role: safeRole,
                isActive
              },
              companyLabel: resolveCompanyLabel(req, res)
            });
          };

          assignDefaultDashboardPermission(newUserId, companyId, (defaultErr) => {
            if (defaultErr) {
              console.error('[users/create] default dashboard permission failed', defaultErr);
            }

            if (safeRole === 'admin' || permissionValues.length === 0) {
              return finalizeCreatedUser();
            }

            const pairs = permissionValues
              .map((v) => String(v).split(':').map(Number))
              .filter((p) => Number.isInteger(p[0]) && Number.isInteger(p[1]));

            if (pairs.length === 0) {
              return finalizeCreatedUser();
            }

            const where = pairs.map(() => '(ma.module_id = ? AND ma.action_id = ?)').join(' OR ');
            const flat = pairs.flat();
            db.all(
              `
              SELECT ma.module_id, ma.action_id
              FROM module_actions ma
              WHERE ${where}
              `,
              flat,
              (maErr, validPairs) => {
                if (maErr) {
                  console.error('[users/create] permissions validate failed', maErr);
                  return res.redirect('/users');
                }

                const stmt = db.prepare(
                  'INSERT OR IGNORE INTO user_permissions (user_id, company_id, module_id, action_id) VALUES (?, ?, ?, ?)'
                );
                validPairs.forEach((p) => {
                  stmt.run(newUserId, companyId, p.module_id, p.action_id);
                });
                stmt.finalize(() => {
                  return finalizeCreatedUser();
                });
              }
            );
          });
        }
      );
    }
  );
});

app.post('/users/:id/update', requireAuth, requirePermission('users', 'edit'), (req, res) => {
  const { id } = req.params;
  const { username, password, role } = req.body;
  const safeRole = role === 'admin' ? 'admin' : 'employee';
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
  const isActive = req.body.is_active ? 1 : 0;

  if (!username) {
    return renderUsers(req, res, res.locals.t('errors.username_required'));
  }

  if (String(req.session.user.id) === String(id) && safeRole !== 'admin') {
    return renderUsers(req, res, res.locals.t('errors.user_remove_admin_self'));
  }

  const updateUser = () => {
    db.run(
      'UPDATE users SET username = ?, role = ?, is_active = ? WHERE id = ? AND company_id = ?',
      [username, safeRole, isActive, id, companyId],
      (err) => {
        if (err) {
          console.error('[users/update] update user failed', {
            companyId,
            id,
            username,
            role: safeRole,
            error: err
          });
          return renderUsers(req, res, res.locals.t('errors.user_update_failed'));
        }
        if (String(req.session.user.id) === String(id)) {
          req.session.user.username = username;
          req.session.user.role = safeRole;
          req.session.user.is_active = isActive;
        }
        logAction(
          req.session.user.id,
          'user_updated',
          JSON.stringify({ id, username, role: safeRole }),
          companyId
        );
        return res.redirect('/users');
      }
    );
  };

  if (password) {
    const passwordHash = bcrypt.hashSync(password, 10);
    db.run('UPDATE users SET password_hash = ? WHERE id = ? AND company_id = ?', [passwordHash, id, companyId], (err) => {
      if (err) {
        console.error('[users/update] update password failed', {
          companyId,
          id,
          error: err
        });
        return renderUsers(req, res, res.locals.t('errors.password_update_failed'));
      }
      updateUser();
    });
  } else {
    updateUser();
  }
});

app.post('/users/:id/delete', requireAuth, requirePermission('users', 'delete'), (req, res) => {
  const { id } = req.params;
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

  if (String(req.session.user.id) === String(id)) {
    return renderUsers(req, res, res.locals.t('errors.user_delete_self'));
  }

  db.get('SELECT role FROM users WHERE id = ? AND company_id = ?', [id, companyId], (err, row) => {
    if (err || !row) {
      return renderUsers(req, res, res.locals.t('errors.user_not_found'));
    }

    if (row.role === 'admin') {
      db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND company_id = ?", [companyId], (err2, row2) => {
        if (!err2 && row2 && row2.count <= 1) {
          return renderUsers(req, res, res.locals.t('errors.user_delete_last_admin'));
        }
        db.run('DELETE FROM users WHERE id = ? AND company_id = ?', [id, companyId], (delErr) => {
          if (delErr) {
            console.error('[users/delete] delete admin failed', {
              companyId,
              id,
              error: delErr
            });
          }
          logAction(req.session.user.id, 'user_deleted', JSON.stringify({ id }), companyId);
          return res.redirect('/users');
        });
      });
    } else {
      db.run('DELETE FROM users WHERE id = ? AND company_id = ?', [id, companyId], (delErr) => {
        if (delErr) {
          console.error('[users/delete] delete user failed', {
            companyId,
            id,
            error: delErr
          });
        }
        logAction(req.session.user.id, 'user_deleted', JSON.stringify({ id }), companyId);
        return res.redirect('/users');
      });
    }
  });
});

app.post('/users/:id/permissions', requireAuth, requirePermission('users', 'assign_permissions'), (req, res) => {
  const { id } = req.params;
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
  const permissionValues = Array.isArray(req.body.permissions) ? req.body.permissions : [];

  const pairs = permissionValues
    .map((v) => String(v).split(':').map(Number))
    .filter((p) => Number.isInteger(p[0]) && Number.isInteger(p[1]));

  db.get('SELECT id, role FROM users WHERE id = ? AND company_id = ?', [id, companyId], (uErr, user) => {
    if (uErr || !user) {
      return renderUsers(req, res, res.locals.t('errors.user_not_found'));
    }

    if (user.role === 'admin') {
      return renderUsers(req, res, res.locals.t('errors.user_admin_permissions_fixed'));
    }

    enqueueDbTransaction((finish) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run('DELETE FROM user_permissions WHERE user_id = ? AND company_id = ?', [id, companyId], (delErr) => {
          if (delErr) {
            rollbackTransaction(finish);
            return renderUsers(req, res, res.locals.t('errors.permissions_update_failed'));
          }

          if (pairs.length === 0) {
            return commitTransaction(finish, () => res.redirect('/users'));
          }

          const where = pairs.map(() => '(ma.module_id = ? AND ma.action_id = ?)').join(' OR ');
          const flat = pairs.flat();

          db.all(
            `
            SELECT ma.module_id, ma.action_id
            FROM module_actions ma
            WHERE ${where}
            `,
            flat,
            (maErr, validPairs) => {
              if (maErr) {
                rollbackTransaction(finish);
                return renderUsers(req, res, res.locals.t('errors.permissions_invalid'));
              }

              const stmt = db.prepare(
                'INSERT OR IGNORE INTO user_permissions (user_id, company_id, module_id, action_id) VALUES (?, ?, ?, ?)'
              );

              validPairs.forEach((p) => {
                stmt.run(id, companyId, p.module_id, p.action_id);
              });

              stmt.finalize(() => {
                commitTransaction(finish, () => res.redirect('/users'));
              });
            }
          );
        });
      });
    });
  });
});


  }
}

module.exports = {
  registerUserRoutes
};

