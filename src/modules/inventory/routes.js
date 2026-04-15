function registerInventoryRoutes(app, deps) {
  const {
    db,
    parse,
    stringify,
    upload,
    csrfMiddleware,
    requireAuth,
    requirePermission,
    getCompanyId,
    normalizeString,
    renderInventory,
    renderCategories,
    renderBrands,
    resolveCategoryId,
    resolveBrandId,
    buildItemSku,
    inventoryRedirectPath,
    getOrCreateCategoryId,
    getOrCreateBrandId,
    generateUniqueSimpleCode,
    normalizeCode,
    codeFromName
  } = deps;
app.post('/inventory/add', requireAuth, requirePermission('inventory', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const name = normalizeString(req.body.name);
  const codeMode = normalizeString(req.body.code_mode) || 'auto';
  const itemCode = normalizeString(req.body.item_code);
  const qty = Number(req.body.qty || 0);
  const minStock = Number(req.body.min_stock || 0);
  const warehouseLocation = normalizeString(req.body.warehouse_location);
  const barcode = normalizeString(req.body.barcode);
  const price = Number(req.body.price || 0);

  if (!name) return renderInventory(req, res, res.locals.t('errors.item_required_fields'));

  resolveCategoryId(req.body.category_id, companyId, (catErr, categoryId) => {
    if (catErr || !categoryId) return renderInventory(req, res, res.locals.t('errors.category_lookup_failed'));
    resolveBrandId(req.body.brand_id, companyId, (brandErr, brandId) => {
      if (brandErr || !brandId) return renderInventory(req, res, res.locals.t('errors.brand_lookup_failed'));
      buildItemSku({
        name,
        categoryId,
        brandId,
        companyId,
        codeMode,
        itemCode,
        excludeId: null
      }, (skuErr, skuInfo) => {
        if (skuErr) {
          const msg = skuErr.message === 'SKU already exists'
            ? res.locals.t('errors.sku_exists')
            : skuErr.message === 'Item code required'
              ? res.locals.t('errors.item_code_required')
              : res.locals.t('errors.item_required_fields');
          return renderInventory(req, res, msg);
        }
        db.run(
          `INSERT INTO items
           (name, sku, item_code, code_manual, qty, min_stock, warehouse_location, barcode, price, category_id, brand_id, company_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            name,
            skuInfo.sku,
            skuInfo.itemCode,
            codeMode === 'manual' ? 1 : 0,
            Number.isFinite(qty) ? qty : 0,
            Number.isFinite(minStock) ? minStock : 0,
            warehouseLocation || null,
            barcode || null,
            Number.isFinite(price) ? price : 0,
            categoryId,
            brandId,
            companyId
          ],
          (insErr) => {
            if (insErr) return renderInventory(req, res, res.locals.t('errors.item_required_fields'));
            return res.redirect(inventoryRedirectPath(req));
          }
        );
      });
    });
  });
});

app.post('/inventory/:id/update', requireAuth, requirePermission('inventory', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.redirect(inventoryRedirectPath(req));
  const name = normalizeString(req.body.name);
  const codeMode = normalizeString(req.body.code_mode) || 'auto';
  const itemCode = normalizeString(req.body.item_code);
  const qty = Number(req.body.qty || 0);
  const minStock = Number(req.body.min_stock || 0);
  const warehouseLocation = normalizeString(req.body.warehouse_location);
  const barcode = normalizeString(req.body.barcode);
  const price = Number(req.body.price || 0);

  if (!name) return renderInventory(req, res, res.locals.t('errors.item_required_fields'));

  resolveCategoryId(req.body.category_id, companyId, (catErr, categoryId) => {
    if (catErr || !categoryId) return renderInventory(req, res, res.locals.t('errors.category_lookup_failed'));
    resolveBrandId(req.body.brand_id, companyId, (brandErr, brandId) => {
      if (brandErr || !brandId) return renderInventory(req, res, res.locals.t('errors.brand_lookup_failed'));
      buildItemSku({
        name,
        categoryId,
        brandId,
        companyId,
        codeMode,
        itemCode,
        excludeId: id
      }, (skuErr, skuInfo) => {
        if (skuErr) {
          const msg = skuErr.message === 'SKU already exists'
            ? res.locals.t('errors.sku_exists')
            : skuErr.message === 'Item code required'
              ? res.locals.t('errors.item_code_required')
              : res.locals.t('errors.item_required_fields');
          return renderInventory(req, res, msg);
        }
        db.run(
          `UPDATE items
           SET name = ?, sku = ?, item_code = ?, code_manual = ?, qty = ?, min_stock = ?, warehouse_location = ?, barcode = ?, price = ?, category_id = ?, brand_id = ?
           WHERE id = ? AND company_id = ?`,
          [
            name,
            skuInfo.sku,
            skuInfo.itemCode,
            codeMode === 'manual' ? 1 : 0,
            Number.isFinite(qty) ? qty : 0,
            Number.isFinite(minStock) ? minStock : 0,
            warehouseLocation || null,
            barcode || null,
            Number.isFinite(price) ? price : 0,
            categoryId,
            brandId,
            id,
            companyId
          ],
          (updErr) => {
            if (updErr) return renderInventory(req, res, res.locals.t('errors.item_required_fields'));
            return res.redirect(inventoryRedirectPath(req));
          }
        );
      });
    });
  });
});

app.post('/inventory/:id/delete', requireAuth, requirePermission('inventory', 'delete'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.redirect(inventoryRedirectPath(req));
  db.run('DELETE FROM items WHERE id = ? AND company_id = ?', [id, companyId], () => {
    return res.redirect(inventoryRedirectPath(req));
  });
});
app.post('/inventory/import', requireAuth, requirePermission('inventory', 'create'), upload.single('csv'), csrfMiddleware, (req, res) => {
  const companyId = getCompanyId(req);
  if (!req.file) return renderInventory(req, res, res.locals.t('errors.csv_required'));
  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return renderInventory(req, res, res.locals.t('errors.invalid_csv'));
  }
  if (!records || records.length === 0) return renderInventory(req, res, res.locals.t('errors.csv_empty'));

  const next = (index) => {
    if (index >= records.length) return res.redirect('/inventory');
    const row = records[index] || {};
    const name = normalizeString(row.name);
    const skuInput = normalizeString(row.sku);
    const qty = Number(row.qty || 0);
    const minStock = Number(row.min_stock || 0);
    const warehouseLocation = normalizeString(row.warehouse_location);
    const barcode = normalizeString(row.barcode);
    const price = Number(row.price || 0);
    const categoryName = normalizeString(row.category);
    const brandName = normalizeString(row.brand);

    if (!name || !categoryName || !brandName) return next(index + 1);

    getOrCreateCategoryId(categoryName, companyId, (catErr, categoryId) => {
      if (catErr || !categoryId) return next(index + 1);
      getOrCreateBrandId(brandName, companyId, (brandErr, brandId) => {
        if (brandErr || !brandId) return next(index + 1);

        const insertWithSku = (skuValue, itemCodeValue, manualMode) => {
          db.run(
            `INSERT INTO items
             (name, sku, item_code, code_manual, qty, min_stock, warehouse_location, barcode, price, category_id, brand_id, company_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              name,
              skuValue,
              itemCodeValue || null,
              manualMode ? 1 : 0,
              Number.isFinite(qty) ? qty : 0,
              Number.isFinite(minStock) ? minStock : 0,
              warehouseLocation || null,
              barcode || null,
              Number.isFinite(price) ? price : 0,
              categoryId,
              brandId,
              companyId
            ],
            () => next(index + 1)
          );
        };

        if (skuInput) {
          db.get('SELECT id FROM items WHERE sku = ? AND company_id = ?', [skuInput, companyId], (dupErr, dupRow) => {
            if (dupErr || dupRow) return next(index + 1);
            const parts = skuInput.split('-');
            const itemCodeValue = parts.length ? parts[parts.length - 1] : null;
            return insertWithSku(skuInput, itemCodeValue, true);
          });
          return;
        }

        buildItemSku({
          name,
          categoryId,
          brandId,
          companyId,
          codeMode: 'auto',
          itemCode: '',
          excludeId: null
        }, (skuErr, skuInfo) => {
          if (skuErr || !skuInfo) return next(index + 1);
          return insertWithSku(skuInfo.sku, skuInfo.itemCode, false);
        });
      });
    });
  };

  next(0);
});

app.get('/inventory/export', requireAuth, requirePermission('inventory', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  db.all(
    `SELECT items.name, items.sku, items.qty, items.min_stock, items.warehouse_location, items.barcode, items.price,
            categories.name AS category_name, brands.name AS brand_name
     FROM items
     LEFT JOIN categories ON items.category_id = categories.id AND categories.company_id = ?
     LEFT JOIN brands ON items.brand_id = brands.id AND brands.company_id = ?
     WHERE items.company_id = ?
     ORDER BY items.created_at DESC`,
    [companyId, companyId, companyId],
    (err, rows) => {
      if (err) return renderInventory(req, res, res.locals.t('errors.export_failed'));
      const csv = stringify(rows || [], {
        header: true,
        columns: [
          { key: 'name', header: 'name' },
          { key: 'sku', header: 'sku' },
          { key: 'qty', header: 'qty' },
          { key: 'min_stock', header: 'min_stock' },
          { key: 'warehouse_location', header: 'warehouse_location' },
          { key: 'barcode', header: 'barcode' },
          { key: 'price', header: 'price' },
          { key: 'category_name', header: 'category' },
          { key: 'brand_name', header: 'brand' }
        ]
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
      return res.send(csv);
    }
  );
});
app.get('/categories', requireAuth, requirePermission('inventory', 'view'), (req, res) => {
  renderCategories(req, res, null);
});

app.post('/categories/create', requireAuth, requirePermission('inventory', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const name = normalizeString(req.body.name);
  const codeMode = normalizeString(req.body.code_mode) || 'auto';
  const code = normalizeString(req.body.code);
  if (!name) return renderCategories(req, res, res.locals.t('errors.category_name_required'));

  const finalizeInsert = (finalCode, manual) => {
    db.run(
      'INSERT INTO categories (name, code, code_manual, company_id) VALUES (?, ?, ?, ?)',
      [name, finalCode || null, manual ? 1 : 0, companyId],
      (err) => {
        if (err) return renderCategories(req, res, res.locals.t('errors.category_create_failed'));
        return res.redirect('/categories');
      }
    );
  };

  if (codeMode === 'manual') {
    const normalized = normalizeCode(code);
    if (!normalized) return renderCategories(req, res, res.locals.t('errors.code_required'));
    db.get('SELECT id FROM categories WHERE code = ? AND company_id = ?', [normalized, companyId], (dupErr, dupRow) => {
      if (dupErr || dupRow) return renderCategories(req, res, res.locals.t('errors.code_duplicate'));
      return finalizeInsert(normalized, true);
    });
    return;
  }

  const base = codeFromName(name, 3);
  generateUniqueSimpleCode('categories', companyId, base, null, (err, generated) => {
    if (err) return renderCategories(req, res, res.locals.t('errors.category_create_failed'));
    return finalizeInsert(generated, false);
  });
});

app.post('/categories/:id/update', requireAuth, requirePermission('inventory', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const name = normalizeString(req.body.name);
  const codeMode = normalizeString(req.body.code_mode) || 'auto';
  const code = normalizeString(req.body.code);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/categories');
  if (!name) return renderCategories(req, res, res.locals.t('errors.category_name_required'));

  const finalizeUpdate = (finalCode, manual) => {
    db.run(
      'UPDATE categories SET name = ?, code = ?, code_manual = ? WHERE id = ? AND company_id = ?',
      [name, finalCode || null, manual ? 1 : 0, id, companyId],
      (err) => {
        if (err) return renderCategories(req, res, res.locals.t('errors.category_update_failed'));
        return res.redirect('/categories');
      }
    );
  };

  if (codeMode === 'manual') {
    const normalized = normalizeCode(code);
    if (!normalized) return renderCategories(req, res, res.locals.t('errors.code_required'));
    db.get(
      'SELECT id FROM categories WHERE code = ? AND company_id = ? AND id != ?',
      [normalized, companyId, id],
      (dupErr, dupRow) => {
        if (dupErr || dupRow) return renderCategories(req, res, res.locals.t('errors.code_duplicate'));
        return finalizeUpdate(normalized, true);
      }
    );
    return;
  }

  const base = codeFromName(name, 3);
  generateUniqueSimpleCode('categories', companyId, base, id, (err, generated) => {
    if (err) return renderCategories(req, res, res.locals.t('errors.category_update_failed'));
    return finalizeUpdate(generated, false);
  });
});

app.post('/categories/:id/delete', requireAuth, requirePermission('inventory', 'delete'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/categories');
  db.run('DELETE FROM categories WHERE id = ? AND company_id = ?', [id, companyId], (err) => {
    if (err) return renderCategories(req, res, res.locals.t('errors.category_delete_failed'));
    return res.redirect('/categories');
  });
});
app.get('/brands', requireAuth, requirePermission('inventory', 'view'), (req, res) => {
  renderBrands(req, res, null);
});

app.post('/brands/create', requireAuth, requirePermission('inventory', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const name = normalizeString(req.body.name);
  const codeMode = normalizeString(req.body.code_mode) || 'auto';
  const code = normalizeString(req.body.code);
  if (!name) return renderBrands(req, res, res.locals.t('errors.brand_name_required'));

  const finalizeInsert = (finalCode, manual) => {
    db.run(
      'INSERT INTO brands (name, code, code_manual, company_id) VALUES (?, ?, ?, ?)',
      [name, finalCode || null, manual ? 1 : 0, companyId],
      (err) => {
        if (err) return renderBrands(req, res, res.locals.t('errors.brand_create_failed'));
        return res.redirect('/brands');
      }
    );
  };

  if (codeMode === 'manual') {
    const normalized = normalizeCode(code);
    if (!normalized) return renderBrands(req, res, res.locals.t('errors.code_required'));
    db.get('SELECT id FROM brands WHERE code = ? AND company_id = ?', [normalized, companyId], (dupErr, dupRow) => {
      if (dupErr || dupRow) return renderBrands(req, res, res.locals.t('errors.code_duplicate'));
      return finalizeInsert(normalized, true);
    });
    return;
  }

  const base = codeFromName(name, 3);
  generateUniqueSimpleCode('brands', companyId, base, null, (err, generated) => {
    if (err) return renderBrands(req, res, res.locals.t('errors.brand_create_failed'));
    return finalizeInsert(generated, false);
  });
});

app.post('/brands/:id/update', requireAuth, requirePermission('inventory', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const name = normalizeString(req.body.name);
  const codeMode = normalizeString(req.body.code_mode) || 'auto';
  const code = normalizeString(req.body.code);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/brands');
  if (!name) return renderBrands(req, res, res.locals.t('errors.brand_name_required'));

  const finalizeUpdate = (finalCode, manual) => {
    db.run(
      'UPDATE brands SET name = ?, code = ?, code_manual = ? WHERE id = ? AND company_id = ?',
      [name, finalCode || null, manual ? 1 : 0, id, companyId],
      (err) => {
        if (err) return renderBrands(req, res, res.locals.t('errors.brand_update_failed'));
        return res.redirect('/brands');
      }
    );
  };

  if (codeMode === 'manual') {
    const normalized = normalizeCode(code);
    if (!normalized) return renderBrands(req, res, res.locals.t('errors.code_required'));
    db.get(
      'SELECT id FROM brands WHERE code = ? AND company_id = ? AND id != ?',
      [normalized, companyId, id],
      (dupErr, dupRow) => {
        if (dupErr || dupRow) return renderBrands(req, res, res.locals.t('errors.code_duplicate'));
        return finalizeUpdate(normalized, true);
      }
    );
    return;
  }

  const base = codeFromName(name, 3);
  generateUniqueSimpleCode('brands', companyId, base, id, (err, generated) => {
    if (err) return renderBrands(req, res, res.locals.t('errors.brand_update_failed'));
    return finalizeUpdate(generated, false);
  });
});

app.post('/brands/:id/delete', requireAuth, requirePermission('inventory', 'delete'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.redirect('/brands');
  db.run('DELETE FROM brands WHERE id = ? AND company_id = ?', [id, companyId], (err) => {
    if (err) return renderBrands(req, res, res.locals.t('errors.brand_delete_failed'));
    return res.redirect('/brands');
  });
});


}
module.exports = {
  registerInventoryRoutes
};
