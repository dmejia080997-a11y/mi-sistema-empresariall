function registerInvoiceRoutes(app, deps) {
  const scope = { app, ...deps };
  with (scope) {
app.get('/invoices', requireAuth, requirePermission('billing', 'view'), (req, res) => {
  renderInvoices(req, res, null);
});

app.get('/invoices/:id', requireAuth, requirePermission('billing', 'view'), (req, res) => {
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
  db.get(
      `SELECT invoices.id, invoices.subtotal, invoices.tax_rate, invoices.tax_amount,
              invoices.discount_type, invoices.discount_value, invoices.discount_amount,
              invoices.total, invoices.created_at, invoices.currency, invoices.exchange_rate, invoices.subtotal_base, invoices.tax_amount_base, invoices.discount_amount_base, invoices.total_base,
              customers.name AS customer_name, customers.customer_code AS customer_code, customers.phone, customers.email,
              COALESCE(customers.full_address, customers.address) AS address
       FROM invoices
       LEFT JOIN customers ON invoices.customer_id = customers.id AND customers.company_id = ?
       WHERE invoices.id = ? AND invoices.company_id = ?`,
    [companyId, id, companyId],
    (invErr, invoice) => {
      if (invErr || !invoice) {
        return res.redirect('/invoices');
      }
      db.all(
        `SELECT invoice_items.qty, invoice_items.unit_price, invoice_items.line_total,
                items.name AS item_name, items.sku
         FROM invoice_items
         LEFT JOIN items ON invoice_items.item_id = items.id AND items.company_id = ?
         WHERE invoice_items.invoice_id = ? AND invoice_items.company_id = ?
         ORDER BY invoice_items.id ASC`,
        [companyId, id, companyId],
        (itemsErr, rows) => {
          const lineItems = itemsErr ? [] : rows;
          res.render('invoice-detail', { invoice, lineItems });
        }
      );
    }
  );
});

app.post('/invoices/create', requireAuth, requirePermission('billing', 'create'), (req, res) => {
  const customerIdRaw = req.body.customer_id;
  const customerId = customerIdRaw ? Number(customerIdRaw) : null;
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
  const taxRate = Number(req.body.tax_rate || companySettings.tax_rate || 0);
  const discountType = req.body.discount_type === 'percent' ? 'percent' : 'amount';
  const discountValue = Number(req.body.discount_value || 0);

  const itemIdsRaw = req.body.item_id || [];
  const qtysRaw = req.body.qty || [];
  const unitPricesRaw = req.body.unit_price || [];
  const itemIds = Array.isArray(itemIdsRaw) ? itemIdsRaw : [itemIdsRaw];
  const qtys = Array.isArray(qtysRaw) ? qtysRaw : [qtysRaw];
  const unitPrices = Array.isArray(unitPricesRaw) ? unitPricesRaw : [unitPricesRaw];

  const rows = itemIds.map((rawId, index) => {
    const itemId = Number(rawId);
    const qty = Number(qtys[index] || 0);
    const unitPrice = Number(unitPrices[index] || 0);
    if (!Number.isInteger(itemId) || itemId <= 0 || qty <= 0) {
      return null;
    }
    return { itemId, qty, unitPrice };
  }).filter(Boolean);

  if (rows.length === 0) {
    return renderInvoices(req, res, res.locals.t('errors.invoice_min_one_item'));
  }

  const resolveCustomer = (callback) => {
    if (!customerId || !Number.isInteger(customerId) || customerId <= 0) {
      return callback(null);
    }
    getCustomerStatusById(customerId, companyId, (custErr, status) => {
      if (custErr || !status || !status.ok) {
        if (status && status.reason === 'voided') {
          return callback({ blocked: true });
        }
        return callback(null);
      }
      return callback(status.id);
    });
  };

  resolveCustomer((resolvedCustomerId) => {
    if (resolvedCustomerId && resolvedCustomerId.blocked) {
      return renderInvoices(req, res, res.locals.t('errors.customer_voided_not_allowed'));
    }
    enqueueDbTransaction((finish) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

      const fetchItems = (index, acc) => {
        if (index >= rows.length) {
          return finalizeInvoice(acc);
        }
        const row = rows[index];
        db.get('SELECT id, name, price FROM items WHERE id = ? AND company_id = ?', [row.itemId, companyId], (err, item) => {
          if (err || !item) {
            return rollbackTransaction(finish, () =>
              renderInvoices(req, res, res.locals.t('errors.invoice_invalid_product'))
            );
          }
          const priceFromItem = Number(item.price || 0);
          const priceToUse = Number.isFinite(row.unitPrice) && row.unitPrice > 0 ? row.unitPrice : priceFromItem;
          acc.push({
            itemId: item.id,
            name: item.name,
            qty: row.qty,
            unitPrice: priceToUse,
            lineTotal: priceToUse * row.qty
          });
          return fetchItems(index + 1, acc);
        });
      };

      const finalizeInvoice = (lineItems) => {
        const subtotal = lineItems.reduce((sum, li) => sum + li.lineTotal, 0);
        const safeTaxRate = Number.isFinite(taxRate) ? taxRate : 12;
        const safeDiscountValue = Number.isFinite(discountValue) ? discountValue : 0;
        const taxAmount = subtotal * (safeTaxRate / 100);
        const discountAmount =
          discountType === 'percent'
            ? subtotal * (safeDiscountValue / 100)
            : safeDiscountValue;
        const total = Math.max(0, subtotal + taxAmount - discountAmount);

        const subtotalBase = subtotal * exchangeRate;
        const taxAmountBase = taxAmount * exchangeRate;
        const discountAmountBase = discountAmount * exchangeRate;
        const totalBase = total * exchangeRate;

        db.run(
          `INSERT INTO invoices
           (customer_id, subtotal, tax_rate, tax_amount, discount_type, discount_value, discount_amount, total, company_id, currency, exchange_rate, subtotal_base, tax_amount_base, discount_amount_base, total_base)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            resolvedCustomerId || null,
            subtotal,
            safeTaxRate,
            taxAmount,
            discountType,
            safeDiscountValue,
            discountAmount,
            total,
            companyId,
            currency,
            exchangeRate,
            subtotalBase,
            taxAmountBase,
            discountAmountBase,
            totalBase
          ],
          function (invErr) {
            if (invErr) {
              return rollbackTransaction(finish, () =>
                renderInvoices(req, res, res.locals.t('errors.invoice_create_failed'))
              );
            }
            const invoiceId = this.lastID;

            const insertLine = (lineIndex) => {
              if (lineIndex >= lineItems.length) {
                return commitTransaction(finish, () => {
                  logAction(
                    req.session.user.id,
                    'invoice_created',
                    JSON.stringify({ id: invoiceId, total }),
                    companyId
                  );
                  return res.redirect(`/invoices/${invoiceId}`);
                });
              }
              const li = lineItems[lineIndex];
              db.run(
                `INSERT INTO invoice_items (invoice_id, item_id, qty, unit_price, line_total, company_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [invoiceId, li.itemId, li.qty, li.unitPrice, li.lineTotal, companyId],
                (lineErr) => {
                  if (lineErr) {
                    return rollbackTransaction(finish, () =>
                      renderInvoices(req, res, res.locals.t('errors.invoice_item_create_failed'))
                    );
                  }
                  return insertLine(lineIndex + 1);
                }
              );
            };

            return insertLine(0);
          }
        );
      };

        fetchItems(0, []);
      });
    });
  });
});

  }
}

module.exports = {
  registerInvoiceRoutes
};
