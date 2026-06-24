const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

const INVOICE_STATUSES = {
  draft: { label: 'Borrador', badgeClass: 'invoice-status-draft', legacyStatus: 'draft' },
  pending_signature: { label: 'Pendiente de firma', badgeClass: 'invoice-status-pending-signature', legacyStatus: 'pending_signature' },
  issued: { label: 'Emitida', badgeClass: 'invoice-status-issued', legacyStatus: 'issued' },
  partially_paid: { label: 'Parcialmente pagada', badgeClass: 'invoice-status-partially-paid', legacyStatus: 'partially_paid' },
  paid: { label: 'Pagada', badgeClass: 'invoice-status-paid', legacyStatus: 'paid' },
  overdue: { label: 'Vencida', badgeClass: 'invoice-status-overdue', legacyStatus: 'issued' },
  voided: { label: 'Anulada', badgeClass: 'invoice-status-voided', legacyStatus: 'voided' }
};

const STATUS_FLOW = ['draft', 'pending_signature', 'issued', 'partially_paid', 'paid', 'voided'];
const PAYMENT_METHODS = ['Efectivo', 'Transferencia', 'Tarjeta', 'Cheque', 'Crédito', 'Depósito', 'Mixto'];
const INVOICE_DOCUMENT_TEXT = {
  es: {
    invoice: 'Factura',
    customer: 'Cliente',
    issueDate: 'Fecha de emision',
    dueDate: 'Fecha de vencimiento',
    invoiceDate: 'Fecha de emision',
    description: 'Descripcion',
    quantity: 'Cantidad',
    price: 'Precio',
    unitPrice: 'Precio unitario',
    lineNumber: 'No.',
    code: 'Codigo',
    subtotal: 'Subtotal',
    taxes: 'Impuestos',
    discounts: 'Descuentos',
    total: 'Total',
    grandTotal: 'Total general',
    notes: 'Observaciones',
    terms: 'Terminos',
    commercialNotes: 'Notas comerciales',
    paymentMethod: 'Metodo',
    status: 'Estado',
    summary: 'Resumen',
    fiscal: 'Fiscal',
    clientData: 'Datos del cliente',
    paid: 'Pagado',
    balanceDue: 'Saldo pendiente',
    noDate: 'Sin fecha',
    noDueDate: 'Sin fecha',
    noMethod: 'Sin definir',
    noNotes: 'Sin observaciones.',
    noContact: 'Sin contacto',
    noFiscalAddress: 'Sin direccion fiscal',
    address: 'Direccion',
    phone: 'Telefono',
    email: 'Correo',
    contact: 'Contacto',
    document: 'NIT / Documento',
    manualLine: 'Linea manual',
    inventoryLine: 'Inventario',
    packingList: 'Packing List',
    company: 'Empresa',
    date: 'Fecha',
    invoiceNumber: 'Numero de factura',
    sku: 'SKU',
    weight: 'Peso',
    dimensions: 'Medidas',
    observations: 'Observaciones',
    packageCount: 'Total de bultos',
    packageType: 'Tipo de empaque',
    packages: 'Bultos',
    unitWeight: 'Peso unitario',
    totalWeight: 'Peso total',
    volume: 'Volumen',
    authorizedSignature: 'Firma autorizada',
    seal: 'Sello',
    dimensionsUnit: 'Unidad de medida'
  },
  en: {
    invoice: 'Invoice',
    customer: 'Customer',
    issueDate: 'Issue Date',
    dueDate: 'Due Date',
    description: 'Description',
    quantity: 'Quantity',
    price: 'Price',
    unitPrice: 'Unit Price',
    lineNumber: 'No.',
    code: 'Code',
    subtotal: 'Subtotal',
    taxes: 'Taxes',
    discounts: 'Discounts',
    total: 'Total',
    grandTotal: 'Grand Total',
    notes: 'Notes',
    terms: 'Terms',
    commercialNotes: 'Commercial Notes',
    paymentMethod: 'Method',
    status: 'Status',
    summary: 'Summary',
    fiscal: 'Tax',
    clientData: 'Client Data',
    paid: 'Paid',
    balanceDue: 'Balance Due',
    noDate: 'No date',
    noDueDate: 'No date',
    noMethod: 'Not defined',
    noNotes: 'No notes.',
    noContact: 'No contact',
    noFiscalAddress: 'No tax address',
    address: 'Address',
    phone: 'Phone',
    email: 'Email',
    contact: 'Contact',
    document: 'Tax ID / Document',
    manualLine: 'Manual line',
    inventoryLine: 'Inventory',
    packingList: 'Packing List',
    company: 'Company',
    date: 'Date',
    invoiceNumber: 'Invoice Number',
    sku: 'SKU',
    weight: 'Weight',
    dimensions: 'Dimensions',
    observations: 'Notes',
    packageCount: 'Total packages',
    packageType: 'Package Type',
    packages: 'Packages',
    unitWeight: 'Unit Weight',
    totalWeight: 'Total Weight',
    volume: 'Volume',
    authorizedSignature: 'Authorized Signature',
    seal: 'Seal',
    dimensionsUnit: 'Unit of Measure'
  }
};
const TAB_KEYS = new Set([
  'dashboard',
  'facturas',
  'nueva-factura',
  'manual',
  'desde-inventario',
  'pendientes',
  'emitidas',
  'pagadas',
  'anuladas',
  'historial-clientes',
  'reportes'
]);
const TAB_ALIASES = new Map([
  ['nueva', 'nueva-factura'],
  ['inventario', 'desde-inventario'],
  ['historial', 'historial-clientes']
]);

function registerInvoiceRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    getCompanyId,
    parseCurrencyList,
    enqueueDbTransaction,
    commitTransaction,
    rollbackTransaction,
    logAction,
    buildFileUrl
  } = deps;

  const schemaReady = ensureInvoiceErpSchema(db).catch((error) => {
    console.error('[invoices] schema initialization failed', error);
    throw error;
  });

  const asyncRoute = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

  app.get(
    '/invoices',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const viewModel = await buildInvoiceDashboardViewModel({
        req,
        res,
        db,
        getCompanyId,
        parseCurrencyList,
        buildFileUrl
      });
      return res.render('invoices', viewModel);
    })
  );

  app.get(
    '/invoices/export',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const activeTab = resolveInvoiceTab(req.query.tab);
      const filters = resolveInvoiceFilters(req.query, activeTab);
      const invoices = await fetchInvoiceHeaders(db, companyId, filters, { limit: 5000 });
      const csv = buildInvoiceCsv(invoices);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="facturas.csv"');
      return res.send(`\uFEFF${csv}`);
    })
  );

  app.post(
    '/invoices/preview/pdf',
    requireAuth,
    requirePermission('billing', 'create'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
      const [customers, inventoryCatalog] = await Promise.all([
        fetchActiveCustomers(db, companyId),
        fetchInventoryCatalog(db, companyId)
      ]);
      const invoice = buildPreviewInvoiceBundle(req.body, company, customers, inventoryCatalog);
      const fileName = `${slugify(invoice.invoiceNumber || `factura-preview-${todayAsDateInput()}`)}.pdf`;
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      await renderInvoicePdfToStream(invoice, company, res, {
        pageSize: resolvePdfPageSize(req.query.paper || req.body.paper)
      });
      return null;
    })
  );

  app.post(
    '/invoices/create',
    requireAuth,
    requirePermission('billing', 'create'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = req.session && req.session.user ? req.session.user.id : null;
      const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
      const customers = await fetchActiveCustomers(db, companyId);
      const inventoryCatalog = await fetchInventoryCatalog(db, companyId);
      const activeTab = resolveInvoiceTab(req.body.active_tab || req.query.tab || 'nueva-factura');
      const rawLines = parseInvoiceLinesFromRequest(req.body);

      if (!rawLines.length) {
        const viewModel = await buildInvoiceDashboardViewModel({
          req,
          res,
          db,
          getCompanyId,
          parseCurrencyList,
          buildFileUrl,
          overrides: {
            activeTab,
            error: 'La factura debe incluir al menos una línea.',
            draftForm: buildDraftForm(req.body, rawLines, company, customers, inventoryCatalog)
          }
        });
        return res.status(422).render('invoices', viewModel);
      }

      const customerId = parsePositiveInt(req.body.customer_id);
      const customer = customerId ? await fetchCustomerById(db, companyId, customerId) : null;
      if (customerId && !customer) {
        const viewModel = await buildInvoiceDashboardViewModel({
          req,
          res,
          db,
          getCompanyId,
          parseCurrencyList,
          buildFileUrl,
          overrides: {
            activeTab,
            error: 'El cliente seleccionado no está disponible para esta empresa.',
            draftForm: buildDraftForm(req.body, rawLines, company, customers, inventoryCatalog)
          }
        });
        return res.status(422).render('invoices', viewModel);
      }

      const currency = resolveCurrency(req.body.currency, company.allowedCurrencies, company.baseCurrency);
      const exchangeRate = currency === company.baseCurrency ? 1 : toPositiveNumber(req.body.exchange_rate, 0);
      if (!exchangeRate || exchangeRate <= 0) {
        const viewModel = await buildInvoiceDashboardViewModel({
          req,
          res,
          db,
          getCompanyId,
          parseCurrencyList,
          buildFileUrl,
          overrides: {
            activeTab,
            error: 'Debes indicar un tipo de cambio válido.',
            draftForm: buildDraftForm(req.body, rawLines, company, customers, inventoryCatalog)
          }
        });
        return res.status(422).render('invoices', viewModel);
      }

      const manualServiceItem = await ensureManualServiceItem(db, companyId);
      const preparedLines = prepareInvoiceLines({
        rawLines,
        inventoryCatalog,
        defaultTaxRate: toNumber(req.body.tax_rate, company.taxRate || 0),
        manualServiceItemId: manualServiceItem.id,
        negativeStockAllowed: company.invoiceNegativeStockAllowed
      });

      if (!preparedLines.ok) {
        const viewModel = await buildInvoiceDashboardViewModel({
          req,
          res,
          db,
          getCompanyId,
          parseCurrencyList,
          buildFileUrl,
          overrides: {
            activeTab,
            error: preparedLines.error,
            draftForm: buildDraftForm(req.body, rawLines, company, customers, inventoryCatalog)
          }
        });
        return res.status(422).render('invoices', viewModel);
      }

      const finalLines = preparedLines.lines;
      const totals = computeInvoiceTotals(finalLines);
      const requestedStatus = normalizeInvoiceStatus(req.body.status || (req.body.emit_now ? 'issued' : 'draft'));
      const initialStatus = ['draft', 'pending_signature', 'issued'].includes(requestedStatus)
        ? requestedStatus
        : 'draft';
      const issueDate = normalizeDateInput(req.body.issue_date) || todayAsDateInput();
      const dueDate = normalizeDateInput(req.body.due_date);
      const paymentMethod = normalizeText(req.body.payment_method);
      const invoiceLanguage = normalizeInvoiceLanguage(req.body.invoice_language);
      const notes = normalizeText(req.body.notes);
      const source = deriveInvoiceSource(finalLines);
      const createdBy = userId || null;
      const customerSnapshot = buildCustomerSnapshot(customer);

      let created;
      try {
        created = await withTransaction(db, enqueueDbTransaction, commitTransaction, rollbackTransaction, async () => {
          const legacyTaxRate = totals.subtotal > 0 ? round2((totals.taxTotal / totals.subtotal) * 100) : 0;
          const legacyInsert = await runDb(
            db,
            `INSERT INTO invoices
             (customer_id, subtotal, tax_rate, tax_amount, discount_type, discount_value, discount_amount, total, company_id, currency, exchange_rate, subtotal_base, tax_amount_base, discount_amount_base, total_base)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              customer ? customer.id : null,
              totals.subtotal,
              legacyTaxRate,
              totals.taxTotal,
              'amount',
              totals.discountTotal,
              totals.discountTotal,
              totals.total,
              companyId,
              currency,
              exchangeRate,
              totals.subtotal * exchangeRate,
              totals.taxTotal * exchangeRate,
              totals.discountTotal * exchangeRate,
              totals.total * exchangeRate
            ]
          );

          const headerInsert = await runDb(
            db,
            `INSERT INTO invoice_headers
             (legacy_invoice_id, company_id, invoice_type, source, customer_id, customer_name_snapshot, customer_code_snapshot, customer_email_snapshot, customer_phone_snapshot, customer_address_snapshot,
              issue_date, due_date, payment_method, invoice_language, status, subtotal, tax_total, discount_total, total, paid_total, balance_due, notes, currency, exchange_rate,
              subtotal_base, tax_amount_base, discount_amount_base, total_base, created_by, updated_by, created_at, updated_at, emitted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
            [
              legacyInsert.lastID,
              companyId,
              'standard',
              source,
              customer ? customer.id : null,
              customerSnapshot.name,
              customerSnapshot.code,
              customerSnapshot.email,
              customerSnapshot.phone,
              customerSnapshot.address,
              issueDate,
              dueDate || null,
              paymentMethod || null,
              invoiceLanguage,
              initialStatus,
              totals.subtotal,
              totals.taxTotal,
              totals.discountTotal,
              totals.total,
              0,
              totals.total,
              notes || null,
              currency,
              exchangeRate,
              totals.subtotal * exchangeRate,
              totals.taxTotal * exchangeRate,
              totals.discountTotal * exchangeRate,
              totals.total * exchangeRate,
              createdBy,
              createdBy,
              initialStatus === 'issued' ? `${issueDate} 00:00:00` : null
            ]
          );

          const invoiceHeaderId = headerInsert.lastID;
          const invoiceNumber = buildInvoiceNumber(invoiceHeaderId, issueDate);
          await runDb(
            db,
            'UPDATE invoice_headers SET invoice_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
            [invoiceNumber, invoiceHeaderId, companyId]
          );

          for (let index = 0; index < finalLines.length; index += 1) {
            const line = finalLines[index];
            await runDb(
              db,
              `INSERT INTO invoice_items
               (invoice_id, header_id, item_id, qty, unit_price, line_total, company_id, line_type, description, sku_snapshot, barcode_snapshot, item_name_snapshot,
                category_name_snapshot, tax_rate, tax_amount, discount_type, discount_value, discount_amount, subtotal, total, sort_order, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              [
                legacyInsert.lastID,
                invoiceHeaderId,
                line.legacyItemId,
                line.qty,
                line.unitPrice,
                line.total,
                companyId,
                line.lineType,
                line.description,
                line.sku || null,
                line.barcode || null,
                line.itemName || null,
                line.categoryName || null,
                line.taxRate,
                line.taxAmount,
                line.discountType,
                line.discountValue,
                line.discountAmount,
                line.subtotal,
                line.total,
                index + 1
              ]
            );
          }

          await insertInvoiceStatusHistory(db, invoiceHeaderId, companyId, null, initialStatus, 'Factura creada', createdBy);

          if (initialStatus === 'issued' && company.invoiceAutoDeductStock) {
            await applyInventoryForIssuedInvoice(db, companyId, invoiceHeaderId, createdBy, company.invoiceNegativeStockAllowed);
          }

          return { headerId: invoiceHeaderId, invoiceNumber, total: totals.total };
        });
      } catch (transactionError) {
        const viewModel = await buildInvoiceDashboardViewModel({
          req,
          res,
          db,
          getCompanyId,
          parseCurrencyList,
          buildFileUrl,
          overrides: {
            activeTab,
            error: transactionError && transactionError.message
              ? transactionError.message
              : 'No se pudo guardar la factura. Revisa stock, datos y vuelve a intentar.',
            draftForm: buildDraftForm(req.body, rawLines, company, customers, inventoryCatalog)
          }
        });
        return res.status(422).render('invoices', viewModel);
      }

      if (typeof logAction === 'function') {
        logAction(
          createdBy,
          'invoice_erp_created',
          JSON.stringify({
            header_id: created.headerId,
            invoice_number: created.invoiceNumber,
            total: created.total,
            source,
            status: initialStatus
          }),
          companyId
        );
      }

      return res.redirect(`/invoices/${created.headerId}?created=1`);
    })
  );

  app.get(
    '/invoices/:id',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');
      return res.render('invoice-detail', {
        lang: res.locals.lang,
        t: res.locals.t,
        csrfToken: res.locals.csrfToken,
        company,
        invoice,
        notice: resolveDetailNotice(req.query),
        moduleTabs: buildInvoiceModuleTabs('facturas'),
        currentModule: 'invoices'
      });
    })
  );

  app.get(
    '/invoices/:id/preview',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');
      return res.render('invoice-detail', {
        lang: res.locals.lang,
        t: res.locals.t,
        csrfToken: res.locals.csrfToken,
        company,
        invoice,
        notice: null,
        previewMode: true,
        printMode: req.query.print === '1',
        moduleTabs: buildInvoiceModuleTabs('facturas'),
        currentModule: 'invoices'
      });
    })
  );

  app.get(
    '/invoices/:id/pdf',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');

      const fileName = `${slugify(invoice.invoiceNumber || `factura-${invoice.id}`)}.pdf`;
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      await renderInvoicePdfToStream(invoice, company, res, {
        pageSize: resolvePdfPageSize(req.query.paper)
      });
      return null;
    })
  );

  app.get(
    '/invoices/:id/packing-list',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      const suffix = req.query.download === '1' ? '/pdf?download=1' : '/edit';
      return res.redirect(`/invoices/${req.params.id}/packing-list${suffix}`);
    })
  );

  app.get(
    '/invoices/:id/packing-list/edit',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');

      const packingList = await fetchPackingListBundle(db, companyId, invoice);
      return res.render('packing-list-edit', {
        lang: res.locals.lang,
        t: res.locals.t,
        csrfToken: res.locals.csrfToken,
        company,
        invoice,
        packingList,
        notice: resolvePackingListNotice(req.query),
        moduleTabs: buildInvoiceModuleTabs('facturas'),
        currentModule: 'invoices'
      });
    })
  );

  app.post(
    '/invoices/:id/packing-list/save',
    requireAuth,
    requirePermission('billing', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');

      const packingItems = parsePackingListItemsFromRequest(req.body, invoice.items);
      await savePackingListItems(db, companyId, invoice.header.id, packingItems);

      const nextAction = normalizeText(req.query.next).toLowerCase();
      if (nextAction === 'pdf' || nextAction === 'print') {
        return res.redirect(`/invoices/${invoice.header.id}/packing-list/pdf`);
      }
      if (nextAction === 'download') {
        return res.redirect(`/invoices/${invoice.header.id}/packing-list/pdf?download=1`);
      }
      return res.redirect(`/invoices/${invoice.header.id}/packing-list/edit?saved=1`);
    })
  );

  app.get(
    '/invoices/:id/packing-list/pdf',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');

      const packingList = await fetchPackingListBundle(db, companyId, invoice);
      const fileName = `${slugify(invoice.invoiceNumber || `packing-list-${invoice.id}`)}-packing-list.pdf`;
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      await renderPackingListPdfToStream(packingList, company, res, {
        pageSize: resolvePdfPageSize(req.query.paper)
      });
      return null;
    })
  );

  app.post(
    '/invoices/:id/payments',
    requireAuth,
    requirePermission('billing', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = req.session && req.session.user ? req.session.user.id : null;
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');

      if (invoice.header.status === 'voided') {
        return res.redirect(`/invoices/${invoice.header.id}?error=voided`);
      }

      const amount = toPositiveNumber(req.body.amount, 0);
      if (!amount) {
        return res.redirect(`/invoices/${invoice.header.id}?payment_error=1`);
      }

      const method = normalizeText(req.body.method) || invoice.header.paymentMethod || 'Efectivo';
      const notes = normalizeText(req.body.notes);
      const reference = normalizeText(req.body.reference);
      const paidAt = normalizeDateInput(req.body.paid_at) || todayAsDateInput();

      await withTransaction(db, enqueueDbTransaction, commitTransaction, rollbackTransaction, async () => {
        await runDb(
          db,
          `INSERT INTO invoice_payments
           (invoice_id, invoice_header_id, company_id, amount, currency, exchange_rate, amount_base, method, notes, paid_at, recorded_by, payment_reference, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            invoice.header.legacyInvoiceId,
            invoice.header.id,
            companyId,
            amount,
            invoice.header.currency,
            invoice.header.exchangeRate,
            round2(amount * invoice.header.exchangeRate),
            method,
            notes || null,
            `${paidAt} 00:00:00`,
            userId || null,
            reference || null
          ]
        );
        await syncInvoicePaymentStatus(db, invoice.header.id, companyId, userId);
      });

      if (typeof logAction === 'function') {
        logAction(
          userId,
          'invoice_payment_recorded',
          JSON.stringify({ header_id: invoice.header.id, amount, method }),
          companyId
        );
      }

      return res.redirect(`/invoices/${invoice.header.id}?payment_saved=1`);
    })
  );

  app.post(
    '/invoices/:id/status',
    requireAuth,
    requirePermission('billing', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = req.session && req.session.user ? req.session.user.id : null;
      const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');

      const targetStatus = normalizeInvoiceStatus(req.body.status);
      const statusNote = normalizeText(req.body.notes);
      const voidReason = normalizeText(req.body.void_reason);
      const currentStatus = invoice.header.status;

      if (!targetStatus || !Object.prototype.hasOwnProperty.call(INVOICE_STATUSES, targetStatus)) {
        return res.redirect(`/invoices/${invoice.header.id}?status_error=1`);
      }

      if (['paid', 'partially_paid', 'overdue'].includes(targetStatus)) {
        return res.redirect(`/invoices/${invoice.header.id}?status_error=1`);
      }

      if (currentStatus === 'voided') {
        return res.redirect(`/invoices/${invoice.header.id}?status_error=1`);
      }

      if (currentStatus === targetStatus) {
        return res.redirect(`/invoices/${invoice.header.id}?status_saved=1`);
      }

      if (currentStatus === 'issued' && targetStatus === 'draft' && invoice.header.stockApplied) {
        return res.redirect(`/invoices/${invoice.header.id}?status_error=1`);
      }

      if (currentStatus === 'issued' && targetStatus === 'pending_signature' && invoice.header.stockApplied) {
        return res.redirect(`/invoices/${invoice.header.id}?status_error=1`);
      }

      try {
        await withTransaction(db, enqueueDbTransaction, commitTransaction, rollbackTransaction, async () => {
          if (targetStatus === 'issued' && company.invoiceAutoDeductStock && !invoice.header.stockApplied) {
            await applyInventoryForIssuedInvoice(db, companyId, invoice.header.id, userId, company.invoiceNegativeStockAllowed);
          }

          if (targetStatus === 'voided') {
            if (invoice.header.stockApplied) {
              await reverseInventoryForVoidedInvoice(db, companyId, invoice.header.id, userId);
            }
            await runDb(
              db,
              `UPDATE invoice_headers
               SET status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP, voided_by = ?, voided_at = CURRENT_TIMESTAMP, voided_reason = ?
               WHERE id = ? AND company_id = ?`,
              [targetStatus, userId || null, userId || null, voidReason || statusNote || null, invoice.header.id, companyId]
            );
          } else {
            await runDb(
              db,
              `UPDATE invoice_headers
               SET status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP, emitted_at = CASE WHEN ? = 'issued' AND emitted_at IS NULL THEN CURRENT_TIMESTAMP ELSE emitted_at END
               WHERE id = ? AND company_id = ?`,
              [targetStatus, userId || null, targetStatus, invoice.header.id, companyId]
            );
          }

          await insertInvoiceStatusHistory(
            db,
            invoice.header.id,
            companyId,
            currentStatus,
            targetStatus,
            targetStatus === 'voided' ? (voidReason || statusNote || 'Factura anulada') : (statusNote || 'Estado actualizado'),
            userId
          );
        });
      } catch (statusError) {
        const message = statusError && statusError.message ? encodeURIComponent(statusError.message) : '1';
        return res.redirect(`/invoices/${invoice.header.id}?status_error=${message}`);
      }

      if (typeof logAction === 'function') {
        logAction(
          userId,
          'invoice_status_updated',
          JSON.stringify({ header_id: invoice.header.id, from: currentStatus, to: targetStatus }),
          companyId
        );
      }

      return res.redirect(`/invoices/${invoice.header.id}?status_saved=1`);
    })
  );

  app.post(
    '/invoices/:id/send',
    requireAuth,
    requirePermission('billing', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const invoice = await fetchInvoiceBundle(db, companyId, req.params.id);
      if (!invoice) return res.redirect('/invoices?tab=facturas');

      const recipient = normalizeText(req.body.email) || invoice.header.customerEmail || null;
      if (!recipient) {
        return res.redirect(`/invoices/${invoice.header.id}?send_error=missing_recipient`);
      }

      try {
        const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
        const pdfBuffer = await renderInvoicePdfToBuffer(invoice, company);
        await sendInvoiceEmail({
          to: recipient,
          subject: `Factura ${invoice.invoiceNumber || invoice.header.invoiceNumber || invoice.header.id}`,
          text: buildInvoiceEmailBody(invoice, company, req),
          attachments: [
            {
              filename: `${slugify(invoice.invoiceNumber || `factura-${invoice.header.id}`)}.pdf`,
              content: pdfBuffer,
              contentType: 'application/pdf'
            }
          ]
        });
      } catch (sendError) {
        const message = sendError && sendError.message ? sendError.message : 'send_failed';
        return res.redirect(`/invoices/${invoice.header.id}?send_error=${encodeURIComponent(message)}`);
      }

      if (typeof logAction === 'function') {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        logAction(
          userId,
          'invoice_sent',
          JSON.stringify({ header_id: invoice.header.id, recipient }),
          companyId
        );
      }

      return res.redirect(`/invoices/${invoice.header.id}?sent=1`);
    })
  );
}

function buildDraftForm(body, rawLines, company, customers, inventoryCatalog) {
  return {
    activeTab: resolveInvoiceTab(body.active_tab || body.tab || 'nueva-factura'),
    mode: normalizeText(body.form_mode) === 'inventory' ? 'inventory' : 'manual',
    customerId: parsePositiveInt(body.customer_id) || '',
    currency: resolveCurrency(body.currency, company.allowedCurrencies, company.baseCurrency),
    exchangeRate: normalizeText(body.exchange_rate) || '1',
    issueDate: normalizeDateInput(body.issue_date) || todayAsDateInput(),
    dueDate: normalizeDateInput(body.due_date) || '',
    taxRate: normalizeText(body.tax_rate) || String(company.taxRate || 0),
    paymentMethod: normalizeText(body.payment_method) || '',
    invoiceLanguage: normalizeInvoiceLanguage(body.invoice_language),
    notes: normalizeText(body.notes) || '',
    status: normalizeInvoiceStatus(body.status || 'draft'),
    lines: hydrateDraftLines(rawLines, inventoryCatalog)
  };
}

function buildPreviewInvoiceBundle(body, company, customers, inventoryCatalog) {
  const rawLines = parseInvoiceLinesFromRequest(body);
  const draft = buildDraftForm(body, rawLines, company, customers, inventoryCatalog);
  const customerId = parsePositiveInt(draft.customerId);
  const customer = (customers || []).find((entry) => Number(entry.id) === customerId) || null;
  const items = (draft.lines || []).map((line, index) => ({
    id: index + 1,
    lineType: normalizeLineType(line.lineType),
    description: normalizeText(line.description) || 'Sin descripcion',
    sku: normalizeText(line.sku),
    barcode: normalizeText(line.barcode),
    qty: round2(toNumber(line.qty, 0)),
    unitPrice: round2(toNumber(line.unitPrice, 0)),
    subtotal: round2(toNumber(line.subtotal, 0)),
    discountType: normalizeDiscountType(line.discountType),
    discountValue: round2(toNumber(line.discountValue, 0)),
    discountAmount: round2(toNumber(line.discountAmount, 0)),
    taxRate: round2(toNumber(line.taxRate, 0)),
    taxAmount: round2(toNumber(line.taxAmount, 0)),
    total: round2(toNumber(line.total, 0)),
    inventoryName: normalizeText(line.description),
    categoryName: normalizeText(line.categoryName)
  }));

  const subtotal = round2(items.reduce((sum, line) => sum + toNumber(line.subtotal, 0), 0));
  const discountTotal = round2(items.reduce((sum, line) => sum + toNumber(line.discountAmount, 0), 0));
  const taxTotal = round2(items.reduce((sum, line) => sum + toNumber(line.taxAmount, 0), 0));
  const total = round2(items.reduce((sum, line) => sum + toNumber(line.total, 0), 0));
  const exchangeRate = draft.currency === company.baseCurrency ? 1 : toPositiveNumber(draft.exchangeRate, 1) || 1;
  const issueDate = draft.issueDate || todayAsDateInput();
  const baseHeader = {
    id: null,
    legacyInvoiceId: null,
    invoiceNumber: `PREVIEW-${issueDate.replace(/-/g, '')}`,
    source: 'preview',
    customerId: customer ? customer.id : null,
    customerName: customer ? customer.name : 'Mostrador',
    customerCode: customer ? normalizeText(customer.customerCode) : '',
    customerEmail: customer ? normalizeText(customer.email) : '',
    customerPhone: customer ? normalizeText(customer.phone) : '',
    customerAddress: customer ? normalizeText(customer.fullAddress || customer.address) : '',
    issueDate,
    dueDate: draft.dueDate || '',
    paymentMethod: draft.paymentMethod || '',
    invoiceLanguage: normalizeInvoiceLanguage(draft.invoiceLanguage),
    status: normalizeInvoiceStatus(draft.status),
    subtotal,
    taxTotal,
    discountTotal,
    total,
    paidTotal: 0,
    balanceDue: total,
    notes: normalizeText(draft.notes),
    currency: draft.currency || company.baseCurrency,
    exchangeRate,
    subtotalBase: round2(subtotal * exchangeRate),
    taxTotalBase: round2(taxTotal * exchangeRate),
    discountTotalBase: round2(discountTotal * exchangeRate),
    totalBase: round2(total * exchangeRate),
    createdAt: '',
    updatedAt: '',
    emittedAt: '',
    paidAt: '',
    voidedAt: '',
    voidedReason: '',
    createdByName: '',
    updatedByName: '',
    voidedByName: '',
    stockApplied: false,
    createdAtDate: issueDate
  };

  baseHeader.effectiveStatus = deriveEffectiveInvoiceStatus(baseHeader);
  baseHeader.statusMeta = resolveInvoiceStatusMeta(baseHeader);

  return {
    id: null,
    invoiceNumber: baseHeader.invoiceNumber,
    header: baseHeader,
    statusMeta: baseHeader.statusMeta,
    items,
    payments: [],
    statusHistory: [],
    inventoryMovements: []
  };
}

function hydrateDraftLines(lines, inventoryCatalog) {
  const catalogMap = new Map((inventoryCatalog || []).map((item) => [item.id, item]));
  return (lines || []).map((line, index) => {
    const itemId = parsePositiveInt(line.item_id || line.itemId);
    const catalog = itemId ? catalogMap.get(itemId) : null;
    const qty = toNumber(line.qty, 1) || 1;
    const unitPrice = toNumber(line.unit_price || line.unitPrice, catalog ? catalog.price : 0);
    const taxRate = toNumber(line.tax_rate || line.taxRate, catalog ? catalog.taxRate : 0);
    const discountValue = toNumber(line.discount_value || line.discountValue, 0);
    const discountType = normalizeDiscountType(line.discount_type || line.discountType);
    const previewSubtotal = round2(qty * unitPrice);
    const previewDiscount = normalizeDiscountAmount(discountType, discountValue, previewSubtotal);
    const previewTaxBase = Math.max(0, previewSubtotal - previewDiscount);
    const previewTax = round2(previewTaxBase * (taxRate / 100));
    const previewTotal = round2(previewTaxBase + previewTax);
    return {
      rowId: `draft-${index + 1}`,
      lineType: normalizeLineType(line.line_type || line.lineType || (catalog ? 'inventory' : 'manual')),
      itemId: itemId || '',
      description: normalizeText(line.description) || (catalog ? catalog.name : ''),
      sku: catalog ? catalog.sku : normalizeText(line.sku),
      barcode: catalog ? catalog.barcode : normalizeText(line.barcode),
      categoryName: catalog ? catalog.categoryName : normalizeText(line.categoryName),
      stock: catalog ? toNumber(catalog.qty, 0) : 0,
      qty,
      unitPrice,
      taxRate,
      discountType,
      discountValue,
      subtotal: previewSubtotal,
      discountAmount: previewDiscount,
      taxAmount: previewTax,
      total: previewTotal
    };
  });
}

async function buildInvoiceDashboardViewModel(options) {
  const { req, res, db, getCompanyId, parseCurrencyList, buildFileUrl, overrides = {} } = options;
  const companyId = getCompanyId(req);
  const company = await fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl);
  const activeTab = overrides.activeTab || resolveInvoiceTab(req.query.tab);
  const filters = resolveInvoiceFilters(req.query, activeTab);
  const [customers, inventoryCatalog, invoices, dashboard, customerHistory, cancelledHistory, pendingSignatureHistory, generalHistory] = await Promise.all([
    fetchActiveCustomers(db, companyId),
    fetchInventoryCatalog(db, companyId),
    fetchInvoiceHeaders(db, companyId, filters, { limit: 250 }),
    fetchInvoiceDashboard(db, companyId, filters),
    fetchCustomerInvoiceHistory(db, companyId, filters),
    fetchCancelledInvoiceHistory(db, companyId, filters),
    fetchPendingSignatureHistory(db, companyId, filters),
    fetchGeneralInvoiceHistory(db, companyId, filters)
  ]);

  const draftForm = overrides.draftForm || {
    activeTab,
    mode: activeTab === 'desde-inventario' ? 'inventory' : 'manual',
    customerId: '',
    currency: company.baseCurrency,
    exchangeRate: '1',
    issueDate: todayAsDateInput(),
    dueDate: '',
    taxRate: String(company.taxRate || 0),
    paymentMethod: '',
    invoiceLanguage: 'es',
    notes: '',
    status: activeTab === 'pendientes' ? 'pending_signature' : 'draft',
    lines: [
      {
        rowId: 'draft-1',
        lineType: activeTab === 'desde-inventario' ? 'inventory' : 'manual',
        itemId: '',
        description: '',
        sku: '',
        barcode: '',
        categoryName: '',
        stock: 0,
        qty: 1,
        unitPrice: 0,
        taxRate: company.taxRate || 0,
        discountType: 'amount',
        discountValue: 0,
        subtotal: 0,
        discountAmount: 0,
        taxAmount: 0,
        total: 0
      }
    ]
  };

  return {
    lang: res.locals.lang,
    t: res.locals.t,
    csrfToken: res.locals.csrfToken,
    flash: res.locals.flash,
    company,
    activeTab,
    moduleTabs: buildInvoiceModuleTabs(activeTab),
    currentModule: 'invoices',
    filters,
    customers,
    inventoryCatalog,
    invoices,
    dashboard,
    customerHistory,
    cancelledHistory,
    pendingSignatureHistory,
    generalHistory,
    paymentMethods: PAYMENT_METHODS,
    invoiceStatuses: Object.entries(INVOICE_STATUSES).map(([key, value]) => ({ key, ...value })),
    notice: overrides.notice || resolveListNotice(req.query),
    error: overrides.error || null,
    draftForm,
    inventorySearchIndexJson: serializeForHtml(inventoryCatalog || []),
    draftFormJson: serializeForHtml(draftForm)
  };
}

async function fetchCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl) {
  const company = await getDb(
    db,
    `SELECT id, name, legal_name, commercial_name, address, tax_address, nit, phone, email, logo, base_currency, allowed_currencies, currency, tax_rate, tax_name,
            COALESCE(invoice_negative_stock_allowed, 0) AS invoice_negative_stock_allowed,
            COALESCE(invoice_auto_deduct_stock, 1) AS invoice_auto_deduct_stock,
            primary_color, secondary_color, theme_background_color
     FROM companies
     WHERE id = ?`,
    [companyId]
  );

  const baseCurrency = String((company && (company.base_currency || company.currency)) || 'GTQ').toUpperCase();
  const allowedCurrencies = typeof parseCurrencyList === 'function'
    ? parseCurrencyList(company && company.allowed_currencies, baseCurrency)
    : [baseCurrency];

  return {
    id: companyId,
    name: normalizeText(company && (company.commercial_name || company.name || company.legal_name)) || 'Empresa',
    legalName: normalizeText(company && company.legal_name),
    commercialName: normalizeText(company && company.commercial_name),
    address: normalizeText(company && company.address),
    taxAddress: normalizeText(company && company.tax_address),
    nit: normalizeText(company && company.nit),
    phone: normalizeText(company && company.phone),
    email: normalizeText(company && company.email),
    logoPath: company && company.logo ? String(company.logo) : null,
    logoUrl: typeof buildFileUrl === 'function' ? buildFileUrl(company && company.logo) : null,
    baseCurrency,
    allowedCurrencies,
    taxRate: toNumber(company && company.tax_rate, 0),
    taxName: normalizeText(company && company.tax_name) || 'Impuesto',
    invoiceNegativeStockAllowed: Boolean(Number(company && company.invoice_negative_stock_allowed)),
    invoiceAutoDeductStock: !company || Number(company.invoice_auto_deduct_stock) !== 0,
    primaryColor: normalizeText(company && company.primary_color) || '#24455d',
    secondaryColor: normalizeText(company && company.secondary_color) || '#2d7c7a',
    backgroundColor: normalizeText(company && company.theme_background_color)
  };
}

async function fetchActiveCustomers(db, companyId) {
  const rows = await allDb(
    db,
    `SELECT id, name, customer_code, phone, email, COALESCE(full_address, address) AS address
     FROM customers
     WHERE company_id = ? AND COALESCE(is_voided, 0) = 0
     ORDER BY name ASC`,
    [companyId]
  );
  return (rows || []).map((row) => ({
    id: row.id,
    name: normalizeText(row.name),
    customerCode: normalizeText(row.customer_code),
    phone: normalizeText(row.phone),
    email: normalizeText(row.email),
    address: normalizeText(row.address)
  }));
}

async function fetchCustomerById(db, companyId, customerId) {
  const row = await getDb(
    db,
    `SELECT id, name, customer_code, phone, email, COALESCE(full_address, address) AS address
     FROM customers
     WHERE id = ? AND company_id = ? AND COALESCE(is_voided, 0) = 0`,
    [customerId, companyId]
  );
  if (!row) return null;
  return {
    id: row.id,
    name: normalizeText(row.name),
    customerCode: normalizeText(row.customer_code),
    phone: normalizeText(row.phone),
    email: normalizeText(row.email),
    address: normalizeText(row.address)
  };
}

async function fetchInventoryCatalog(db, companyId) {
  const rows = await allDb(
    db,
    `SELECT items.id, items.name, items.sku, items.item_code, items.qty, items.min_stock, items.price, items.barcode,
            COALESCE(categories.name, '') AS category_name,
            COALESCE(brands.name, '') AS brand_name
     FROM items
     LEFT JOIN categories ON categories.id = items.category_id AND categories.company_id = items.company_id
     LEFT JOIN brands ON brands.id = items.brand_id AND brands.company_id = items.company_id
     WHERE items.company_id = ?
     ORDER BY items.name ASC`,
    [companyId]
  );

  return (rows || []).map((row) => ({
    id: row.id,
    name: normalizeText(row.name),
    sku: normalizeText(row.sku),
    itemCode: normalizeText(row.item_code),
    qty: toNumber(row.qty, 0),
    minStock: toNumber(row.min_stock, 0),
    price: toNumber(row.price, 0),
    barcode: normalizeText(row.barcode),
    categoryName: normalizeText(row.category_name),
    brandName: normalizeText(row.brand_name),
    taxRate: 0,
    searchIndex: [
      normalizeText(row.name),
      normalizeText(row.sku),
      normalizeText(row.item_code),
      normalizeText(row.category_name),
      normalizeText(row.brand_name),
      normalizeText(row.barcode)
    ].filter(Boolean).join(' ').toLowerCase()
  }));
}

async function fetchInvoiceHeaders(db, companyId, filters, options = {}) {
  const params = [companyId];
  let sql = `
    SELECT h.*,
           c.name AS customer_live_name,
           c.customer_code AS customer_live_code,
           u1.username AS created_by_name,
           u2.username AS updated_by_name,
           u3.username AS voided_by_name
    FROM invoice_headers h
    LEFT JOIN customers c ON c.id = h.customer_id AND c.company_id = h.company_id
    LEFT JOIN users u1 ON u1.id = h.created_by AND (u1.company_id = h.company_id OR u1.company_id IS NULL)
    LEFT JOIN users u2 ON u2.id = h.updated_by AND (u2.company_id = h.company_id OR u2.company_id IS NULL)
    LEFT JOIN users u3 ON u3.id = h.voided_by AND (u3.company_id = h.company_id OR u3.company_id IS NULL)
    WHERE h.company_id = ?
  `;

  if (filters.customerId) {
    sql += ' AND h.customer_id = ?';
    params.push(filters.customerId);
  }

  if (filters.fromDate) {
    sql += " AND COALESCE(NULLIF(h.issue_date, '')::date, h.created_at::date) >= ?::date";
    params.push(filters.fromDate);
  }

  if (filters.toDate) {
    sql += " AND COALESCE(NULLIF(h.issue_date, '')::date, h.created_at::date) <= ?::date";
    params.push(filters.toDate);
  }

  if (filters.query) {
    sql += ` AND (
      lower(COALESCE(h.invoice_number, '')) LIKE ?
      OR lower(COALESCE(h.customer_name_snapshot, c.name, '')) LIKE ?
      OR lower(COALESCE(h.customer_code_snapshot, c.customer_code, '')) LIKE ?
      OR lower(COALESCE(h.notes, '')) LIKE ?
    )`;
    const like = `%${filters.query.toLowerCase()}%`;
    params.push(like, like, like, like);
  }

  sql += " ORDER BY COALESCE(NULLIF(h.issue_date, '')::date, h.created_at::date) DESC, h.id DESC";
  if (options.limit) {
    sql += ` LIMIT ${Number(options.limit)}`;
  }

  const rows = await allDb(db, sql, params);
  const mapped = (rows || []).map(mapInvoiceHeaderRow);
  if (filters.status) {
    return mapped.filter((row) => row.effectiveStatus === filters.status);
  }
  return mapped;
}

async function fetchInvoiceDashboard(db, companyId, filters) {
  const currentRows = await fetchInvoiceHeaders(db, companyId, {
    ...filters,
    status: null
  }, { limit: 5000 });
  const previousRows = filters.previousRange
    ? await fetchInvoiceHeaders(
      db,
      companyId,
      {
        ...filters,
        status: null,
        fromDate: filters.previousRange.fromDate,
        toDate: filters.previousRange.toDate
      },
      { limit: 5000 }
    )
    : [];

  const currentCountable = currentRows.filter((row) => isCountableInvoiceStatus(row.effectiveStatus));
  const previousCountable = previousRows.filter((row) => isCountableInvoiceStatus(row.effectiveStatus));
  const dailySales = sumInvoiceTotals(currentCountable.filter((row) => row.issueDate === todayAsDateInput()));
  const monthlySales = sumInvoiceTotals(currentCountable.filter((row) => row.issueDate && row.issueDate.startsWith(todayAsDateInput().slice(0, 7))));
  const yearlySales = sumInvoiceTotals(currentCountable.filter((row) => row.issueDate && row.issueDate.startsWith(todayAsDateInput().slice(0, 4))));
  const totalFactured = sumInvoiceTotals(currentCountable);
  const totalPending = round2(
    currentRows
      .filter((row) => !['voided', 'paid'].includes(row.effectiveStatus))
      .reduce((sum, row) => sum + toNumber(row.balanceDue, 0), 0)
  );
  const totalVoided = round2(
    currentRows
      .filter((row) => row.effectiveStatus === 'voided')
      .reduce((sum, row) => sum + toNumber(row.total, 0), 0)
  );
  const currentTotal = sumInvoiceTotals(currentCountable);
  const previousTotal = sumInvoiceTotals(previousCountable);

  const [topClients, topProducts] = await Promise.all([
    fetchDashboardTopClients(db, companyId, filters),
    fetchDashboardTopProducts(db, companyId, filters)
  ]);

  return {
    dailySales,
    monthlySales,
    yearlySales,
    totalFactured,
    totalPending,
    totalVoided,
    invoiceCount: currentRows.length,
    compareCurrent: currentTotal,
    comparePrevious: previousTotal,
    compareDelta: round2(currentTotal - previousTotal),
    topClients,
    topProducts
  };
}

async function fetchDashboardTopClients(db, companyId, filters) {
  const { whereSql, params } = buildHeaderFilterWhereClause(companyId, filters, {
    includeQuery: false,
    excludeStatuses: ['draft', 'pending_signature', 'voided']
  });
  const rows = await allDb(
    db,
    `SELECT COALESCE(h.customer_name_snapshot, c.name, 'Mostrador') AS customer_name,
            COALESCE(h.customer_code_snapshot, c.customer_code, '') AS customer_code,
            COUNT(*) AS invoice_count,
            SUM(h.total) AS total_billed,
            SUM(h.balance_due) AS balance_due
     FROM invoice_headers h
     LEFT JOIN customers c ON c.id = h.customer_id AND c.company_id = h.company_id
     ${whereSql}
     GROUP BY COALESCE(h.customer_name_snapshot, c.name, 'Mostrador'), COALESCE(h.customer_code_snapshot, c.customer_code, '')
     ORDER BY total_billed DESC
     LIMIT 8`,
    params
  );
  return (rows || []).map((row) => ({
    customerName: normalizeText(row.customer_name) || 'Mostrador',
    customerCode: normalizeText(row.customer_code),
    invoiceCount: toNumber(row.invoice_count, 0),
    totalBilled: round2(toNumber(row.total_billed, 0)),
    balanceDue: round2(toNumber(row.balance_due, 0))
  }));
}

async function fetchDashboardTopProducts(db, companyId, filters) {
  const { whereSql, params } = buildHeaderFilterWhereClause(companyId, filters, {
    includeQuery: false,
    excludeStatuses: ['draft', 'pending_signature', 'voided']
  });
  const rows = await allDb(
    db,
    `SELECT COALESCE(ii.description, ii.item_name_snapshot, items.name, 'Sin descripción') AS line_name,
            COALESCE(ii.sku_snapshot, items.sku, '') AS sku,
            SUM(ii.qty) AS total_qty,
            SUM(ii.total) AS total_billed
     FROM invoice_items ii
     INNER JOIN invoice_headers h ON h.id = ii.header_id AND h.company_id = ii.company_id
     LEFT JOIN items ON items.id = ii.item_id AND items.company_id = ii.company_id
     ${whereSql}
       AND ii.company_id = ?
     GROUP BY COALESCE(ii.description, ii.item_name_snapshot, items.name, 'Sin descripción'), COALESCE(ii.sku_snapshot, items.sku, '')
     ORDER BY total_qty DESC, total_billed DESC
     LIMIT 8`,
    [...params, companyId]
  );
  return (rows || []).map((row) => ({
    lineName: normalizeText(row.line_name) || 'Sin descripción',
    sku: normalizeText(row.sku),
    totalQty: toNumber(row.total_qty, 0),
    totalBilled: round2(toNumber(row.total_billed, 0))
  }));
}

async function fetchCustomerInvoiceHistory(db, companyId, filters) {
  const { whereSql, params } = buildHeaderFilterWhereClause(companyId, filters, {
    includeQuery: false
  });
  const rows = await allDb(
    db,
    `SELECT COALESCE(h.customer_name_snapshot, c.name, 'Mostrador') AS customer_name,
            COALESCE(h.customer_code_snapshot, c.customer_code, '') AS customer_code,
            COUNT(*) AS invoice_count,
            SUM(h.total) AS total_billed,
            SUM(h.balance_due) AS total_pending,
            MAX(COALESCE(NULLIF(h.issue_date, '')::date, h.created_at::date)) AS last_purchase
     FROM invoice_headers h
     LEFT JOIN customers c ON c.id = h.customer_id AND c.company_id = h.company_id
     ${whereSql}
     GROUP BY COALESCE(h.customer_name_snapshot, c.name, 'Mostrador'), COALESCE(h.customer_code_snapshot, c.customer_code, '')
     ORDER BY total_billed DESC, last_purchase DESC
     LIMIT 50`,
    params
  );
  return (rows || []).map((row) => ({
    customerName: normalizeText(row.customer_name) || 'Mostrador',
    customerCode: normalizeText(row.customer_code),
    invoiceCount: toNumber(row.invoice_count, 0),
    totalBilled: round2(toNumber(row.total_billed, 0)),
    totalPending: round2(toNumber(row.total_pending, 0)),
    lastPurchase: normalizeText(row.last_purchase)
  }));
}

async function fetchCancelledInvoiceHistory(db, companyId, filters) {
  const rows = await fetchInvoiceHeaders(db, companyId, { ...filters, status: 'voided' }, { limit: 200 });
  return rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    customerName: row.customerName,
    total: row.total,
    voidedAt: row.voidedAt,
    voidedByName: row.voidedByName,
    voidedReason: row.voidedReason
  }));
}

async function fetchPendingSignatureHistory(db, companyId, filters) {
  const rows = await fetchInvoiceHeaders(db, companyId, { ...filters, status: 'pending_signature' }, { limit: 200 });
  return rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    customerName: row.customerName,
    total: row.total,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    ageDays: calculateDaysOpen(row.issueDate || row.createdAtDate)
  }));
}

async function fetchGeneralInvoiceHistory(db, companyId, filters) {
  return fetchInvoiceHeaders(db, companyId, filters, { limit: 500 });
}

async function fetchInvoiceBundle(db, companyId, lookupValue) {
  const numericLookup = parsePositiveInt(lookupValue);
  if (!numericLookup) return null;

  const headerRow = await getDb(
    db,
    `SELECT h.*,
            c.name AS customer_live_name,
            c.customer_code AS customer_live_code,
            c.phone AS customer_live_phone,
            c.email AS customer_live_email,
            COALESCE(c.full_address, c.address) AS customer_live_address,
            u1.username AS created_by_name,
            u2.username AS updated_by_name,
            u3.username AS voided_by_name
     FROM invoice_headers h
     LEFT JOIN customers c ON c.id = h.customer_id AND c.company_id = h.company_id
     LEFT JOIN users u1 ON u1.id = h.created_by AND (u1.company_id = h.company_id OR u1.company_id IS NULL)
     LEFT JOIN users u2 ON u2.id = h.updated_by AND (u2.company_id = h.company_id OR u2.company_id IS NULL)
     LEFT JOIN users u3 ON u3.id = h.voided_by AND (u3.company_id = h.company_id OR u3.company_id IS NULL)
     WHERE h.company_id = ? AND (h.id = ? OR h.legacy_invoice_id = ?)
     ORDER BY CASE WHEN h.id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
    [companyId, numericLookup, numericLookup, numericLookup]
  );

  if (!headerRow) return null;
  const header = mapInvoiceHeaderRow(headerRow);

  const [items, payments, statusHistory, inventoryMovements] = await Promise.all([
    allDb(
      db,
      `SELECT ii.*, items.name AS inventory_name
       FROM invoice_items ii
       LEFT JOIN items ON items.id = ii.item_id AND items.company_id = ii.company_id
       WHERE ii.company_id = ? AND ii.header_id = ?
       ORDER BY COALESCE(ii.sort_order, ii.id) ASC, ii.id ASC`,
      [companyId, header.id]
    ),
    allDb(
      db,
      `SELECT ip.*, u.username AS recorded_by_name
       FROM invoice_payments ip
       LEFT JOIN users u ON u.id = ip.recorded_by AND (u.company_id = ip.company_id OR u.company_id IS NULL)
       WHERE ip.company_id = ? AND (ip.invoice_header_id = ? OR (ip.invoice_header_id IS NULL AND ip.invoice_id = ?))
       ORDER BY COALESCE(ip.paid_at, ip.created_at) DESC, ip.id DESC`,
      [companyId, header.id, header.legacyInvoiceId]
    ),
    allDb(
      db,
      `SELECT ish.*, u.username AS changed_by_name
       FROM invoice_status_history ish
       LEFT JOIN users u ON u.id = ish.changed_by AND (u.company_id = ish.company_id OR u.company_id IS NULL)
       WHERE ish.company_id = ? AND ish.invoice_header_id = ?
       ORDER BY ish.id DESC`,
      [companyId, header.id]
    ),
    allDb(
      db,
      `SELECT iim.*, items.name AS item_name, items.sku AS item_sku
       FROM invoice_inventory_movements iim
       LEFT JOIN items ON items.id = iim.item_id AND items.company_id = iim.company_id
       WHERE iim.company_id = ? AND iim.invoice_header_id = ?
       ORDER BY iim.id DESC`,
      [companyId, header.id]
    )
  ]);

  return {
    id: header.id,
    invoiceNumber: header.invoiceNumber,
    header,
    statusMeta: resolveInvoiceStatusMeta(header),
    items: (items || []).map((row) => ({
      id: row.id,
      lineType: normalizeLineType(row.line_type),
      description: normalizeText(row.description) || normalizeText(row.item_name_snapshot) || normalizeText(row.inventory_name) || 'Sin descripción',
      sku: normalizeText(row.sku_snapshot) || '',
      barcode: normalizeText(row.barcode_snapshot) || '',
      qty: toNumber(row.qty, 0),
      unitPrice: toNumber(row.unit_price, 0),
      subtotal: toNumber(row.subtotal, row.qty * row.unit_price),
      discountType: normalizeDiscountType(row.discount_type),
      discountValue: toNumber(row.discount_value, 0),
      discountAmount: toNumber(row.discount_amount, 0),
      taxRate: toNumber(row.tax_rate, 0),
      taxAmount: toNumber(row.tax_amount, 0),
      total: toNumber(row.total, row.line_total),
      inventoryName: normalizeText(row.inventory_name),
      categoryName: normalizeText(row.category_name_snapshot)
    })),
    payments: (payments || []).map((row) => ({
      id: row.id,
      amount: toNumber(row.amount, 0),
      method: normalizeText(row.method),
      notes: normalizeText(row.notes),
      paidAt: normalizeDateTime(row.paid_at || row.created_at),
      reference: normalizeText(row.payment_reference),
      recordedByName: normalizeText(row.recorded_by_name)
    })),
    statusHistory: (statusHistory || []).map((row) => ({
      id: row.id,
      fromStatus: normalizeInvoiceStatus(row.from_status),
      toStatus: normalizeInvoiceStatus(row.to_status),
      note: normalizeText(row.notes),
      changedByName: normalizeText(row.changed_by_name),
      createdAt: normalizeDateTime(row.created_at)
    })),
    inventoryMovements: (inventoryMovements || []).map((row) => ({
      id: row.id,
      movementType: normalizeText(row.movement_type),
      itemName: normalizeText(row.item_name),
      itemSku: normalizeText(row.item_sku),
      qty: toNumber(row.qty, 0),
      stockBefore: toNumber(row.stock_before, 0),
      stockAfter: toNumber(row.stock_after, 0),
      note: normalizeText(row.notes),
      createdAt: normalizeDateTime(row.created_at)
    }))
  };
}

async function fetchPackingListBundle(db, companyId, invoice) {
  const rows = await allDb(
    db,
    `SELECT *
     FROM invoice_packing_items
     WHERE company_id = ? AND invoice_id = ?
     ORDER BY invoice_item_id ASC, id ASC`,
    [companyId, invoice.header.id]
  );

  const savedMap = new Map();
  for (const row of rows || []) {
    if (!savedMap.has(row.invoice_item_id)) {
      savedMap.set(row.invoice_item_id, row);
    }
  }

  const items = (invoice.items || []).map((item, index) => {
    const saved = savedMap.get(item.id);
    const weightUnit = round3(toNumber(saved && saved.weight_unit, 0));
    const autoWeightTotal = weightUnit > 0 ? round3(weightUnit * toNumber(item.qty, 0)) : 0;
    const weightTotal = round3(toNumber(saved && saved.weight_total, autoWeightTotal));
    const length = round3(toNumber(saved && saved.length, 0));
    const width = round3(toNumber(saved && saved.width, 0));
    const height = round3(toNumber(saved && saved.height, 0));
    const packagesCount = round3(toNumber(saved && saved.packages_count, 0));
    const dimensionUnit = normalizeDimensionUnit(saved && saved.dimension_unit);
    const volume = length > 0 && width > 0 && height > 0 && packagesCount > 0
      ? round3(length * width * height * packagesCount)
      : 0;

    return {
      lineNumber: index + 1,
      invoiceItemId: item.id,
      description: item.description,
      sku: item.sku,
      qty: toNumber(item.qty, 0),
      weightUnit,
      weightTotal,
      length,
      width,
      height,
      dimensionUnit,
      packagesCount,
      packageType: normalizeText(saved && saved.package_type),
      notes: normalizeText(saved && saved.notes),
      dimensionsLabel: formatPackingDimensions({ length, width, height, dimensionUnit }),
      volume
    };
  });

  return {
    invoiceId: invoice.header.id,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.header.issueDate,
    invoiceNotes: invoice.header.notes || '',
    customerName: invoice.header.customerName || '',
    customerCode: invoice.header.customerCode || '',
    customerAddress: invoice.header.customerAddress || '',
    customerPhone: invoice.header.customerPhone || '',
    customerEmail: invoice.header.customerEmail || '',
    updatedAt: rows && rows.length ? normalizeDateTime(rows[0].updated_at || rows[0].created_at) : '',
    items,
    totals: buildPackingListTotals(items)
  };
}

function parsePackingListItemsFromRequest(body, invoiceItems) {
  const itemIdsRaw = asArray(body && body.invoice_item_id);
  const weightUnitsRaw = asArray(body && body.weight_unit);
  const weightTotalsRaw = asArray(body && body.weight_total);
  const lengthsRaw = asArray(body && body.length);
  const widthsRaw = asArray(body && body.width);
  const heightsRaw = asArray(body && body.height);
  const dimensionUnitsRaw = asArray(body && body.dimension_unit);
  const packagesRaw = asArray(body && body.packages_count);
  const packageTypesRaw = asArray(body && body.package_type);
  const notesRaw = asArray(body && body.notes);
  const validItemIds = new Set((invoiceItems || []).map((item) => item.id));
  const parsed = [];

  for (let index = 0; index < itemIdsRaw.length; index += 1) {
    const invoiceItemId = parsePositiveInt(itemIdsRaw[index]);
    if (!invoiceItemId || !validItemIds.has(invoiceItemId)) continue;

    const weightUnit = round3(Math.max(0, toNumber(weightUnitsRaw[index], 0)));
    const weightTotalInput = round3(Math.max(0, toNumber(weightTotalsRaw[index], 0)));
    const invoiceItem = (invoiceItems || []).find((item) => item.id === invoiceItemId);
    const fallbackWeightTotal = weightUnit > 0 && invoiceItem ? round3(weightUnit * toNumber(invoiceItem.qty, 0)) : 0;

    parsed.push({
      invoiceItemId,
      weightUnit,
      weightTotal: weightTotalInput > 0 ? weightTotalInput : fallbackWeightTotal,
      length: round3(Math.max(0, toNumber(lengthsRaw[index], 0))),
      width: round3(Math.max(0, toNumber(widthsRaw[index], 0))),
      height: round3(Math.max(0, toNumber(heightsRaw[index], 0))),
      dimensionUnit: normalizeDimensionUnit(dimensionUnitsRaw[index]),
      packagesCount: round3(Math.max(0, toNumber(packagesRaw[index], 0))),
      packageType: normalizeText(packageTypesRaw[index]),
      notes: normalizeText(notesRaw[index])
    });
  }

  return parsed;
}

async function savePackingListItems(db, companyId, invoiceId, items) {
  const validItems = Array.isArray(items) ? items : [];
  const itemIds = validItems.map((item) => item.invoiceItemId).filter(Boolean);

  await runDb(
    db,
    `DELETE FROM invoice_packing_items
     WHERE company_id = ? AND invoice_id = ?
       ${itemIds.length ? `AND invoice_item_id NOT IN (${itemIds.map(() => '?').join(', ')})` : ''}`,
    itemIds.length ? [companyId, invoiceId, ...itemIds] : [companyId, invoiceId]
  );

  for (const item of validItems) {
    await runDb(
      db,
      `INSERT INTO invoice_packing_items
       (company_id, invoice_id, invoice_item_id, weight_unit, weight_total, length, width, height, dimension_unit, packages_count, package_type, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(company_id, invoice_id, invoice_item_id) DO UPDATE SET
         weight_unit = excluded.weight_unit,
         weight_total = excluded.weight_total,
         length = excluded.length,
         width = excluded.width,
         height = excluded.height,
         dimension_unit = excluded.dimension_unit,
         packages_count = excluded.packages_count,
         package_type = excluded.package_type,
         notes = excluded.notes,
         updated_at = CURRENT_TIMESTAMP`,
      [
        companyId,
        invoiceId,
        item.invoiceItemId,
        item.weightUnit,
        item.weightTotal,
        item.length,
        item.width,
        item.height,
        item.dimensionUnit,
        item.packagesCount,
        item.packageType || null,
        item.notes || null
      ]
    );
  }
}

function buildPackingListTotals(items) {
  let totalPackages = 0;
  let totalWeight = 0;
  let totalVolume = 0;
  const volumeUnits = new Set();

  for (const item of items || []) {
    totalPackages += toNumber(item.packagesCount, 0);
    totalWeight += toNumber(item.weightTotal, 0);
    totalVolume += toNumber(item.volume, 0);
    if (toNumber(item.volume, 0) > 0 && item.dimensionUnit) {
      volumeUnits.add(item.dimensionUnit);
    }
  }

  const singleVolumeUnit = volumeUnits.size === 1 ? Array.from(volumeUnits)[0] : '';
  return {
    totalPackages: round3(totalPackages),
    totalWeight: round3(totalWeight),
    totalVolume: round3(totalVolume),
    volumeUnit: singleVolumeUnit,
    hasMixedVolumeUnits: volumeUnits.size > 1
  };
}

function mapInvoiceHeaderRow(row) {
  const issueDate = normalizeDateInput(row.issue_date) || normalizeDateInput(row.created_at);
  const dueDate = normalizeDateInput(row.due_date);
  const status = normalizeInvoiceStatus(row.status);
  const base = {
    id: row.id,
    legacyInvoiceId: row.legacy_invoice_id,
    invoiceNumber: normalizeText(row.invoice_number) || `FAC-${String(row.id).padStart(6, '0')}`,
    source: normalizeText(row.source) || 'legacy',
    customerId: row.customer_id,
    customerName: normalizeText(row.customer_name_snapshot) || normalizeText(row.customer_live_name) || 'Mostrador',
    customerCode: normalizeText(row.customer_code_snapshot) || normalizeText(row.customer_live_code),
    customerEmail: normalizeText(row.customer_email_snapshot) || normalizeText(row.customer_live_email),
    customerPhone: normalizeText(row.customer_phone_snapshot) || normalizeText(row.customer_live_phone),
    customerAddress: normalizeText(row.customer_address_snapshot) || normalizeText(row.customer_live_address),
    issueDate,
    dueDate,
    paymentMethod: normalizeText(row.payment_method),
    invoiceLanguage: normalizeInvoiceLanguage(row.invoice_language),
    status,
    subtotal: round2(toNumber(row.subtotal, 0)),
    taxTotal: round2(toNumber(row.tax_total, row.tax_amount)),
    discountTotal: round2(toNumber(row.discount_total, row.discount_amount)),
    total: round2(toNumber(row.total, 0)),
    paidTotal: round2(toNumber(row.paid_total, 0)),
    balanceDue: round2(toNumber(row.balance_due, Math.max(0, toNumber(row.total, 0) - toNumber(row.paid_total, 0)))),
    notes: normalizeText(row.notes),
    currency: normalizeText(row.currency) || 'GTQ',
    exchangeRate: toNumber(row.exchange_rate, 1) || 1,
    subtotalBase: round2(toNumber(row.subtotal_base, 0)),
    taxTotalBase: round2(toNumber(row.tax_amount_base, 0)),
    discountTotalBase: round2(toNumber(row.discount_amount_base, 0)),
    totalBase: round2(toNumber(row.total_base, 0)),
    createdAt: normalizeDateTime(row.created_at),
    updatedAt: normalizeDateTime(row.updated_at || row.created_at),
    emittedAt: normalizeDateTime(row.emitted_at),
    paidAt: normalizeDateTime(row.paid_at),
    voidedAt: normalizeDateTime(row.voided_at),
    voidedReason: normalizeText(row.voided_reason),
    createdByName: normalizeText(row.created_by_name),
    updatedByName: normalizeText(row.updated_by_name),
    voidedByName: normalizeText(row.voided_by_name),
    stockApplied: Boolean(Number(row.stock_applied)),
    createdAtDate: normalizeDateInput(row.created_at)
  };
  base.effectiveStatus = deriveEffectiveInvoiceStatus(base);
  base.statusMeta = resolveInvoiceStatusMeta(base);
  return base;
}

function parseInvoiceLinesFromRequest(body) {
  if (body && body.lines_json) {
    try {
      const parsed = JSON.parse(body.lines_json);
      if (Array.isArray(parsed)) return parsed;
    } catch (error) {
      return [];
    }
  }

  const itemIdsRaw = asArray(body && body.item_id);
  const descriptionsRaw = asArray(body && body.description);
  const qtysRaw = asArray(body && body.qty);
  const unitPricesRaw = asArray(body && body.unit_price);
  const discountTypesRaw = asArray(body && body.discount_type_line);
  const discountValuesRaw = asArray(body && body.discount_value_line);
  const taxRatesRaw = asArray(body && body.tax_rate_line);
  const lineTypesRaw = asArray(body && body.line_type);

  const maxLength = Math.max(
    itemIdsRaw.length,
    descriptionsRaw.length,
    qtysRaw.length,
    unitPricesRaw.length,
    discountTypesRaw.length,
    discountValuesRaw.length,
    taxRatesRaw.length,
    lineTypesRaw.length
  );

  const lines = [];
  for (let index = 0; index < maxLength; index += 1) {
    lines.push({
      item_id: itemIdsRaw[index],
      description: descriptionsRaw[index],
      qty: qtysRaw[index],
      unit_price: unitPricesRaw[index],
      discount_type: discountTypesRaw[index],
      discount_value: discountValuesRaw[index],
      tax_rate: taxRatesRaw[index],
      line_type: lineTypesRaw[index]
    });
  }
  return lines;
}

function prepareInvoiceLines(options) {
  const {
    rawLines,
    inventoryCatalog,
    defaultTaxRate,
    manualServiceItemId,
    negativeStockAllowed
  } = options;
  const itemMap = new Map((inventoryCatalog || []).map((item) => [item.id, item]));
  const lines = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] || {};
    const itemId = parsePositiveInt(raw.item_id || raw.itemId);
    const inventoryItem = itemId ? itemMap.get(itemId) : null;
    const lineType = normalizeLineType(raw.line_type || raw.lineType || (inventoryItem ? 'inventory' : 'manual'));
    const qty = toPositiveNumber(raw.qty, 0);
    const unitPrice = toNumber(raw.unit_price || raw.unitPrice, inventoryItem ? inventoryItem.price : 0);
    const taxRate = toNumber(raw.tax_rate || raw.taxRate, inventoryItem ? inventoryItem.taxRate : defaultTaxRate);
    const discountType = normalizeDiscountType(raw.discount_type || raw.discountType);
    const discountValue = toNumber(raw.discount_value || raw.discountValue, 0);
    const description = normalizeText(raw.description) || (inventoryItem ? inventoryItem.name : '');

    if (!qty || qty <= 0) {
      return { ok: false, error: `La línea ${index + 1} debe tener una cantidad válida.` };
    }

    if (unitPrice < 0) {
      return { ok: false, error: `La línea ${index + 1} tiene un precio unitario inválido.` };
    }

    if (lineType === 'inventory' && !inventoryItem) {
      return { ok: false, error: `La línea ${index + 1} requiere un artículo de inventario válido.` };
    }

    if (lineType === 'manual' && !description) {
      return { ok: false, error: `La línea ${index + 1} requiere una descripción manual.` };
    }

    if (lineType === 'inventory' && !negativeStockAllowed) {
      const stockAfter = toNumber(inventoryItem.qty, 0) - qty;
      if (stockAfter < 0) {
        return {
          ok: false,
          error: `No hay stock suficiente para ${inventoryItem.name}. Disponible: ${inventoryItem.qty}.`
        };
      }
    }

    const subtotal = round2(qty * unitPrice);
    const discountAmount = normalizeDiscountAmount(discountType, discountValue, subtotal);
    const taxableBase = Math.max(0, round2(subtotal - discountAmount));
    const taxAmount = round2(taxableBase * (taxRate / 100));
    const total = round2(taxableBase + taxAmount);

    lines.push({
      lineType,
      itemId: inventoryItem ? inventoryItem.id : null,
      legacyItemId: lineType === 'inventory' ? inventoryItem.id : manualServiceItemId,
      description,
      itemName: inventoryItem ? inventoryItem.name : description,
      sku: inventoryItem ? inventoryItem.sku : '',
      barcode: inventoryItem ? inventoryItem.barcode : '',
      categoryName: inventoryItem ? inventoryItem.categoryName : '',
      qty,
      unitPrice,
      taxRate,
      taxAmount,
      discountType,
      discountValue,
      discountAmount,
      subtotal,
      total,
      stockAvailable: inventoryItem ? toNumber(inventoryItem.qty, 0) : 0,
      minStock: inventoryItem ? toNumber(inventoryItem.minStock, 0) : 0
    });
  }

  if (!lines.length) {
    return { ok: false, error: 'La factura debe incluir al menos una línea válida.' };
  }

  return { ok: true, lines };
}

function computeInvoiceTotals(lines) {
  return lines.reduce(
    (acc, line) => {
      acc.subtotal += toNumber(line.subtotal, 0);
      acc.discountTotal += toNumber(line.discountAmount, 0);
      acc.taxTotal += toNumber(line.taxAmount, 0);
      acc.total += toNumber(line.total, 0);
      return acc;
    },
    { subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0 }
  );
}

function deriveInvoiceSource(lines) {
  const types = new Set(lines.map((line) => line.lineType));
  if (types.has('inventory') && types.has('manual')) return 'mixed';
  if (types.has('inventory')) return 'inventory';
  return 'manual';
}

async function ensureManualServiceItem(db, companyId) {
  const existing = await getDb(
    db,
    'SELECT id, name, sku FROM items WHERE company_id = ? AND sku = ? LIMIT 1',
    [companyId, 'MANUAL-SERVICE']
  );
  if (existing) return existing;

  const created = await runDb(
    db,
    `INSERT INTO items
     (name, sku, item_code, code_manual, qty, min_stock, warehouse_location, barcode, price, category_id, brand_id, company_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    ['Manual / Servicio', 'MANUAL-SERVICE', 'MANUAL', 1, 0, 0, null, null, 0, null, null, companyId]
  );
  return { id: created.lastID, name: 'Manual / Servicio', sku: 'MANUAL-SERVICE' };
}

async function applyInventoryForIssuedInvoice(db, companyId, headerId, userId, negativeStockAllowed) {
  const header = await getDb(
    db,
    'SELECT id, stock_applied FROM invoice_headers WHERE id = ? AND company_id = ?',
    [headerId, companyId]
  );
  if (!header || Number(header.stock_applied) === 1) return;

  const lines = await allDb(
    db,
    `SELECT id, item_id, qty, description
     FROM invoice_items
     WHERE company_id = ? AND header_id = ? AND line_type = 'inventory' AND item_id IS NOT NULL`,
    [companyId, headerId]
  );

  for (const line of lines || []) {
    const item = await getDb(
      db,
      'SELECT id, name, qty, min_stock FROM items WHERE id = ? AND company_id = ?',
      [line.item_id, companyId]
    );
    if (!item) continue;
    const stockBefore = toNumber(item.qty, 0);
    const stockAfter = round2(stockBefore - toNumber(line.qty, 0));
    if (!negativeStockAllowed && stockAfter < 0) {
      throw new Error(`Stock insuficiente para ${item.name}.`);
    }
    await runDb(db, 'UPDATE items SET qty = ? WHERE id = ? AND company_id = ?', [stockAfter, item.id, companyId]);
    await runDb(
      db,
      `INSERT INTO invoice_inventory_movements
       (invoice_header_id, invoice_item_id, item_id, company_id, movement_type, qty, stock_before, stock_after, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        headerId,
        line.id,
        item.id,
        companyId,
        'deduction',
        toNumber(line.qty, 0),
        stockBefore,
        stockAfter,
        stockAfter <= toNumber(item.min_stock, 0)
          ? `Stock en mínimo o por debajo tras emitir ${line.description || item.name}`
          : `Salida por facturación ${line.description || item.name}`,
        userId || null
      ]
    );
  }

  await runDb(
    db,
    `UPDATE invoice_headers
     SET stock_applied = 1,
         updated_by = ?,
         updated_at = CURRENT_TIMESTAMP,
         emitted_at = COALESCE(emitted_at, CURRENT_TIMESTAMP),
         status = CASE WHEN status = 'draft' OR status = 'pending_signature' THEN 'issued' ELSE status END
     WHERE id = ? AND company_id = ?`,
    [userId || null, headerId, companyId]
  );
}

async function reverseInventoryForVoidedInvoice(db, companyId, headerId, userId) {
  const existingRestock = await getDb(
    db,
    `SELECT COUNT(*) AS total
     FROM invoice_inventory_movements
     WHERE company_id = ? AND invoice_header_id = ? AND movement_type = 'restock'`,
    [companyId, headerId]
  );
  if (existingRestock && Number(existingRestock.total) > 0) {
    await runDb(
      db,
      'UPDATE invoice_headers SET stock_applied = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
      [userId || null, headerId, companyId]
    );
    return;
  }

  const movements = await allDb(
    db,
    `SELECT invoice_item_id, item_id, qty
     FROM invoice_inventory_movements
     WHERE company_id = ? AND invoice_header_id = ? AND movement_type = 'deduction'
     ORDER BY id ASC`,
    [companyId, headerId]
  );

  for (const movement of movements || []) {
    const item = await getDb(
      db,
      'SELECT id, name, qty FROM items WHERE id = ? AND company_id = ?',
      [movement.item_id, companyId]
    );
    if (!item) continue;
    const stockBefore = toNumber(item.qty, 0);
    const stockAfter = round2(stockBefore + toNumber(movement.qty, 0));
    await runDb(db, 'UPDATE items SET qty = ? WHERE id = ? AND company_id = ?', [stockAfter, item.id, companyId]);
    await runDb(
      db,
      `INSERT INTO invoice_inventory_movements
       (invoice_header_id, invoice_item_id, item_id, company_id, movement_type, qty, stock_before, stock_after, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        headerId,
        movement.invoice_item_id,
        item.id,
        companyId,
        'restock',
        toNumber(movement.qty, 0),
        stockBefore,
        stockAfter,
        'Reintegro por anulación de factura',
        userId || null
      ]
    );
  }

  await runDb(
    db,
    'UPDATE invoice_headers SET stock_applied = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
    [userId || null, headerId, companyId]
  );
}

async function syncInvoicePaymentStatus(db, headerId, companyId, userId) {
  const [header, paymentTotals] = await Promise.all([
    getDb(
      db,
      `SELECT id, company_id, status, total, due_date
       FROM invoice_headers
       WHERE id = ? AND company_id = ?`,
      [headerId, companyId]
    ),
    getDb(
      db,
      `SELECT COALESCE(SUM(amount), 0) AS paid_total
       FROM invoice_payments
       WHERE company_id = ? AND invoice_header_id = ?`,
      [companyId, headerId]
    )
  ]);

  if (!header) return;
  if (normalizeInvoiceStatus(header.status) === 'voided') return;

  const paidTotal = round2(toNumber(paymentTotals && paymentTotals.paid_total, 0));
  const total = round2(toNumber(header.total, 0));
  const balanceDue = round2(Math.max(0, total - paidTotal));
  let nextStatus = normalizeInvoiceStatus(header.status);

  if (paidTotal <= 0) {
    nextStatus = nextStatus === 'paid' || nextStatus === 'partially_paid' ? 'issued' : nextStatus;
  } else if (balanceDue <= 0) {
    nextStatus = 'paid';
  } else {
    nextStatus = 'partially_paid';
  }

  await runDb(
    db,
    `UPDATE invoice_headers
     SET paid_total = ?, balance_due = ?, status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP,
         paid_at = CASE WHEN ? = 'paid' THEN CURRENT_TIMESTAMP ELSE paid_at END
     WHERE id = ? AND company_id = ?`,
    [paidTotal, balanceDue, nextStatus, userId || null, nextStatus, headerId, companyId]
  );

  if (normalizeInvoiceStatus(header.status) !== nextStatus) {
    await insertInvoiceStatusHistory(db, headerId, companyId, normalizeInvoiceStatus(header.status), nextStatus, 'Estado actualizado por pago', userId);
  }
}

async function insertInvoiceStatusHistory(db, headerId, companyId, fromStatus, toStatus, notes, changedBy) {
  await runDb(
    db,
    `INSERT INTO invoice_status_history
     (invoice_header_id, company_id, from_status, to_status, notes, changed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [headerId, companyId, fromStatus || null, toStatus || null, notes || null, changedBy || null]
  );
}

function deriveEffectiveInvoiceStatus(invoice) {
  const normalized = normalizeInvoiceStatus(invoice.status);
  if (normalized === 'voided') return 'voided';
  if (normalized === 'paid') return 'paid';
  if (normalized === 'partially_paid') {
    if (invoice.dueDate && invoice.balanceDue > 0 && invoice.dueDate < todayAsDateInput()) {
      return 'overdue';
    }
    return 'partially_paid';
  }
  if (normalized === 'issued' && invoice.dueDate && invoice.balanceDue > 0 && invoice.dueDate < todayAsDateInput()) {
    return 'overdue';
  }
  return normalized || 'draft';
}

function resolveInvoiceStatusMeta(invoice) {
  const statusKey = invoice.effectiveStatus || normalizeInvoiceStatus(invoice.status) || 'draft';
  return INVOICE_STATUSES[statusKey] || INVOICE_STATUSES.draft;
}

function resolveInvoiceFilters(query, activeTab) {
  const period = normalizeText(query.period) || defaultPeriodForTab(activeTab);
  const range = resolvePeriodRange(period, query.from, query.to);
  const requestedStatus = normalizeInvoiceStatus(query.status);
  const tabStatus = defaultStatusForTab(activeTab);
  return {
    period,
    fromDate: range.fromDate,
    toDate: range.toDate,
    previousRange: range.previousRange,
    status: requestedStatus || tabStatus || null,
    customerId: parsePositiveInt(query.customer_id),
    query: normalizeText(query.q),
    activeTab
  };
}

function buildHeaderFilterWhereClause(companyId, filters, options = {}) {
  const params = [companyId];
  let sql = 'WHERE h.company_id = ?';

  if (filters.customerId) {
    sql += ' AND h.customer_id = ?';
    params.push(filters.customerId);
  }

  if (filters.fromDate) {
    sql += " AND COALESCE(NULLIF(h.issue_date, '')::date, h.created_at::date) >= ?::date";
    params.push(filters.fromDate);
  }

  if (filters.toDate) {
    sql += " AND COALESCE(NULLIF(h.issue_date, '')::date, h.created_at::date) <= ?::date";
    params.push(filters.toDate);
  }

  if (filters.status && !options.excludeStatuses) {
    sql += ' AND h.status = ?';
    params.push(filters.status === 'overdue' ? 'issued' : filters.status);
  }

  if (Array.isArray(options.excludeStatuses) && options.excludeStatuses.length) {
    sql += ` AND h.status NOT IN (${options.excludeStatuses.map(() => '?').join(', ')})`;
    params.push(...options.excludeStatuses);
  }

  if (options.includeQuery !== false && filters.query) {
    const like = `%${filters.query.toLowerCase()}%`;
    sql += ` AND (
      lower(COALESCE(h.invoice_number, '')) LIKE ?
      OR lower(COALESCE(h.customer_name_snapshot, '')) LIKE ?
      OR lower(COALESCE(h.customer_code_snapshot, '')) LIKE ?
      OR lower(COALESCE(h.notes, '')) LIKE ?
    )`;
    params.push(like, like, like, like);
  }

  return { whereSql: sql, params };
}

function defaultStatusForTab(activeTab) {
  switch (activeTab) {
    case 'pendientes':
      return 'pending_signature';
    case 'emitidas':
      return 'issued';
    case 'pagadas':
      return 'paid';
    case 'anuladas':
      return 'voided';
    default:
      return null;
  }
}

function defaultPeriodForTab() {
  return 'month';
}

function resolvePeriodRange(period, rawFrom, rawTo) {
  const today = new Date();
  const current = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let from = null;
  let to = null;

  switch (period) {
    case 'day':
      from = new Date(current);
      to = new Date(current);
      break;
    case 'week': {
      const day = current.getDay() || 7;
      from = new Date(current);
      from.setDate(current.getDate() - day + 1);
      to = new Date(from);
      to.setDate(from.getDate() + 6);
      break;
    }
    case 'month':
      from = new Date(current.getFullYear(), current.getMonth(), 1);
      to = new Date(current.getFullYear(), current.getMonth() + 1, 0);
      break;
    case 'year':
      from = new Date(current.getFullYear(), 0, 1);
      to = new Date(current.getFullYear(), 11, 31);
      break;
    case 'custom':
      from = rawFrom ? new Date(rawFrom) : null;
      to = rawTo ? new Date(rawTo) : null;
      break;
    default:
      from = null;
      to = null;
  }

  const fromDate = isValidDateObject(from) ? formatDateInput(from) : '';
  const toDate = isValidDateObject(to) ? formatDateInput(to) : '';

  let previousRange = null;
  if (fromDate && toDate) {
    const fromTime = new Date(fromDate).getTime();
    const toTime = new Date(toDate).getTime();
    const spanMs = Math.max(0, toTime - fromTime);
    const prevTo = new Date(fromTime - 24 * 60 * 60 * 1000);
    const prevFrom = new Date(prevTo.getTime() - spanMs);
    previousRange = {
      fromDate: formatDateInput(prevFrom),
      toDate: formatDateInput(prevTo)
    };
  }

  return { fromDate, toDate, previousRange };
}

function buildInvoiceModuleTabs(activeTab) {
  return [
    { key: 'dashboard', href: '/invoices?tab=dashboard', label: 'Dashboard' },
    { key: 'facturas', href: '/invoices?tab=facturas', label: 'Facturas' },
    { key: 'nueva-factura', href: '/invoices?tab=nueva', label: 'Nueva factura', billingTab: 'nueva' },
    { key: 'historial-clientes', href: '/invoices?tab=historial', label: 'Historial clientes', billingTab: 'historial' },
    { key: 'reportes', href: '/invoices?tab=reportes', label: 'Reportes' }
  ].map((tab) => ({
    ...tab,
    active: tab.key === activeTab
  }));
}

function resolveInvoiceTab(rawTab) {
  const normalized = normalizeText(rawTab) || 'dashboard';
  const resolved = TAB_ALIASES.get(normalized) || normalized;
  return TAB_KEYS.has(resolved) ? resolved : 'dashboard';
}

function resolveListNotice(query) {
  if (query && query.created === '1') return 'Factura creada correctamente.';
  return null;
}

function resolveDetailNotice(query) {
  if (query && query.created === '1') return 'Factura creada correctamente.';
  if (query && query.payment_saved === '1') return 'Pago registrado correctamente.';
  if (query && query.status_saved === '1') return 'Estado actualizado correctamente.';
  if (query && query.sent === '1') return 'Factura reenviada por correo.';
  if (query && query.error === 'voided') return 'No puedes registrar pagos sobre una factura anulada.';
  if (query && query.payment_error === '1') return 'No se pudo registrar el pago. Verifica el monto.';
  if (query && query.status_error) {
    return query.status_error === '1'
      ? 'La transicion de estado no es valida para esta factura.'
      : decodeURIComponent(query.status_error);
  }
  if (query && query.send_error) {
    if (query.send_error === 'missing_recipient') return 'La factura no tiene un correo de destino para reenviar.';
    if (query.send_error === 'email_not_configured') return 'El correo SMTP no esta configurado en este entorno.';
    return 'No se pudo reenviar la factura por correo.';
  }
  return null;
}

function resolvePackingListNotice(query) {
  if (query && query.saved === '1') return 'Packing List guardado correctamente.';
  return null;
}

function buildInvoiceCsv(rows) {
  const headers = [
    'invoice_number',
    'status',
    'customer',
    'customer_code',
    'issue_date',
    'due_date',
    'currency',
    'subtotal',
    'tax_total',
    'discount_total',
    'total',
    'paid_total',
    'balance_due',
    'payment_method',
    'source'
  ];
  const lines = [headers.join(',')];
  for (const row of rows || []) {
    lines.push([
      csvCell(row.invoiceNumber),
      csvCell(row.effectiveStatus),
      csvCell(row.customerName),
      csvCell(row.customerCode),
      csvCell(row.issueDate),
      csvCell(row.dueDate),
      csvCell(row.currency),
      csvCell(row.subtotal),
      csvCell(row.taxTotal),
      csvCell(row.discountTotal),
      csvCell(row.total),
      csvCell(row.paidTotal),
      csvCell(row.balanceDue),
      csvCell(row.paymentMethod),
      csvCell(row.source)
    ].join(','));
  }
  return lines.join('\n');
}

function buildInvoiceEmailBody(invoice, company, req) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return [
    `${company.name || 'Empresa'} te comparte la factura ${invoice.invoiceNumber}.`,
    '',
    `Cliente: ${invoice.header.customerName}`,
    `Total: ${invoice.header.currency} ${invoice.header.total.toFixed(2)}`,
    `Estado: ${invoice.statusMeta.label}`,
    '',
    `Vista previa: ${baseUrl}/invoices/${invoice.header.id}/preview`
  ].join('\n');
}

async function sendInvoiceEmail(message) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 0);
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!host || !port || !from) {
    throw new Error('email_not_configured');
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  });

  await transport.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    attachments: message.attachments || []
  });
}

async function renderInvoicePdfToBuffer(invoice, company) {
  const chunks = [];
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  doc.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  await drawInvoicePdfV2(doc, invoice, company);
  doc.end();
  await ended;
  return Buffer.concat(chunks);
}

async function renderInvoicePdfToStream(invoice, company, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  doc.pipe(stream);
  await drawInvoicePdfV2(doc, invoice, company);
  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function drawInvoicePdf(doc, invoice, company) {
  const accent = company.secondaryColor || '#2d7c7a';
  const primary = company.primaryColor || '#24455d';
  const pageWidth = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;
  const text = getInvoiceDocumentText(invoice.header.invoiceLanguage);

  doc.rect(0, 0, doc.page.width, 132).fill(primary);
  doc.fillColor('#ffffff');

  if (company.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, doc.page.margins.left, 30, { fit: [84, 54], align: 'left' });
    } catch (error) {
      doc.roundedRect(doc.page.margins.left, 32, 84, 54, 12).fillOpacity(0.12).fill('#ffffff').fillOpacity(1);
    }
  }

  doc.fontSize(22).text(company.name || text.invoice, 140, 38, { width: 240 });
  doc.fontSize(10).fillOpacity(0.86).text(company.legalName || '', 140, 64, { width: 250 });
  doc.text(company.nit ? `NIT: ${company.nit}` : '', 140, 78, { width: 250 });
  doc.text(company.phone || company.email || '', 140, 92, { width: 250 });
  doc.fillOpacity(1);

  doc.roundedRect(doc.page.width - 220, 28, 178, 78, 16).fill('#ffffff');
  doc.fillColor(primary).fontSize(10).text(text.invoice.toUpperCase(), doc.page.width - 200, 42);
  doc.fontSize(18).text(invoice.invoiceNumber, doc.page.width - 200, 58, { width: 150 });
  doc.fontSize(9).fillColor('#506275');
  doc.text(`${text.status}: ${invoice.statusMeta.label}`, doc.page.width - 200, 82, { width: 150 });
  doc.text(`Emisión: ${invoice.header.issueDate || ''}`, doc.page.width - 200, 94, { width: 150 });

  const qrPayload = `${invoice.invoiceNumber}|${invoice.header.customerName}|${invoice.header.total.toFixed(2)}`;
  try {
    const qr = await QRCode.toBuffer(qrPayload, { margin: 1, width: 110 });
    doc.image(qr, doc.page.width - 116, 148, { fit: [74, 74] });
  } catch (error) {
    doc.roundedRect(doc.page.width - 116, 148, 74, 74, 12).strokeColor('#b5c3cc').stroke();
    doc.fontSize(8).fillColor('#657789').text('QR listo para uso futuro', doc.page.width - 112, 178, { width: 66, align: 'center' });
  }

  doc.fillColor('#24313f');
  doc.roundedRect(doc.page.margins.left, 152, pageWidth() - 96, 96, 18).fill('#f6f8fb');
  doc.fillColor('#2a3745').fontSize(10);
  doc.text(text.customer, doc.page.margins.left + 18, 166);
  doc.fontSize(13).text(invoice.header.customerName, doc.page.margins.left + 18, 182, { width: 300 });
  doc.fontSize(9).fillColor('#5f7283');
  doc.text(invoice.header.customerCode ? `Código: ${invoice.header.customerCode}` : 'Cliente mostrador / sin código', doc.page.margins.left + 18, 202, { width: 260 });
  doc.text(invoice.header.customerPhone || invoice.header.customerEmail || '', doc.page.margins.left + 18, 216, { width: 260 });
  doc.text(invoice.header.customerAddress || '', doc.page.margins.left + 18, 230, { width: 320 });

  doc.fillColor('#2a3745').fontSize(10);
  doc.text(text.summary, doc.page.width - 286, 166);
  doc.fontSize(9).fillColor('#5f7283');
  doc.text(`${text.dueDate}: ${invoice.header.dueDate || text.noDueDate}`, doc.page.width - 286, 184, { width: 150 });
  doc.text(`Método: ${invoice.header.paymentMethod || 'No definido'}`, doc.page.width - 286, 198, { width: 150 });
  doc.text(`Moneda: ${invoice.header.currency}`, doc.page.width - 286, 212, { width: 150 });
  doc.text(`Cambio: ${invoice.header.exchangeRate.toFixed(4)}`, doc.page.width - 286, 226, { width: 150 });

  let cursorY = 274;
  const columns = [
    { label: text.description, x: doc.page.margins.left, width: 236 },
    { label: text.quantity, x: 286, width: 48, align: 'right' },
    { label: text.price, x: 344, width: 74, align: 'right' },
    { label: text.taxes, x: 428, width: 64, align: 'right' },
    { label: text.total, x: 502, width: 76, align: 'right' }
  ];

  const drawTableHeader = (startY) => {
    doc.roundedRect(doc.page.margins.left, startY, pageWidth(), 30, 10).fill(primary);
    doc.fillColor('#ffffff').fontSize(9);
    columns.forEach((column) => {
      doc.text(column.label, column.x + 8, startY + 10, { width: column.width - 16, align: column.align || 'left' });
    });
    return startY + 38;
  };

  const drawFooter = (startY) => {
    const footerY = Math.min(startY, pageBottom() - 48);
    doc.moveTo(doc.page.margins.left, footerY).lineTo(doc.page.width - doc.page.margins.right, footerY).strokeColor('#dbe3ea').stroke();
    doc.fillColor('#6a7e90').fontSize(9);
    doc.text(company.taxAddress || company.address || '', doc.page.margins.left, footerY + 10, { width: 260 });
    doc.text('Firma / autorizaciÃ³n', doc.page.width - 170, footerY + 10, { width: 130, align: 'center' });
    doc.moveTo(doc.page.width - 176, footerY + 38).lineTo(doc.page.width - 44, footerY + 38).strokeColor('#93a3af').stroke();
  };

  const drawContinuationHeader = () => {
    doc.roundedRect(doc.page.margins.left, doc.page.margins.top, pageWidth(), 54, 16).fill('#f6f8fb');
    doc.fillColor(primary).fontSize(11).text(text.invoice.toUpperCase(), doc.page.margins.left + 18, doc.page.margins.top + 14);
    doc.fontSize(16).text(invoice.invoiceNumber, doc.page.margins.left + 18, doc.page.margins.top + 28, { width: 240 });
    doc.fontSize(9).fillColor('#5f7283').text(`ContinuaciÃ³n - ${invoice.header.customerName}`, doc.page.width - 220, doc.page.margins.top + 20, {
      width: 160,
      align: 'right'
    });
    return drawTableHeader(doc.page.margins.top + 72);
  };

  cursorY = drawTableHeader(cursorY);

  doc.fillColor('#2a3745');
  invoice.items.forEach((line, index) => {
    const rowHeight = 42;
    if (cursorY + rowHeight + 84 > pageBottom()) {
      doc.addPage();
      cursorY = drawContinuationHeader();
    }
    const rowFill = index % 2 === 0 ? '#f9fbfc' : '#ffffff';
    doc.roundedRect(doc.page.margins.left, cursorY - 2, pageWidth(), rowHeight, 10).fill(rowFill);
    doc.fillColor('#24313f').fontSize(10).text(line.description, columns[0].x + 8, cursorY + 4, { width: columns[0].width - 16 });
    doc.fontSize(8).fillColor('#6a7e90').text(line.sku || line.categoryName || (line.lineType === 'inventory' ? text.inventoryLine : text.manualLine), columns[0].x + 8, cursorY + 22, { width: columns[0].width - 16 });
    doc.fillColor('#24313f').fontSize(10);
    doc.text(line.qty.toFixed(2), columns[1].x, cursorY + 10, { width: columns[1].width, align: 'right' });
    doc.text(`${invoice.header.currency} ${line.unitPrice.toFixed(2)}`, columns[2].x, cursorY + 10, { width: columns[2].width, align: 'right' });
    doc.text(`${line.taxRate.toFixed(2)}%`, columns[3].x, cursorY + 10, { width: columns[3].width, align: 'right' });
    doc.text(`${invoice.header.currency} ${line.total.toFixed(2)}`, columns[4].x, cursorY + 10, { width: columns[4].width, align: 'right' });
    cursorY += rowHeight + 6;
  });

  if (cursorY + 178 > pageBottom()) {
    doc.addPage();
    cursorY = doc.page.margins.top + 20;
  }

  const summaryX = doc.page.width - 220;
  const summaryY = cursorY + 10;
  doc.roundedRect(summaryX, summaryY, 178, 124, 16).fill('#f6f8fb');
  doc.fillColor('#2a3745').fontSize(10);
  doc.text(text.subtotal, summaryX + 14, summaryY + 18);
  doc.text(`${invoice.header.currency} ${invoice.header.subtotal.toFixed(2)}`, summaryX + 84, summaryY + 18, { width: 82, align: 'right' });
  doc.text(text.taxes, summaryX + 14, summaryY + 42);
  doc.text(`${invoice.header.currency} ${invoice.header.taxTotal.toFixed(2)}`, summaryX + 84, summaryY + 42, { width: 82, align: 'right' });
  doc.text(text.discounts, summaryX + 14, summaryY + 66);
  doc.text(`${invoice.header.currency} ${invoice.header.discountTotal.toFixed(2)}`, summaryX + 84, summaryY + 66, { width: 82, align: 'right' });
  doc.fontSize(13).fillColor(accent).text(text.total, summaryX + 14, summaryY + 92);
  doc.text(`${invoice.header.currency} ${invoice.header.total.toFixed(2)}`, summaryX + 84, summaryY + 90, { width: 82, align: 'right' });

  doc.fillColor('#2a3745').fontSize(10);
  doc.text(text.notes, doc.page.margins.left, summaryY + 10, { width: 250 });
  doc.fontSize(9).fillColor('#5f7283').text(invoice.header.notes || text.noNotes, doc.page.margins.left, summaryY + 26, {
    width: 250,
    height: 92
  });

  drawFooter(summaryY + 150);
}

async function drawInvoicePdfV2(doc, invoice, company) {
  const accent = company.secondaryColor || '#2d7c7a';
  const primary = company.primaryColor || '#24455d';
  const ink = '#24313f';
  const muted = '#5f7283';
  const softBorder = '#dbe3ea';
  const panelFill = '#f8fafc';
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;
  const text = getInvoiceDocumentText(invoice.header.invoiceLanguage);
  const measureTextHeight = (value, fontSize, width, options = {}) => {
    if (!value) return 0;
    doc.fontSize(fontSize);
    return doc.heightOfString(String(value), { width, ...options });
  };
  const drawPanel = (x, y, width, height, options = {}) => {
    const radius = options.radius || 16;
    doc.roundedRect(x, y, width, height, radius).fill(options.fill || panelFill);
    doc.roundedRect(x, y, width, height, radius).lineWidth(options.lineWidth || 1).strokeColor(options.stroke || softBorder).stroke();
    if (options.accentBarColor) {
      doc.roundedRect(x + 10, y + 10, 4, Math.max(22, height - 20), 2).fill(options.accentBarColor);
    }
  };
  const drawSectionLabel = (label, x, y, width) => {
    doc.fillColor(accent).fontSize(8).text(label.toUpperCase(), x, y, {
      width,
      lineGap: 1
    });
  };

  const drawFooter = (minimumY) => {
    const footerHeight = 48;
    const footerY = Math.max(minimumY, pageBottom() - footerHeight);
    doc.moveTo(left, footerY).lineTo(right, footerY).strokeColor('#dbe3ea').stroke();
    doc.fillColor(muted).fontSize(9);
    doc.text(company.taxAddress || company.address || '', left, footerY + 10, { width: 260 });
    doc.text('Firma / autorizacion', right - 130, footerY + 10, { width: 130, align: 'center' });
    doc.moveTo(right - 136, footerY + 38).lineTo(right, footerY + 38).strokeColor('#93a3af').stroke();
  };

  const rightCardWidth = 178;
  const rightCardX = right - rightCardWidth;
  const headerTextX = left + 98;
  const headerTextWidth = Math.max(180, rightCardX - headerTextX - 18);
  const companyLines = [
    { value: company.name || text.invoice, size: 22, color: '#ffffff', lineGap: 1 },
    { value: company.legalName || '', size: 10, color: '#d7e1ea', lineGap: 0 },
    { value: company.nit ? `NIT: ${company.nit}` : '', size: 10, color: '#d7e1ea', lineGap: 0 },
    { value: company.phone || company.email || '', size: 10, color: '#d7e1ea', lineGap: 0 }
  ].filter((line) => line.value);
  const companyBlockHeight = companyLines.reduce((total, line, index) => {
    return total + measureTextHeight(line.value, line.size, headerTextWidth, { lineGap: line.lineGap }) + (index < companyLines.length - 1 ? 4 : 0);
  }, 0);
  const invoiceCardLines = [
    { value: text.invoice.toUpperCase(), size: 10, color: primary, lineGap: 0 },
    { value: invoice.invoiceNumber, size: 18, color: primary, lineGap: 1 },
    { value: `${text.issueDate}: ${invoice.header.issueDate || text.noDate}`, size: 9, color: '#506275', lineGap: 0 }
  ];
  const invoiceCardContentHeight = invoiceCardLines.reduce((total, line, index) => {
    return total + measureTextHeight(line.value, line.size, 138, { lineGap: line.lineGap }) + (index < invoiceCardLines.length - 1 ? 4 : 0);
  }, 0);
  const invoiceCardHeight = Math.max(78, invoiceCardContentHeight + 28);
  const headerHeight = Math.max(132, 28 + Math.max(54, companyBlockHeight, invoiceCardHeight) + 24);

  doc.rect(0, 0, doc.page.width, headerHeight).fill(primary);
  doc.fillColor('#ffffff');

  if (company.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, left, 30, { fit: [84, 54], align: 'left' });
    } catch (error) {
      doc.roundedRect(left, 32, 84, 54, 12).fillOpacity(0.12).fill('#ffffff').fillOpacity(1);
    }
  }

  let headerCursorY = 38;
  companyLines.forEach((line) => {
    doc.fillColor(line.color).fontSize(line.size).text(line.value, headerTextX, headerCursorY, {
      width: headerTextWidth,
      lineGap: line.lineGap
    });
    headerCursorY += measureTextHeight(line.value, line.size, headerTextWidth, { lineGap: line.lineGap }) + 4;
  });

  drawPanel(rightCardX, 28, rightCardWidth, invoiceCardHeight, { fill: '#ffffff', stroke: '#cfd9e2' });
  doc.roundedRect(rightCardX + 20, 40, 94, 20, 10).fill(accent);
  doc.fillColor('#ffffff').fontSize(8).text(invoice.statusMeta.label.toUpperCase(), rightCardX + 20, 46, {
    width: 94,
    align: 'center'
  });
  let invoiceCardCursorY = 42;
  invoiceCardLines.forEach((line) => {
    if (line.value === text.invoice.toUpperCase()) invoiceCardCursorY = 68;
    doc.fillColor(line.color).fontSize(line.size).text(line.value, rightCardX + 20, invoiceCardCursorY, {
      width: 138,
      lineGap: line.lineGap
    });
    invoiceCardCursorY += measureTextHeight(line.value, line.size, 138, { lineGap: line.lineGap }) + 4;
  });

  const detailSectionY = headerHeight + 20;
  const sidebarWidth = 164;
  const sectionGap = 18;
  const customerCardWidth = contentWidth - sidebarWidth - sectionGap;
  const customerCardX = left;
  const sidebarX = customerCardX + customerCardWidth + sectionGap;
  const customerTextWidth = customerCardWidth - 36;
  const customerLines = [
    { value: text.customer, size: 10, color: '#2a3745', lineGap: 0 },
    { value: invoice.header.customerName || text.noContact, size: 13, color: '#24313f', lineGap: 1 },
    {
      value: invoice.header.customerCode ? `Codigo: ${invoice.header.customerCode}` : 'Cliente mostrador / sin codigo',
      size: 9,
      color: muted,
      lineGap: 0
    },
    { value: invoice.header.customerPhone || invoice.header.customerEmail || text.noContact, size: 9, color: muted, lineGap: 0 },
    { value: invoice.header.customerAddress || '', size: 9, color: muted, lineGap: 0 }
  ].filter((line) => line.value);
  const customerCardHeight = Math.max(108, customerLines.reduce((total, line, index) => {
    return total + measureTextHeight(line.value, line.size, customerTextWidth, { lineGap: line.lineGap }) + (index < customerLines.length - 1 ? 6 : 0);
  }, 0) + 30);

  const summaryTextWidth = sidebarWidth - 28;
  const summaryLines = [
    { value: text.summary, size: 10, color: '#2a3745', lineGap: 0 },
    { value: `${text.dueDate}: ${invoice.header.dueDate || text.noDueDate}`, size: 9, color: muted, lineGap: 0 },
    { value: `${text.paymentMethod}: ${invoice.header.paymentMethod || text.noMethod}`, size: 9, color: muted, lineGap: 0 },
    { value: `Moneda: ${invoice.header.currency}`, size: 9, color: muted, lineGap: 0 },
    { value: `Cambio: ${invoice.header.exchangeRate.toFixed(4)}`, size: 9, color: muted, lineGap: 0 }
  ];
  const summaryCardHeight = Math.max(104, summaryLines.reduce((total, line, index) => {
    return total + measureTextHeight(line.value, line.size, summaryTextWidth, { lineGap: line.lineGap }) + (index < summaryLines.length - 1 ? 6 : 0);
  }, 0) + 28);
  const qrCardSize = 90;
  const qrCardY = detailSectionY + summaryCardHeight + 12;
  const detailSectionBottom = Math.max(detailSectionY + customerCardHeight, qrCardY + qrCardSize);

  drawPanel(customerCardX, detailSectionY, customerCardWidth, customerCardHeight, { accentBarColor: accent });
  drawSectionLabel(text.customer, customerCardX + 22, detailSectionY + 16, customerTextWidth);
  let customerCursorY = detailSectionY + 32;
  customerLines.forEach((line) => {
    doc.fillColor(line.color).fontSize(line.size).text(line.value, customerCardX + 18, customerCursorY, {
      width: customerTextWidth,
      lineGap: line.lineGap
    });
    customerCursorY += measureTextHeight(line.value, line.size, customerTextWidth, { lineGap: line.lineGap }) + 6;
  });

  drawPanel(sidebarX, detailSectionY, sidebarWidth, summaryCardHeight, { accentBarColor: primary });
  drawSectionLabel(text.summary, sidebarX + 18, detailSectionY + 16, summaryTextWidth);
  let summaryCursorY = detailSectionY + 32;
  summaryLines.forEach((line) => {
    doc.fillColor(line.color).fontSize(line.size).text(line.value, sidebarX + 14, summaryCursorY, {
      width: summaryTextWidth,
      lineGap: line.lineGap
    });
    summaryCursorY += measureTextHeight(line.value, line.size, summaryTextWidth, { lineGap: line.lineGap }) + 6;
  });

  drawPanel(sidebarX, qrCardY, qrCardSize, qrCardSize, { fill: '#ffffff' });
  const qrPayload = `${invoice.invoiceNumber}|${invoice.header.customerName}|${invoice.header.total.toFixed(2)}`;
  try {
    const qr = await QRCode.toBuffer(qrPayload, { margin: 1, width: 110 });
    doc.image(qr, sidebarX + 8, qrCardY + 8, { fit: [qrCardSize - 16, qrCardSize - 16] });
  } catch (error) {
    doc.roundedRect(sidebarX + 8, qrCardY + 8, qrCardSize - 16, qrCardSize - 16, 12).strokeColor('#b5c3cc').stroke();
    doc.fontSize(8).fillColor(muted).text('QR listo', sidebarX + 18, qrCardY + 34, {
      width: qrCardSize - 36,
      align: 'center'
    });
  }

  const colGap = 10;
  const totalWidth = 76;
  const taxWidth = 60;
  const priceWidth = 74;
  const qtyWidth = 50;
  const totalX = right - totalWidth;
  const taxX = totalX - colGap - taxWidth;
  const priceX = taxX - colGap - priceWidth;
  const qtyX = priceX - colGap - qtyWidth;
  const descriptionWidth = qtyX - colGap - left;
  const columns = [
    { label: text.description, x: left, width: descriptionWidth },
    { label: text.quantity, x: qtyX, width: qtyWidth, align: 'right' },
    { label: text.price, x: priceX, width: priceWidth, align: 'right' },
    { label: text.taxes, x: taxX, width: taxWidth, align: 'right' },
    { label: text.total, x: totalX, width: totalWidth, align: 'right' }
  ];

  const drawTableHeader = (startY) => {
    doc.roundedRect(left, startY, contentWidth, 30, 10).fill(primary);
    doc.fillColor('#ffffff').fontSize(9);
    columns.forEach((column) => {
      doc.text(column.label, column.x + 6, startY + 10, { width: column.width - 12, align: column.align || 'left' });
    });
    return startY + 38;
  };

  const drawContinuationHeader = () => {
    drawPanel(left, doc.page.margins.top, contentWidth, 56, { accentBarColor: accent });
    doc.fillColor(primary).fontSize(11).text(text.invoice.toUpperCase(), left + 18, doc.page.margins.top + 14);
    doc.fontSize(16).text(invoice.invoiceNumber, left + 18, doc.page.margins.top + 28, { width: 240 });
    doc.fontSize(9).fillColor(muted).text(`Continuacion - ${invoice.header.customerName}`, right - 180, doc.page.margins.top + 20, {
      width: 160,
      align: 'right'
    });
    return drawTableHeader(doc.page.margins.top + 74);
  };

  let cursorY = drawTableHeader(detailSectionBottom + 20);
  doc.fillColor('#2a3745');
  invoice.items.forEach((line, index) => {
    const description = normalizeText(line.description) || 'Sin descripcion';
    const meta = normalizeText(line.sku || line.categoryName || (line.lineType === 'inventory' ? text.inventoryLine : text.manualLine));
    const descriptionHeight = measureTextHeight(description, 10, columns[0].width - 16, { lineGap: 1 });
    const metaHeight = measureTextHeight(meta, 8, columns[0].width - 16);
    const valueHeight = measureTextHeight(`${invoice.header.currency} ${line.total.toFixed(2)}`, 10, totalWidth);
    const rowHeight = Math.max(40, 8 + descriptionHeight + 4 + metaHeight + 8, 12 + valueHeight + 12);

    if (cursorY + rowHeight + 70 > pageBottom()) {
      doc.addPage();
      cursorY = drawContinuationHeader();
    }

    const rowFill = index % 2 === 0 ? '#f9fbfc' : '#ffffff';
    drawPanel(left, cursorY - 2, contentWidth, rowHeight, { fill: rowFill, stroke: '#edf2f7', radius: 10 });
    const descriptionY = cursorY + 8;
    const metaY = descriptionY + descriptionHeight + 4;
    const numericY = cursorY + Math.max(10, (rowHeight - valueHeight) / 2);

    doc.fillColor(ink).fontSize(10).text(description, columns[0].x + 8, descriptionY, {
      width: columns[0].width - 16,
      lineGap: 1
    });
    doc.fontSize(8).fillColor(muted).text(meta, columns[0].x + 8, metaY, { width: columns[0].width - 16 });
    doc.fillColor(ink).fontSize(10);
    doc.text(line.qty.toFixed(2), columns[1].x, numericY, { width: columns[1].width, align: 'right' });
    doc.text(`${invoice.header.currency} ${line.unitPrice.toFixed(2)}`, columns[2].x, numericY, { width: columns[2].width, align: 'right' });
    doc.text(`${line.taxRate.toFixed(2)}%`, columns[3].x, numericY, { width: columns[3].width, align: 'right' });
    doc.text(`${invoice.header.currency} ${line.total.toFixed(2)}`, columns[4].x, numericY, { width: columns[4].width, align: 'right' });
    cursorY += rowHeight + 8;
  });

  const summaryWidth = 186;
  const notesWidth = contentWidth - summaryWidth - sectionGap;
  const notesText = invoice.header.notes || text.noNotes;
  const notesTextHeight = measureTextHeight(notesText, 9, notesWidth - 28, { lineGap: 1 });
  const notesCardHeight = Math.max(110, 18 + measureTextHeight(text.notes, 10, notesWidth - 28) + 8 + notesTextHeight + 18);
  const summaryRows = [
    { label: text.subtotal, value: `${invoice.header.currency} ${invoice.header.subtotal.toFixed(2)}`, size: 10, color: '#2a3745' },
    { label: text.taxes, value: `${invoice.header.currency} ${invoice.header.taxTotal.toFixed(2)}`, size: 10, color: '#2a3745' },
    { label: text.discounts, value: `${invoice.header.currency} ${invoice.header.discountTotal.toFixed(2)}`, size: 10, color: '#2a3745' },
    { label: text.paid, value: `${invoice.header.currency} ${invoice.header.paidTotal.toFixed(2)}`, size: 10, color: '#2a3745' },
    { label: text.total, value: `${invoice.header.currency} ${invoice.header.total.toFixed(2)}`, size: 12, color: accent },
    { label: text.balanceDue, value: `${invoice.header.currency} ${invoice.header.balanceDue.toFixed(2)}`, size: 12, color: primary }
  ];
  const totalsCardHeight = 22 + summaryRows.reduce((total, row) => total + row.size + 14, 0);
  const blockHeight = Math.max(notesCardHeight, totalsCardHeight);

  if (cursorY + 18 + blockHeight + 66 > pageBottom()) {
    doc.addPage();
    cursorY = doc.page.margins.top + 20;
  }

  const notesY = cursorY + 10;
  const summaryX = right - summaryWidth;
  drawPanel(left, notesY, notesWidth, notesCardHeight, { accentBarColor: accent });
  drawSectionLabel(text.notes, left + 20, notesY + 16, notesWidth - 34);
  doc.fillColor(ink).fontSize(10).text(notesText, left + 14, notesY + 34, {
    width: notesWidth - 28,
    lineGap: 1
  });

  drawPanel(summaryX, notesY, summaryWidth, totalsCardHeight, { fill: '#f7faf9', stroke: '#d7e7e4' });
  let totalsCursorY = notesY + 16;
  summaryRows.forEach((row, index) => {
    if (index >= 4) {
      doc.roundedRect(summaryX + 10, totalsCursorY - 4, summaryWidth - 20, row.size + 10, 8).fill(index === 4 ? '#e9f7f3' : '#eef4f8');
    }
    doc.fillColor(row.color).fontSize(row.size).text(row.label, summaryX + 14, totalsCursorY, { width: 78 });
    doc.text(row.value, summaryX + 84, totalsCursorY, { width: 88, align: 'right' });
    if (index < summaryRows.length - 1) {
      doc.moveTo(summaryX + 14, totalsCursorY + row.size + 5).lineTo(summaryX + summaryWidth - 14, totalsCursorY + row.size + 5).strokeColor('#e4ebf1').stroke();
    }
    totalsCursorY += row.size + 14;
  });

  drawFooter(notesY + blockHeight + 18);
}

async function renderPackingListPdfToStream(invoice, company, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  doc.pipe(stream);
  drawPackingListPdf(doc, invoice, company);
  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function drawPackingListPdf(doc, invoice, company) {
  const primary = company.primaryColor || '#24455d';
  const accent = company.secondaryColor || '#2d7c7a';
  const ink = '#24313f';
  const muted = '#5f7283';
  const softBorder = '#dbe3ea';
  const panelFill = '#f8fafc';
  const text = getInvoiceDocumentText(invoice.header.invoiceLanguage);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;
  const measureTextHeight = (value, fontSize, width, options = {}) => {
    if (!value) return 0;
    doc.fontSize(fontSize);
    return doc.heightOfString(String(value), { width, ...options });
  };
  const drawPanel = (x, y, width, height, options = {}) => {
    const radius = options.radius || 16;
    doc.roundedRect(x, y, width, height, radius).fill(options.fill || panelFill);
    doc.roundedRect(x, y, width, height, radius).lineWidth(options.lineWidth || 1).strokeColor(options.stroke || softBorder).stroke();
    if (options.accentBarColor) {
      doc.roundedRect(x + 10, y + 10, 4, Math.max(22, height - 20), 2).fill(options.accentBarColor);
    }
  };
  const drawSectionLabel = (label, x, y, width) => {
    doc.fillColor(accent).fontSize(8).text(label.toUpperCase(), x, y, {
      width,
      lineGap: 1
    });
  };
  const drawFooter = (minimumY) => {
    const footerHeight = 42;
    const footerY = Math.max(minimumY, pageBottom() - footerHeight);
    doc.moveTo(left, footerY).lineTo(right, footerY).strokeColor(softBorder).stroke();
    doc.fillColor(muted).fontSize(9);
    doc.text(company.taxAddress || company.address || '', left, footerY + 10, { width: 300 });
  };

  const headerCardWidth = 188;
  const headerCardX = right - headerCardWidth;
  const headerTextX = left + 98;
  const headerTextWidth = Math.max(180, headerCardX - headerTextX - 18);
  const headerLines = [
    { value: text.packingList, size: 22, color: '#ffffff', lineGap: 1 },
    { value: company.name || '', size: 10, color: '#d7e1ea', lineGap: 0 },
    { value: company.legalName || '', size: 10, color: '#d7e1ea', lineGap: 0 }
  ].filter((line) => line.value);
  const headerTextHeight = headerLines.reduce((total, line, index) => {
    return total + measureTextHeight(line.value, line.size, headerTextWidth, { lineGap: line.lineGap }) + (index < headerLines.length - 1 ? 4 : 0);
  }, 0);
  const metaLines = [
    { value: text.invoiceNumber.toUpperCase(), size: 10, color: primary, lineGap: 0 },
    { value: invoice.invoiceNumber || `#${invoice.header.id}`, size: 16, color: primary, lineGap: 1 },
    { value: `${text.date}: ${invoice.header.issueDate || text.noDate}`, size: 9, color: '#506275', lineGap: 0 }
  ];
  const metaHeight = metaLines.reduce((total, line, index) => {
    return total + measureTextHeight(line.value, line.size, 148, { lineGap: line.lineGap }) + (index < metaLines.length - 1 ? 4 : 0);
  }, 0);
  const headerCardHeight = Math.max(74, metaHeight + 28);
  const headerHeight = Math.max(120, 28 + Math.max(54, headerTextHeight, headerCardHeight) + 22);

  doc.rect(0, 0, doc.page.width, headerHeight).fill(primary);
  doc.fillColor('#ffffff');

  if (company.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, left, 28, { fit: [84, 54], align: 'left' });
    } catch (error) {
      doc.roundedRect(left, 30, 84, 54, 12).fillOpacity(0.12).fill('#ffffff').fillOpacity(1);
    }
  }

  let headerCursorY = 36;
  headerLines.forEach((line) => {
    doc.fillColor(line.color).fontSize(line.size).text(line.value, headerTextX, headerCursorY, {
      width: headerTextWidth,
      lineGap: line.lineGap
    });
    headerCursorY += measureTextHeight(line.value, line.size, headerTextWidth, { lineGap: line.lineGap }) + 4;
  });

  drawPanel(headerCardX, 28, headerCardWidth, headerCardHeight, { fill: '#ffffff', stroke: '#cfd9e2' });
  let metaCursorY = 42;
  metaLines.forEach((line) => {
    doc.fillColor(line.color).fontSize(line.size).text(line.value, headerCardX + 20, metaCursorY, {
      width: 148,
      lineGap: line.lineGap
    });
    metaCursorY += measureTextHeight(line.value, line.size, 148, { lineGap: line.lineGap }) + 4;
  });

  const detailsY = headerHeight + 20;
  const infoGap = 18;
  const infoWidth = (pageWidth - infoGap) / 2;
  const companyLines = [
    { value: text.company, size: 10, color: '#2a3745', lineGap: 0 },
    { value: company.name || '', size: 12, color: '#24313f', lineGap: 1 },
    { value: company.taxAddress || company.address || text.noFiscalAddress, size: 9, color: '#5f7283', lineGap: 0 }
  ].filter((line) => line.value);
  const customerLines = [
    { value: text.customer, size: 10, color: '#2a3745', lineGap: 0 },
    { value: invoice.header.customerName || '', size: 12, color: '#24313f', lineGap: 1 },
    { value: invoice.header.customerAddress || invoice.header.customerPhone || invoice.header.customerEmail || text.noContact, size: 9, color: '#5f7283', lineGap: 0 }
  ].filter((line) => line.value);
  const calcInfoHeight = (lines) => Math.max(96, lines.reduce((total, line, index) => {
    return total + measureTextHeight(line.value, line.size, infoWidth - 36, { lineGap: line.lineGap }) + (index < lines.length - 1 ? 6 : 0);
  }, 0) + 30);
  const companyCardHeight = calcInfoHeight(companyLines);
  const customerCardHeight = calcInfoHeight(customerLines);
  const detailsBottom = detailsY + Math.max(companyCardHeight, customerCardHeight);

  drawPanel(left, detailsY, infoWidth, companyCardHeight, { accentBarColor: accent });
  drawSectionLabel(text.company, left + 22, detailsY + 16, infoWidth - 36);
  let companyCursorY = detailsY + 32;
  companyLines.forEach((line) => {
    doc.fillColor(line.color).fontSize(line.size).text(line.value, left + 18, companyCursorY, {
      width: infoWidth - 36,
      lineGap: line.lineGap
    });
    companyCursorY += measureTextHeight(line.value, line.size, infoWidth - 36, { lineGap: line.lineGap }) + 6;
  });

  const customerCardX = left + infoWidth + infoGap;
  drawPanel(customerCardX, detailsY, infoWidth, customerCardHeight, { accentBarColor: primary });
  drawSectionLabel(text.customer, customerCardX + 22, detailsY + 16, infoWidth - 36);
  let customerCursorY = detailsY + 32;
  customerLines.forEach((line) => {
    doc.fillColor(line.color).fontSize(line.size).text(line.value, customerCardX + 18, customerCursorY, {
      width: infoWidth - 36,
      lineGap: line.lineGap
    });
    customerCursorY += measureTextHeight(line.value, line.size, infoWidth - 36, { lineGap: line.lineGap }) + 6;
  });

  const colGap = 10;
  const dimensionsWidth = 76;
  const weightWidth = 62;
  const qtyWidth = 56;
  const skuWidth = 90;
  const dimensionsX = right - dimensionsWidth;
  const weightX = dimensionsX - colGap - weightWidth;
  const qtyX = weightX - colGap - qtyWidth;
  const skuX = qtyX - colGap - skuWidth;
  const descriptionWidth = skuX - colGap - left;
  const columns = [
    { label: text.description, x: left, width: descriptionWidth },
    { label: text.sku, x: skuX, width: skuWidth },
    { label: text.quantity, x: qtyX, width: qtyWidth, align: 'right' },
    { label: text.weight, x: weightX, width: weightWidth, align: 'right' },
    { label: text.dimensions, x: dimensionsX, width: dimensionsWidth, align: 'right' }
  ];

  const drawTableHeader = (startY) => {
    doc.roundedRect(left, startY, pageWidth, 30, 10).fill(accent);
    doc.fillColor('#ffffff').fontSize(9);
    columns.forEach((column) => {
      doc.text(column.label, column.x + 6, startY + 10, { width: column.width - 12, align: column.align || 'left' });
    });
    return startY + 38;
  };

  const drawContinuationHeader = () => {
    drawPanel(left, doc.page.margins.top, pageWidth, 56, { accentBarColor: accent });
    doc.fillColor(primary).fontSize(11).text(text.packingList.toUpperCase(), left + 18, doc.page.margins.top + 14);
    doc.fontSize(16).text(invoice.invoiceNumber || `#${invoice.header.id}`, left + 18, doc.page.margins.top + 28, { width: 240 });
    doc.fontSize(9).fillColor(muted).text(`Continuacion - ${invoice.header.customerName || text.customer}`, right - 180, doc.page.margins.top + 20, {
      width: 160,
      align: 'right'
    });
    return drawTableHeader(doc.page.margins.top + 74);
  };

  let cursorY = drawTableHeader(detailsBottom + 20);
  doc.fillColor('#2a3745');
  invoice.items.forEach((line, index) => {
    const description = normalizeText(line.description);
    const meta = normalizeText(line.categoryName || '');
    const sku = normalizeText(line.sku || '');
    const weight = normalizeText(line.weight || '');
    const dimensions = normalizeText(line.dimensions || '');
    const descriptionHeight = measureTextHeight(description, 10, columns[0].width - 16, { lineGap: 1 });
    const metaHeight = meta ? measureTextHeight(meta, 8, columns[0].width - 16) : 0;
    const skuHeight = measureTextHeight(sku || ' ', 10, columns[1].width);
    const dimensionsHeight = measureTextHeight(dimensions || ' ', 10, columns[4].width);
    const contentHeight = Math.max(
      descriptionHeight + (metaHeight ? metaHeight + 4 : 0),
      skuHeight,
      dimensionsHeight
    );
    const rowHeight = Math.max(40, contentHeight + 16);

    if (cursorY + rowHeight + 70 > pageBottom()) {
      doc.addPage();
      cursorY = drawContinuationHeader();
    }

    const rowFill = index % 2 === 0 ? '#f9fbfc' : '#ffffff';
    drawPanel(left, cursorY - 2, pageWidth, rowHeight, { fill: rowFill, stroke: '#edf2f7', radius: 10 });
    const textY = cursorY + 8;
    const metaY = textY + descriptionHeight + 4;
    const singleLineY = cursorY + Math.max(10, (rowHeight - skuHeight) / 2);

    doc.fillColor(ink).fontSize(10).text(description, columns[0].x + 8, textY, {
      width: columns[0].width - 16,
      lineGap: 1
    });
    if (meta) {
      doc.fontSize(8).fillColor(muted).text(meta, columns[0].x + 8, metaY, { width: columns[0].width - 16 });
    }
    doc.fillColor(ink).fontSize(10);
    doc.text(sku, columns[1].x, singleLineY, { width: columns[1].width });
    doc.text(Number(line.qty || 0).toFixed(2), columns[2].x, singleLineY, { width: columns[2].width, align: 'right' });
    doc.text(weight, columns[3].x, singleLineY, { width: columns[3].width, align: 'right' });
    doc.text(dimensions, columns[4].x, singleLineY, { width: columns[4].width, align: 'right' });
    cursorY += rowHeight + 8;
  });

  const totalPackages = toPositiveNumber(invoice.header.packageCount, 0);
  const notesText = invoice.header.notes || text.noNotes;
  const notesWidth = pageWidth - 32;
  const notesTextHeight = measureTextHeight(notesText, 9, notesWidth, { lineGap: 1 });
  const packageCountHeight = totalPackages ? measureTextHeight(`${text.packageCount}: ${totalPackages}`, 10, notesWidth) + 8 : 0;
  const notesCardHeight = Math.max(96, 16 + measureTextHeight(text.observations, 10, notesWidth) + 10 + notesTextHeight + packageCountHeight + 18);

  if (cursorY + 12 + notesCardHeight > pageBottom()) {
    doc.addPage();
    cursorY = doc.page.margins.top + 20;
  }

  const notesY = cursorY + 8;
  drawPanel(left, notesY, pageWidth, notesCardHeight, { accentBarColor: accent });
  drawSectionLabel(text.observations, left + 20, notesY + 16, notesWidth);
  doc.fillColor(ink).fontSize(10).text(notesText, left + 16, notesY + 34, {
    width: notesWidth,
    lineGap: 1
  });

  if (totalPackages) {
    const packagesY = notesY + 34 + notesTextHeight + 10;
    doc.fillColor(accent).fontSize(10).text(`${text.packageCount}: ${totalPackages}`, left + 16, packagesY, { width: notesWidth });
  }

drawFooter(notesY + notesCardHeight + 12);
}

async function renderInvoicePdfToBuffer(invoice, company, options = {}) {
  const chunks = [];
  const doc = createBufferedPdfDocumentV3(options.pageSize);
  doc.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  await drawInvoicePdfV3(doc, invoice, company);
  finalizeBufferedPdfV3(doc, (pageNumber, pageCount) => drawBufferedPdfFooterV3(doc, company, pageNumber, pageCount));
  doc.end();
  await ended;
  return Buffer.concat(chunks);
}

async function renderInvoicePdfToStream(invoice, company, stream, options = {}) {
  const doc = createBufferedPdfDocumentV3(options.pageSize);
  doc.pipe(stream);
  await drawInvoicePdfV3(doc, invoice, company);
  finalizeBufferedPdfV3(doc, (pageNumber, pageCount) => drawBufferedPdfFooterV3(doc, company, pageNumber, pageCount));
  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function drawInvoicePdfV2(doc, invoice, company) {
  return drawInvoicePdfV3(doc, invoice, company);
}

function isPdfHexColor(value) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalizeText(value));
}

function normalizePdfHexColor(value, fallback = '') {
  const raw = normalizeText(value);
  if (!isPdfHexColor(raw)) return fallback;
  if (raw.length === 4) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return raw.toLowerCase();
}

function mixPdfHexColors(source, target, ratio) {
  const from = normalizePdfHexColor(source);
  const to = normalizePdfHexColor(target);
  if (!from) return to || '#ffffff';
  if (!to) return from;
  const weight = Math.max(0, Math.min(1, toNumber(ratio, 0)));
  const mixChannel = (start, end) => Math.round(start + (end - start) * weight);
  const rgb = [0, 2, 4].map((offset) => {
    const start = parseInt(from.slice(1 + offset, 3 + offset), 16);
    const end = parseInt(to.slice(1 + offset, 3 + offset), 16);
    return mixChannel(start, end).toString(16).padStart(2, '0');
  });
  return `#${rgb.join('')}`;
}

function buildInvoicePdfPalette(company) {
  const primary = normalizePdfHexColor(company && company.primaryColor, '#24455d');
  const accent = normalizePdfHexColor(company && company.secondaryColor, '#2d7c7a');
  const backgroundSeed = normalizePdfHexColor(company && company.backgroundColor, mixPdfHexColors(accent, '#ffffff', 0.88));
  return {
    primary,
    accent,
    ink: mixPdfHexColors(primary, '#111827', 0.58),
    muted: mixPdfHexColors(primary, '#ffffff', 0.56),
    pageBackground: '#ffffff',
    panelFill: mixPdfHexColors(backgroundSeed, '#ffffff', 0.34),
    panelAlt: mixPdfHexColors(primary, '#ffffff', 0.9),
    lineBorder: mixPdfHexColors(primary, '#ffffff', 0.82),
    rowAltFill: mixPdfHexColors(backgroundSeed, '#ffffff', 0.48),
    totalFill: mixPdfHexColors(accent, '#ffffff', 0.88),
    totalBorder: mixPdfHexColors(accent, '#ffffff', 0.74),
    signatureLine: mixPdfHexColors(primary, '#ffffff', 0.64),
    metaText: mixPdfHexColors(primary, '#ffffff', 0.84)
  };
}

async function drawInvoicePdfV3(doc, invoice, company) {
  const text = getInvoiceDocumentText(invoice.header.invoiceLanguage);
  const palette = buildInvoicePdfPalette(company);
  const primary = palette.primary;
  const accent = palette.accent;
  const ink = palette.ink;
  const muted = palette.muted;
  const pageBackground = palette.pageBackground;
  const panelFill = palette.panelFill;
  const panelAlt = palette.panelAlt;
  const lineBorder = palette.lineBorder;
  const rowAltFill = palette.rowAltFill;
  const totalFill = palette.totalFill;
  const totalBorder = palette.totalBorder;
  const signatureLine = palette.signatureLine;
  const metaText = palette.metaText;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom - 8;
  const money = (value) => formatPdfMoneyV3(invoice.header.currency, value);
  const amount = (value) => toNumber(value, 0).toFixed(2);
  const dateValue = (value, fallback = text.noDate) => formatPdfDateV3(value, fallback);
  const measureHeight = (value, fontSize, width, options = {}) => {
    if (!value) return 0;
    doc.fontSize(fontSize);
    return doc.heightOfString(String(value), { width, ...options });
  };

  const drawHeader = (continued = false) => {
    const headerHeight = 118;
    doc.save();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(pageBackground);
    doc.restore();
    doc.save();
    doc.rect(0, 0, doc.page.width, headerHeight).fill(primary);
    doc.restore();

    drawPdfLogoBlockV3(doc, company, left, 22, 82, 52, {
      fill: mixPdfHexColors(primary, '#ffffff', 0.08),
      stroke: mixPdfHexColors(accent, '#ffffff', 0.2)
    });

    const metaWidth = 198;
    const companyX = left + 94;
    const companyWidth = contentWidth - metaWidth - 108;
    const companyLines = [
      company.name || text.company,
      company.legalName || '',
      company.nit ? `NIT: ${company.nit}` : '',
      company.address || company.taxAddress || '',
      [company.phone, company.email].filter(Boolean).join(' · ')
    ].filter(Boolean);

    let companyY = 24;
    companyLines.forEach((line, index) => {
      const size = index === 0 ? 19.5 : 9.2;
      const color = index === 0 ? '#ffffff' : metaText;
      doc.fillColor(color).fontSize(size).text(line, companyX, companyY, {
        width: companyWidth,
        lineGap: 1
      });
      companyY += measureHeight(line, size, companyWidth, { lineGap: 1 }) + (index === 0 ? 4 : 2);
    });

    const metaX = right - metaWidth;
    drawPdfPanelV3(doc, metaX, 20, metaWidth, 80, {
      fill: '#ffffff',
      stroke: lineBorder,
      radius: 18
    });
    doc.save();
    doc.roundedRect(metaX + 18, 30, 92, 18, 9).fill(accent);
    doc.restore();
    doc.fillColor('#ffffff').fontSize(8).text(invoice.statusMeta.label.toUpperCase(), metaX + 18, 35, {
      width: 92,
      align: 'center'
    });
    doc.fillColor(primary).fontSize(11).text(text.invoice.toUpperCase(), metaX + 18, 54, {
      width: metaWidth - 36
    });
    doc.fontSize(17).text(invoice.invoiceNumber, metaX + 18, 68, {
      width: metaWidth - 36
    });
    doc.fillColor(muted).fontSize(8.5).text(`${text.issueDate}: ${dateValue(invoice.header.issueDate)}`, metaX + 18, 88, {
      width: metaWidth - 36
    });

    if (continued) {
      doc.fillColor(metaText).fontSize(8.5).text('CONTINUACION', right - 110, headerHeight - 18, {
        width: 92,
        align: 'right'
      });
    }
    return headerHeight + 12;
  };

  const drawCustomerSection = (startY) => {
    const gap = 16;
    const leftWidth = Math.floor(contentWidth * 0.58);
    const rightWidth = contentWidth - leftWidth - gap;
    const customerName = invoice.header.customerName || 'Mostrador';
    const customerContentWidth = leftWidth - 36;
    const summaryLabelWidth = 72;
    const summaryValueWidth = rightWidth - summaryLabelWidth - 34;
    const customerRows = [
      { label: text.document, value: invoice.header.customerCode || 'N/D' },
      { label: text.address, value: invoice.header.customerAddress || 'N/D' },
      { label: text.phone, value: invoice.header.customerPhone || 'N/D' },
      { label: text.email, value: invoice.header.customerEmail || 'N/D' }
    ];
    const summaryRows = [
      [text.status, invoice.statusMeta.label],
      [text.invoiceDate, dateValue(invoice.header.issueDate)],
      [text.dueDate, dateValue(invoice.header.dueDate, text.noDueDate)],
      [text.paymentMethod, invoice.header.paymentMethod || text.noMethod],
      ['Moneda', invoice.header.currency],
      ['Cambio', Number(invoice.header.exchangeRate || 1).toFixed(4)]
    ];
    const customerTitleHeight = measureHeight(customerName, 12.5, customerContentWidth, { lineGap: 1.1 });
    const customerBodyHeight = customerRows.reduce((total, row) => (
      total + measureHeight(`${row.label}: ${row.value}`, 8.8, customerContentWidth, { lineGap: 1.2 }) + 5
    ), 0);
    const summaryBodyHeight = summaryRows.reduce((total, [label, value]) => {
      const labelHeight = measureHeight(label, 8.5, summaryLabelWidth);
      const valueHeight = measureHeight(String(value || 'N/D'), 8.8, summaryValueWidth, { lineGap: 1.1 });
      return total + Math.max(labelHeight, valueHeight) + 5;
    }, 0);
    const cardHeight = Math.max(100, 34 + customerTitleHeight + customerBodyHeight, 34 + summaryBodyHeight);

    drawPdfPanelV3(doc, left, startY, leftWidth, cardHeight, {
      fill: panelFill,
      stroke: lineBorder,
      radius: 18
    });
    doc.fillColor(accent).fontSize(8).text(text.clientData.toUpperCase(), left + 18, startY + 14, {
      width: leftWidth - 36
    });
    doc.fillColor(ink).fontSize(12.5).text(customerName, left + 18, startY + 30, {
      width: customerContentWidth,
      lineGap: 1.1
    });
    let customerY = startY + 30 + customerTitleHeight + 8;
    customerRows.forEach((row) => {
      const line = `${row.label}: ${row.value}`;
      doc.fillColor(muted).fontSize(8.8).text(line, left + 18, customerY, {
        width: customerContentWidth,
        lineGap: 1.2
      });
      customerY += measureHeight(line, 8.8, customerContentWidth, { lineGap: 1.2 }) + 5;
    });

    const summaryX = left + leftWidth + gap;
    drawPdfPanelV3(doc, summaryX, startY, rightWidth, cardHeight, {
      fill: '#ffffff',
      stroke: lineBorder,
      radius: 18
    });
    doc.fillColor(primary).fontSize(8).text(text.summary.toUpperCase(), summaryX + 18, startY + 14, {
      width: rightWidth - 36
    });
    let summaryY = startY + 30;
    summaryRows.forEach(([label, value]) => {
      const safeValue = String(value || 'N/D');
      const rowHeight = Math.max(
        measureHeight(label, 8.5, summaryLabelWidth),
        measureHeight(safeValue, 8.8, summaryValueWidth, { lineGap: 1.1 })
      );
      doc.fillColor(muted).fontSize(8.5).text(label, summaryX + 18, summaryY, {
        width: summaryLabelWidth
      });
      doc.fillColor(ink).fontSize(8.8).text(safeValue, summaryX + 18 + summaryLabelWidth + 8, summaryY, {
        width: summaryValueWidth,
        align: 'right'
      });
      summaryY += rowHeight + 5;
    });

    return startY + cardHeight + 14;
  };

  const notesRows = [
    { label: text.notes, value: invoice.header.notes || text.noNotes },
    {
      label: text.terms,
      value: [
        `${text.paymentMethod}: ${invoice.header.paymentMethod || text.noMethod}`,
        `${text.dueDate}: ${dateValue(invoice.header.dueDate, text.noDueDate)}`
      ].join(' | ')
    }
  ];
  const notesWidth = Math.floor(contentWidth * 0.56);
  const totalsWidth = contentWidth - notesWidth - 16;
  const notesContentWidth = notesWidth - 28;
  const notesHeight = Math.max(
    104,
    24 + notesRows.reduce((total, row) => (
      total + 12 + measureHeight(row.value, 8.8, notesContentWidth, { lineGap: 1.2 }) + 8
    ), 0)
  );
  const totalsRows = [
    { label: text.subtotal, value: money(invoice.header.subtotal), emphasis: false },
    { label: text.discounts, value: money(invoice.header.discountTotal), emphasis: false },
    { label: text.taxes, value: money(invoice.header.taxTotal), emphasis: false },
    { label: text.paid, value: money(invoice.header.paidTotal), emphasis: false },
    { label: text.balanceDue, value: money(invoice.header.balanceDue), emphasis: false },
    { label: text.grandTotal, value: money(invoice.header.total), emphasis: true }
  ];
  const totalsHeight = 20 + totalsRows.length * 20;
  const blockHeight = Math.max(notesHeight, totalsHeight);
  const signatureHeight = 62;
  const reservedBottomSpace = blockHeight + signatureHeight + 34;

  const fixedWidths = {
    number: 22,
    sku: 48,
    qty: 38,
    unitPrice: 56,
    discount: 44,
    tax: 40,
    subtotal: 54,
    total: 54
  };
  const descriptionWidth = contentWidth
    - fixedWidths.number
    - fixedWidths.sku
    - fixedWidths.qty
    - fixedWidths.unitPrice
    - fixedWidths.discount
    - fixedWidths.tax
    - fixedWidths.subtotal
    - fixedWidths.total;
  const columns = [
    { label: text.lineNumber, width: fixedWidths.number, align: 'left' },
    { label: text.description, width: descriptionWidth, align: 'left' },
    { label: `${text.sku} / ${text.code}`, width: fixedWidths.sku, align: 'left' },
    { label: text.quantity, width: fixedWidths.qty, align: 'right' },
    { label: text.unitPrice, width: fixedWidths.unitPrice, align: 'right' },
    { label: text.discounts, width: fixedWidths.discount, align: 'right' },
    { label: text.taxes, width: fixedWidths.tax, align: 'right' },
    { label: text.subtotal, width: fixedWidths.subtotal, align: 'right' },
    { label: text.total, width: fixedWidths.total, align: 'right' }
  ];
  let runningX = left;
  columns.forEach((column) => {
    column.x = runningX;
    runningX += column.width;
  });

  const drawTableHeader = (startY) => {
    drawPdfPanelV3(doc, left, startY, contentWidth, 32, {
      fill: panelAlt,
      stroke: lineBorder,
      radius: 12
    });
    doc.fillColor(primary).fontSize(7.6);
    columns.forEach((column) => {
      doc.text(column.label, column.x + 4, startY + 11, {
        width: column.width - 8,
        align: column.align
      });
    });
    return startY + 38;
  };

  const addContinuationPage = () => {
    doc.addPage();
    const nextY = drawHeader(true);
    return drawTableHeader(nextY);
  };

  let cursorY = drawCustomerSection(drawHeader(false));
  cursorY = drawTableHeader(cursorY);

  (invoice.items || []).forEach((line, index) => {
    const description = normalizeText(line.description) || 'Sin descripcion';
    const detailMeta = [
      line.lineType === 'inventory' ? text.inventoryLine : text.manualLine,
      normalizeText(line.categoryName)
    ].filter(Boolean).join(' · ');
    const descriptionHeight = measureHeight(description, 9.2, columns[1].width - 10, { lineGap: 1.3 });
    const metaHeight = detailMeta ? measureHeight(detailMeta, 7.4, columns[1].width - 10) + 4 : 0;
    const rowHeight = Math.max(32, descriptionHeight + metaHeight + 14);

    if (cursorY + rowHeight + reservedBottomSpace > pageBottom()) {
      cursorY = addContinuationPage();
    }

    const rowFill = index % 2 === 0 ? '#ffffff' : rowAltFill;
    drawPdfPanelV3(doc, left, cursorY, contentWidth, rowHeight, {
      fill: rowFill,
      stroke: '#ebf1f5',
      radius: 10
    });
    const textY = cursorY + 8;
    doc.fillColor(ink).fontSize(8.5).text(String(index + 1), columns[0].x + 4, textY + 2, {
      width: columns[0].width - 8
    });
    doc.fontSize(9.2).text(description, columns[1].x + 4, textY, {
      width: columns[1].width - 8,
      lineGap: 1.3
    });
    if (detailMeta) {
      doc.fillColor(muted).fontSize(7.4).text(detailMeta, columns[1].x + 4, textY + descriptionHeight + 4, {
        width: columns[1].width - 8
      });
    }
    doc.fillColor(ink).fontSize(8.4).text(line.sku || '-', columns[2].x + 3, textY + 2, {
      width: columns[2].width - 6
    });
    doc.text(formatPdfMeasureV3(line.qty, 2), columns[3].x + 2, textY + 2, {
      width: columns[3].width - 4,
      align: 'right'
    });
    doc.text(amount(line.unitPrice), columns[4].x + 2, textY + 2, {
      width: columns[4].width - 4,
      align: 'right'
    });
    doc.text(amount(line.discountAmount), columns[5].x + 2, textY + 2, {
      width: columns[5].width - 4,
      align: 'right'
    });
    doc.text(amount(line.taxAmount), columns[6].x + 2, textY + 2, {
      width: columns[6].width - 4,
      align: 'right'
    });
    doc.text(amount(line.subtotal), columns[7].x + 2, textY + 2, {
      width: columns[7].width - 4,
      align: 'right'
    });
    doc.text(amount(line.total), columns[8].x + 2, textY + 2, {
      width: columns[8].width - 4,
      align: 'right'
    });
    cursorY += rowHeight + 6;
  });

  if (cursorY + reservedBottomSpace > pageBottom()) {
    doc.addPage();
    cursorY = drawHeader(true);
  }

  const notesY = cursorY + 6;
  drawPdfPanelV3(doc, left, notesY, notesWidth, notesHeight, {
    fill: panelFill,
    stroke: lineBorder,
    radius: 16
  });
  doc.fillColor(accent).fontSize(8).text(text.notes.toUpperCase(), left + 18, notesY + 14, {
    width: notesWidth - 36
  });
  let notesCursorY = notesY + 30;
  notesRows.forEach((row) => {
    doc.fillColor(primary).fontSize(8.3).text(row.label, left + 16, notesCursorY, {
      width: notesContentWidth
    });
    const valueY = notesCursorY + 10;
    doc.fillColor(muted).fontSize(8.8).text(row.value, left + 16, valueY, {
      width: notesContentWidth,
      lineGap: 1.2
    });
    notesCursorY = valueY + measureHeight(row.value, 8.8, notesContentWidth, { lineGap: 1.2 }) + 10;
  });

  const totalsX = left + notesWidth + 16;
  drawPdfPanelV3(doc, totalsX, notesY, totalsWidth, totalsHeight, {
    fill: '#ffffff',
    stroke: lineBorder,
    radius: 16
  });
  let totalsY = notesY + 14;
  totalsRows.forEach((row, index) => {
    if (row.emphasis) {
      drawPdfPanelV3(doc, totalsX + 10, totalsY - 4, totalsWidth - 20, 24, {
        fill: totalFill,
        stroke: totalBorder,
        radius: 10
      });
    }
    doc.fillColor(row.emphasis ? primary : muted).fontSize(row.emphasis ? 10.5 : 9).text(row.label, totalsX + 14, totalsY, {
      width: totalsWidth - 108
    });
    doc.fillColor(row.emphasis ? primary : ink).fontSize(row.emphasis ? 11 : 9).text(row.value, totalsX + totalsWidth - 94, totalsY, {
      width: 78,
      align: 'right'
    });
    if (!row.emphasis && index < totalsRows.length - 1) {
      doc.moveTo(totalsX + 14, totalsY + 15).lineTo(totalsX + totalsWidth - 14, totalsY + 15).strokeColor('#e6edf2').stroke();
    }
    totalsY += 20;
  });

  const signatureY = notesY + blockHeight + 14;
  const signatureGap = 12;
  const signatureWidth = (contentWidth - signatureGap * 2) / 3;
  [
    { x: left, label: text.authorizedSignature },
    { x: left + signatureWidth + signatureGap, label: text.seal },
    { x: left + (signatureWidth + signatureGap) * 2, label: text.date }
  ].forEach((block) => {
    drawPdfPanelV3(doc, block.x, signatureY, signatureWidth, signatureHeight, {
      fill: '#ffffff',
      stroke: lineBorder,
      radius: 14
    });
    doc.fillColor(primary).fontSize(8).text(block.label.toUpperCase(), block.x + 14, signatureY + 12, {
      width: signatureWidth - 28,
      align: 'center'
    });
    doc.moveTo(block.x + 16, signatureY + 46).lineTo(block.x + signatureWidth - 16, signatureY + 46).strokeColor(signatureLine).stroke();
  });
}

async function renderPackingListPdfToStream(packingList, company, stream, options = {}) {
  const doc = createBufferedPdfDocumentV3(options.pageSize);
  doc.pipe(stream);
  drawPackingListPdfV3(doc, packingList, company);
  finalizeBufferedPdfV3(doc, (pageNumber, pageCount) => drawBufferedPdfFooterV3(doc, company, pageNumber, pageCount));
  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function drawPackingListPdf(doc, packingList, company) {
  return drawPackingListPdfV3(doc, packingList, company);
}

function drawPackingListPdfV3(doc, packingList, company) {
  const text = getInvoiceDocumentText('es');
  const primary = company.primaryColor || '#24455d';
  const accent = company.secondaryColor || '#2d7c7a';
  const ink = '#24313f';
  const muted = '#64748b';
  const panelFill = '#f8fafc';
  const panelAlt = '#eef4f7';
  const lineBorder = '#d9e4ea';
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom - 8;
  const measureHeight = (value, fontSize, width, options = {}) => {
    if (!value) return 0;
    doc.fontSize(fontSize);
    return doc.heightOfString(String(value), { width, ...options });
  };

  const drawHeader = (continued = false) => {
    const headerHeight = 128;
    doc.save();
    doc.rect(0, 0, doc.page.width, headerHeight).fill(primary);
    doc.restore();

    drawPdfLogoBlockV3(doc, company, left, 24, 86, 56);
    const metaWidth = 198;
    const titleX = left + 100;
    const titleWidth = contentWidth - metaWidth - 118;
    const titleLines = [
      text.packingList,
      company.name || '',
      company.address || company.taxAddress || ''
    ].filter(Boolean);
    let titleY = 30;
    titleLines.forEach((line, index) => {
      const size = index === 0 ? 22 : 9.4;
      const color = index === 0 ? '#ffffff' : '#d7e5ee';
      doc.fillColor(color).fontSize(size).text(line, titleX, titleY, {
        width: titleWidth,
        lineGap: 1
      });
      titleY += measureHeight(line, size, titleWidth, { lineGap: 1 }) + 3;
    });

    const metaX = right - metaWidth;
    drawPdfPanelV3(doc, metaX, 24, metaWidth, 84, {
      fill: '#ffffff',
      stroke: '#d5e1e8',
      radius: 18
    });
    doc.fillColor(primary).fontSize(11).text(text.invoiceNumber.toUpperCase(), metaX + 18, 40, {
      width: metaWidth - 36
    });
    doc.fontSize(16).text(packingList.invoiceNumber, metaX + 18, 56, {
      width: metaWidth - 36
    });
    doc.fillColor(muted).fontSize(8.5).text(`${text.date}: ${formatPdfDateV3(packingList.issueDate, text.noDate)}`, metaX + 18, 80, {
      width: metaWidth - 36
    });
    if (continued) {
      doc.fillColor('#dce8ef').fontSize(8.5).text('CONTINUACION', right - 110, headerHeight - 18, {
        width: 92,
        align: 'right'
      });
    }
    return headerHeight + 18;
  };

  const infoGap = 12;
  const infoWidth = (contentWidth - infoGap * 2) / 3;
  const drawInfoCards = (startY) => {
    const companyLines = [
      company.name || '',
      company.nit ? `NIT: ${company.nit}` : '',
      company.address || company.taxAddress || '',
      [company.phone, company.email].filter(Boolean).join(' · ')
    ].filter(Boolean);
    const customerLines = [
      packingList.customerName || '',
      packingList.customerCode ? `${text.document}: ${packingList.customerCode}` : `${text.document}: N/D`,
      packingList.customerAddress || 'Direccion no registrada',
      [packingList.customerPhone, packingList.customerEmail].filter(Boolean).join(' · ') || text.noContact
    ].filter(Boolean);
    const documentLines = [
      `${text.invoiceNumber}: ${packingList.invoiceNumber}`,
      `${text.date}: ${formatPdfDateV3(packingList.issueDate, text.noDate)}`,
      `${text.packageCount}: ${formatPdfMeasureV3(packingList.totals.totalPackages, 2)}`,
      `${text.totalWeight}: ${formatPdfMeasureV3(packingList.totals.totalWeight, 3)}`
    ];

    const cards = [
      { x: left, title: text.company, lines: companyLines, accentBarColor: accent },
      { x: left + infoWidth + infoGap, title: text.customer, lines: customerLines, accentBarColor: primary },
      { x: left + (infoWidth + infoGap) * 2, title: text.summary, lines: documentLines, accentBarColor: accent }
    ];
    cards.forEach((card) => {
      drawPdfPanelV3(doc, card.x, startY, infoWidth, 106, {
        fill: panelFill,
        stroke: lineBorder,
        radius: 16,
        accentBarColor: card.accentBarColor
      });
      doc.fillColor(card.accentBarColor).fontSize(8).text(card.title.toUpperCase(), card.x + 18, startY + 14, {
        width: infoWidth - 36
      });
      let lineY = startY + 30;
      card.lines.forEach((line, index) => {
        doc.fillColor(index === 0 ? ink : muted).fontSize(index === 0 ? 10.5 : 8.6).text(line, card.x + 16, lineY, {
          width: infoWidth - 32,
          lineGap: 1.1
        });
        lineY += measureHeight(line, index === 0 ? 10.5 : 8.6, infoWidth - 32, { lineGap: 1.1 }) + 4;
      });
    });
    return startY + 122;
  };

  const fixedWidths = {
    number: 18,
    sku: 46,
    qty: 34,
    weight: 52,
    dimensions: 70,
    packages: 34,
    packageType: 56,
    notes: 95
  };
  const descriptionWidth = contentWidth
    - fixedWidths.number
    - fixedWidths.sku
    - fixedWidths.qty
    - fixedWidths.weight
    - fixedWidths.dimensions
    - fixedWidths.packages
    - fixedWidths.packageType
    - fixedWidths.notes;
  const columns = [
    { label: text.lineNumber, width: fixedWidths.number, align: 'left' },
    { label: text.description, width: descriptionWidth, align: 'left' },
    { label: text.sku, width: fixedWidths.sku, align: 'left' },
    { label: text.quantity, width: fixedWidths.qty, align: 'right' },
    { label: text.weight, width: fixedWidths.weight, align: 'right' },
    { label: text.dimensions, width: fixedWidths.dimensions, align: 'left' },
    { label: text.packages, width: fixedWidths.packages, align: 'right' },
    { label: text.packageType, width: fixedWidths.packageType, align: 'left' },
    { label: text.observations, width: fixedWidths.notes, align: 'left' }
  ];
  let runningX = left;
  columns.forEach((column) => {
    column.x = runningX;
    runningX += column.width;
  });

  const drawTableHeader = (startY) => {
    drawPdfPanelV3(doc, left, startY, contentWidth, 32, {
      fill: panelAlt,
      stroke: lineBorder,
      radius: 12
    });
    doc.fillColor(primary).fontSize(7.5);
    columns.forEach((column) => {
      doc.text(column.label, column.x + 4, startY + 11, {
        width: column.width - 8,
        align: column.align
      });
    });
    return startY + 38;
  };

  const addContinuationPage = () => {
    doc.addPage();
    const nextY = drawHeader(true);
    return drawTableHeader(nextY);
  };

  let cursorY = drawTableHeader(drawInfoCards(drawHeader(false)));
  (packingList.items || []).forEach((item) => {
    const description = normalizeText(item.description) || 'Sin descripcion';
    const notes = normalizeText(item.notes) || '-';
    const type = normalizeText(item.packageType) || '-';
    const dimensions = item.dimensionsLabel || '-';
    const weightMain = item.weightTotal > 0 ? formatPdfMeasureV3(item.weightTotal, 3) : '-';
    const weightMeta = item.weightUnit > 0 ? `u. ${formatPdfMeasureV3(item.weightUnit, 3)}` : '';
    const descriptionHeight = measureHeight(description, 8.7, columns[1].width - 8, { lineGap: 1.2 });
    const notesHeight = measureHeight(notes, 8.2, columns[8].width - 8, { lineGap: 1.2 });
    const typeHeight = measureHeight(type, 8.2, columns[7].width - 8, { lineGap: 1.2 });
    const rowHeight = Math.max(34, Math.max(descriptionHeight, notesHeight, typeHeight) + (weightMeta ? 14 : 10));

    if (cursorY + rowHeight + 132 > pageBottom()) {
      cursorY = addContinuationPage();
    }

    drawPdfPanelV3(doc, left, cursorY, contentWidth, rowHeight, {
      fill: item.lineNumber % 2 === 0 ? '#f9fbfc' : '#ffffff',
      stroke: '#ebf1f5',
      radius: 10
    });
    const textY = cursorY + 8;
    doc.fillColor(ink).fontSize(8.3).text(String(item.lineNumber), columns[0].x + 3, textY + 2, {
      width: columns[0].width - 6
    });
    doc.fontSize(8.7).text(description, columns[1].x + 4, textY, {
      width: columns[1].width - 8,
      lineGap: 1.2
    });
    doc.fontSize(8.3).text(item.sku || '-', columns[2].x + 3, textY + 2, {
      width: columns[2].width - 6
    });
    doc.text(formatPdfMeasureV3(item.qty, 2), columns[3].x + 2, textY + 2, {
      width: columns[3].width - 4,
      align: 'right'
    });
    doc.text(weightMain, columns[4].x + 2, textY + 2, {
      width: columns[4].width - 4,
      align: 'right'
    });
    if (weightMeta) {
      doc.fillColor(muted).fontSize(7.2).text(weightMeta, columns[4].x + 2, textY + 14, {
        width: columns[4].width - 4,
        align: 'right'
      });
      doc.fillColor(ink);
    }
    doc.fontSize(8.2).text(dimensions, columns[5].x + 3, textY + 2, {
      width: columns[5].width - 6,
      lineGap: 1.1
    });
    doc.text(formatPdfMeasureV3(item.packagesCount, 2), columns[6].x + 2, textY + 2, {
      width: columns[6].width - 4,
      align: 'right'
    });
    doc.text(type, columns[7].x + 3, textY + 2, {
      width: columns[7].width - 6,
      lineGap: 1.2
    });
    doc.text(notes, columns[8].x + 3, textY + 2, {
      width: columns[8].width - 6,
      lineGap: 1.2
    });
    cursorY += rowHeight + 6;
  });

  const notesText = packingList.invoiceNotes || text.noNotes;
  const notesWidth = Math.floor(contentWidth * 0.58);
  const totalsWidth = contentWidth - notesWidth - 16;
  const notesContentWidth = notesWidth - 28;
  const notesHeight = Math.max(94, 40 + measureHeight(notesText, 8.8, notesContentWidth, { lineGap: 1.2 }));
  const totalsRows = [
    { label: text.packageCount, value: formatPdfMeasureV3(packingList.totals.totalPackages, 2), emphasis: false },
    { label: text.totalWeight, value: formatPdfMeasureV3(packingList.totals.totalWeight, 3), emphasis: false },
    {
      label: text.volume,
      value: packingList.totals.totalVolume > 0
        ? `${formatPdfMeasureV3(packingList.totals.totalVolume, 3)}${packingList.totals.hasMixedVolumeUnits ? '' : ` ${packingList.totals.volumeUnit || 'u'}³`}`
        : '-',
      emphasis: true
    }
  ];
  const totalsHeight = 26 + totalsRows.length * 24;
  const blockHeight = Math.max(notesHeight, totalsHeight);

  if (cursorY + blockHeight + 28 > pageBottom()) {
    doc.addPage();
    cursorY = drawHeader(true);
  }

  const blockY = cursorY + 6;
  drawPdfPanelV3(doc, left, blockY, notesWidth, notesHeight, {
    fill: panelFill,
    stroke: lineBorder,
    radius: 16,
    accentBarColor: accent
  });
  doc.fillColor(accent).fontSize(8).text(text.notes.toUpperCase(), left + 18, blockY + 14, {
    width: notesWidth - 36
  });
  doc.fillColor(muted).fontSize(8.8).text(notesText, left + 16, blockY + 34, {
    width: notesContentWidth,
    lineGap: 1.2
  });

  const totalsX = left + notesWidth + 16;
  drawPdfPanelV3(doc, totalsX, blockY, totalsWidth, totalsHeight, {
    fill: '#ffffff',
    stroke: lineBorder,
    radius: 16
  });
  let totalsY = blockY + 16;
  totalsRows.forEach((row) => {
    if (row.emphasis) {
      drawPdfPanelV3(doc, totalsX + 10, totalsY - 4, totalsWidth - 20, 24, {
        fill: '#eaf7f4',
        stroke: '#d0ebe3',
        radius: 10
      });
    }
    doc.fillColor(row.emphasis ? primary : muted).fontSize(row.emphasis ? 10.5 : 9).text(row.label, totalsX + 14, totalsY, {
      width: totalsWidth - 106
    });
    doc.fillColor(row.emphasis ? primary : ink).fontSize(row.emphasis ? 11 : 9).text(row.value, totalsX + totalsWidth - 94, totalsY, {
      width: 78,
      align: 'right'
    });
    totalsY += 24;
  });
}

function createBufferedPdfDocumentV3(pageSize) {
  return new PDFDocument({
    size: resolvePdfPageSize(pageSize),
    margins: {
      top: 34,
      right: 28,
      bottom: 38,
      left: 28
    },
    bufferPages: true
  });
}

function resolvePdfPageSize(value) {
  return normalizeText(value).toLowerCase() === 'letter' ? 'LETTER' : 'A4';
}

function finalizeBufferedPdfV3(doc, footerRenderer) {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index);
    footerRenderer(index + 1, range.count);
  }
}

function drawBufferedPdfFooterV3(doc, company, pageNumber, pageCount) {
  const palette = buildInvoicePdfPalette(company);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const footerLineY = doc.page.height - doc.page.margins.bottom + 4;
  const footerText = [
    company.name || 'ERP',
    company.email || company.phone || company.address || 'Documento institucional'
  ].filter(Boolean).join(' · ');

  doc.moveTo(left, footerLineY).lineTo(right, footerLineY).strokeColor(palette.lineBorder).stroke();
  doc.fillColor(palette.muted).fontSize(8);
  doc.text(footerText, left, footerLineY + 8, {
    width: right - left - 90
  });
  doc.text(`Pagina ${pageNumber} de ${pageCount}`, right - 90, footerLineY + 8, {
    width: 90,
    align: 'right'
  });
}

function drawPdfLogoBlockV3(doc, company, x, y, width, height, options = {}) {
  if (company.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, x, y, { fit: [width, height], align: 'left', valign: 'center' });
      return;
    } catch (error) {
      // Fallback below.
    }
  }
  drawPdfPanelV3(doc, x, y, width, height, {
    fill: options.fill || normalizePdfHexColor(company && company.primaryColor, '#3a556c'),
    stroke: options.stroke || normalizePdfHexColor(company && company.secondaryColor, '#5a7388'),
    radius: 14
  });
  doc.fillColor('#ffffff').fontSize(18).text((company.name || 'ER').slice(0, 2).toUpperCase(), x, y + 18, {
    width,
    align: 'center'
  });
}

function drawPdfPanelV3(doc, x, y, width, height, options = {}) {
  const radius = options.radius || 14;
  const fill = options.fill || '#ffffff';
  const stroke = options.stroke || '#d9e4ea';

  doc.save();
  doc.roundedRect(x, y, width, height, radius).fill(fill);
  doc.restore();
  doc.save();
  doc.roundedRect(x, y, width, height, radius).lineWidth(options.lineWidth || 1).strokeColor(stroke).stroke();
  doc.restore();

  if (options.accentBarColor) {
    doc.save();
    doc.roundedRect(x + 10, y + 10, 4, Math.max(18, height - 20), 2).fill(options.accentBarColor);
    doc.restore();
  }
}

function formatPdfMoneyV3(currency, value) {
  return `${currency || 'GTQ'} ${toNumber(value, 0).toFixed(2)}`;
}

function formatPdfDateV3(value, fallback) {
  const normalized = normalizeDateInput(value);
  return normalized || fallback || '';
}

async function ensureInvoiceErpSchema(db) {
  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS invoice_headers (
      id BIGSERIAL PRIMARY KEY,
      legacy_invoice_id INTEGER NULL,
      company_id INTEGER NOT NULL,
      invoice_number TEXT NULL,
      invoice_type TEXT NOT NULL DEFAULT 'standard',
      source TEXT NOT NULL DEFAULT 'legacy',
      customer_id INTEGER NULL,
      customer_name_snapshot TEXT NULL,
      customer_code_snapshot TEXT NULL,
      customer_email_snapshot TEXT NULL,
      customer_phone_snapshot TEXT NULL,
      customer_address_snapshot TEXT NULL,
      issue_date TEXT NULL,
      due_date TEXT NULL,
      payment_method TEXT NULL,
      invoice_language TEXT NOT NULL DEFAULT 'es',
      status TEXT NOT NULL DEFAULT 'draft',
      subtotal REAL NOT NULL DEFAULT 0,
      tax_total REAL NOT NULL DEFAULT 0,
      discount_total REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      paid_total REAL NOT NULL DEFAULT 0,
      balance_due REAL NOT NULL DEFAULT 0,
      notes TEXT NULL,
      currency TEXT NULL,
      exchange_rate REAL NOT NULL DEFAULT 1,
      subtotal_base REAL NOT NULL DEFAULT 0,
      tax_amount_base REAL NOT NULL DEFAULT 0,
      discount_amount_base REAL NOT NULL DEFAULT 0,
      total_base REAL NOT NULL DEFAULT 0,
      created_by INTEGER NULL,
      updated_by INTEGER NULL,
      voided_by INTEGER NULL,
      voided_reason TEXT NULL,
      stock_applied INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      emitted_at TIMESTAMP NULL,
      paid_at TIMESTAMP NULL,
      voided_at TIMESTAMP NULL
    )`
  );

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS invoice_status_history (
      id BIGSERIAL PRIMARY KEY,
      invoice_header_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      from_status TEXT NULL,
      to_status TEXT NULL,
      notes TEXT NULL,
      changed_by INTEGER NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS invoice_inventory_movements (
      id BIGSERIAL PRIMARY KEY,
      invoice_header_id INTEGER NOT NULL,
      invoice_item_id INTEGER NULL,
      item_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      stock_before REAL NOT NULL DEFAULT 0,
      stock_after REAL NOT NULL DEFAULT 0,
      notes TEXT NULL,
      created_by INTEGER NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS invoice_packing_items (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      invoice_id INTEGER NOT NULL,
      invoice_item_id INTEGER NOT NULL,
      weight_unit REAL NOT NULL DEFAULT 0,
      weight_total REAL NOT NULL DEFAULT 0,
      length REAL NOT NULL DEFAULT 0,
      width REAL NOT NULL DEFAULT 0,
      height REAL NOT NULL DEFAULT 0,
      dimension_unit TEXT NOT NULL DEFAULT 'cm',
      packages_count REAL NOT NULL DEFAULT 0,
      package_type TEXT NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await ensureColumn(db, 'companies', 'commercial_name', 'TEXT');
  await ensureColumn(db, 'companies', 'invoice_negative_stock_allowed', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'companies', 'invoice_auto_deduct_stock', 'INTEGER NOT NULL DEFAULT 1');

  await ensureColumn(db, 'invoice_payments', 'invoice_header_id', 'INTEGER NULL');
  await ensureColumn(db, 'invoice_payments', 'recorded_by', 'INTEGER NULL');
  await ensureColumn(db, 'invoice_payments', 'payment_reference', 'TEXT NULL');

  await ensureColumn(db, 'invoice_items', 'header_id', 'INTEGER NULL');
  await ensureColumn(db, 'invoice_items', 'line_type', "TEXT NOT NULL DEFAULT 'inventory'");
  await ensureColumn(db, 'invoice_items', 'description', 'TEXT NULL');
  await ensureColumn(db, 'invoice_items', 'sku_snapshot', 'TEXT NULL');
  await ensureColumn(db, 'invoice_items', 'barcode_snapshot', 'TEXT NULL');
  await ensureColumn(db, 'invoice_items', 'item_name_snapshot', 'TEXT NULL');
  await ensureColumn(db, 'invoice_items', 'category_name_snapshot', 'TEXT NULL');
  await ensureColumn(db, 'invoice_items', 'tax_rate', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn(db, 'invoice_items', 'tax_amount', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn(db, 'invoice_items', 'discount_type', "TEXT NOT NULL DEFAULT 'amount'");
  await ensureColumn(db, 'invoice_items', 'discount_value', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn(db, 'invoice_items', 'discount_amount', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn(db, 'invoice_items', 'subtotal', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn(db, 'invoice_items', 'total', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn(db, 'invoice_items', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'invoice_headers', 'invoice_language', "TEXT NOT NULL DEFAULT 'es'");

  await runDb(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_headers_company_number ON invoice_headers (company_id, invoice_number)');
  await runDb(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_headers_company_legacy ON invoice_headers (company_id, legacy_invoice_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_headers_company_status ON invoice_headers (company_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_headers_company_issue_date ON invoice_headers (company_id, issue_date)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_items_header_id ON invoice_items (header_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_status_history_header ON invoice_status_history (invoice_header_id, company_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_inventory_movements_header ON invoice_inventory_movements (invoice_header_id, company_id)');
  await runDb(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_packing_items_unique ON invoice_packing_items (company_id, invoice_id, invoice_item_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_packing_items_invoice ON invoice_packing_items (invoice_id, company_id)');

  await runDb(
    db,
     `INSERT INTO invoice_headers
     (legacy_invoice_id, company_id, invoice_number, invoice_type, source, customer_id, customer_name_snapshot, customer_code_snapshot, customer_email_snapshot, customer_phone_snapshot, customer_address_snapshot,
      issue_date, due_date, payment_method, invoice_language, status, subtotal, tax_total, discount_total, total, paid_total, balance_due, notes, currency, exchange_rate, subtotal_base, tax_amount_base, discount_amount_base, total_base,
      created_at, updated_at, emitted_at)
     SELECT i.id,
            i.company_id,
            'FAC-' || LPAD(i.id::text, 6, '0'),
            'standard',
            'legacy',
            i.customer_id,
            c.name,
            c.customer_code,
            c.email,
            c.phone,
            COALESCE(c.full_address, c.address),
             date(COALESCE(i.created_at, CURRENT_TIMESTAMP)),
             NULL,
             NULL,
             'es',
             'issued',
            COALESCE(i.subtotal, 0),
            COALESCE(i.tax_amount, 0),
            COALESCE(i.discount_amount, 0),
            COALESCE(i.total, 0),
            0,
            COALESCE(i.total, 0),
            NULL,
            COALESCE(i.currency, 'GTQ'),
            COALESCE(i.exchange_rate, 1),
            COALESCE(i.subtotal_base, COALESCE(i.subtotal, 0)),
            COALESCE(i.tax_amount_base, COALESCE(i.tax_amount, 0)),
            COALESCE(i.discount_amount_base, COALESCE(i.discount_amount, 0)),
            COALESCE(i.total_base, COALESCE(i.total, 0)),
            COALESCE(i.created_at, CURRENT_TIMESTAMP),
            COALESCE(i.created_at, CURRENT_TIMESTAMP),
            COALESCE(i.created_at, CURRENT_TIMESTAMP)
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id AND c.company_id = i.company_id
     WHERE i.company_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM invoice_headers h
         WHERE h.company_id = i.company_id AND h.legacy_invoice_id = i.id
       ) ON CONFLICT DO NOTHING`
  );

  await runDb(
    db,
    `UPDATE invoice_items
     SET header_id = (
           SELECT h.id
           FROM invoice_headers h
           WHERE h.legacy_invoice_id = invoice_items.invoice_id
             AND h.company_id = invoice_items.company_id
           LIMIT 1
         )
     WHERE company_id IS NOT NULL
       AND invoice_id IS NOT NULL
       AND header_id IS NULL`
  );

  await runDb(
    db,
    `UPDATE invoice_items
     SET line_type = COALESCE(line_type, CASE WHEN item_id IS NULL THEN 'manual' ELSE 'inventory' END),
         description = COALESCE(description, (
           SELECT items.name
           FROM items
           WHERE items.id = invoice_items.item_id
             AND items.company_id = invoice_items.company_id
           LIMIT 1
         ), 'Línea heredada'),
         sku_snapshot = COALESCE(sku_snapshot, (
           SELECT items.sku
           FROM items
           WHERE items.id = invoice_items.item_id
             AND items.company_id = invoice_items.company_id
           LIMIT 1
         )),
         barcode_snapshot = COALESCE(barcode_snapshot, (
           SELECT items.barcode
           FROM items
           WHERE items.id = invoice_items.item_id
             AND items.company_id = invoice_items.company_id
           LIMIT 1
         )),
         item_name_snapshot = COALESCE(item_name_snapshot, (
           SELECT items.name
           FROM items
           WHERE items.id = invoice_items.item_id
             AND items.company_id = invoice_items.company_id
           LIMIT 1
         )),
         category_name_snapshot = COALESCE(category_name_snapshot, (
           SELECT categories.name
           FROM items
           LEFT JOIN categories ON categories.id = items.category_id AND categories.company_id = items.company_id
           WHERE items.id = invoice_items.item_id
             AND items.company_id = invoice_items.company_id
           LIMIT 1
         )),
         subtotal = CASE WHEN COALESCE(subtotal, 0) = 0 THEN ROUND(COALESCE(qty, 0) * COALESCE(unit_price, 0), 2) ELSE subtotal END,
         total = CASE WHEN COALESCE(total, 0) = 0 THEN COALESCE(line_total, ROUND(COALESCE(qty, 0) * COALESCE(unit_price, 0), 2)) ELSE total END,
         tax_amount = COALESCE(tax_amount, 0),
         discount_amount = COALESCE(discount_amount, 0),
         sort_order = CASE WHEN COALESCE(sort_order, 0) = 0 THEN COALESCE(sort_order, id) ELSE sort_order END
     WHERE company_id IS NOT NULL`
  );

  await runDb(
    db,
    `INSERT INTO invoice_status_history
     (invoice_header_id, company_id, from_status, to_status, notes, changed_by, created_at)
     SELECT h.id, h.company_id, NULL, h.status, 'Migración de factura heredada', NULL, h.created_at
     FROM invoice_headers h
     WHERE NOT EXISTS (
       SELECT 1
       FROM invoice_status_history ish
       WHERE ish.invoice_header_id = h.id
         AND ish.company_id = h.company_id
     )`
  );

  await runDb(
    db,
    `UPDATE invoice_payments
     SET invoice_header_id = (
       SELECT h.id
       FROM invoice_headers h
       WHERE h.company_id = invoice_payments.company_id
         AND h.legacy_invoice_id = invoice_payments.invoice_id
       LIMIT 1
     )
     WHERE invoice_header_id IS NULL
       AND invoice_id IS NOT NULL`
  );

  await runDb(
    db,
    `UPDATE invoice_headers
     SET invoice_language = 'es'
     WHERE invoice_language IS NULL OR trim(invoice_language) = ''`
  );
}

async function ensureColumn(db, table, column, typeDef) {
  const columns = await allDb(db, `SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ?
    ORDER BY ordinal_position`, [table]);
  if ((columns || []).some((entry) => entry.name === column)) return;
  await runDb(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
}

function withTransaction(db, enqueueDbTransaction, commitTransaction, rollbackTransaction, work) {
  return new Promise((resolve, reject) => {
    enqueueDbTransaction((finish) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        Promise.resolve()
          .then(work)
          .then((result) => {
            commitTransaction(finish, (commitError) => {
              if (commitError) {
                reject(commitError);
                return;
              }
              resolve(result);
            });
          })
          .catch((error) => {
            rollbackTransaction(finish, () => reject(error));
          });
      });
    });
  });
}

function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row || null);
    });
  });
}

function allDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows || []);
    });
  });
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return '';
  return normalized;
}

function normalizeInvoiceStatus(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return 'draft';
  if (normalized === 'pending') return 'pending_signature';
  if (normalized === 'emitida') return 'issued';
  if (normalized === 'pagada') return 'paid';
  if (normalized === 'anulada') return 'voided';
  if (normalized === 'borrador') return 'draft';
  if (normalized === 'pendiente_de_firma') return 'pending_signature';
  if (normalized === 'parcialmente_pagada') return 'partially_paid';
  if (normalized === 'vencida') return 'overdue';
  return normalized;
}

function normalizeInvoiceLanguage(value) {
  return normalizeText(value).toLowerCase() === 'en' ? 'en' : 'es';
}

function getInvoiceDocumentText(language) {
  return INVOICE_DOCUMENT_TEXT[normalizeInvoiceLanguage(language)] || INVOICE_DOCUMENT_TEXT.es;
}

function normalizeLineType(value) {
  return normalizeText(value).toLowerCase() === 'manual' ? 'manual' : 'inventory';
}

function normalizeDiscountType(value) {
  return normalizeText(value).toLowerCase() === 'percent' ? 'percent' : 'amount';
}

function normalizeDiscountAmount(discountType, discountValue, subtotal) {
  const safeSubtotal = round2(toNumber(subtotal, 0));
  const safeDiscount = round2(Math.max(0, toNumber(discountValue, 0)));
  if (discountType === 'percent') {
    return round2(safeSubtotal * (safeDiscount / 100));
  }
  return Math.min(safeSubtotal, safeDiscount);
}

function resolveCurrency(value, allowedCurrencies, fallback) {
  const requested = normalizeText(value).toUpperCase();
  if (Array.isArray(allowedCurrencies) && allowedCurrencies.includes(requested)) return requested;
  return fallback;
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round2(value) {
  return Math.round((toNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function round3(value) {
  return Math.round((toNumber(value, 0) + Number.EPSILON) * 1000) / 1000;
}

function normalizeDimensionUnit(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ['cm', 'm', 'mm', 'in', 'ft'].includes(normalized) ? normalized : 'cm';
}

function formatPackingDimensions(item) {
  if (!item || !toNumber(item.length, 0) || !toNumber(item.width, 0) || !toNumber(item.height, 0)) {
    return '';
  }
  return `${formatPdfMeasureV3(item.length, 3)} x ${formatPdfMeasureV3(item.width, 3)} x ${formatPdfMeasureV3(item.height, 3)} ${normalizeDimensionUnit(item.dimensionUnit)}`;
}

function formatPdfMeasureV3(value, precision = 2) {
  const fixed = toNumber(value, 0).toFixed(precision);
  return fixed.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}

function normalizeDateInput(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (!isValidDateObject(parsed)) return '';
  return formatDateInput(parsed);
}

function normalizeDateTime(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const parsed = new Date(text);
  if (!isValidDateObject(parsed)) return text;
  return parsed.toISOString();
}

function isValidDateObject(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function formatDateInput(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayAsDateInput() {
  return formatDateInput(new Date());
}

function calculateDaysOpen(dateText) {
  const date = normalizeDateInput(dateText);
  if (!date) return 0;
  const diff = new Date(todayAsDateInput()).getTime() - new Date(date).getTime();
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)));
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

function sumInvoiceTotals(rows) {
  return round2((rows || []).reduce((sum, row) => sum + toNumber(row.total, 0), 0));
}

function isCountableInvoiceStatus(status) {
  return ['issued', 'partially_paid', 'paid', 'overdue'].includes(status);
}

function buildCustomerSnapshot(customer) {
  if (!customer) {
    return {
      name: 'Mostrador',
      code: '',
      email: '',
      phone: '',
      address: ''
    };
  }
  return {
    name: normalizeText(customer.name),
    code: normalizeText(customer.customerCode),
    email: normalizeText(customer.email),
    phone: normalizeText(customer.phone),
    address: normalizeText(customer.address)
  };
}

function buildInvoiceNumber(headerId, issueDate) {
  const year = (normalizeDateInput(issueDate) || todayAsDateInput()).slice(0, 4);
  return `FAC-${year}-${String(headerId).padStart(6, '0')}`;
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'factura';
}

function serializeForHtml(value) {
  return JSON.stringify(value || []).replace(/</g, '\\u003c');
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

module.exports = {
  registerInvoiceRoutes
};
