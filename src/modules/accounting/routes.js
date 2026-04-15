function registerAccountingRoutes(app, deps) {
  const scope = { app, ...deps };
  with (scope) {
app.get('/accounting/settings', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    if (!company) return res.redirect('/dashboard');
    fetchNifAccounts(companyId, company.accounting_framework, (accounts) => {
      res.render('accounting-settings', { company, accounts, frameworks: ACCOUNTING_FRAMEWORKS });
    });
  });
});

app.post('/accounting/settings', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const {
    country,
    base_currency,
    allowed_currencies,
    tax_rate,
    tax_name,
    tax_payable_account_id,
    tax_credit_account_id,
    accounting_framework,
    costing_method,
    multi_currency_enabled
  } = req.body;

  const baseCurrency = base_currency || 'GTQ';
  const allowedCurrencies = parseCurrencyList(allowed_currencies, baseCurrency).join(',');
  const taxRateValue = Number.isFinite(Number(tax_rate)) ? Number(tax_rate) : null;
  const taxNameValue = tax_name || null;
  const taxPayableAccountId = Number(tax_payable_account_id) || null;
  const taxCreditAccountId = Number(tax_credit_account_id) || null;
  const accountingFramework = normalizeFramework(accounting_framework);
  const costingMethodValue = costing_method || null;
  const multiCurrencyValue = multi_currency_enabled ? 1 : 0;

  db.run(
    `UPDATE companies
     SET country = ?,
         base_currency = ?,
         allowed_currencies = ?,
         tax_rate = ?,
         tax_name = ?,
         tax_payable_account_id = ?,
         tax_credit_account_id = ?,
         accounting_framework = ?,
         costing_method = ?,
         multi_currency_enabled = ?,
         currency = ?
     WHERE id = ?`,
    [
      country || null,
      baseCurrency,
      allowedCurrencies,
      taxRateValue,
      taxNameValue,
      taxPayableAccountId,
      taxCreditAccountId,
      accountingFramework,
      costingMethodValue,
      multiCurrencyValue,
      baseCurrency,
      companyId
    ],
    (err) => {
      if (err) {
        console.error('[accounting/settings] update failed', err);
      }
      getCompanySettings(companyId, (company) => {
        if (req.session && company) {
          req.session.company = {
            ...req.session.company,
            country: company.country,
            currency: company.currency,
            base_currency: company.base_currency,
            allowed_currencies: company.allowed_currencies.join(','),
            tax_rate: company.tax_rate,
            tax_name: company.tax_name,
            tax_payable_account_id: company.tax_payable_account_id,
            tax_credit_account_id: company.tax_credit_account_id,
            accounting_framework: company.accounting_framework,
            costing_method: company.costing_method,
            multi_currency_enabled: company.multi_currency_enabled
          };
        }
        return res.redirect('/accounting/settings');
      });
    }
  );
});

app.get('/accounting', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  return res.redirect('/accounting/reports');
});

app.get('/accounting/accounts', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(company && company.accounting_framework);
    fetchNifAccounts(companyId, framework, (accounts) => {
      fetchAccountingCategories(companyId, framework, (categories) => {
        res.render('accounting-accounts', {
          accounts,
          categories,
          framework,
          nifTypes: NIF_TYPES,
          nifSubtypes: NIF_SUBTYPES,
          flash: res.locals.flash,
          active: 'accounts'
        });
      });
    });
  });
});

app.get('/accounting/categories', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(req.query.framework || (company && company.accounting_framework));
    fetchAccountingCategories(companyId, framework, (categories) => {
      res.render('accounting-categories', {
        categories,
        framework,
        frameworks: ACCOUNTING_FRAMEWORKS,
        flash: res.locals.flash,
        active: 'accounts'
      });
    });
  });
});

app.post('/accounting/categories/create', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const framework = normalizeFramework(req.body.framework);
  const code = (req.body.code || '').trim().toUpperCase();
  const name = (req.body.name || '').trim();
  const type = normalizeNifType(req.body.type);
  const sortOrder = Number(req.body.sort_order || 0);

  if (!code || !name || !type) {
    setFlash(req, 'error', 'Completa cÃ³digo, nombre y tipo.');
    return res.redirect(`/accounting/categories?framework=${framework}`);
  }

  db.get(
    'SELECT id FROM accounting_categories WHERE company_id = ? AND framework = ? AND code = ? LIMIT 1',
    [companyId, framework, code],
    (dupErr, dupRow) => {
      if (dupRow) {
        setFlash(req, 'error', 'Ya existe una categorÃ­a con ese cÃ³digo.');
        return res.redirect(`/accounting/categories?framework=${framework}`);
      }

      db.run(
        `INSERT INTO accounting_categories (company_id, framework, code, name, type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [companyId, framework, code, name, type, Number.isFinite(sortOrder) ? sortOrder : 0],
        (err) => {
          if (err) {
            console.error('[accounting/categories] insert failed', err);
            setFlash(req, 'error', 'No se pudo crear la categorÃ­a.');
          } else {
            setFlash(req, 'success', 'CategorÃ­a creada correctamente.');
          }
          return res.redirect(`/accounting/categories?framework=${framework}`);
        }
      );
    }
  );
});

app.post('/accounting/categories/:id/update', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const framework = normalizeFramework(req.body.framework);
  const code = (req.body.code || '').trim().toUpperCase();
  const name = (req.body.name || '').trim();
  const type = normalizeNifType(req.body.type);
  const sortOrder = Number(req.body.sort_order || 0);

  if (!Number.isInteger(id) || id <= 0 || !code || !name || !type) {
    setFlash(req, 'error', 'Datos invÃ¡lidos para actualizar.');
    return res.redirect(`/accounting/categories?framework=${framework}`);
  }

  db.run(
    `UPDATE accounting_categories
     SET code = ?, name = ?, type = ?, sort_order = ?
     WHERE id = ? AND company_id = ? AND framework = ?`,
    [code, name, type, Number.isFinite(sortOrder) ? sortOrder : 0, id, companyId, framework],
    (err) => {
      if (err) {
        console.error('[accounting/categories] update failed', err);
        setFlash(req, 'error', 'No se pudo actualizar la categorÃ­a.');
      } else {
        setFlash(req, 'success', 'CategorÃ­a actualizada.');
      }
      return res.redirect(`/accounting/categories?framework=${framework}`);
    }
  );
});

app.post('/accounting/categories/:id/delete', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const framework = normalizeFramework(req.body.framework);
  if (!Number.isInteger(id) || id <= 0) {
    setFlash(req, 'error', 'CategorÃ­a invÃ¡lida.');
    return res.redirect(`/accounting/categories?framework=${framework}`);
  }
  db.run(
    'DELETE FROM accounting_categories WHERE id = ? AND company_id = ? AND framework = ?',
    [id, companyId, framework],
    (err) => {
      if (err) {
        console.error('[accounting/categories] delete failed', err);
        setFlash(req, 'error', 'No se pudo eliminar la categorÃ­a.');
      } else {
        setFlash(req, 'success', 'CategorÃ­a eliminada.');
      }
      return res.redirect(`/accounting/categories?framework=${framework}`);
    }
  );
});

app.get('/accounting/categories/rules', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(req.query.framework || company.accounting_framework);
    db.all(
      `SELECT id, rule_text, target_category_code, priority, is_active
       FROM accounting_category_rules
       WHERE company_id = ? AND framework = ?
       ORDER BY priority DESC, id ASC`,
      [companyId, framework],
      (err, rules) => {
        res.render('accounting-category-rules', {
          rules: err ? [] : rules,
          framework,
          frameworks: ACCOUNTING_FRAMEWORKS,
          flash: res.locals.flash
        });
      }
    );
  });
});

app.post('/accounting/categories/rules/create', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const framework = normalizeFramework(req.body.framework);
  const ruleText = (req.body.rule_text || '').trim();
  const targetCode = (req.body.target_category_code || '').trim().toUpperCase();
  const priority = Number(req.body.priority || 0);
  if (!ruleText || !targetCode) {
    setFlash(req, 'error', 'Completa texto y categorÃ­a destino.');
    return res.redirect(`/accounting/categories/rules?framework=${framework}`);
  }
  db.run(
    `INSERT INTO accounting_category_rules (company_id, framework, rule_text, target_category_code, priority, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [companyId, framework, ruleText, targetCode, Number.isFinite(priority) ? priority : 0],
    (err) => {
      if (err) {
        setFlash(req, 'error', 'No se pudo crear la regla.');
      } else {
        setFlash(req, 'success', 'Regla creada.');
      }
      return res.redirect(`/accounting/categories/rules?framework=${framework}`);
    }
  );
});

app.post('/accounting/categories/rules/:id/update', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const framework = normalizeFramework(req.body.framework);
  const ruleText = (req.body.rule_text || '').trim();
  const targetCode = (req.body.target_category_code || '').trim().toUpperCase();
  const priority = Number(req.body.priority || 0);
  const isActive = req.body.is_active ? 1 : 0;
  if (!Number.isInteger(id) || id <= 0 || !ruleText || !targetCode) {
    setFlash(req, 'error', 'Datos invÃ¡lidos.');
    return res.redirect(`/accounting/categories/rules?framework=${framework}`);
  }
  db.run(
    `UPDATE accounting_category_rules
     SET rule_text = ?, target_category_code = ?, priority = ?, is_active = ?
     WHERE id = ? AND company_id = ? AND framework = ?`,
    [ruleText, targetCode, Number.isFinite(priority) ? priority : 0, isActive, id, companyId, framework],
    (err) => {
      if (err) {
        setFlash(req, 'error', 'No se pudo actualizar la regla.');
      } else {
        setFlash(req, 'success', 'Regla actualizada.');
      }
      return res.redirect(`/accounting/categories/rules?framework=${framework}`);
    }
  );
});

app.post('/accounting/categories/rules/:id/delete', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const framework = normalizeFramework(req.body.framework);
  if (!Number.isInteger(id) || id <= 0) {
    setFlash(req, 'error', 'Regla invÃ¡lida.');
    return res.redirect(`/accounting/categories/rules?framework=${framework}`);
  }
  db.run(
    'DELETE FROM accounting_category_rules WHERE id = ? AND company_id = ? AND framework = ?',
    [id, companyId, framework],
    (err) => {
      if (err) {
        setFlash(req, 'error', 'No se pudo eliminar la regla.');
      } else {
        setFlash(req, 'success', 'Regla eliminada.');
      }
      return res.redirect(`/accounting/categories/rules?framework=${framework}`);
    }
  );
});

app.get('/api/accounting/categories', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(req.query.framework || company.accounting_framework);
    fetchAccountingCategories(companyId, framework, (categories) => {
      res.json({ framework, categories });
    });
  });
});

app.post('/api/accounting/categories', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const framework = normalizeFramework(req.body.framework);
  const code = (req.body.code || '').trim().toUpperCase();
  const name = (req.body.name || '').trim();
  const type = normalizeNifType(req.body.type);
  const sortOrder = Number(req.body.sort_order || 0);

  if (!code || !name || !type) {
    return res.status(400).json({ ok: false, message: 'Datos incompletos.' });
  }

  db.get(
    'SELECT id FROM accounting_categories WHERE company_id = ? AND framework = ? AND code = ? LIMIT 1',
    [companyId, framework, code],
    (dupErr, dupRow) => {
      if (dupRow) {
        return res.status(409).json({ ok: false, message: 'CÃ³digo duplicado.' });
      }

      db.run(
        `INSERT INTO accounting_categories (company_id, framework, code, name, type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [companyId, framework, code, name, type, Number.isFinite(sortOrder) ? sortOrder : 0],
        function (err) {
          if (err) {
            return res.status(500).json({ ok: false, message: 'Error al crear.' });
          }
          return res.json({ ok: true, id: this.lastID });
        }
      );
    }
  );
});

app.put('/api/accounting/categories/:id', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const framework = normalizeFramework(req.body.framework);
  const code = (req.body.code || '').trim().toUpperCase();
  const name = (req.body.name || '').trim();
  const type = normalizeNifType(req.body.type);
  const sortOrder = Number(req.body.sort_order || 0);

  if (!Number.isInteger(id) || id <= 0 || !code || !name || !type) {
    return res.status(400).json({ ok: false, message: 'Datos invÃ¡lidos.' });
  }

  db.run(
    `UPDATE accounting_categories
     SET code = ?, name = ?, type = ?, sort_order = ?
     WHERE id = ? AND company_id = ? AND framework = ?`,
    [code, name, type, Number.isFinite(sortOrder) ? sortOrder : 0, id, companyId, framework],
    (err) => {
      if (err) {
        return res.status(500).json({ ok: false, message: 'Error al actualizar.' });
      }
      return res.json({ ok: true });
    }
  );
});

app.delete('/api/accounting/categories/:id', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const framework = normalizeFramework(req.body.framework || req.query.framework);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: 'ID invÃ¡lido.' });
  }
  db.run(
    'DELETE FROM accounting_categories WHERE id = ? AND company_id = ? AND framework = ?',
    [id, companyId, framework],
    (err) => {
      if (err) return res.status(500).json({ ok: false, message: 'Error al eliminar.' });
      return res.json({ ok: true });
    }
  );
});

app.post('/api/accounting/categories/auto-assign', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const framework = normalizeFramework(req.body.framework);
  autoAssignAccountCategoriesWithRules({ companyId, framework }, (result) => {
    return res.json({ ok: true, framework, ...result });
  });
});

app.get('/api/accounting/reports/categories', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(req.query.framework || company.accounting_framework);
    fetchNifTrialBalance(companyId, { startDate, endDate, framework }, (balances) => {
      fetchAccountingCategories(companyId, framework, (categories) => {
        const totals = computeCategoryTotals({ balances, categories });
        return res.json({ framework, totals });
      });
    });
  });
});

app.get('/accounting/reports/categories/export', requireAuth, requirePermission('accounting', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(req.query.framework || company.accounting_framework);
    fetchNifTrialBalance(companyId, { startDate, endDate, framework }, (balances) => {
      fetchAccountingCategories(companyId, framework, (categories) => {
        const totals = computeCategoryTotals({ balances, categories });
        const data = totals.map((row) => ({
          categoria: `${row.code} - ${row.name}`,
          tipo: row.type,
          total: Number(row.total || 0)
        }));
        if (format === 'pdf') {
          const table = [
            ['CategorÃ­a', 'Tipo', 'Total'],
            ...data.map((d) => [d.categoria, d.tipo, d.total.toFixed(2)])
          ];
          return renderSimplePdf(res, 'Totales por categorÃ­a', table);
        }
        const sheet = XLSX.utils.json_to_sheet(data);
        return sendExcel(res, 'totales-categorias.xlsx', [{ name: 'Categorias', data: sheet }]);
      });
    });
  });
});

app.post('/accounting/accounts/create', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const code = (req.body.code || '').trim();
  const name = (req.body.name || '').trim();
  const type = normalizeNifType(req.body.type);
  const level = req.body.level === 'subcuenta' ? 'subcuenta' : 'mayor';
  const subtype = normalizeNifSubtype(req.body.subtype);
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
  const depreciable = req.body.depreciable ? 1 : 0;
  const isDepreciation = req.body.is_depreciation ? 1 : 0;

  if (!code || !name || (!type && !categoryId)) {
    setFlash(req, 'error', 'Completa el cÃ³digo, nombre y tipo o categorÃ­a de cuenta.');
    return res.redirect('/accounting/accounts');
  }

  if (level === 'subcuenta' && !parentId) {
    setFlash(req, 'error', 'Las subcuentas deben tener una cuenta padre.');
    return res.redirect('/accounting/accounts');
  }

  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(company && company.accounting_framework);
    db.get(
      'SELECT id FROM accounts WHERE company_id = ? AND code = ? LIMIT 1',
      [companyId, code],
      (dupErr, dupRow) => {
        if (dupRow) {
          setFlash(req, 'error', 'Ya existe una cuenta con ese cÃ³digo.');
          return res.redirect('/accounting/accounts');
        }

        const finishInsert = (resolvedParentId, resolvedCategoryId, resolvedType) => {
          db.run(
            `INSERT INTO accounts (company_id, code, name, type, level, subtype, parent_id, depreciable, is_depreciation, framework, category_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              companyId,
              code,
              name,
              resolvedType,
              level,
              subtype,
              resolvedParentId,
              depreciable,
              isDepreciation,
              framework,
              resolvedCategoryId
            ],
            function (err) {
              if (err) {
                console.error('[accounting/accounts] insert failed', err);
                setFlash(req, 'error', 'No se pudo crear la cuenta.');
              } else {
                const userId = req.session && req.session.user ? req.session.user.id : null;
                logAction(userId, 'accounting_account_created', JSON.stringify({ code, name }), companyId);
                setFlash(req, 'success', 'Cuenta creada correctamente.');
              }
              return res.redirect('/accounting/accounts');
            }
          );
        };

        const validateParent = (next) => {
          if (!parentId) return next(null);
          db.get(
            'SELECT id FROM accounts WHERE id = ? AND company_id = ? LIMIT 1',
            [parentId, companyId],
            (parentErr, parentRow) => {
              if (parentErr || !parentRow) {
                setFlash(req, 'error', 'Cuenta padre invÃ¡lida.');
                return res.redirect('/accounting/accounts');
              }
              return next(parentId);
            }
          );
        };

        const validateCategory = (next) => {
          if (!categoryId) return next(null, type);
          db.get(
            'SELECT id, type FROM accounting_categories WHERE id = ? AND company_id = ? LIMIT 1',
            [categoryId, companyId],
            (catErr, catRow) => {
              if (catErr || !catRow) {
                setFlash(req, 'error', 'CategorÃ­a invÃ¡lida.');
                return res.redirect('/accounting/accounts');
              }
              return next(categoryId, normalizeNifType(catRow.type) || type);
            }
          );
        };

        validateParent((resolvedParentId) => {
          validateCategory((resolvedCategoryId, resolvedType) => {
            finishInsert(resolvedParentId, resolvedCategoryId, resolvedType);
          });
        });
      }
    );
  });
});

app.post('/accounting/accounts/seed-niif', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  db.get('SELECT id FROM accounts WHERE company_id = ? LIMIT 1', [companyId], (err, row) => {
    if (err) {
      setFlash(req, 'error', 'No se pudo validar el catÃ¡logo.');
      return res.redirect('/accounting/accounts');
    }
    if (row) {
      setFlash(req, 'error', 'El catÃ¡logo ya tiene cuentas. No se puede cargar plantilla NIIF.');
      return res.redirect('/accounting/accounts');
    }
    seedNiifCatalog(companyId, () => {
      setFlash(req, 'success', 'Plantilla NIIF cargada.');
      return res.redirect('/accounting/accounts');
    });
  });
});

app.post('/accounting/accounts/auto-assign', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const framework = normalizeFramework(req.body.framework);
  autoAssignAccountCategoriesWithRules({ companyId, framework }, (result) => {
    setFlash(
      req,
      'success',
      `CategorÃ­as asignadas automÃ¡ticamente: ${result.updated}. Sin cambios: ${result.skipped}.`
    );
    return res.redirect('/accounting/accounts');
  });
});

app.get('/accounting/accounts/auto-assign/preview', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(req.query.framework || company.accounting_framework);
    buildAutoAssignPlan({ companyId, framework }, (plan) => {
      db.all(
        `SELECT batch_id, created_at, created_by, COUNT(*) AS total
         FROM accounting_category_assignments_history
         WHERE company_id = ?
         GROUP BY batch_id
         ORDER BY created_at DESC
         LIMIT 10`,
        [companyId],
        (err, batches) => {
          res.render('accounting-accounts-auto-assign', {
            framework: plan.framework,
            plan: plan.items,
            batches: err ? [] : batches,
            flash: res.locals.flash
          });
        }
      );
    });
  });
});

app.get('/accounting/accounts/auto-assign/preview/export', requireAuth, requirePermission('accounting', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const framework = normalizeFramework(req.query.framework || company.accounting_framework);
    const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
    buildAutoAssignPlan({ companyId, framework }, (plan) => {
      const data = plan.items.map((item) => ({
        cuenta: `${item.account.code} - ${item.account.name}`,
        tipo: item.account.type,
        actual: item.account.category_id ? 'Asignada' : 'Sin categorÃ­a',
        sugerida: item.newCategory ? `${item.newCategory.code} - ${item.newCategory.name}` : '',
        estado: item.account.category_id ? 'Sin cambios' : (item.newCategory ? 'Asignable' : 'Sin regla')
      }));
      if (format === 'pdf') {
        const table = [
          ['Cuenta', 'Tipo', 'Actual', 'Sugerida', 'Estado'],
          ...data.map((d) => [d.cuenta, d.tipo, d.actual, d.sugerida, d.estado])
        ];
        return renderSimplePdf(res, 'PrevisualizaciÃ³n autoasignaciÃ³n', table);
      }
      const sheet = XLSX.utils.json_to_sheet(data);
      return sendExcel(res, 'previsualizacion-categorias.xlsx', [{ name: 'Preview', data: sheet }]);
    });
  });
});

app.post('/accounting/accounts/auto-assign/apply', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const framework = normalizeFramework(req.body.framework);
  const userId = req.session && req.session.user ? req.session.user.id : null;
  buildAutoAssignPlan({ companyId, framework }, (plan) => {
    const toApply = plan.items.filter(
      (item) => !item.account.category_id && item.newCategoryId
    );
    if (!toApply.length) {
      setFlash(req, 'info', 'No hay cuentas pendientes de asignaciÃ³n.');
      return res.redirect(`/accounting/accounts/auto-assign/preview?framework=${framework}`);
    }
    const batchId = `CAT-${Date.now()}`;
    enqueueDbTransaction((finish) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        const historyStmt = db.prepare(
          `INSERT INTO accounting_category_assignments_history
           (batch_id, company_id, account_id, previous_category_id, new_category_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        const updateStmt = db.prepare('UPDATE accounts SET category_id = ? WHERE id = ?');
        let hadError = false;
        toApply.forEach((item) => {
          historyStmt.run(
            batchId,
            companyId,
            item.account.id,
            item.account.category_id || null,
            item.newCategoryId,
            userId
          );
          updateStmt.run(item.newCategoryId, item.account.id, (err) => {
            if (err) hadError = true;
          });
        });
        historyStmt.finalize((histErr) => {
          updateStmt.finalize((updErr) => {
            if (histErr || updErr || hadError) {
              rollbackTransaction(finish);
              setFlash(req, 'error', 'No se pudo aplicar la asignaciÃ³n.');
              return res.redirect(`/accounting/accounts/auto-assign/preview?framework=${framework}`);
            }
            commitTransaction(finish, () => {
              logAction(userId, 'accounting_categories_auto_assign', JSON.stringify({ batchId, framework, count: toApply.length }), companyId);
              setFlash(req, 'success', `AsignaciÃ³n aplicada. Lote: ${batchId}.`);
              return res.redirect(`/accounting/accounts/auto-assign/preview?framework=${framework}`);
            });
          });
        });
      });
    });
  });
});

app.post('/accounting/accounts/auto-assign/revert', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const batchId = String(req.body.batch_id || '').trim();
  const userId = req.session && req.session.user ? req.session.user.id : null;
  if (!batchId) {
    setFlash(req, 'error', 'Lote invÃ¡lido.');
    return res.redirect('/accounting/accounts/auto-assign/preview');
  }
  db.all(
    `SELECT account_id, previous_category_id
     FROM accounting_category_assignments_history
     WHERE company_id = ? AND batch_id = ?`,
    [companyId, batchId],
    (err, rows) => {
      if (err || !rows || !rows.length) {
        setFlash(req, 'error', 'No se encontrÃ³ el lote.');
        return res.redirect('/accounting/accounts/auto-assign/preview');
      }
      enqueueDbTransaction((finish) => {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare('UPDATE accounts SET category_id = ? WHERE id = ?');
          let hadError = false;
          rows.forEach((row) => {
            stmt.run(row.previous_category_id || null, row.account_id, (updErr) => {
              if (updErr) hadError = true;
            });
          });
          stmt.finalize((finalErr) => {
            if (finalErr || hadError) {
              rollbackTransaction(finish);
              setFlash(req, 'error', 'No se pudo revertir el lote.');
              return res.redirect('/accounting/accounts/auto-assign/preview');
            }
            commitTransaction(finish, () => {
              logAction(userId, 'accounting_categories_auto_revert', JSON.stringify({ batchId }), companyId);
              setFlash(req, 'success', `Lote revertido: ${batchId}.`);
              return res.redirect('/accounting/accounts/auto-assign/preview');
            });
          });
        });
      });
    }
  );
});

app.get('/accounting/accounts/auto-assign/batch', requireAuth, requirePermission('accounting', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const batchId = String(req.query.batch_id || '').trim();
  if (!batchId) return res.redirect('/accounting/accounts/auto-assign/preview');
  db.all(
    `SELECT h.batch_id, h.created_at, u.username,
            a.code AS account_code, a.name AS account_name,
            c1.code AS prev_code, c1.name AS prev_name,
            c2.code AS new_code, c2.name AS new_name
     FROM accounting_category_assignments_history h
     LEFT JOIN accounts a ON a.id = h.account_id
     LEFT JOIN accounting_categories c1 ON c1.id = h.previous_category_id
     LEFT JOIN accounting_categories c2 ON c2.id = h.new_category_id
     LEFT JOIN users u ON u.id = h.created_by
     WHERE h.company_id = ? AND h.batch_id = ?
     ORDER BY h.id`,
    [companyId, batchId],
    (err, rows) => {
      const mapped = (rows || []).map((row) => ({
        account_code: row.account_code,
        account_name: row.account_name,
        prev_category: row.prev_code ? `${row.prev_code} - ${row.prev_name}` : null,
        new_category: row.new_code ? `${row.new_code} - ${row.new_name}` : null,
        username: row.username,
        created_at: row.created_at
      }));
      res.render('accounting-accounts-auto-assign-batch', {
        batchId,
        rows: err ? [] : mapped
      });
    }
  );
});

app.get('/accounting/accounts/auto-assign/batch/export', requireAuth, requirePermission('accounting', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const batchId = String(req.query.batch_id || '').trim();
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  if (!batchId) return res.redirect('/accounting/accounts/auto-assign/preview');
  db.all(
    `SELECT h.batch_id, h.created_at, u.username,
            a.code AS account_code, a.name AS account_name,
            c1.code AS prev_code, c1.name AS prev_name,
            c2.code AS new_code, c2.name AS new_name
     FROM accounting_category_assignments_history h
     LEFT JOIN accounts a ON a.id = h.account_id
     LEFT JOIN accounting_categories c1 ON c1.id = h.previous_category_id
     LEFT JOIN accounting_categories c2 ON c2.id = h.new_category_id
     LEFT JOIN users u ON u.id = h.created_by
     WHERE h.company_id = ? AND h.batch_id = ?
     ORDER BY h.id`,
    [companyId, batchId],
    (err, rows) => {
      const data = (rows || []).map((row) => ({
        cuenta: `${row.account_code} - ${row.account_name}`,
        anterior: row.prev_code ? `${row.prev_code} - ${row.prev_name}` : '',
        nuevo: row.new_code ? `${row.new_code} - ${row.new_name}` : '',
        usuario: row.username || '',
        fecha: row.created_at
      }));
      if (format === 'pdf') {
        const table = [
          ['Cuenta', 'Anterior', 'Nuevo', 'Usuario', 'Fecha'],
          ...data.map((d) => [d.cuenta, d.anterior, d.nuevo, d.usuario, d.fecha])
        ];
        return renderSimplePdf(res, `Detalle lote ${batchId}`, table);
      }
      const sheet = XLSX.utils.json_to_sheet(data);
      return sendExcel(res, `lote-${batchId}.xlsx`, [{ name: 'Lote', data: sheet }]);
    }
  );
});

app.get('/accounting/journal', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    db.all(
      `SELECT je.id, je.entry_date, je.description, je.memo, je.status, je.currency, je.exchange_rate,
              u.username AS user_name,
              COALESCE(SUM(jd.debit_base), 0) AS debit_base,
              COALESCE(SUM(jd.credit_base), 0) AS credit_base
       FROM journal_entries je
       LEFT JOIN users u ON u.id = je.user_id
       LEFT JOIN journal_details jd ON jd.entry_id = je.id AND jd.company_id = je.company_id
       WHERE je.company_id = ?
       GROUP BY je.id
       ORDER BY je.entry_date DESC, je.id DESC`,
      [companyId],
      (err, rows) => {
        res.render('accounting-journal', {
          entries: err ? [] : rows,
          baseCurrency,
          flash: res.locals.flash,
          active: 'journal'
        });
      }
    );
  });
});

app.get('/accounting/journal/new', requireAuth, requirePermission('accounting', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    const allowedCurrencies = company ? company.allowed_currencies : [baseCurrency];
    fetchNifAccounts(companyId, company.accounting_framework, (accounts) => {
      res.render('accounting-journal-new', {
        accounts,
        baseCurrency,
        allowedCurrencies,
        taxRate: company && company.tax_rate != null ? company.tax_rate : 0,
        flash: res.locals.flash,
        active: 'journal'
      });
    });
  });
});

app.post('/accounting/journal/create', requireAuth, requirePermission('accounting', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const entryDate = req.body.entry_date || null;
  const description = (req.body.description || '').trim();
  const memo = (req.body.memo || '').trim();
  const userId = req.session && req.session.user ? req.session.user.id : null;
  const lines = parseJournalLines(req.body);
  const validation = validateJournalLines(lines);
  const currency = String(req.body.currency || '').trim().toUpperCase();
  const exchangeRateInput = Number(req.body.exchange_rate || 0);
  const applyTax = req.body.apply_tax ? 1 : 0;
  const taxType = req.body.tax_type === 'purchase' ? 'purchase' : 'sale';
  const taxRate = Number(req.body.tax_rate || 0);

  if (!entryDate || !description) {
    setFlash(req, 'error', 'La pÃ³liza requiere fecha y descripciÃ³n.');
    return res.redirect('/accounting/journal/new');
  }
  if (lines.length < 2) {
    setFlash(req, 'error', 'Agrega al menos dos movimientos.');
    return res.redirect('/accounting/journal/new');
  }
  if (!validation.isBalanced) {
    setFlash(req, 'error', 'La pÃ³liza no cuadra. Verifica debe y haber.');
    return res.redirect('/accounting/journal/new');
  }

  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    const allowedCurrencies = company ? company.allowed_currencies : [baseCurrency];
    const resolvedCurrency = allowedCurrencies.includes(currency) ? currency : baseCurrency;
    const exchangeRate = resolvedCurrency === baseCurrency ? 1 : exchangeRateInput;

    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      setFlash(req, 'error', 'Tipo de cambio invÃ¡lido.');
      return res.redirect('/accounting/journal/new');
    }

    let workingLines = [...lines];
    let resolvedTaxAmount = 0;

    if (applyTax && taxRate > 0) {
      resolvedTaxAmount = Number((validation.totals.debit * (taxRate / 100)).toFixed(2));
      if (resolvedTaxAmount > 0) {
        if (taxType === 'sale') {
          const debitIndex = workingLines.findIndex((line) => Number(line.debit || 0) > 0);
          if (debitIndex === -1) {
            setFlash(req, 'error', 'No hay un movimiento de debe para aplicar IVA.');
            return res.redirect('/accounting/journal/new');
          }
          workingLines[debitIndex].debit = Number(workingLines[debitIndex].debit || 0) + resolvedTaxAmount;
          if (!company || !company.tax_payable_account_id) {
            setFlash(req, 'error', 'Configura la cuenta de IVA trasladado en Contabilidad.');
            return res.redirect('/accounting/journal/new');
          }
          workingLines.push({
            account_id: Number(company.tax_payable_account_id),
            debit: 0,
            credit: resolvedTaxAmount,
            line_memo: 'IVA trasladado'
          });
        } else {
          const creditIndex = workingLines.findIndex((line) => Number(line.credit || 0) > 0);
          if (creditIndex === -1) {
            setFlash(req, 'error', 'No hay un movimiento de haber para aplicar IVA.');
            return res.redirect('/accounting/journal/new');
          }
          workingLines[creditIndex].credit = Number(workingLines[creditIndex].credit || 0) + resolvedTaxAmount;
          if (!company || !company.tax_credit_account_id) {
            setFlash(req, 'error', 'Configura la cuenta de IVA acreditable en Contabilidad.');
            return res.redirect('/accounting/journal/new');
          }
          workingLines.push({
            account_id: Number(company.tax_credit_account_id),
            debit: resolvedTaxAmount,
            credit: 0,
            line_memo: 'IVA acreditable'
          });
        }
      }
    }

    const revalidation = validateJournalLines(workingLines);
    if (!revalidation.isBalanced) {
      setFlash(req, 'error', 'La pÃ³liza con IVA no cuadra. Ajusta los montos.');
      return res.redirect('/accounting/journal/new');
    }

    const accountIds = [...new Set(workingLines.map((line) => line.account_id))];
    if (!accountIds.length) {
      setFlash(req, 'error', 'Selecciona cuentas vÃ¡lidas.');
      return res.redirect('/accounting/journal/new');
    }

    const placeholders = accountIds.map(() => '?').join(',');
    db.all(
      `SELECT id FROM accounts WHERE company_id = ? AND id IN (${placeholders})`,
      [companyId, ...accountIds],
      (accErr, accRows) => {
        if (accErr || !accRows || accRows.length !== accountIds.length) {
          setFlash(req, 'error', 'Una o mÃ¡s cuentas no son vÃ¡lidas.');
          return res.redirect('/accounting/journal/new');
        }

        enqueueDbTransaction((finish) => {
          db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            db.run(
              `INSERT INTO journal_entries (company_id, entry_date, description, user_id, memo, currency, exchange_rate, tax_rate, tax_amount, tax_type, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted')`,
              [
                companyId,
                entryDate,
                description,
                userId,
                memo || null,
                resolvedCurrency,
                exchangeRate,
                applyTax ? taxRate : null,
                applyTax ? resolvedTaxAmount : null,
                applyTax ? taxType : null
              ],
              function (entryErr) {
                if (entryErr) {
                  rollbackTransaction(finish);
                  setFlash(req, 'error', 'No se pudo guardar la pÃ³liza.');
                  return res.redirect('/accounting/journal/new');
                }

                const entryId = this.lastID;
                const stmt = db.prepare(
                  `INSERT INTO journal_details (entry_id, company_id, account_id, line_memo, debit, credit, currency, exchange_rate, debit_base, credit_base)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                );
                let lineError = null;
                workingLines.forEach((line) => {
                  const debit = Number(line.debit || 0);
                  const credit = Number(line.credit || 0);
                  stmt.run(
                    entryId,
                    companyId,
                    line.account_id,
                    line.line_memo || null,
                    debit,
                    credit,
                    resolvedCurrency,
                    exchangeRate,
                    debit * exchangeRate,
                    credit * exchangeRate,
                    (err) => {
                      if (err) lineError = err;
                    }
                  );
                });
                stmt.finalize((finalErr) => {
                  if (finalErr || lineError) {
                    rollbackTransaction(finish);
                    setFlash(req, 'error', 'No se pudo guardar el detalle de la pÃ³liza.');
                    return res.redirect('/accounting/journal/new');
                  }
                  commitTransaction(finish, () => {
                    logAction(userId, 'accounting_journal_created', JSON.stringify({ entryId }), companyId);
                    setFlash(req, 'success', 'PÃ³liza registrada correctamente.');
                    return res.redirect(`/accounting/journal/${entryId}`);
                  });
                });
              }
            );
          });
        });
      }
    );
  });
});

app.get('/accounting/journal/:id', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const entryId = Number(req.params.id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return res.redirect('/accounting/journal');
  }
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    db.get(
      `SELECT je.id, je.entry_date, je.description, je.memo, je.status, je.currency, je.exchange_rate, je.tax_rate, je.tax_amount, je.tax_type,
              u.username AS user_name
       FROM journal_entries je
       LEFT JOIN users u ON u.id = je.user_id
       WHERE je.company_id = ? AND je.id = ?`,
      [companyId, entryId],
      (err, entry) => {
        if (err || !entry) return res.redirect('/accounting/journal');
        db.all(
          `SELECT jd.id, jd.debit, jd.credit, jd.debit_base, jd.credit_base, jd.line_memo,
                  a.code AS account_code, a.name AS account_name
           FROM journal_details jd
           LEFT JOIN accounts a ON a.id = jd.account_id
           WHERE jd.company_id = ? AND jd.entry_id = ?
           ORDER BY jd.id`,
          [companyId, entryId],
          (lineErr, lines) => {
            res.render('accounting-journal-detail', {
              entry,
              lines: lineErr ? [] : lines,
              baseCurrency,
              flash: res.locals.flash,
              active: 'journal'
            });
          }
        );
      }
    );
  });
});

app.get('/accounting/receivables', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    db.all(
      `SELECT invoices.id, invoices.created_at, invoices.total, invoices.currency, invoices.total_base,
              customers.name AS customer_name,
              customers.customer_code AS customer_code,
              COALESCE(SUM(invoice_payments.amount_base), 0) AS paid_base
       FROM invoices
       LEFT JOIN customers ON invoices.customer_id = customers.id AND customers.company_id = ?
       LEFT JOIN invoice_payments ON invoice_payments.invoice_id = invoices.id AND invoice_payments.company_id = ?
       WHERE invoices.company_id = ?
       GROUP BY invoices.id
       HAVING (invoices.total_base - paid_base) > 0.01
       ORDER BY invoices.created_at DESC`,
      [companyId, companyId, companyId],
      (err, rows) => {
        res.render('accounting-receivables', {
          rows: err ? [] : rows,
          baseCurrency
        });
      }
    );
  });
});

app.get('/accounting/payables', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    db.all(
      `SELECT bills.id, bills.created_at, bills.total, bills.currency, bills.total_base,
              bills.vendor_name,
              COALESCE(SUM(bill_payments.amount_base), 0) AS paid_base
       FROM bills
       LEFT JOIN bill_payments ON bill_payments.bill_id = bills.id AND bill_payments.company_id = ?
       WHERE bills.company_id = ?
       GROUP BY bills.id
       HAVING (bills.total_base - paid_base) > 0.01
       ORDER BY bills.created_at DESC`,
      [companyId, companyId],
      (err, rows) => {
        res.render('accounting-payables', {
          rows: err ? [] : rows,
          baseCurrency
        });
      }
    );
  });
});

app.get('/accounting/reports', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    fetchNifTrialBalance(companyId, { framework: company.accounting_framework }, (balances) => {
      const summary = computeNifFinancials(balances);
      res.render('accounting-reports', {
        balances,
        totals: summary.totals,
        baseCurrency,
        flash: res.locals.flash,
        active: 'reports'
      });
    });
  });
});

app.get('/accounting/reports/diario', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    fetchNifDiary(companyId, { startDate, endDate }, (rows) => {
      const entries = [];
      const byEntry = new Map();
      rows.forEach((row) => {
        if (!byEntry.has(row.entry_id)) {
          const entry = {
            id: row.entry_id,
            entry_date: row.entry_date,
            description: row.description || row.memo,
            user_name: row.user_name,
            lines: []
          };
          byEntry.set(row.entry_id, entry);
          entries.push(entry);
        }
        if (row.line_id) {
          byEntry.get(row.entry_id).lines.push({
            account_code: row.account_code,
            account_name: row.account_name,
            debit: Number(row.debit || 0),
            credit: Number(row.credit || 0),
            line_memo: row.line_memo
          });
        }
      });
      res.render('accounting-diary', {
        entries,
        baseCurrency,
        startDate,
        endDate,
        active: 'reports'
      });
    });
  });
});

app.get('/accounting/reports/diario/export', requireAuth, requirePermission('accounting', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  fetchNifDiary(companyId, { startDate, endDate }, (rows) => {
    const data = rows.map((row) => ({
      fecha: row.entry_date,
      poliza: row.entry_id,
      descripcion: row.description || row.memo || '',
      cuenta: `${row.account_code || ''} ${row.account_name || ''}`.trim(),
      debe: Number(row.debit || 0),
      haber: Number(row.credit || 0),
      detalle: row.line_memo || ''
    }));
    if (format === 'pdf') {
      const table = [
        ['Fecha', 'PÃ³liza', 'DescripciÃ³n', 'Cuenta', 'Debe', 'Haber', 'Detalle'],
        ...data.map((d) => [
          d.fecha || '',
          String(d.poliza || ''),
          d.descripcion,
          d.cuenta,
          d.debe.toFixed(2),
          d.haber.toFixed(2),
          d.detalle
        ])
      ];
      return renderSimplePdf(res, 'Libro diario', table);
    }
    const sheet = XLSX.utils.json_to_sheet(data);
    return sendExcel(res, 'libro-diario.xlsx', [{ name: 'Diario', data: sheet }]);
  });
});

app.get('/accounting/reports/mayor', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    fetchNifLedger(companyId, { startDate, endDate }, (rows) => {
      const ledger = [];
      const byAccount = new Map();
      rows.forEach((row) => {
        if (!byAccount.has(row.account_id)) {
          const account = {
            id: row.account_id,
            code: row.code,
            name: row.name,
            type: row.type,
            lines: []
          };
          byAccount.set(row.account_id, account);
          ledger.push(account);
        }
        if (row.entry_date) {
          byAccount.get(row.account_id).lines.push({
            entry_date: row.entry_date,
            description: row.description,
            debit: Number(row.debit || 0),
            credit: Number(row.credit || 0),
            line_memo: row.line_memo
          });
        }
      });
      res.render('accounting-ledger', {
        ledger,
        baseCurrency,
        startDate,
        endDate,
        active: 'reports'
      });
    });
  });
});

app.get('/accounting/reports/mayor/export', requireAuth, requirePermission('accounting', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  fetchNifLedger(companyId, { startDate, endDate }, (rows) => {
    const data = rows.map((row) => ({
      cuenta: `${row.code || ''} ${row.name || ''}`.trim(),
      fecha: row.entry_date || '',
      descripcion: row.description || row.line_memo || '',
      debe: Number(row.debit || 0),
      haber: Number(row.credit || 0)
    }));
    if (format === 'pdf') {
      const table = [
        ['Cuenta', 'Fecha', 'DescripciÃ³n', 'Debe', 'Haber'],
        ...data.map((d) => [
          d.cuenta,
          d.fecha,
          d.descripcion,
          d.debe.toFixed(2),
          d.haber.toFixed(2)
        ])
      ];
      return renderSimplePdf(res, 'Libro mayor', table);
    }
    const sheet = XLSX.utils.json_to_sheet(data);
    return sendExcel(res, 'libro-mayor.xlsx', [{ name: 'Mayor', data: sheet }]);
  });
});

app.get('/accounting/reports/balance', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    fetchNifTrialBalance(companyId, { startDate, endDate, framework: company.accounting_framework }, (balances) => {
      res.render('accounting-trial-balance', {
        balances,
        baseCurrency,
        startDate,
        endDate,
        active: 'reports'
      });
    });
  });
});

app.get('/accounting/reports/balance/export', requireAuth, requirePermission('accounting', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  getCompanySettings(companyId, (company) => {
    fetchNifTrialBalance(companyId, { startDate, endDate, framework: company.accounting_framework }, (balances) => {
      const data = balances.map((row) => ({
        codigo: row.code,
        nombre: row.name,
        debe: Number(row.debit || 0),
        haber: Number(row.credit || 0),
        balance: Number(row.balance || 0)
      }));
      if (format === 'pdf') {
        const table = [
          ['CÃ³digo', 'Nombre', 'Debe', 'Haber', 'Balance'],
          ...data.map((d) => [
            d.codigo,
            d.nombre,
            d.debe.toFixed(2),
            d.haber.toFixed(2),
            d.balance.toFixed(2)
          ])
        ];
        return renderSimplePdf(res, 'Balance de comprobaciÃ³n', table);
      }
      const sheet = XLSX.utils.json_to_sheet(data);
      return sendExcel(res, 'balance-comprobacion.xlsx', [{ name: 'Balance', data: sheet }]);
    });
  });
});

app.get('/accounting/financials', requireAuth, requirePermission('accounting', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  getCompanySettings(companyId, (company) => {
    const baseCurrency = company ? company.base_currency : 'GTQ';
    fetchNifTrialBalance(companyId, { startDate, endDate, framework: company.accounting_framework }, (balances) => {
      const summary = computeNifFinancials(balances);
      const framework = normalizeFramework(company && company.accounting_framework);
      fetchAccountingCategories(companyId, framework, (categories) => {
        const categoryTotals = computeCategoryTotals({ balances, categories });
        res.render('accounting-financials', {
          totals: summary.totals,
          flujoEfectivo: summary.flujo_efectivo,
          categoryTotals,
          baseCurrency,
          startDate,
          endDate,
          active: 'reports'
        });
      });
    });
  });
});

app.get('/accounting/financials/export', requireAuth, requirePermission('accounting', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  getCompanySettings(companyId, (company) => {
    fetchNifTrialBalance(companyId, { startDate, endDate, framework: company.accounting_framework }, (balances) => {
      const summary = computeNifFinancials(balances);
      const data = [
        { concepto: 'Activos', monto: summary.totals.activos },
        { concepto: 'Pasivos', monto: summary.totals.pasivos },
        { concepto: 'Capital', monto: summary.totals.capital },
        { concepto: 'Ingresos', monto: summary.totals.ingresos },
        { concepto: 'Gastos', monto: summary.totals.gastos },
        { concepto: 'Utilidad neta', monto: summary.totals.utilidad_neta },
        { concepto: 'Cuadre', monto: summary.totals.balance_cuadre },
        { concepto: 'Flujo de efectivo', monto: summary.flujo_efectivo }
      ];
      if (format === 'pdf') {
        const table = [
          ['Concepto', 'Monto'],
          ...data.map((d) => [d.concepto, Number(d.monto || 0).toFixed(2)])
        ];
        return renderSimplePdf(res, 'Estados financieros', table);
      }
      const sheet = XLSX.utils.json_to_sheet(data);
      return sendExcel(res, 'estados-financieros.xlsx', [{ name: 'Financieros', data: sheet }]);
    });
  });
});

  }
}
module.exports = {
  registerAccountingRoutes
};
