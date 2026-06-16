const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');

const PROJECT_STATUSES = [
  { key: 'draft', label: 'Borrador', badgeClass: 'project-status-draft' },
  { key: 'planning', label: 'En planificación', badgeClass: 'project-status-planning' },
  { key: 'in_progress', label: 'En proceso', badgeClass: 'project-status-progress' },
  { key: 'paused', label: 'En pausa', badgeClass: 'project-status-paused' },
  { key: 'completed', label: 'Finalizado', badgeClass: 'project-status-completed' },
  { key: 'cancelled', label: 'Cancelado', badgeClass: 'project-status-cancelled' }
];

const PROJECT_PRIORITIES = [
  { key: 'low', label: 'Baja', badgeClass: 'project-priority-low' },
  { key: 'medium', label: 'Media', badgeClass: 'project-priority-medium' },
  { key: 'high', label: 'Alta', badgeClass: 'project-priority-high' },
  { key: 'critical', label: 'Crítica', badgeClass: 'project-priority-critical' }
];

const SCHEDULE_STATUSES = [
  { key: 'pending', label: 'Pendiente' },
  { key: 'in_progress', label: 'En proceso' },
  { key: 'completed', label: 'Finalizada' },
  { key: 'blocked', label: 'Bloqueada' }
];

const TASK_STATUSES = [
  { key: 'pending', label: 'Pendiente' },
  { key: 'in_progress', label: 'En proceso' },
  { key: 'paused', label: 'En pausa' },
  { key: 'completed', label: 'Finalizada' },
  { key: 'cancelled', label: 'Cancelada' }
];

const EXPENSE_PAYMENT_STATUSES = [
  { key: 'pending', label: 'Pendiente' },
  { key: 'partial', label: 'Parcial' },
  { key: 'paid', label: 'Pagado' }
];

const ACCOUNTING_STATUSES = [
  { key: 'pending', label: 'Pendiente de enviar' },
  { key: 'sent', label: 'Enviado a contabilidad' },
  { key: 'omitted', label: 'Omitido' },
  { key: 'error', label: 'Con error' }
];

const EXPENSE_LOCK_ROLES = new Set(['admin', 'administrator', 'administrador', 'gerente', 'manager', 'supervisor']);

const QUOTE_STATUSES = [
  { key: 'draft', label: 'Borrador' },
  { key: 'sent', label: 'Enviada' },
  { key: 'approved', label: 'Aprobada' },
  { key: 'rejected', label: 'Rechazada' },
  { key: 'converted_project', label: 'Transformada a proyecto' },
  { key: 'converted', label: 'Convertida a factura' }
];

const QUOTE_DASHBOARD_VIEWS = new Set(['summary', 'list', 'new', 'status']);
const QUOTE_DASHBOARD_SCOPES = new Set(['active', 'archived', 'all']);
const PROJECT_QUOTE_PDF_FIELD_GROUPS = [
  {
    key: 'summary',
    label: 'Resumen comercial',
    fields: [
      { key: 'project_code', label: 'Codigo de proyecto' },
      { key: 'project_name', label: 'Nombre del proyecto' },
      { key: 'issue_date', label: 'Fecha de emision' },
      { key: 'valid_until', label: 'Valida hasta' },
      { key: 'currency', label: 'Moneda' },
      { key: 'exchange_rate', label: 'Tipo de cambio' }
    ]
  },
  {
    key: 'lines',
    label: 'Lineas cotizadas',
    fields: [
      { key: 'line_details', label: 'Detalle del servicio' },
      { key: 'line_qty', label: 'Cantidad' },
      { key: 'line_unit_price', label: 'Precio unitario' },
      { key: 'line_tax_rate', label: 'IVA por linea' },
      { key: 'line_total', label: 'Total por linea' }
    ]
  },
  {
    key: 'totals',
    label: 'Totales',
    fields: [
      { key: 'cost_estimated', label: 'Costo estimado' },
      { key: 'margin_percent', label: 'Margen estimado' },
      { key: 'subtotal', label: 'Subtotal' },
      { key: 'tax_amount', label: 'Impuestos' },
      { key: 'discount_amount', label: 'Descuento' },
      { key: 'total', label: 'Total' }
    ]
  },
  {
    key: 'sections',
    label: 'Secciones',
    fields: [
      { key: 'customer', label: 'Datos del cliente' },
      { key: 'notes', label: 'Alcance y observaciones' }
    ]
  }
];
const PROJECT_QUOTE_PDF_FIELD_KEYS = PROJECT_QUOTE_PDF_FIELD_GROUPS.flatMap((group) => group.fields.map((field) => field.key));
const PROJECT_QUOTE_PDF_DEFAULT_FIELDS = PROJECT_QUOTE_PDF_FIELD_KEYS.slice();

const DETAIL_TABS = [
  { key: 'summary', label: 'Resumen' },
  { key: 'financial', label: 'Reporte financiero' },
  { key: 'schedule', label: 'Cronograma' },
  { key: 'tasks', label: 'Tareas' },
  { key: 'expenses', label: 'Gastos' },
  { key: 'quotes', label: 'Cotización' },
  { key: 'knowledge', label: 'Bitácora' },
  { key: 'files', label: 'Archivo' }
];

const PROJECT_UPLOAD_ROOT = path.join(process.cwd(), 'data', 'uploads', 'projects');
const PROJECT_FILE_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.txt',
  '.csv'
]);

function registerProjectRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    getCompanyId,
    csrfMiddleware,
    setFlash,
    logAction,
    buildFileUrl,
    parseCurrencyList,
    enqueueDbTransaction,
    commitTransaction,
    rollbackTransaction
  } = deps;

  ensureDir(PROJECT_UPLOAD_ROOT);

  const projectFileUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const companyId = getCompanyId(req) || 'shared';
        const projectId = normalizeId(req.params && req.params.id) || 'general';
        const targetDir = path.join(PROJECT_UPLOAD_ROOT, `company-${companyId}`, `project-${projectId}`);
        ensureDir(targetDir);
        cb(null, targetDir);
      },
      filename: (req, file, cb) => {
        const ext = safeExtension(file && file.originalname);
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
      }
    }),
    limits: { fileSize: 12 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = safeExtension(file && file.originalname);
      if ((file && file.mimetype && file.mimetype.startsWith('image/')) || PROJECT_FILE_EXTENSIONS.has(ext)) {
        return cb(null, true);
      }
      const err = new Error('PROJECT_FILETYPE');
      err.code = 'PROJECT_FILETYPE';
      return cb(err);
    }
  });

  const schemaReady = ensureProjectsSchema({
    db,
    parseCurrencyList
  }).catch((error) => {
    console.error('[projects] schema initialization failed', error);
    throw error;
  });

  const asyncRoute = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

  app.get(
    '/mensajes/projects/quotes/:quoteId',
    requireAuth,
    requirePermission('projects', 'view'),
    (req, res) => {
      const quoteId = normalizeId(req.params.quoteId);
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(quoteId ? `/projects/quotes/${quoteId}${query}` : '/projects?section=quotes&quote_view=list');
    }
  );

  app.get(
    '/mensajes/projects/quotes/:quoteId/pdf',
    requireAuth,
    requirePermission('projects', 'view'),
    (req, res) => {
      const quoteId = normalizeId(req.params.quoteId);
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(quoteId ? `/projects/quotes/${quoteId}/pdf${query}` : '/projects?section=quotes&quote_view=list');
    }
  );

  app.get(
    '/mensajes/projects/:id/quotes/:quoteId/pdf',
    requireAuth,
    requirePermission('projects', 'view'),
    (req, res) => {
      const projectId = normalizeId(req.params.id);
      const quoteId = normalizeId(req.params.quoteId);
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(
        projectId && quoteId ? `/projects/${projectId}/quotes/${quoteId}/pdf${query}` : '/projects'
      );
    }
  );

  app.get(
    '/projects',
    requireAuth,
    requirePermission('projects', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const viewModel = await buildProjectsDashboardViewModel({ db, companyId, query: req.query, parseCurrencyList });
      return res.render('projects', {
        ...viewModel,
        lang: res.locals.lang,
        t: res.locals.t,
        csrfToken: res.locals.csrfToken,
        flash: res.locals.flash,
        currentModule: 'projects'
      });
    })
  );

  app.get(
    '/projects/quotes/:quoteId',
    requireAuth,
    requirePermission('projects', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const quoteId = normalizeId(req.params.quoteId);
      if (!quoteId) return res.redirect('/projects?section=quotes&quote_view=list');

      const quoteRow = await getDb(
        db,
        `SELECT q.*,
                p.name AS project_name,
                p.code AS project_code,
                p.client_id AS project_client_id,
                p.description AS project_description,
                c.name AS customer_name,
                c.customer_code AS customer_code
         FROM project_quotes q
         LEFT JOIN projects p ON p.id = q.project_id AND p.company_id = q.company_id
         LEFT JOIN customers c ON c.id = q.customer_id AND c.company_id = q.company_id
         WHERE q.id = ? AND q.company_id = ?`,
        [quoteId, companyId]
      );

      if (!quoteRow) {
        setFlash(req, 'error', 'No se encontro la cotizacion solicitada.');
        return res.redirect('/projects?section=quotes&quote_view=list');
      }

      const projectId = normalizeId(quoteRow.project_id);
      const invoiceId = normalizeId(quoteRow.converted_invoice_id);
      const [lineRows, fileRows, expenseRows, invoice, invoiceItems] = await Promise.all([
        allDb(
          db,
          `SELECT *
           FROM project_quote_lines
           WHERE quote_id = ? AND company_id = ?
           ORDER BY sort_order ASC, id ASC`,
          [quoteId, companyId]
        ),
        allDb(
          db,
          `SELECT f.*, u.username AS uploaded_by_name
           FROM project_files f
           LEFT JOIN users u ON u.id = f.uploaded_by AND u.company_id = f.company_id
           WHERE f.company_id = ?
             AND (
               (? > 0 AND f.project_id = ?)
               OR (f.source_type = 'quote' AND f.source_id = ?)
             )
           ORDER BY CASE WHEN f.source_type = 'quote' AND f.source_id = ? THEN 0 ELSE 1 END,
                    COALESCE(f.uploaded_at, f.created_at) DESC,
                    f.id DESC`,
          [companyId, projectId, projectId, quoteId, quoteId]
        ),
        projectId
          ? allDb(
            db,
            `SELECT id, description, category, total_amount, attachment_path, expense_date, created_at
             FROM project_expenses
             WHERE project_id = ? AND company_id = ? AND COALESCE(attachment_path, '') <> ''
             ORDER BY COALESCE(expense_date, created_at) DESC, id DESC`,
            [projectId, companyId]
          )
          : Promise.resolve([]),
        invoiceId
          ? getDb(
            db,
            `SELECT id, invoice_number, status, issue_date, due_date, subtotal, tax_total, discount_total, total, balance_due, currency
             FROM invoice_headers
             WHERE id = ? AND company_id = ?`,
            [invoiceId, companyId]
          )
          : Promise.resolve(null),
        invoiceId
          ? allDb(
            db,
            `SELECT description, qty, unit_price, tax_amount, discount_amount, total
             FROM invoice_items
             WHERE header_id = ? AND company_id = ?
             ORDER BY sort_order ASC, id ASC`,
            [invoiceId, companyId]
          )
          : Promise.resolve([])
      ]);

      const quote = decorateDashboardQuoteRow(quoteRow, lineRows);
      const documents = [
        ...fileRows.map((row) => ({
          id: `file-${row.id}`,
          name: row.original_name || row.filename || 'Documento',
          type: row.file_type || 'Archivo',
          notes: row.notes || '',
          uploaded_at: row.uploaded_at || row.created_at,
          uploaded_by_name: row.uploaded_by_name || '',
          url: buildFileUrl(row.filename)
        })),
        ...expenseRows.map((row) => ({
          id: `expense-${row.id}`,
          name: row.description || row.category || `Gasto ${row.id}`,
          type: 'Comprobante de gasto',
          notes: row.total_amount ? `Monto: ${quote.currency || 'GTQ'} ${Number(row.total_amount || 0).toFixed(2)}` : '',
          uploaded_at: row.expense_date || row.created_at,
          uploaded_by_name: '',
          url: buildFileUrl(row.attachment_path)
        }))
      ].filter((doc) => doc.url);

      return res.render('project-quote-detail', {
        quote,
        documents,
        invoice,
        invoiceItems,
        lang: res.locals.lang,
        t: res.locals.t,
        csrfToken: res.locals.csrfToken,
        flash: res.locals.flash,
        currentModule: 'projects'
      });
    })
  );

  app.get(
    '/projects/quotes/:quoteId/pdf',
    requireAuth,
    requirePermission('projects', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const quoteId = normalizeId(req.params.quoteId);
      if (!quoteId) return res.redirect('/projects?section=quotes&quote_view=list');

      const quote = await getDb(
        db,
        `SELECT q.*,
                p.id AS project_resolved_id,
                p.name AS project_name,
                p.code AS project_code,
                p.description AS project_description,
                p.client_id AS project_client_id
         FROM project_quotes q
         LEFT JOIN projects p ON p.id = q.project_id AND p.company_id = q.company_id
         WHERE q.id = ? AND q.company_id = ?`,
        [quoteId, companyId]
      );
      if (!quote) {
        setFlash(req, 'error', 'No se encontro la cotizacion solicitada.');
        return res.redirect('/projects?section=quotes&quote_view=list');
      }

      const project = {
        id: normalizeId(quote.project_resolved_id) || 0,
        code: quote.project_code || 'GENERAL',
        name: quote.project_name || 'Cotizacion general',
        description: quote.project_description || ''
      };
      const customerId = normalizeId(quote.customer_id) || normalizeId(quote.project_client_id);
      const [company, customer, lines, attachments] = await Promise.all([
        fetchProjectCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl),
        customerId
          ? getDb(
            db,
            `SELECT id, name, customer_code, phone, email, COALESCE(full_address, address) AS address
             FROM customers
             WHERE id = ? AND company_id = ?`,
            [customerId, companyId]
          )
          : Promise.resolve(null),
        allDb(
          db,
          `SELECT *
           FROM project_quote_lines
           WHERE quote_id = ? AND company_id = ?
           ORDER BY sort_order ASC, id ASC`,
          [quoteId, companyId]
        ),
        fetchProjectQuotePdfAttachments(db, companyId, quoteId)
      ]);

      const quoteDocument = buildProjectQuotePdfBundle({ project, quote, customer, lines, attachments });
      const fileName = `${slugifyProjectQuotePdfName(quoteDocument.fileBaseName || quoteDocument.title, 'cotizacion')}.pdf`;
      const disposition = normalizeText(req.query.download) === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      await renderProjectQuotePdfToStream(quoteDocument, company, res);
      return null;
    })
  );

  app.post(
    '/projects/create',
    requireAuth,
    requirePermission('projects', 'create'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = getUserId(req);
      const payload = buildProjectPayload(req.body);
      const quoteId = normalizeId(req.body.quote_id);
      if (!payload.name) {
        setFlash(req, 'error', 'Debes escribir el nombre del proyecto.');
        return res.redirect('/projects?section=projects#new-project');
      }
      const sourceQuote = quoteId
        ? await getDb(
          db,
          `SELECT *
           FROM project_quotes
           WHERE id = ?
             AND company_id = ?
             AND COALESCE(project_id, 0) = 0
             AND COALESCE(is_archived, 0) = 0`,
          [quoteId, companyId]
        )
        : null;
      if (quoteId && !sourceQuote) {
        setFlash(req, 'error', 'La cotizacion seleccionada no esta disponible para crear un proyecto.');
        return res.redirect('/projects?section=projects#new-project');
      }
      const code = payload.code || await generateProjectCode(db, companyId);
      const clientId = payload.clientId || normalizeId(sourceQuote && sourceQuote.customer_id) || null;
      const saleAmount = payload.saleAmount || toNumber(sourceQuote && sourceQuote.total, 0);
      const estimatedBudget = payload.estimatedBudget || toNumber(sourceQuote && sourceQuote.cost_estimated, 0);
      const insert = await runDb(
        db,
        `INSERT INTO projects
         (company_id, code, name, client_id, description, start_date, estimated_end_date, real_end_date, status, priority,
          estimated_budget, real_cost, sale_amount, profit_estimated, profit_real, notes, source_quote_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          companyId,
          code,
          payload.name,
          clientId,
          payload.description || normalizeText(sourceQuote && sourceQuote.description),
          payload.startDate,
          payload.estimatedEndDate,
          payload.realEndDate,
          payload.status,
          payload.priority,
          estimatedBudget,
          payload.realCost,
          saleAmount,
          payload.profitEstimated || round2(saleAmount - estimatedBudget),
          payload.profitReal,
          payload.notes,
          quoteId || null,
          userId
        ]
      );
      let createdTasks = 0;
      if (sourceQuote) {
        await runDb(
          db,
          `UPDATE project_quotes
           SET project_id = ?, status = 'converted_project', is_archived = 1, archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND company_id = ?`,
          [insert.lastID, quoteId, companyId]
        );
        await runDb(
          db,
          `UPDATE project_quote_lines
           SET project_id = ?
           WHERE quote_id = ? AND company_id = ?`,
          [insert.lastID, quoteId, companyId]
        );
        createdTasks = await createProjectTasksFromQuoteLines({
          db,
          companyId,
          projectId: insert.lastID,
          quoteId,
          userId
        });
      }

      await createProjectLog({
        db,
        companyId,
        projectId: insert.lastID,
        type: 'project_created',
        message: `Proyecto creado: ${payload.name}`,
        createdBy: userId,
        metadata: { code, status: payload.status, quote_id: quoteId, tasks_created: createdTasks }
      });
      if (typeof logAction === 'function') {
        logAction(userId, 'project_created', JSON.stringify({ project_id: insert.lastID, code }), companyId);
      }
      setFlash(req, 'success', 'Proyecto creado correctamente.');
      return res.redirect(`/projects/${insert.lastID}`);
    })
  );

  app.post(
    '/projects/tasks/create',
    requireAuth,
    requirePermission('projects', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.body.project_id);
      if (!projectId) {
        setFlash(req, 'error', 'Debes seleccionar el proyecto para la tarea.');
        return res.redirect(buildProjectsDashboardUrl('tasks'));
      }
      const project = await getProjectById(db, companyId, projectId);
      if (!project) {
        setFlash(req, 'error', 'No se encontro el proyecto seleccionado para la tarea.');
        return res.redirect(buildProjectsDashboardUrl('tasks'));
      }
      try {
        await createProjectTask({
          db,
          companyId,
          projectId,
          body: req.body,
          userId: getUserId(req)
        });
      } catch (error) {
        if (error && error.message === 'PROJECT_TASK_TITLE_REQUIRED') {
          setFlash(req, 'error', 'Debes escribir el titulo de la tarea.');
          return res.redirect(buildProjectsDashboardUrl('tasks', { task_project_id: projectId }));
        }
        throw error;
      }
      setFlash(req, 'success', 'Tarea creada correctamente.');
      return res.redirect(buildProjectsDashboardUrl('tasks', { task_project_id: projectId }));
    })
  );

  app.post(
    '/projects/quotes/create',
    requireAuth,
    requirePermission('projects', 'quotes'),
    projectFileUpload.array('quote_attachments', 10),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.body.project_id);
      const project = projectId ? await getProjectById(db, companyId, projectId) : null;
      if (projectId && !project) {
        setFlash(req, 'error', 'No se encontro el proyecto seleccionado para la cotizacion.');
        return res.redirect(buildProjectsDashboardUrl('quotes', { quote_view: 'new' }));
      }
      try {
        await createProjectQuote({
          db,
          companyId,
          projectId,
          project,
          body: req.body,
          userId: getUserId(req),
          enqueueDbTransaction,
          commitTransaction,
          rollbackTransaction,
          parseCurrencyList,
          files: req.files
        });
      } catch (error) {
        if (error && error.message === 'PROJECT_QUOTE_LINES_REQUIRED') {
          setFlash(req, 'error', 'Debes agregar al menos una linea de cotizacion.');
          const redirectOptions = projectId ? { quote_view: 'new', quote_project_id: projectId } : { quote_view: 'new' };
          return res.redirect(buildProjectsDashboardUrl('quotes', redirectOptions));
        }
        throw error;
      }
      setFlash(req, 'success', 'Cotizacion creada correctamente.');
      const redirectOptions = projectId ? { quote_view: 'list', quote_project_id: projectId } : { quote_view: 'list' };
      return res.redirect(buildProjectsDashboardUrl('quotes', redirectOptions));
    })
  );

  app.post(
    '/projects/quotes/:quoteId/update',
    requireAuth,
    requirePermission('projects', 'quotes'),
    projectFileUpload.array('quote_attachments', 10),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const quoteId = normalizeId(req.params.quoteId);
      const fallbackRedirect = buildProjectsDashboardUrl('quotes', {
        quote_view: 'list',
        quote_mode: 'edit',
        quote_id: quoteId
      });
      const quote = await getDb(
        db,
        'SELECT * FROM project_quotes WHERE id = ? AND company_id = ?',
        [quoteId, companyId]
      );
      if (!quote) {
        setFlash(req, 'error', 'No se encontro la cotizacion seleccionada.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectsDashboardUrl('quotes', { quote_view: 'list' })));
      }
      if (quote.converted_invoice_id) {
        setFlash(req, 'error', 'No puedes editar una cotizacion ya convertida a factura.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectsDashboardUrl('quotes', { quote_view: 'list' })));
      }
      const quoteProjectId = normalizeId(quote.project_id);
      const project = quoteProjectId ? await getProjectById(db, companyId, quoteProjectId) : null;
      if (quoteProjectId && !project) {
        setFlash(req, 'error', 'No se encontro el proyecto relacionado con la cotizacion.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectsDashboardUrl('quotes', { quote_view: 'list' })));
      }
      try {
        await updateProjectQuote({
          db,
          companyId,
          project,
          quote,
          body: req.body,
          userId: getUserId(req),
          enqueueDbTransaction,
          commitTransaction,
          rollbackTransaction,
          parseCurrencyList,
          files: req.files
        });
      } catch (error) {
        if (error && error.message === 'PROJECT_QUOTE_LINES_REQUIRED') {
          setFlash(req, 'error', 'Debes agregar al menos una linea de cotizacion.');
          return res.redirect(resolveProjectsReturnTo(req.body.return_to, fallbackRedirect));
        }
        throw error;
      }
      setFlash(req, 'success', 'Cotizacion actualizada correctamente.');
      return res.redirect(resolveProjectsReturnTo(
        req.body.return_to,
        buildProjectsDashboardUrl('quotes', { quote_view: 'list' })
      ));
    })
  );

  app.post(
    '/projects/quotes/:quoteId/attachments',
    requireAuth,
    requirePermission('projects', 'quotes'),
    projectFileUpload.array('quote_attachments', 10),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const quoteId = normalizeId(req.params.quoteId);
      const quote = await getDb(
        db,
        'SELECT * FROM project_quotes WHERE id = ? AND company_id = ?',
        [quoteId, companyId]
      );
      if (!quote) {
        setFlash(req, 'error', 'No se encontro la cotizacion seleccionada.');
        return res.redirect('/projects?section=quotes&quote_view=list');
      }
      if (!Array.isArray(req.files) || !req.files.length) {
        setFlash(req, 'error', 'Debes seleccionar al menos un archivo valido.');
        return res.redirect(`/projects/quotes/${quoteId}`);
      }
      await insertProjectQuoteAttachments({
        db,
        companyId,
        projectId: normalizeId(quote.project_id) || 0,
        quoteId,
        files: req.files,
        userId: getUserId(req)
      });
      if (normalizeId(quote.project_id)) {
        await createProjectLog({
          db,
          companyId,
          projectId: normalizeId(quote.project_id),
          type: 'file_uploaded',
          message: `Soporte agregado a cotizacion: ${quote.title}.`,
          createdBy: getUserId(req),
          metadata: { quote_id: quoteId }
        });
      }
      setFlash(req, 'success', 'Adjuntos agregados a la cotizacion.');
      return res.redirect(`/projects/quotes/${quoteId}`);
    })
  );

  app.post(
    '/projects/quotes/:quoteId/archive',
    requireAuth,
    requirePermission('projects', 'quotes'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const quoteId = normalizeId(req.params.quoteId);
      const quote = await getDb(
        db,
        'SELECT * FROM project_quotes WHERE id = ? AND company_id = ?',
        [quoteId, companyId]
      );
      if (!quote) {
        setFlash(req, 'error', 'No se encontro la cotizacion seleccionada.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectsDashboardUrl('quotes', { quote_view: 'list' })));
      }
      const shouldRestore = normalizeText(req.body.archive_action).toLowerCase() === 'restore';
      await runDb(
        db,
        `UPDATE project_quotes
         SET is_archived = ?, archived_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ?`,
        [
          shouldRestore ? 0 : 1,
          shouldRestore ? null : new Date().toISOString(),
          quoteId,
          companyId
        ]
      );
      await createProjectLog({
        db,
        companyId,
        projectId: quote.project_id,
        type: shouldRestore ? 'quote_restored' : 'quote_archived',
        message: shouldRestore
          ? `Cotizacion restaurada: ${quote.title}.`
          : `Cotizacion archivada: ${quote.title}.`,
        createdBy: getUserId(req),
        metadata: { quote_id: quoteId }
      });
      setFlash(req, 'success', shouldRestore ? 'Cotizacion restaurada.' : 'Cotizacion archivada.');
      return res.redirect(resolveProjectsReturnTo(
        req.body.return_to,
        buildProjectsDashboardUrl('quotes', { quote_view: 'list' })
      ));
    })
  );

  app.post(
    '/projects/quotes/:quoteId/project',
    requireAuth,
    requirePermission('projects', 'quotes'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const quoteId = normalizeId(req.params.quoteId);
      const quote = await getDb(
        db,
        'SELECT * FROM project_quotes WHERE id = ? AND company_id = ?',
        [quoteId, companyId]
      );
      if (!quote) {
        setFlash(req, 'error', 'No se encontro la cotizacion seleccionada.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectsDashboardUrl('quotes', { quote_view: 'list' })));
      }
      const createdProject = await createProjectFromQuote({
        db,
        companyId,
        quote,
        userId: getUserId(req)
      });
      if (!createdProject || !createdProject.projectId) {
        setFlash(req, 'error', 'La cotizacion ya tiene un proyecto asociado o no esta disponible.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectsDashboardUrl('quotes', { quote_view: 'list' })));
      }
      setFlash(req, 'success', `Cotizacion transformada a proyecto con ${createdProject.tasksCreated} tarea(s).`);
      return res.redirect(`/projects/${createdProject.projectId}?tab=tasks`);
    })
  );

  app.post(
    '/projects/quotes/bulk-status',
    requireAuth,
    requirePermission('projects', 'quotes'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = getUserId(req);
      const quoteIds = uniqueIds(req.body.quote_ids);
      const action = normalizeQuoteBulkAction(req.body.bulk_action);
      const targetStatus = normalizeQuoteStatus(req.body.status);
      const rejectionComment = normalizeText(req.body.rejection_comment);
      const returnTo = resolveProjectsReturnTo(
        req.body.return_to,
        buildProjectsDashboardUrl('quotes', { quote_view: 'status' })
      );

      if (!quoteIds.length) {
        setFlash(req, 'error', 'Selecciona al menos una cotizacion.');
        return res.redirect(returnTo);
      }
      if (action === 'status' && targetStatus === 'rejected' && !rejectionComment) {
        setFlash(req, 'error', 'Debes escribir el motivo para anular cotizaciones.');
        return res.redirect(returnTo);
      }

      const summary = {
        updated: 0,
        invoiced: 0,
        projects: 0,
        skipped: 0
      };

      for (let index = 0; index < quoteIds.length; index += 1) {
        const quoteId = quoteIds[index];
        const quote = await getDb(
          db,
          'SELECT * FROM project_quotes WHERE id = ? AND company_id = ?',
          [quoteId, companyId]
        );
        if (!quote) {
          summary.skipped += 1;
          continue;
        }

        if (action === 'invoice') {
          try {
            const created = await convertProjectQuoteToInvoice({
              db,
              companyId,
              quote,
              userId,
              parseCurrencyList,
              enqueueDbTransaction,
              commitTransaction,
              rollbackTransaction
            });
            summary.invoiced += created && created.invoiceHeaderId ? 1 : 0;
          } catch (error) {
            summary.skipped += 1;
          }
          continue;
        }

        if (action === 'project') {
          try {
            const createdProject = await createProjectFromQuote({
              db,
              companyId,
              quote,
              userId
            });
            if (createdProject && createdProject.projectId) {
              summary.projects += 1;
            } else {
              summary.skipped += 1;
            }
          } catch (error) {
            summary.skipped += 1;
          }
          continue;
        }

        if (quote.converted_invoice_id && targetStatus !== 'converted') {
          summary.skipped += 1;
          continue;
        }
        await updateQuoteStatus({
          db,
          companyId,
          quote,
          status: targetStatus,
          rejectionComment,
          userId
        });
        summary.updated += 1;
      }

      const messages = [];
      if (summary.updated) messages.push(`${summary.updated} estado(s) actualizado(s)`);
      if (summary.invoiced) messages.push(`${summary.invoiced} factura(s) creada(s)`);
      if (summary.projects) messages.push(`${summary.projects} proyecto(s) creado(s)`);
      if (summary.skipped) messages.push(`${summary.skipped} omitida(s)`);
      setFlash(req, summary.updated || summary.invoiced || summary.projects ? 'success' : 'error', messages.join(', ') || 'No se aplicaron cambios.');
      return res.redirect(returnTo);
    })
  );

  app.get(
    '/projects/:id',
    requireAuth,
    requirePermission('projects', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      if (!projectId) return res.redirect('/projects');
      const viewModel = await buildProjectDetailViewModel({
        db,
        companyId,
        projectId,
        query: req.query,
        buildFileUrl,
        currentUser: req.session.user,
        parseCurrencyList
      });
      if (!viewModel || !viewModel.project) {
        setFlash(req, 'error', 'No se encontró el proyecto solicitado.');
        return res.redirect('/projects');
      }
      return res.render('project-detail', {
        ...viewModel,
        lang: res.locals.lang,
        t: res.locals.t,
        csrfToken: res.locals.csrfToken,
        flash: res.locals.flash,
        currentModule: 'projects'
      });
    })
  );

  app.post(
    '/projects/:id/update',
    requireAuth,
    requirePermission('projects', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      if (!projectId) return res.redirect('/projects');
      const existing = await getProjectById(db, companyId, projectId);
      if (!existing) return res.redirect('/projects');
      const payload = buildProjectPayload(req.body, existing);
      if (!payload.name) {
        setFlash(req, 'error', 'Debes escribir el nombre del proyecto.');
        return res.redirect(buildProjectDetailUrl(projectId, 'summary'));
      }
      await runDb(
        db,
        `UPDATE projects
         SET code = ?, name = ?, client_id = ?, description = ?, start_date = ?, estimated_end_date = ?, real_end_date = ?,
             status = ?, priority = ?, estimated_budget = ?, sale_amount = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ?`,
        [
          payload.code || existing.code,
          payload.name,
          payload.clientId,
          payload.description,
          payload.startDate,
          payload.estimatedEndDate,
          payload.realEndDate,
          payload.status,
          payload.priority,
          payload.estimatedBudget,
          payload.saleAmount,
          payload.notes,
          projectId,
          companyId
        ]
      );
      if (existing.status !== payload.status) {
        await createProjectLog({
          db,
          companyId,
          projectId,
          type: 'status_changed',
          message: `Estado cambiado de ${getStatusLabel(existing.status)} a ${getStatusLabel(payload.status)}.`,
          createdBy: getUserId(req)
        });
      }
      await refreshProjectFinancials(db, companyId, projectId);
      setFlash(req, 'success', 'Proyecto actualizado.');
      return res.redirect(buildProjectDetailUrl(projectId, 'summary'));
    })
  );

  app.post(
    '/projects/:id/finalize',
    requireAuth,
    requirePermission('projects', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const project = await getProjectById(db, companyId, projectId);
      if (!project) return res.redirect('/projects');
      const finishDate = normalizeDate(req.body.real_end_date) || today();
      await runDb(
        db,
        `UPDATE projects
         SET status = 'completed', real_end_date = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ?`,
        [finishDate, projectId, companyId]
      );
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'project_finalized',
        message: `Proyecto finalizado el ${finishDate}.`,
        createdBy: getUserId(req)
      });
      setFlash(req, 'success', 'Proyecto finalizado.');
      return res.redirect(buildProjectDetailUrl(projectId, 'financial'));
    })
  );

  app.post(
    '/projects/:id/schedule/create',
    requireAuth,
    requirePermission('projects', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const project = await getProjectById(db, companyId, projectId);
      if (!project) return res.redirect('/projects');
      const activityName = normalizeText(req.body.name);
      if (!activityName) {
        setFlash(req, 'error', 'Debes escribir el nombre de la actividad.');
        return res.redirect(buildProjectDetailUrl(projectId, 'schedule'));
      }
      const responsibleId = normalizeId(req.body.responsible_id);
      const responsibleName = await resolveUserName(db, companyId, responsibleId);
      await runDb(
        db,
        `INSERT INTO project_schedule
         (project_id, company_id, name, start_date, estimated_end_date, real_end_date, responsible_id, responsible, status, progress_percent, observations, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          projectId,
          companyId,
          activityName,
          normalizeDate(req.body.start_date),
          normalizeDate(req.body.estimated_end_date),
          normalizeDate(req.body.real_end_date),
          responsibleId,
          responsibleName || normalizeText(req.body.responsible),
          normalizeScheduleStatus(req.body.status),
          clampPercentage(req.body.progress_percent),
          normalizeText(req.body.observations),
          getUserId(req)
        ]
      );
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'schedule_created',
        message: `Actividad agregada al cronograma: ${activityName}.`,
        createdBy: getUserId(req)
      });
      setFlash(req, 'success', 'Actividad agregada al cronograma.');
      return res.redirect(buildProjectDetailUrl(projectId, 'schedule'));
    })
  );

  app.post(
    '/projects/:id/schedule/:scheduleId/update',
    requireAuth,
    requirePermission('projects', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const scheduleId = normalizeId(req.params.scheduleId);
      if (!projectId || !scheduleId) return res.redirect('/projects');
      const row = await getDb(
        db,
        'SELECT * FROM project_schedule WHERE id = ? AND project_id = ? AND company_id = ?',
        [scheduleId, projectId, companyId]
      );
      if (!row) return res.redirect(buildProjectDetailUrl(projectId, 'schedule'));
      const responsibleId = normalizeId(req.body.responsible_id);
      const responsibleName = await resolveUserName(db, companyId, responsibleId);
      await runDb(
        db,
        `UPDATE project_schedule
         SET name = ?, start_date = ?, estimated_end_date = ?, real_end_date = ?, responsible_id = ?, responsible = ?, status = ?, progress_percent = ?, observations = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ? AND company_id = ?`,
        [
          normalizeText(req.body.name) || row.name,
          normalizeDate(req.body.start_date) || row.start_date,
          normalizeDate(req.body.estimated_end_date) || row.estimated_end_date,
          normalizeDate(req.body.real_end_date),
          responsibleId,
          responsibleName || normalizeText(req.body.responsible) || row.responsible,
          normalizeScheduleStatus(req.body.status),
          clampPercentage(req.body.progress_percent),
          normalizeText(req.body.observations),
          scheduleId,
          projectId,
          companyId
        ]
      );
      setFlash(req, 'success', 'Actividad actualizada.');
      return res.redirect(buildProjectDetailUrl(projectId, 'schedule'));
    })
  );

  app.post(
    '/projects/:id/tasks/create',
    requireAuth,
    requirePermission('projects', 'edit'),
    projectFileUpload.single('attachment'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const project = await getProjectById(db, companyId, projectId);
      if (!project) return res.redirect('/projects');
      const title = normalizeText(req.body.title);
      if (!title) {
        setFlash(req, 'error', 'Debes escribir el título de la tarea.');
        return res.redirect(buildProjectDetailUrl(projectId, 'tasks'));
      }
      const nextOrderRow = await getDb(
        db,
        'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM project_tasks WHERE project_id = ? AND company_id = ?',
        [projectId, companyId]
      );
      const taskColor = await getNextProjectTaskColor(db, companyId);
      const insert = await runDb(
        db,
        `INSERT INTO project_tasks
         (project_id, company_id, title, description, assigned_to, status, priority, color, sort_order, estimated_hours, real_hours, start_date, due_date, completed_at, complications, solution_applied, learned_notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          projectId,
          companyId,
          title,
          normalizeText(req.body.description),
          normalizeId(req.body.assigned_to),
          normalizeTaskStatus(req.body.status),
          normalizePriority(req.body.priority),
          taskColor,
          toNumber(nextOrderRow && nextOrderRow.next_order, 1),
          toNullableNumber(req.body.estimated_hours),
          toNullableNumber(req.body.real_hours),
          normalizeDate(req.body.start_date),
          normalizeDate(req.body.due_date),
          null,
          null,
          null,
          null,
          getUserId(req)
        ]
      );
      if (req.file) {
        await createProjectFileRecord({
          db,
          projectId,
          companyId,
          file: req.file,
          userId: getUserId(req),
          notes: `Adjunto de tarea: ${title}`,
          sourceType: 'task',
          sourceId: insert.lastID,
          sourceLabel: title
        });
      }
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'task_created',
        message: `Nueva tarea creada: ${title}.`,
        createdBy: getUserId(req)
      });
      setFlash(req, 'success', 'Tarea creada correctamente.');
      return res.redirect(buildProjectDetailUrl(projectId, 'tasks'));
    })
  );

  app.post(
    '/projects/:id/tasks/:taskId/update',
    requireAuth,
    requirePermission('projects', 'edit'),
    projectFileUpload.single('attachment'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const taskId = normalizeId(req.params.taskId);
      if (!projectId || !taskId) return res.redirect('/projects');
      const task = await getDb(
        db,
        'SELECT * FROM project_tasks WHERE id = ? AND project_id = ? AND company_id = ?',
        [taskId, projectId, companyId]
      );
      if (!task) return res.redirect(buildProjectDetailUrl(projectId, 'tasks'));
      await runDb(
        db,
        `UPDATE project_tasks
         SET title = ?, description = ?, assigned_to = ?, status = ?, priority = ?, estimated_hours = ?, start_date = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ? AND company_id = ?`,
        [
          normalizeText(req.body.title) || task.title,
          normalizeText(req.body.description),
          normalizeId(req.body.assigned_to),
          normalizeTaskStatus(req.body.status),
          normalizePriority(req.body.priority),
          toNullableNumber(req.body.estimated_hours),
          normalizeDate(req.body.start_date),
          normalizeDate(req.body.due_date),
          taskId,
          projectId,
          companyId
        ]
      );
      if (req.file) {
        await createProjectFileRecord({
          db,
          projectId,
          companyId,
          file: req.file,
          userId: getUserId(req),
          notes: `Adjunto de tarea: ${normalizeText(req.body.title) || task.title}`,
          sourceType: 'task',
          sourceId: taskId,
          sourceLabel: normalizeText(req.body.title) || task.title
        });
      }
      setFlash(req, 'success', 'Tarea actualizada.');
      return res.redirect(`${buildProjectDetailUrl(projectId, 'tasks')}&task_id=${taskId}`);
    })
  );

  app.post(
    '/projects/:id/tasks/:taskId/move',
    requireAuth,
    requirePermission('projects', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const taskId = normalizeId(req.params.taskId);
      const direction = normalizeText(req.body.direction).toLowerCase();
      if (!projectId || !taskId || !['up', 'down'].includes(direction)) {
        return res.redirect(buildProjectDetailUrl(projectId, 'tasks'));
      }
      const tasks = await allDb(
        db,
        `SELECT id, sort_order
         FROM project_tasks
         WHERE project_id = ? AND company_id = ?
         ORDER BY sort_order ASC, id ASC`,
        [projectId, companyId]
      );
      const index = tasks.findIndex((item) => Number(item.id) === Number(taskId));
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (index >= 0 && swapIndex >= 0 && swapIndex < tasks.length) {
        const current = tasks[index];
        const swap = tasks[swapIndex];
        await runDb(db, 'UPDATE project_tasks SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [swap.sort_order, current.id, companyId]);
        await runDb(db, 'UPDATE project_tasks SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [current.sort_order, swap.id, companyId]);
      }
      return res.redirect(buildProjectDetailUrl(projectId, 'tasks'));
    })
  );

  app.post(
    '/projects/:id/tasks/:taskId/complete',
    requireAuth,
    requirePermission('projects', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const taskId = normalizeId(req.params.taskId);
      if (!projectId || !taskId) return res.redirect('/projects');
      const task = await getDb(
        db,
        'SELECT * FROM project_tasks WHERE id = ? AND project_id = ? AND company_id = ?',
        [taskId, projectId, companyId]
      );
      if (!task) return res.redirect(buildProjectDetailUrl(projectId, 'tasks'));
      const realHours = toNullableNumber(req.body.real_hours);
      if (realHours === null) {
        setFlash(req, 'error', 'Debes registrar las horas reales utilizadas para finalizar la tarea.');
        return res.redirect(buildProjectDetailUrl(projectId, 'tasks'));
      }
      await runDb(
        db,
        `UPDATE project_tasks
         SET status = 'completed',
             real_hours = ?,
             completed_at = ?,
             complications = ?,
             solution_applied = ?,
             learned_notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ? AND company_id = ?`,
        [
          realHours,
          normalizeDate(req.body.completed_at) || today(),
          normalizeText(req.body.complications),
          normalizeText(req.body.solution_applied),
          normalizeText(req.body.learned_notes),
          taskId,
          projectId,
          companyId
        ]
      );
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'task_completed',
        message: `Tarea finalizada: ${task.title}.`,
        createdBy: getUserId(req),
        metadata: {
          real_hours: realHours,
          complications: normalizeText(req.body.complications)
        }
      });
      setFlash(req, 'success', 'Tarea finalizada y documentada.');
      return res.redirect(buildProjectDetailUrl(projectId, 'tasks'));
    })
  );

  app.post(
    '/projects/:id/expenses/create',
    requireAuth,
    requirePermission('projects', 'expenses'),
    projectFileUpload.single('attachment'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const project = await getProjectById(db, companyId, projectId);
      if (!project) return res.redirect('/projects');
      const description = normalizeText(req.body.description);
      const amount = toNullableNumber(req.body.amount);
      if (!description || amount === null) {
        setFlash(req, 'error', 'Completa descripción y monto del gasto.');
        return res.redirect(buildProjectDetailUrl(projectId, 'expenses'));
      }
      const taxAmount = toNumber(req.body.tax_amount, 0);
      const totalAmount = toNumber(req.body.total_amount, round2(amount + taxAmount));
      const currency = normalizeText(req.body.currency).toUpperCase() || 'GTQ';
      const filePath = req.file ? normalizeStoredPath(req.file.path) : null;
      const expenseInsert = await runDb(
        db,
        `INSERT INTO project_expenses
         (project_id, company_id, task_id, supplier_id, expense_date, category, description, amount, tax_amount, total_amount, currency, invoice_number,
          notes, payment_status, accounting_status, attachment_path, accounting_entry_id, accounting_bill_id, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          projectId,
          companyId,
          normalizeId(req.body.task_id),
          normalizeId(req.body.supplier_id),
          normalizeDate(req.body.expense_date) || today(),
          normalizeText(req.body.category),
          description,
          amount,
          taxAmount,
          totalAmount,
          currency,
          normalizeText(req.body.invoice_number),
          normalizeText(req.body.notes),
          normalizeExpensePaymentStatus(req.body.payment_status),
          filePath,
          getUserId(req),
          getUserId(req)
        ]
      );
      if (req.file) {
        await createProjectFileRecord({
          db,
          projectId,
          companyId,
          file: req.file,
          userId: getUserId(req),
          notes: `Adjunto de gasto: ${description}`,
          sourceType: 'expense',
          sourceId: expenseInsert.lastID,
          sourceLabel: description
        });
      }
      await refreshProjectFinancials(db, companyId, projectId);
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'expense_created',
        message: `Gasto registrado: ${description}.`,
        createdBy: getUserId(req),
        metadata: { total_amount: totalAmount }
      });
      setFlash(req, 'success', 'Gasto registrado y marcado para contabilidad.');
      return res.redirect(buildProjectDetailUrl(projectId, 'expenses'));
    })
  );

  app.post(
    '/projects/:id/expenses/:expenseId/update',
    requireAuth,
    requirePermission('projects', 'expenses'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const expenseId = normalizeId(req.params.expenseId);
      const expense = await getProjectExpenseById(db, companyId, projectId, expenseId);
      if (!expense) return res.redirect(buildProjectDetailUrl(projectId, 'expenses'));
      if (isExpenseLocked(expense)) {
        await auditProjectExpenseAction({ logAction, req, companyId, action: 'project_expense_locked_edit_attempt', expense, extra: { project_id: projectId } });
        setFlash(req, 'error', 'Este gasto está bloqueado y no se puede editar.');
        return res.redirect(buildProjectDetailUrl(projectId, 'expenses') + `&expense_id=${expenseId}#expense-detail`);
      }
      const description = normalizeText(req.body.description);
      const amount = toNullableNumber(req.body.amount);
      if (!description || amount === null) {
        setFlash(req, 'error', 'Completa descripción y monto del gasto.');
        return res.redirect(buildProjectDetailUrl(projectId, 'expenses') + `&expense_id=${expenseId}&expense_mode=edit#expense-edit`);
      }
      const taxAmount = toNumber(req.body.tax_amount, toNumber(expense.tax_amount, 0));
      const totalAmount = toNumber(req.body.total_amount, round2(amount + taxAmount));
      const currency = normalizeText(req.body.currency).toUpperCase() || normalizeText(expense.currency).toUpperCase() || 'GTQ';
      await runDb(
        db,
        `UPDATE project_expenses
         SET supplier_id = ?, expense_date = ?, category = ?, description = ?, amount = ?, tax_amount = ?, total_amount = ?,
             currency = ?, invoice_number = ?, notes = ?, payment_status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ? AND company_id = ? AND COALESCE(is_locked, 0) = 0`,
        [
          normalizeId(req.body.supplier_id),
          normalizeDate(req.body.expense_date) || today(),
          normalizeText(req.body.category),
          description,
          amount,
          taxAmount,
          totalAmount,
          currency,
          normalizeText(req.body.invoice_number),
          normalizeText(req.body.notes),
          normalizeExpensePaymentStatus(req.body.payment_status),
          getUserId(req),
          expenseId,
          projectId,
          companyId
        ]
      );
      await refreshProjectFinancials(db, companyId, projectId);
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'expense_updated',
        message: `Gasto editado: ${description}.`,
        createdBy: getUserId(req),
        metadata: { expense_id: expenseId, total_amount: totalAmount }
      });
      await auditProjectExpenseAction({ logAction, req, companyId, action: 'project_expense_updated', expense: { ...expense, description }, extra: { project_id: projectId, total_amount: totalAmount } });
      setFlash(req, 'success', 'Gasto actualizado correctamente.');
      return res.redirect(buildProjectDetailUrl(projectId, 'expenses') + `&expense_id=${expenseId}#expense-detail`);
    })
  );

  app.post(
    '/projects/:id/expenses/:expenseId/lock',
    requireAuth,
    requirePermission('projects', 'expenses'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const expenseId = normalizeId(req.params.expenseId);
      if (!canLockProjectExpenses(req)) return res.status(403).send('Forbidden');
      const expense = await getProjectExpenseById(db, companyId, projectId, expenseId);
      if (!expense) return res.redirect(buildProjectDetailUrl(projectId, 'expenses'));
      if (!isExpenseLocked(expense)) {
        await runDb(
          db,
          `UPDATE project_expenses
           SET is_locked = 1, locked_by = ?, locked_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND project_id = ? AND company_id = ?`,
          [getUserId(req), getUserId(req), expenseId, projectId, companyId]
        );
        await createProjectLog({
          db,
          companyId,
          projectId,
          type: 'expense_locked',
          message: `Gasto bloqueado: ${expense.description}.`,
          createdBy: getUserId(req),
          metadata: { expense_id: expenseId }
        });
        await auditProjectExpenseAction({ logAction, req, companyId, action: 'project_expense_locked', expense, extra: { project_id: projectId } });
      }
      setFlash(req, 'success', 'Gasto bloqueado correctamente.');
      return res.redirect(buildProjectDetailUrl(projectId, 'expenses') + `&expense_id=${expenseId}#expense-detail`);
    })
  );

  app.post(
    '/projects/:id/expenses/:expenseId/unlock',
    requireAuth,
    requirePermission('projects', 'expenses'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const expenseId = normalizeId(req.params.expenseId);
      if (!canLockProjectExpenses(req)) return res.status(403).send('Forbidden');
      const expense = await getProjectExpenseById(db, companyId, projectId, expenseId);
      if (!expense) return res.redirect(buildProjectDetailUrl(projectId, 'expenses'));
      if (isExpenseLocked(expense)) {
        await runDb(
          db,
          `UPDATE project_expenses
           SET is_locked = 0, unlocked_by = ?, unlocked_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND project_id = ? AND company_id = ?`,
          [getUserId(req), getUserId(req), expenseId, projectId, companyId]
        );
        await createProjectLog({
          db,
          companyId,
          projectId,
          type: 'expense_unlocked',
          message: `Gasto desbloqueado: ${expense.description}.`,
          createdBy: getUserId(req),
          metadata: { expense_id: expenseId }
        });
        await auditProjectExpenseAction({ logAction, req, companyId, action: 'project_expense_unlocked', expense, extra: { project_id: projectId } });
      }
      setFlash(req, 'success', 'Gasto desbloqueado correctamente.');
      return res.redirect(buildProjectDetailUrl(projectId, 'expenses') + `&expense_id=${expenseId}#expense-detail`);
    })
  );

  app.post(
    '/projects/:id/expenses/:expenseId/send-accounting',
    requireAuth,
    requirePermission('projects', 'expenses'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const expenseId = normalizeId(req.params.expenseId);
      const expense = await getDb(
        db,
        `SELECT pe.*, s.trade_name AS supplier_name
         FROM project_expenses pe
         LEFT JOIN suppliers s ON s.id = pe.supplier_id AND s.company_id = pe.company_id
         WHERE pe.id = ? AND pe.project_id = ? AND pe.company_id = ?`,
        [expenseId, projectId, companyId]
      );
      if (!expense) return res.redirect(buildProjectDetailUrl(projectId, 'expenses'));
      if (expense.accounting_bill_id || expense.accounting_status === 'sent') {
        setFlash(req, 'info', 'Este gasto ya fue enviado a contabilidad.');
        return res.redirect(buildProjectDetailUrl(projectId, 'expenses'));
      }
      const billInsert = await runDb(
        db,
        `INSERT INTO bills
         (vendor_name, supplier_id, accounting_category, subtotal, tax_rate, tax_amount, total, currency, exchange_rate, subtotal_base, tax_amount_base, total_base, status, company_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)`,
        [
          expense.supplier_name || `Proveedor ${expense.supplier_id || expense.id}`,
          expense.supplier_id || null,
          expense.category || 'Gastos de proyectos',
          toNumber(expense.amount, 0),
          toNumber(expense.amount, 0) > 0 ? round2((toNumber(expense.tax_amount, 0) / Math.max(toNumber(expense.amount, 0), 0.01)) * 100) : 0,
          toNumber(expense.tax_amount, 0),
          toNumber(expense.total_amount, 0),
          normalizeText(expense.currency).toUpperCase() || 'GTQ',
          1,
          toNumber(expense.amount, 0),
          toNumber(expense.tax_amount, 0),
          toNumber(expense.total_amount, 0),
          companyId
        ]
      );
      await runDb(
        db,
        `UPDATE project_expenses
         SET accounting_status = 'sent', accounting_bill_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ?`,
        [billInsert.lastID, getUserId(req), expenseId, companyId]
      );
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'expense_sent_accounting',
        message: `Gasto enviado a contabilidad: ${expense.description}.`,
        createdBy: getUserId(req),
        metadata: { bill_id: billInsert.lastID }
      });
      setFlash(req, 'success', 'Gasto enviado a contabilidad como cuenta por pagar.');
      return res.redirect(buildProjectDetailUrl(projectId, 'expenses'));
    })
  );

  app.post(
    '/projects/:id/quotes/create',
    requireAuth,
    requirePermission('projects', 'quotes'),
    projectFileUpload.array('quote_attachments', 10),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const project = await getProjectById(db, companyId, projectId);
      if (!project) return res.redirect('/projects');
      const lines = parseQuoteLines(req.body);
      if (!lines.length) {
        setFlash(req, 'error', 'Debes agregar al menos una línea de cotización.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectDetailUrl(projectId, 'quotes')));
      }
      const totals = computeQuoteTotals(lines, req.body);
      const companyCurrency = await fetchCompanyCurrency(db, companyId, parseCurrencyList);
      const currency = resolveProjectQuoteCurrency(req.body.currency, companyCurrency.allowedCurrencies, companyCurrency.baseCurrency);
      const pdfFieldsJson = JSON.stringify(normalizeProjectQuotePdfFields(req.body.pdf_fields, Boolean(req.body.pdf_fields_submitted)));
      const title = normalizeText(req.body.title) || `Cotización ${project.code || project.name}`;
      const customerId = normalizeId(req.body.customer_id) || project.client_id || null;
      const createdBy = getUserId(req);
      const quote = await withTransaction(
        db,
        enqueueDbTransaction,
        commitTransaction,
        rollbackTransaction,
        async () => {
          const quoteInsert = await runDb(
            db,
            `INSERT INTO project_quotes
             (project_id, company_id, customer_id, title, description, valid_until, currency, exchange_rate, cost_estimated, margin_percent, tax_rate,
              discount_type, discount_value, discount_amount, subtotal, tax_amount, total, notes, pdf_fields_json, status, approved_at, converted_invoice_id, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              projectId,
              companyId,
              customerId,
              title,
              normalizeText(req.body.description) || project.description || null,
              normalizeDate(req.body.valid_until),
              currency,
              toNumber(req.body.exchange_rate, 1) || 1,
              totals.costEstimated,
              totals.marginPercent,
              totals.taxRate,
              totals.discountType,
              totals.discountValue,
              totals.discountAmount,
              totals.subtotal,
              totals.taxAmount,
              totals.total,
              normalizeText(req.body.notes),
              pdfFieldsJson,
              normalizeQuoteStatus(req.body.status),
              createdBy
            ]
          );

          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            await runDb(
              db,
              `INSERT INTO project_quote_lines
               (quote_id, project_id, company_id, line_type, description, qty, unit_cost, margin_percent, profit_amount, unit_price, tax_rate, discount_type, discount_value,
                discount_amount, subtotal_cost, subtotal, tax_amount, total, sort_order, created_at)
               VALUES (?, ?, ?, 'service', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              [
                quoteInsert.lastID,
                projectId,
                companyId,
                line.description,
                line.qty,
                line.unitCost,
                line.marginPercent,
                line.profitAmount,
                line.unitPrice,
                line.taxRate,
                line.discountType,
                line.discountValue,
                line.discountAmount,
                line.subtotalCost,
                line.subtotal,
                line.taxAmount,
                line.total,
                index + 1
              ]
            );
          }
          await insertProjectQuoteAttachments({
            db,
            companyId,
            projectId,
            quoteId: quoteInsert.lastID,
            files: req.files,
            userId: createdBy
          });
          return { id: quoteInsert.lastID, totals };
        }
      );

      if (!project.sale_amount || normalizeQuoteStatus(req.body.status) === 'approved') {
        await runDb(
          db,
          `UPDATE projects
           SET sale_amount = ?, profit_estimated = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND company_id = ?`,
          [quote.totals.total, round2(quote.totals.total - toNumber(project.estimated_budget, 0)), projectId, companyId]
        );
      }
      await refreshProjectFinancials(db, companyId, projectId);
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'quote_created',
        message: `Cotización creada: ${title}.`,
        createdBy,
        metadata: { quote_id: quote.id, total: quote.totals.total }
      });
      setFlash(req, 'success', 'Cotización creada correctamente.');
      return res.redirect(buildProjectDetailUrl(projectId, 'quotes'));
    })
  );

  app.post(
    '/projects/:id/quotes/:quoteId/status',
    requireAuth,
    requirePermission('projects', 'quotes'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const quoteId = normalizeId(req.params.quoteId);
      const quote = await getDb(
        db,
        'SELECT * FROM project_quotes WHERE id = ? AND project_id = ? AND company_id = ?',
        [quoteId, projectId, companyId]
      );
      if (!quote) return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectDetailUrl(projectId, 'quotes')));
      const status = normalizeQuoteStatus(req.body.status);
      const rejectionComment = normalizeText(req.body.rejection_comment);
      if (quote.converted_invoice_id && status !== 'converted') {
        setFlash(req, 'error', 'No puedes cambiar el estado de una cotizacion ya convertida a factura.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectDetailUrl(projectId, 'quotes')));
      }
      if (status === 'rejected' && !rejectionComment) {
        setFlash(req, 'error', 'Debes escribir el motivo por el que se anula la cotizacion.');
        return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectDetailUrl(projectId, 'quotes')));
      }
      await runDb(
        db,
        `UPDATE project_quotes
         SET status = ?, approved_at = ?, rejection_comment = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ? AND company_id = ?`,
        [
          status,
          status === 'approved' ? new Date().toISOString() : null,
          status === 'rejected' ? rejectionComment : null,
          quoteId,
          projectId,
          companyId
        ]
      );
      if (status === 'approved' || quote.status === 'approved' || quote.status === 'converted') {
        await syncProjectSaleAmountFromQuotes(db, companyId, projectId);
      }
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'quote_status_changed',
        message: status === 'rejected'
          ? `Cotizacion ${quote.title} anulada. Motivo: ${rejectionComment}.`
          : `Cotizacion ${quote.title} marcada como ${getQuoteStatusLabel(status)}.`,
        createdBy: getUserId(req)
      });
      setFlash(req, 'success', 'Estado de cotización actualizado.');
      return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectDetailUrl(projectId, 'quotes')));
    })
  );

  app.get(
    '/projects/:id/quotes/:quoteId/pdf',
    requireAuth,
    requirePermission('projects', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const quoteId = normalizeId(req.params.quoteId);
      if (!projectId || !quoteId) return res.redirect('/projects');

      const [project, quote] = await Promise.all([
        getProjectById(db, companyId, projectId),
        getDb(
          db,
          'SELECT * FROM project_quotes WHERE id = ? AND project_id = ? AND company_id = ?',
          [quoteId, projectId, companyId]
        )
      ]);

      if (!project || !quote) {
        setFlash(req, 'error', 'No se encontro la cotizacion solicitada.');
        return res.redirect(projectId ? buildProjectDetailUrl(projectId, 'quotes') : '/projects');
      }

      const customerId = normalizeId(quote.customer_id) || normalizeId(project.client_id);
      const [company, customer, lines, attachments] = await Promise.all([
        fetchProjectCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl),
        customerId
          ? getDb(
            db,
            `SELECT id, name, customer_code, phone, email, COALESCE(full_address, address) AS address
             FROM customers
             WHERE id = ? AND company_id = ?`,
            [customerId, companyId]
          )
          : Promise.resolve(null),
        allDb(
          db,
          `SELECT *
           FROM project_quote_lines
           WHERE quote_id = ? AND project_id = ? AND company_id = ?
           ORDER BY sort_order ASC, id ASC`,
          [quoteId, projectId, companyId]
        ),
        fetchProjectQuotePdfAttachments(db, companyId, quoteId)
      ]);

      const quoteDocument = buildProjectQuotePdfBundle({
        project,
        quote,
        customer,
        lines,
        attachments
      });
      const fileName = `${slugifyProjectQuotePdfName(quoteDocument.fileBaseName || quoteDocument.title, 'cotizacion')}.pdf`;
      const disposition = normalizeText(req.query.download) === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      await renderProjectQuotePdfToStream(quoteDocument, company, res);
      return null;
    })
  );

  app.post(
    '/projects/:id/quotes/:quoteId/convert',
    requireAuth,
    requirePermission('projects', 'quotes'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const quoteId = normalizeId(req.params.quoteId);
      const quote = await getDb(
        db,
        'SELECT * FROM project_quotes WHERE id = ? AND project_id = ? AND company_id = ?',
        [quoteId, projectId, companyId]
      );
      if (!quote) return res.redirect(resolveProjectsReturnTo(req.body.return_to, buildProjectDetailUrl(projectId, 'quotes')));
      if (quote.converted_invoice_id) {
        setFlash(req, 'info', 'Esta cotización ya fue convertida a factura.');
        return res.redirect(`/invoices/${quote.converted_invoice_id}`);
      }
      const project = await getProjectById(db, companyId, projectId);
      const lines = await allDb(
        db,
        `SELECT *
         FROM project_quote_lines
         WHERE quote_id = ? AND project_id = ? AND company_id = ?
         ORDER BY sort_order, id`,
        [quoteId, projectId, companyId]
      );
      if (!project || !lines.length) {
        setFlash(req, 'error', 'La cotización no tiene líneas para convertir.');
        return res.redirect(buildProjectDetailUrl(projectId, 'quotes'));
      }
      const invoiceHeaderId = await withTransaction(
        db,
        enqueueDbTransaction,
        commitTransaction,
        rollbackTransaction,
        async () => {
          const company = await fetchCompanyCurrency(db, companyId, parseCurrencyList);
          const serviceItemId = await ensureProjectServiceItem(db, companyId);
          const currency = normalizeText(quote.currency).toUpperCase() || company.baseCurrency;
          const exchangeRate = currency === company.baseCurrency ? 1 : (toNumber(quote.exchange_rate, 1) || 1);
          const legacyInsert = await runDb(
            db,
            `INSERT INTO invoices
             (customer_id, subtotal, tax_rate, tax_amount, discount_type, discount_value, discount_amount, total, company_id,
              currency, exchange_rate, subtotal_base, tax_amount_base, discount_amount_base, total_base, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              quote.customer_id || project.client_id || null,
              quote.subtotal,
              quote.tax_rate,
              quote.tax_amount,
              quote.discount_type,
              quote.discount_value,
              quote.discount_amount,
              quote.total,
              companyId,
              currency,
              exchangeRate,
              quote.subtotal * exchangeRate,
              quote.tax_amount * exchangeRate,
              quote.discount_amount * exchangeRate,
              quote.total * exchangeRate
            ]
          );
          const headerInsert = await runDb(
            db,
            `INSERT INTO invoice_headers
             (legacy_invoice_id, company_id, invoice_number, invoice_type, source, customer_id, customer_name_snapshot, customer_code_snapshot,
              customer_email_snapshot, customer_phone_snapshot, customer_address_snapshot, issue_date, due_date, payment_method, invoice_language, status,
              subtotal, tax_total, discount_total, total, paid_total, balance_due, notes, currency, exchange_rate,
              subtotal_base, tax_amount_base, discount_amount_base, total_base, created_by, updated_by, created_at, updated_at, emitted_at)
             VALUES (?, ?, ?, 'standard', 'project_quote', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'es', 'issued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              legacyInsert.lastID,
              companyId,
              null,
              quote.customer_id || project.client_id || null,
              null,
              null,
              null,
              null,
              null,
              today(),
              quote.valid_until,
              null,
              quote.subtotal,
              quote.tax_amount,
              quote.discount_amount,
              quote.total,
              quote.total,
              normalizeText(quote.notes) || `Factura generada desde cotización del proyecto ${project.code || project.name}.`,
              currency,
              exchangeRate,
              quote.subtotal * exchangeRate,
              quote.tax_amount * exchangeRate,
              quote.discount_amount * exchangeRate,
              quote.total * exchangeRate,
              getUserId(req),
              getUserId(req)
            ]
          );
          await runDb(
            db,
            'UPDATE invoice_headers SET invoice_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
            [buildInvoiceNumber(headerInsert.lastID, today()), headerInsert.lastID, companyId]
          );

          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            await runDb(
              db,
              `INSERT INTO invoice_items
               (invoice_id, header_id, item_id, qty, unit_price, line_total, company_id, line_type, description, sku_snapshot, barcode_snapshot,
                item_name_snapshot, category_name_snapshot, tax_rate, tax_amount, discount_type, discount_value, discount_amount, subtotal, total, sort_order, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              [
                legacyInsert.lastID,
                headerInsert.lastID,
                serviceItemId,
                line.qty,
                line.unit_price,
                line.total,
                companyId,
                line.description,
                line.description,
                line.tax_rate,
                line.tax_amount,
                line.discount_type,
                line.discount_value,
                normalizeLineDiscount(line),
                line.subtotal,
                line.total,
                index + 1
              ]
            );
          }

          await runDb(
            db,
            `INSERT INTO invoice_status_history
             (invoice_header_id, company_id, from_status, to_status, notes, changed_by, created_at)
             VALUES (?, ?, NULL, 'issued', ?, ?, CURRENT_TIMESTAMP)`,
            [
              headerInsert.lastID,
              companyId,
              `Factura creada desde cotización del proyecto ${project.code || project.name}.`,
              getUserId(req)
            ]
          );

          await runDb(
            db,
            `UPDATE project_quotes
             SET status = 'converted', converted_invoice_id = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND company_id = ?`,
            [headerInsert.lastID, quoteId, companyId]
          );
          return headerInsert.lastID;
        }
      );
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'quote_converted',
        message: `Cotización convertida a factura #${invoiceHeaderId}.`,
        createdBy: getUserId(req),
        metadata: { quote_id: quoteId, invoice_header_id: invoiceHeaderId }
      });
      setFlash(req, 'success', 'Cotización convertida a factura.');
      return res.redirect(`/invoices/${invoiceHeaderId}`);
    })
  );

  app.post(
    '/projects/:id/files/upload',
    requireAuth,
    requirePermission('projects', 'edit'),
    projectFileUpload.single('project_file'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const project = await getProjectById(db, companyId, projectId);
      if (!project) return res.redirect('/projects');
      if (!req.file) {
        setFlash(req, 'error', 'Debes seleccionar un archivo válido.');
        return res.redirect(buildProjectDetailUrl(projectId, 'files'));
      }
      const storedPath = normalizeStoredPath(req.file.path);
      await runDb(
        db,
        `INSERT INTO project_files
         (project_id, company_id, filename, original_name, file_type, uploaded_by, uploaded_at, notes, source_type, source_label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'project', 'Proyecto', CURRENT_TIMESTAMP)`,
        [
          projectId,
          companyId,
          storedPath,
          req.file.originalname || req.file.filename,
          normalizeText(req.file.mimetype) || safeExtension(req.file.originalname),
          getUserId(req),
          normalizeText(req.body.notes)
        ]
      );
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: 'file_uploaded',
        message: `Archivo subido: ${req.file.originalname || req.file.filename}.`,
        createdBy: getUserId(req)
      });
      setFlash(req, 'success', 'Archivo cargado correctamente.');
      return res.redirect(buildProjectDetailUrl(projectId, 'files'));
    })
  );

  app.post(
    '/projects/:id/logs/create',
    requireAuth,
    requirePermission('projects', 'edit'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const projectId = normalizeId(req.params.id);
      const project = await getProjectById(db, companyId, projectId);
      if (!project) return res.redirect('/projects');
      const message = normalizeText(req.body.message);
      if (!message) {
        setFlash(req, 'error', 'Debes escribir una nota para la bitácora.');
        return res.redirect(buildProjectDetailUrl(projectId, 'knowledge'));
      }
      await createProjectLog({
        db,
        companyId,
        projectId,
        type: normalizeLogType(req.body.log_type),
        message,
        createdBy: getUserId(req)
      });
      setFlash(req, 'success', 'Nota registrada en la bitácora.');
      return res.redirect(buildProjectDetailUrl(projectId, 'knowledge'));
    })
  );
}

async function ensureProjectsSchema({ db, parseCurrencyList }) {
  await ensureProjectsPermissionData(db);
  await ensureProjectTables(db);
  await ensureProjectIndexes(db);
  await appendModuleToJsonColumn(db, 'companies', 'allowed_modules', 'projects');
  await appendModuleToJsonColumn(db, 'business_activities', 'modules_json', 'projects');
  await ensureQuoteInvoiceSupport(db, parseCurrencyList);
}

async function ensureProjectsPermissionData(db) {
  await runDb(
    db,
    `INSERT OR IGNORE INTO permission_modules (code, name, description)
     VALUES ('projects', 'Proyectos', 'Gestión de proyectos, cronogramas, tareas, gastos y cotizaciones')`
  );
  await runDb(
    db,
    `INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES
     ('expenses', 'Gastos', 'Registrar y enviar gastos del proyecto'),
     ('quotes', 'Cotizaciones', 'Crear y convertir cotizaciones del proyecto'),
     ('reports', 'Reportes', 'Ver reportes financieros y de avance del proyecto')`
  );
  await runDb(
    db,
    `INSERT OR IGNORE INTO module_actions (module_id, action_id)
     SELECT pm.id, pa.id
     FROM permission_modules pm, permission_actions pa
     WHERE pm.code = 'projects' AND pa.code IN ('view', 'create', 'edit', 'delete', 'expenses', 'quotes', 'reports')`
  );
}

async function ensureProjectTables(db) {
  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT,
      name TEXT NOT NULL,
      client_id INTEGER,
      description TEXT,
      start_date TEXT,
      estimated_end_date TEXT,
      real_end_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      priority TEXT NOT NULL DEFAULT 'medium',
      estimated_budget REAL NOT NULL DEFAULT 0,
      real_cost REAL NOT NULL DEFAULT 0,
      sale_amount REAL NOT NULL DEFAULT 0,
      profit_estimated REAL NOT NULL DEFAULT 0,
      profit_real REAL NOT NULL DEFAULT 0,
      notes TEXT,
      source_quote_id INTEGER,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'projects', [
    ['company_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['code', 'TEXT'],
    ['name', 'TEXT'],
    ['client_id', 'INTEGER'],
    ['description', 'TEXT'],
    ['start_date', 'TEXT'],
    ['estimated_end_date', 'TEXT'],
    ['real_end_date', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'draft'"],
    ['priority', "TEXT NOT NULL DEFAULT 'medium'"],
    ['estimated_budget', 'REAL NOT NULL DEFAULT 0'],
    ['real_cost', 'REAL NOT NULL DEFAULT 0'],
    ['sale_amount', 'REAL NOT NULL DEFAULT 0'],
    ['profit_estimated', 'REAL NOT NULL DEFAULT 0'],
    ['profit_real', 'REAL NOT NULL DEFAULT 0'],
    ['notes', 'TEXT'],
    ['source_quote_id', 'INTEGER'],
    ['created_by', 'INTEGER'],
    ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
  ]);

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS project_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      start_date TEXT,
      estimated_end_date TEXT,
      real_end_date TEXT,
      responsible_id INTEGER,
      responsible TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress_percent REAL NOT NULL DEFAULT 0,
      observations TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'project_schedule', [
    ['project_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['company_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['name', 'TEXT'],
    ['start_date', 'TEXT'],
    ['estimated_end_date', 'TEXT'],
    ['real_end_date', 'TEXT'],
    ['responsible_id', 'INTEGER'],
    ['responsible', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['progress_percent', 'REAL NOT NULL DEFAULT 0'],
    ['observations', 'TEXT'],
    ['created_by', 'INTEGER'],
    ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
  ]);

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS project_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      assigned_to INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      quote_line_id INTEGER,
      estimated_hours REAL,
      real_hours REAL,
      start_date TEXT,
      due_date TEXT,
      completed_at TEXT,
      complications TEXT,
      solution_applied TEXT,
      learned_notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'project_tasks', [
    ['project_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['company_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['title', 'TEXT'],
    ['description', 'TEXT'],
    ['assigned_to', 'INTEGER'],
    ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['priority', "TEXT NOT NULL DEFAULT 'medium'"],
    ['color', 'TEXT'],
    ['sort_order', 'INTEGER NOT NULL DEFAULT 0'],
    ['quote_line_id', 'INTEGER'],
    ['estimated_hours', 'REAL'],
    ['real_hours', 'REAL'],
    ['start_date', 'TEXT'],
    ['due_date', 'TEXT'],
    ['completed_at', 'TEXT'],
    ['complications', 'TEXT'],
    ['solution_applied', 'TEXT'],
    ['learned_notes', 'TEXT'],
    ['created_by', 'INTEGER'],
    ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
  ]);
  await backfillProjectTaskColors(db);

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS project_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      task_id INTEGER,
      quote_line_id INTEGER,
      is_estimated INTEGER NOT NULL DEFAULT 0,
      supplier_id INTEGER,
      expense_date TEXT,
      category TEXT,
      description TEXT,
      amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'GTQ',
      invoice_number TEXT,
      notes TEXT,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      accounting_status TEXT NOT NULL DEFAULT 'pending',
      attachment_path TEXT,
      accounting_entry_id INTEGER,
      accounting_bill_id INTEGER,
      is_locked INTEGER NOT NULL DEFAULT 0,
      locked_by INTEGER,
      locked_at DATETIME,
      unlocked_by INTEGER,
      unlocked_at DATETIME,
      created_by INTEGER,
      updated_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'project_expenses', [
    ['project_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['company_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['task_id', 'INTEGER'],
    ['quote_line_id', 'INTEGER'],
    ['is_estimated', 'INTEGER NOT NULL DEFAULT 0'],
    ['supplier_id', 'INTEGER'],
    ['expense_date', 'TEXT'],
    ['category', 'TEXT'],
    ['description', 'TEXT'],
    ['amount', 'REAL NOT NULL DEFAULT 0'],
    ['tax_amount', 'REAL NOT NULL DEFAULT 0'],
    ['total_amount', 'REAL NOT NULL DEFAULT 0'],
    ['currency', "TEXT NOT NULL DEFAULT 'GTQ'"],
    ['invoice_number', 'TEXT'],
    ['notes', 'TEXT'],
    ['payment_status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['accounting_status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['attachment_path', 'TEXT'],
    ['accounting_entry_id', 'INTEGER'],
    ['accounting_bill_id', 'INTEGER'],
    ['is_locked', 'INTEGER NOT NULL DEFAULT 0'],
    ['locked_by', 'INTEGER'],
    ['locked_at', 'DATETIME'],
    ['unlocked_by', 'INTEGER'],
    ['unlocked_at', 'DATETIME'],
    ['created_by', 'INTEGER'],
    ['updated_by', 'INTEGER'],
    ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
  ]);

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS project_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      file_type TEXT,
      uploaded_by INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      source_type TEXT NOT NULL DEFAULT 'project',
      source_id INTEGER,
      source_label TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'project_files', [
    ['project_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['company_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['filename', 'TEXT'],
    ['original_name', 'TEXT'],
    ['file_type', 'TEXT'],
    ['uploaded_by', 'INTEGER'],
    ['uploaded_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    ['notes', 'TEXT'],
    ['source_type', "TEXT NOT NULL DEFAULT 'project'"],
    ['source_id', 'INTEGER'],
    ['source_label', 'TEXT'],
    ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
  ]);

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS project_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      log_type TEXT NOT NULL DEFAULT 'manual_note',
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'project_logs', [
    ['project_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['company_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['log_type', "TEXT NOT NULL DEFAULT 'manual_note'"],
    ['message', 'TEXT'],
    ['metadata_json', 'TEXT'],
    ['created_by', 'INTEGER'],
    ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
  ]);

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS project_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      customer_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      valid_until TEXT,
      currency TEXT NOT NULL DEFAULT 'GTQ',
      exchange_rate REAL NOT NULL DEFAULT 1,
      cost_estimated REAL NOT NULL DEFAULT 0,
      margin_percent REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      discount_type TEXT NOT NULL DEFAULT 'amount',
      discount_value REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      notes TEXT,
      pdf_fields_json TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      approved_at DATETIME,
      rejection_comment TEXT,
      converted_invoice_id INTEGER,
      is_archived INTEGER NOT NULL DEFAULT 0,
      archived_at DATETIME,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'project_quotes', [
    ['project_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['company_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['customer_id', 'INTEGER'],
    ['title', 'TEXT'],
    ['description', 'TEXT'],
    ['valid_until', 'TEXT'],
    ['currency', "TEXT NOT NULL DEFAULT 'GTQ'"],
    ['exchange_rate', 'REAL NOT NULL DEFAULT 1'],
    ['cost_estimated', 'REAL NOT NULL DEFAULT 0'],
    ['margin_percent', 'REAL NOT NULL DEFAULT 0'],
    ['tax_rate', 'REAL NOT NULL DEFAULT 0'],
    ['discount_type', "TEXT NOT NULL DEFAULT 'amount'"],
    ['discount_value', 'REAL NOT NULL DEFAULT 0'],
    ['discount_amount', 'REAL NOT NULL DEFAULT 0'],
    ['subtotal', 'REAL NOT NULL DEFAULT 0'],
    ['tax_amount', 'REAL NOT NULL DEFAULT 0'],
    ['total', 'REAL NOT NULL DEFAULT 0'],
    ['notes', 'TEXT'],
    ['pdf_fields_json', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'draft'"],
    ['approved_at', 'DATETIME'],
    ['rejection_comment', 'TEXT'],
    ['converted_invoice_id', 'INTEGER'],
    ['is_archived', 'INTEGER NOT NULL DEFAULT 0'],
    ['archived_at', 'DATETIME'],
    ['created_by', 'INTEGER'],
    ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
  ]);

  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS project_quote_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      line_type TEXT NOT NULL DEFAULT 'service',
      service_name TEXT NULL,
      service_unit TEXT NULL,
      service_details TEXT NULL,
      description TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 1,
      unit_cost REAL NOT NULL DEFAULT 0,
      margin_percent REAL NOT NULL DEFAULT 0,
      profit_amount REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      discount_type TEXT NOT NULL DEFAULT 'amount',
      discount_value REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      subtotal_cost REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'project_quote_lines', [
    ['quote_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['project_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['company_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['line_type', "TEXT NOT NULL DEFAULT 'service'"],
    ['service_name', 'TEXT NULL'],
    ['service_unit', 'TEXT NULL'],
    ['service_details', 'TEXT NULL'],
    ['description', 'TEXT'],
    ['qty', 'REAL NOT NULL DEFAULT 1'],
    ['unit_cost', 'REAL NOT NULL DEFAULT 0'],
    ['margin_percent', 'REAL NOT NULL DEFAULT 0'],
    ['profit_amount', 'REAL NOT NULL DEFAULT 0'],
    ['unit_price', 'REAL NOT NULL DEFAULT 0'],
    ['tax_rate', 'REAL NOT NULL DEFAULT 0'],
    ['discount_type', "TEXT NOT NULL DEFAULT 'amount'"],
    ['discount_value', 'REAL NOT NULL DEFAULT 0'],
    ['discount_amount', 'REAL NOT NULL DEFAULT 0'],
    ['subtotal_cost', 'REAL NOT NULL DEFAULT 0'],
    ['subtotal', 'REAL NOT NULL DEFAULT 0'],
    ['tax_amount', 'REAL NOT NULL DEFAULT 0'],
    ['total', 'REAL NOT NULL DEFAULT 0'],
    ['sort_order', 'INTEGER NOT NULL DEFAULT 0'],
    ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
  ]);

  await runDb(
    db,
    `UPDATE projects
     SET source_quote_id = (
       SELECT q.id
       FROM project_quotes q
       WHERE q.project_id = projects.id
         AND q.company_id = projects.company_id
         AND q.status = 'converted_project'
       ORDER BY q.id ASC
       LIMIT 1
     )
     WHERE source_quote_id IS NULL`
  );
  await runDb(
    db,
    `UPDATE project_tasks
     SET sort_order = id
     WHERE COALESCE(sort_order, 0) = 0`
  );
}

async function ensureProjectIndexes(db) {
  await runDb(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_company_code ON projects (company_id, code)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_projects_company_status ON projects (company_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_projects_company_client ON projects (company_id, client_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_schedule_project ON project_schedule (project_id, company_id, start_date)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_tasks_project ON project_tasks (project_id, company_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_tasks_order ON project_tasks (project_id, company_id, sort_order)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_expenses_project ON project_expenses (project_id, company_id, expense_date)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_expenses_task ON project_expenses (task_id, company_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_files_project ON project_files (project_id, company_id, uploaded_at)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_logs_project ON project_logs (project_id, company_id, created_at)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_quotes_project ON project_quotes (project_id, company_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON project_quote_lines (quote_id, project_id, company_id)');
}

async function ensureQuoteInvoiceSupport(db) {
  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS invoice_headers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      emitted_at DATETIME NULL,
      paid_at DATETIME NULL,
      voided_at DATETIME NULL
    )`
  );
  await runDb(
    db,
    `CREATE TABLE IF NOT EXISTS invoice_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_header_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      from_status TEXT NULL,
      to_status TEXT NULL,
      notes TEXT NULL,
      changed_by INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await ensureColumns(db, 'invoice_payments', [
    ['invoice_header_id', 'INTEGER NULL'],
    ['recorded_by', 'INTEGER NULL'],
    ['payment_reference', 'TEXT NULL']
  ]);
  await ensureColumns(db, 'invoice_items', [
    ['header_id', 'INTEGER NULL'],
    ['line_type', "TEXT NOT NULL DEFAULT 'inventory'"],
    ['description', 'TEXT NULL'],
    ['sku_snapshot', 'TEXT NULL'],
    ['barcode_snapshot', 'TEXT NULL'],
    ['item_name_snapshot', 'TEXT NULL'],
    ['category_name_snapshot', 'TEXT NULL'],
    ['tax_rate', 'REAL NOT NULL DEFAULT 0'],
    ['tax_amount', 'REAL NOT NULL DEFAULT 0'],
    ['discount_type', "TEXT NOT NULL DEFAULT 'amount'"],
    ['discount_value', 'REAL NOT NULL DEFAULT 0'],
    ['discount_amount', 'REAL NOT NULL DEFAULT 0'],
    ['subtotal', 'REAL NOT NULL DEFAULT 0'],
    ['total', 'REAL NOT NULL DEFAULT 0'],
    ['sort_order', 'INTEGER NOT NULL DEFAULT 0']
  ]);
  await runDb(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_headers_company_number ON invoice_headers (company_id, invoice_number)');
  await runDb(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_headers_company_legacy ON invoice_headers (company_id, legacy_invoice_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_headers_company_status ON invoice_headers (company_id, status)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_items_header_id ON invoice_items (header_id)');
  await runDb(db, 'CREATE INDEX IF NOT EXISTS idx_invoice_status_history_header ON invoice_status_history (invoice_header_id, company_id)');
}

async function buildProjectsDashboardViewModel({ db, companyId, query, parseCurrencyList }) {
  const section = normalizeDashboardSection(query.section);
  const view = normalizeDashboardView(query.view);
  const quoteView = normalizeQuoteDashboardView(query.quote_view);
  const search = normalizeText(query.q);
  const statusFilter = normalizeDashboardStatus(query.status);
  const createdFrom = normalizeDate(query.created_from);
  const createdTo = normalizeDate(query.created_to);
  const finishedFrom = normalizeDate(query.finished_from);
  const finishedTo = normalizeDate(query.finished_to);
  const taskSearch = normalizeText(query.task_q);
  const taskProjectId = normalizeId(query.task_project_id);
  const taskStatusFilter = normalizeTaskDashboardStatus(query.task_status);
  const taskAssignedTo = normalizeId(query.assigned_to);
  const dueFrom = normalizeDate(query.due_from);
  const dueTo = normalizeDate(query.due_to);
  const quoteSearch = normalizeText(query.quote_q);
  const quoteProjectId = normalizeId(query.quote_project_id);
  const quoteStatusFilter = normalizeQuoteDashboardStatus(query.quote_status);
  const quoteScope = normalizeQuoteDashboardScope(query.quote_scope);
  const validFrom = normalizeDate(query.valid_from);
  const validTo = normalizeDate(query.valid_to);
  const quoteTargetId = normalizeId(query.quote_target_id);
  const quoteMode = normalizeQuoteDashboardMode(query.quote_mode);
  const editingQuoteId = normalizeId(query.quote_id);
  const companyCurrency = await fetchCompanyCurrency(db, companyId, parseCurrencyList);
  const params = [companyId];
  let whereSql = 'WHERE p.company_id = ?';
  if (statusFilter && statusFilter !== 'all') {
    whereSql += ' AND p.status = ?';
    params.push(statusFilter);
  }
  if (search) {
    whereSql += ' AND (p.code LIKE ? OR p.name LIKE ? OR COALESCE(c.name, \'\') LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (createdFrom) {
    whereSql += ' AND DATE(p.created_at) >= ?';
    params.push(createdFrom);
  }
  if (createdTo) {
    whereSql += ' AND DATE(p.created_at) <= ?';
    params.push(createdTo);
  }
  if (finishedFrom || finishedTo) {
    whereSql += ' AND COALESCE(p.real_end_date, \'\') <> \'\'';
  }
  if (finishedFrom) {
    whereSql += ' AND p.real_end_date >= ?';
    params.push(finishedFrom);
  }
  if (finishedTo) {
    whereSql += ' AND p.real_end_date <= ?';
    params.push(finishedTo);
  }

  const projectSelectSql = `SELECT p.*,
              c.name AS client_name,
              c.customer_code AS client_code,
              (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.company_id = p.company_id) AS task_count,
              (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.company_id = p.company_id AND t.status = 'completed') AS completed_tasks,
              (SELECT COALESCE(AVG(s.progress_percent), 0) FROM project_schedule s WHERE s.project_id = p.id AND s.company_id = p.company_id) AS schedule_progress,
              (SELECT COALESCE(SUM(e.total_amount), 0) FROM project_expenses e WHERE e.project_id = p.id AND e.company_id = p.company_id) AS expense_total,
              (SELECT COUNT(*) FROM project_quotes q WHERE q.project_id = p.id AND q.company_id = p.company_id) AS quote_count
       FROM projects p
       LEFT JOIN customers c ON c.id = p.client_id AND c.company_id = p.company_id`;
  const projectOrderSql = `ORDER BY CASE p.status
         WHEN 'in_progress' THEN 1
         WHEN 'planning' THEN 2
         WHEN 'paused' THEN 3
         WHEN 'draft' THEN 4
         WHEN 'completed' THEN 5
         ELSE 6
       END, p.updated_at DESC, p.id DESC`;

  const taskParams = [companyId];
  let taskWhereSql = 'WHERE t.company_id = ?';
  if (taskProjectId) {
    taskWhereSql += ' AND t.project_id = ?';
    taskParams.push(taskProjectId);
  }
  if (taskStatusFilter !== 'all') {
    taskWhereSql += ' AND t.status = ?';
    taskParams.push(taskStatusFilter);
  }
  if (taskAssignedTo) {
    taskWhereSql += ' AND t.assigned_to = ?';
    taskParams.push(taskAssignedTo);
  }
  if (taskSearch) {
    taskWhereSql += ' AND (t.title LIKE ? OR COALESCE(t.description, \'\') LIKE ? OR p.name LIKE ? OR COALESCE(p.code, \'\') LIKE ?)';
    taskParams.push(`%${taskSearch}%`, `%${taskSearch}%`, `%${taskSearch}%`, `%${taskSearch}%`);
  }
  if (dueFrom) {
    taskWhereSql += ' AND DATE(COALESCE(t.due_date, t.start_date, t.created_at)) >= ?';
    taskParams.push(dueFrom);
  }
  if (dueTo) {
    taskWhereSql += ' AND DATE(COALESCE(t.due_date, t.start_date, t.created_at)) <= ?';
    taskParams.push(dueTo);
  }

  const taskSelectSql = `SELECT t.*,
              p.name AS project_name,
              p.code AS project_code,
              p.status AS project_status,
              u.username AS assigned_name,
              (SELECT COUNT(*) FROM project_tasks tx WHERE tx.project_id = t.project_id AND tx.company_id = t.company_id) AS project_task_count,
              (SELECT COUNT(*) FROM project_tasks tx WHERE tx.project_id = t.project_id AND tx.company_id = t.company_id AND tx.status = 'completed') AS project_completed_tasks
       FROM project_tasks t
       JOIN projects p ON p.id = t.project_id AND p.company_id = t.company_id
       LEFT JOIN users u ON u.id = t.assigned_to AND u.company_id = t.company_id`;
  const taskOrderSql = `ORDER BY CASE t.status
         WHEN 'in_progress' THEN 1
         WHEN 'pending' THEN 2
         WHEN 'paused' THEN 3
         WHEN 'completed' THEN 4
         ELSE 5
       END,
       CASE t.priority
         WHEN 'critical' THEN 1
         WHEN 'high' THEN 2
         WHEN 'medium' THEN 3
         ELSE 4
       END,
       CASE WHEN COALESCE(t.due_date, '') = '' THEN 1 ELSE 0 END,
       COALESCE(t.due_date, t.start_date, DATE(t.created_at)) ASC,
       t.updated_at DESC,
       t.id DESC`;

  const quoteParams = [companyId];
  let quoteWhereSql = 'WHERE q.company_id = ?';
  if (quoteScope === 'active') {
    quoteWhereSql += ' AND COALESCE(q.is_archived, 0) = 0';
  } else if (quoteScope === 'archived') {
    quoteWhereSql += ' AND COALESCE(q.is_archived, 0) = 1';
  }
  if (quoteProjectId) {
    quoteWhereSql += ' AND q.project_id = ?';
    quoteParams.push(quoteProjectId);
  }
  if (quoteStatusFilter !== 'all') {
    quoteWhereSql += ' AND q.status = ?';
    quoteParams.push(quoteStatusFilter);
  }
  if (quoteSearch) {
    quoteWhereSql += ' AND (q.title LIKE ? OR COALESCE(q.description, \'\') LIKE ? OR COALESCE(p.name, \'\') LIKE ? OR COALESCE(p.code, \'\') LIKE ? OR COALESCE(c.name, \'\') LIKE ?)';
    quoteParams.push(`%${quoteSearch}%`, `%${quoteSearch}%`, `%${quoteSearch}%`, `%${quoteSearch}%`, `%${quoteSearch}%`);
  }
  if (validFrom) {
    quoteWhereSql += ' AND DATE(COALESCE(q.valid_until, q.created_at)) >= ?';
    quoteParams.push(validFrom);
  }
  if (validTo) {
    quoteWhereSql += ' AND DATE(COALESCE(q.valid_until, q.created_at)) <= ?';
    quoteParams.push(validTo);
  }

  const quoteSelectSql = `SELECT q.*,
              p.name AS project_name,
              p.code AS project_code,
              c.name AS customer_name,
              c.customer_code AS customer_code
       FROM project_quotes q
       LEFT JOIN projects p ON p.id = q.project_id AND p.company_id = q.company_id
       LEFT JOIN customers c ON c.id = q.customer_id AND c.company_id = q.company_id`;
  const quoteOrderSql = `ORDER BY CASE q.status
         WHEN 'approved' THEN 1
         WHEN 'sent' THEN 2
         WHEN 'draft' THEN 3
         WHEN 'rejected' THEN 4
         ELSE 5
       END,
       CASE WHEN COALESCE(q.valid_until, '') = '' THEN 1 ELSE 0 END,
       COALESCE(q.valid_until, DATE(q.created_at)) ASC,
       q.created_at DESC,
       q.id DESC`;

  const [rows, allRows, customers, users, taskRows, allTaskRows, quoteRows, allQuoteRows, quoteLineRows] = await Promise.all([
    allDb(
      db,
      `${projectSelectSql}
       ${whereSql}
       ${projectOrderSql}`,
      params
    ),
    allDb(
      db,
      `${projectSelectSql}
       WHERE p.company_id = ?
       ${projectOrderSql}`,
      [companyId]
    ),
    allDb(
      db,
      `SELECT id, name, customer_code
       FROM customers
       WHERE company_id = ? AND COALESCE(is_voided, 0) = 0
       ORDER BY name`,
      [companyId]
    ),
    allDb(
      db,
      `SELECT id, username
       FROM users
       WHERE company_id = ? AND COALESCE(is_active, 1) = 1
       ORDER BY username`,
      [companyId]
    ),
    allDb(
      db,
      `${taskSelectSql}
       ${taskWhereSql}
       ${taskOrderSql}`,
      taskParams
    ),
    allDb(
      db,
      `${taskSelectSql}
       WHERE t.company_id = ?
       ${taskOrderSql}`,
      [companyId]
    ),
    allDb(
      db,
      `${quoteSelectSql}
       ${quoteWhereSql}
       ${quoteOrderSql}`,
      quoteParams
    ),
    allDb(
      db,
      `${quoteSelectSql}
       WHERE q.company_id = ?
       ${quoteOrderSql}`,
      [companyId]
    ),
    allDb(
      db,
      `SELECT *
       FROM project_quote_lines
       WHERE company_id = ?
       ORDER BY quote_id DESC, sort_order ASC, id ASC`,
      [companyId]
    )
  ]);

  const projects = rows.map((row) => decorateProjectRow(row));
  const allProjects = allRows.map((row) => decorateProjectRow(row));
  const projectOptions = [...allProjects]
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
  const columns = PROJECT_STATUSES.map((status) => ({
    ...status,
    count: projects.filter((project) => project.status === status.key).length,
    projects: projects.filter((project) => project.status === status.key)
  }));

  const summary = allProjects.reduce((acc, project) => {
    acc.totalProjects += 1;
    acc.estimatedBudget += toNumber(project.estimated_budget, 0);
    acc.realCost += toNumber(project.real_cost_resolved, 0);
    acc.saleAmount += toNumber(project.sale_amount, 0);
    if (['planning', 'in_progress', 'paused'].includes(project.status)) acc.activeProjects += 1;
    if (project.isOverdue) acc.overdueProjects += 1;
    if (project.status === 'completed') acc.completedProjects += 1;
    return acc;
  }, {
    totalProjects: 0,
    activeProjects: 0,
    completedProjects: 0,
    overdueProjects: 0,
    estimatedBudget: 0,
    realCost: 0,
    saleAmount: 0
  });
  summary.estimatedProfit = round2(summary.saleAmount - summary.estimatedBudget);
  summary.realProfit = round2(summary.saleAmount - summary.realCost);
  summary.completionRate = summary.totalProjects
    ? clampPercentage((summary.completedProjects / summary.totalProjects) * 100)
    : 0;

  const filteredSummary = projects.reduce((acc, project) => {
    acc.totalProjects += 1;
    if (['planning', 'in_progress', 'paused'].includes(project.status)) acc.activeProjects += 1;
    if (project.status === 'completed') acc.completedProjects += 1;
    if (project.isOverdue) acc.overdueProjects += 1;
    return acc;
  }, {
    totalProjects: 0,
    activeProjects: 0,
    completedProjects: 0,
    overdueProjects: 0
  });

  const statusOverview = PROJECT_STATUSES.map((status) => {
    const matchingProjects = allProjects.filter((project) => project.status === status.key);
    return {
      ...status,
      count: matchingProjects.length,
      estimatedBudget: round2(matchingProjects.reduce((sum, project) => sum + toNumber(project.estimated_budget, 0), 0)),
      realCost: round2(matchingProjects.reduce((sum, project) => sum + toNumber(project.real_cost_resolved, 0), 0)),
      saleAmount: round2(matchingProjects.reduce((sum, project) => sum + toNumber(project.sale_amount, 0), 0))
    };
  });

  const recentProjects = [...allProjects]
    .sort((left, right) => String(right.updated_at || right.created_at || '').localeCompare(String(left.updated_at || left.created_at || '')))
    .slice(0, 6);
  const recentCompletedProjects = allProjects
    .filter((project) => project.status === 'completed')
    .sort((left, right) => String(right.real_end_date || right.updated_at || '').localeCompare(String(left.real_end_date || left.updated_at || '')))
    .slice(0, 5);
  const overdueProjects = allProjects
    .filter((project) => project.isOverdue)
    .sort((left, right) => String(left.estimated_end_date || '').localeCompare(String(right.estimated_end_date || '')))
    .slice(0, 5);

  const tasks = taskRows.map((row) => decorateDashboardTaskRow(row));
  const allTasks = allTaskRows.map((row) => decorateDashboardTaskRow(row));
  const taskSummary = buildTaskSummary(tasks);
  taskSummary.overdue = tasks.filter((task) => task.isOverdue).length;
  taskSummary.completedRate = taskSummary.total
    ? clampPercentage((taskSummary.completed / taskSummary.total) * 100)
    : 0;
  const taskPortfolioSummary = buildTaskSummary(allTasks);
  taskPortfolioSummary.overdue = allTasks.filter((task) => task.isOverdue).length;
  taskPortfolioSummary.completedRate = taskPortfolioSummary.total
    ? clampPercentage((taskPortfolioSummary.completed / taskPortfolioSummary.total) * 100)
    : 0;
  const taskStatusOverview = TASK_STATUSES.map((status) => ({
    ...status,
    count: allTasks.filter((task) => task.status === status.key).length
  }));

  const quotes = quoteRows.map((row) => decorateDashboardQuoteRow(row, quoteLineRows));
  const allQuotes = allQuoteRows.map((row) => decorateDashboardQuoteRow(row, quoteLineRows));
  const quoteSummary = buildQuoteSummary(quotes);
  const quotePortfolioSummary = buildQuoteSummary(allQuotes);
  const editingQuote = quoteMode === 'edit' && editingQuoteId
    ? allQuotes.find((quote) => Number(quote.id) === Number(editingQuoteId)) || null
    : null;
  const selectedQuoteForStatus = quoteTargetId
    ? allQuotes.find((quote) => Number(quote.id) === Number(quoteTargetId)) || null
    : (quotes[0] || allQuotes[0] || null);
  const recentQuotes = allQuotes
    .filter((quote) => !quote.isArchived)
    .sort((left, right) => String(right.updated_at || right.created_at || '').localeCompare(String(left.updated_at || left.created_at || '')))
    .slice(0, 6);
  const recentArchivedQuotes = allQuotes
    .filter((quote) => quote.isArchived)
    .sort((left, right) => String(right.archived_at || right.updated_at || right.created_at || '').localeCompare(String(left.archived_at || left.updated_at || left.created_at || '')))
    .slice(0, 6);
  const expiringQuotes = allQuotes
    .filter((quote) => !quote.isArchived && quote.valid_until && !['approved', 'converted'].includes(quote.status))
    .sort((left, right) => String(left.valid_until || '').localeCompare(String(right.valid_until || '')))
    .slice(0, 6);
  const availableProjectQuoteOptions = allQuotes
    .filter((quote) => !normalizeId(quote.project_id) && !quote.isArchived)
    .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));

  return {
    activeTab: 'dashboard',
    activeSection: section,
    dashboardView: view,
    quoteView,
    filters: {
      q: search,
      status: statusFilter || 'all',
      created_from: createdFrom,
      created_to: createdTo,
      finished_from: finishedFrom,
      finished_to: finishedTo,
      task_q: taskSearch,
      task_project_id: taskProjectId || '',
      task_status: taskStatusFilter,
      assigned_to: taskAssignedTo || '',
      due_from: dueFrom,
      due_to: dueTo,
      quote_q: quoteSearch,
      quote_project_id: quoteProjectId || '',
      quote_status: quoteStatusFilter,
      quote_scope: quoteScope,
      valid_from: validFrom,
      valid_to: validTo,
      quote_target_id: quoteTargetId || ''
    },
    projectStatuses: PROJECT_STATUSES,
    projectPriorities: PROJECT_PRIORITIES,
    taskStatuses: TASK_STATUSES,
    quoteStatuses: QUOTE_STATUSES,
    quoteEditableStatuses: QUOTE_STATUSES.filter((status) => status.key !== 'converted_project'),
    quotePdfFieldGroups: PROJECT_QUOTE_PDF_FIELD_GROUPS,
    quotePdfDefaultFields: PROJECT_QUOTE_PDF_DEFAULT_FIELDS,
    baseCurrency: companyCurrency.baseCurrency,
    currencyOptions: companyCurrency.allowedCurrencies,
    projects,
    projectOptions,
    projectColumns: columns,
    summary,
    filteredSummary,
    statusOverview,
    recentProjects,
    recentCompletedProjects,
    overdueProjects,
    tasks,
    taskSummary,
    taskPortfolioSummary,
    taskStatusOverview,
    quotes,
    quoteSelectorOptions: allQuotes,
    availableProjectQuoteOptions,
    quoteSummary,
    quotePortfolioSummary,
    editingQuote,
    selectedQuoteForStatus,
    recentQuotes,
    recentArchivedQuotes,
    expiringQuotes,
    customers,
    users,
    createDefaults: {
      status: 'draft',
      priority: 'medium',
      start_date: today(),
      task_status: 'pending',
      quote_status: 'draft'
    }
  };
}

async function buildProjectDetailViewModel({ db, companyId, projectId, query, buildFileUrl, currentUser, parseCurrencyList }) {
  const companyCurrency = await fetchCompanyCurrency(db, companyId, parseCurrencyList);
  const projectRow = await getDb(
    db,
    `SELECT p.*,
            c.name AS client_name,
            c.customer_code AS client_code,
            (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.company_id = p.company_id) AS task_count,
            (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.company_id = p.company_id AND t.status = 'completed') AS completed_tasks,
            (SELECT COALESCE(AVG(s.progress_percent), 0) FROM project_schedule s WHERE s.project_id = p.id AND s.company_id = p.company_id) AS schedule_progress,
            (SELECT COALESCE(SUM(e.total_amount), 0) FROM project_expenses e WHERE e.project_id = p.id AND e.company_id = p.company_id) AS expense_total
     FROM projects p
     LEFT JOIN customers c ON c.id = p.client_id AND c.company_id = p.company_id
     WHERE p.id = ? AND p.company_id = ?`,
    [projectId, companyId]
  );
  if (!projectRow) return null;

  const activeTab = normalizeDetailTab(query.tab);
  const knowledgeSearch = normalizeText(query.knowledge_q);
  const project = decorateProjectRow(projectRow);

  const [
    customers,
    users,
    scheduleRows,
    taskRows,
    expenseRows,
    fileRows,
    logRows,
    quoteRows,
    quoteLineRows,
    knowledgeRows,
    commercialRows
  ] = await Promise.all([
    allDb(
      db,
      `SELECT id, name, customer_code
       FROM customers
       WHERE company_id = ? AND COALESCE(is_voided, 0) = 0
       ORDER BY name`,
      [companyId]
    ),
    allDb(
      db,
      `SELECT id, username
       FROM users
       WHERE company_id = ? AND COALESCE(is_active, 1) = 1
       ORDER BY username`,
      [companyId]
    ),
    allDb(
      db,
      `SELECT s.*, u.username AS responsible_user
       FROM project_schedule s
       LEFT JOIN users u ON u.id = s.responsible_id AND u.company_id = s.company_id
       WHERE s.project_id = ? AND s.company_id = ?
       ORDER BY COALESCE(s.start_date, s.created_at), s.id`,
      [projectId, companyId]
    ),
    allDb(
      db,
      `SELECT t.*, u.username AS assigned_name
       FROM project_tasks t
       LEFT JOIN users u ON u.id = t.assigned_to AND u.company_id = t.company_id
       WHERE t.project_id = ? AND t.company_id = ?
       ORDER BY t.sort_order ASC, t.id ASC`,
      [projectId, companyId]
    ),
    allDb(
      db,
      `SELECT e.*, c.name AS supplier_name, u.username AS created_by_name, uu.username AS updated_by_name,
              lu.username AS locked_by_name, unu.username AS unlocked_by_name, t.title AS task_title
       FROM project_expenses e
       LEFT JOIN customers c ON c.id = e.supplier_id AND c.company_id = e.company_id
       LEFT JOIN users u ON u.id = e.created_by AND u.company_id = e.company_id
       LEFT JOIN users uu ON uu.id = e.updated_by AND uu.company_id = e.company_id
       LEFT JOIN users lu ON lu.id = e.locked_by AND lu.company_id = e.company_id
       LEFT JOIN users unu ON unu.id = e.unlocked_by AND unu.company_id = e.company_id
       LEFT JOIN project_tasks t ON t.id = e.task_id AND t.company_id = e.company_id
       WHERE e.project_id = ? AND e.company_id = ?
       ORDER BY COALESCE(e.expense_date, e.created_at) DESC, e.id DESC`,
      [projectId, companyId]
    ),
    allDb(
      db,
      `SELECT f.*, u.username AS uploaded_by_name
       FROM project_files f
       LEFT JOIN users u ON u.id = f.uploaded_by AND u.company_id = f.company_id
       WHERE f.project_id = ? AND f.company_id = ?
       ORDER BY COALESCE(f.uploaded_at, f.created_at) DESC, f.id DESC`,
      [projectId, companyId]
    ),
    allDb(
      db,
      `SELECT l.*, u.username AS created_by_name
       FROM project_logs l
       LEFT JOIN users u ON u.id = l.created_by AND u.company_id = l.company_id
       WHERE l.project_id = ? AND l.company_id = ?
       ORDER BY l.created_at DESC, l.id DESC`,
      [projectId, companyId]
    ),
    allDb(
      db,
      `SELECT q.*,
              c.name AS customer_name,
              c.customer_code AS customer_code
       FROM project_quotes q
       LEFT JOIN customers c ON c.id = q.customer_id AND c.company_id = q.company_id
       WHERE q.project_id = ? AND q.company_id = ?
         AND (COALESCE(q.is_archived, 0) = 0 OR q.id = ?)
       ORDER BY q.created_at DESC, q.id DESC`,
      [projectId, companyId, normalizeId(project.source_quote_id) || 0]
    ),
    allDb(
      db,
      `SELECT *
       FROM project_quote_lines
       WHERE project_id = ? AND company_id = ?
       ORDER BY quote_id DESC, sort_order ASC, id ASC`,
      [projectId, companyId]
    ),
    allDb(
      db,
      `SELECT t.*,
              p.name AS project_name,
              p.code AS project_code,
              u.username AS assigned_name
       FROM project_tasks t
       JOIN projects p ON p.id = t.project_id AND p.company_id = t.company_id
       LEFT JOIN users u ON u.id = t.assigned_to AND u.company_id = t.company_id
       WHERE t.company_id = ?
         AND t.project_id != ?
         AND t.status = 'completed'
         AND (
           COALESCE(t.complications, '') <> ''
           OR COALESCE(t.solution_applied, '') <> ''
           OR COALESCE(t.learned_notes, '') <> ''
         )
         ${knowledgeSearch ? "AND (t.title LIKE ? OR t.complications LIKE ? OR t.solution_applied LIKE ? OR t.learned_notes LIKE ?)" : ''}
       ORDER BY COALESCE(t.completed_at, t.updated_at, t.created_at) DESC
       LIMIT 18`,
      knowledgeSearch
        ? [companyId, projectId, `%${knowledgeSearch}%`, `%${knowledgeSearch}%`, `%${knowledgeSearch}%`, `%${knowledgeSearch}%`]
        : [companyId, projectId]
    ),
    allDb(
      db,
      `SELECT q.id AS quote_id,
              q.title AS quote_title,
              q.status AS quote_status,
              q.valid_until,
              q.created_at AS quote_created_at,
              q.updated_at AS quote_updated_at,
              q.converted_invoice_id,
              ih.invoice_number,
              ih.status AS invoice_status,
              ih.issue_date,
              ih.due_date,
              ih.total AS invoice_total,
              ih.paid_total,
              ih.balance_due,
              ih.paid_at
       FROM project_quotes q
       LEFT JOIN invoice_headers ih ON ih.id = q.converted_invoice_id AND ih.company_id = q.company_id
       WHERE q.project_id = ? AND q.company_id = ?
       ORDER BY q.created_at DESC, q.id DESC`,
      [projectId, companyId]
    )
  ]);

  const schedule = scheduleRows.map((row) => ({
    ...row,
    progress_percent: clampPercentage(row.progress_percent),
    status_label: getScheduleStatusLabel(row.status),
    responsible_display: row.responsible || row.responsible_user || 'Sin responsable',
    is_overdue: Boolean(
      row.estimated_end_date
      && row.estimated_end_date < today()
      && !row.real_end_date
      && row.status !== 'completed'
    )
  }));
  const tasks = taskRows.map((row) => ({
    ...row,
    color: normalizeProjectTaskColor(row.color, row.id),
    status_label: getTaskStatusLabel(row.status),
    priority_label: getPriorityLabel(row.priority),
    priority_meta: getPriorityMeta(row.priority),
    assigned_display: row.assigned_name || 'Sin asignar'
  }));
  const expenses = expenseRows.map((row) => ({
    ...row,
    supplier_display: row.supplier_name || 'Sin proveedor vinculado',
    accounting_status_label: getAccountingStatusLabel(row.accounting_status),
    payment_status_label: getExpensePaymentStatusLabel(row.payment_status),
    attachment_url: buildFileUrl(row.attachment_path),
    task_display: row.task_title || 'Sin tarea asignada',
    currency: normalizeText(row.currency).toUpperCase() || 'GTQ',
    is_locked: isExpenseLocked(row),
    lock_status_label: isExpenseLocked(row) ? 'Bloqueado' : 'Editable'
  }));
  const files = fileRows.map((row) => ({
    ...row,
    download_url: buildFileUrl(row.filename),
    folder: getProjectFileFolder(row.source_type),
    origin_display: row.source_label || getProjectFileFolder(row.source_type)
  })).concat(expenseRows
    .filter((row) => row.attachment_path && !fileRows.some((file) => file.filename === row.attachment_path))
    .map((row) => ({
      id: `expense-${row.id}`,
      original_name: path.basename(row.attachment_path),
      file_type: 'Adjunto de gasto',
      uploaded_by_name: row.created_by_name || 'Sistema',
      notes: row.description,
      download_url: buildFileUrl(row.attachment_path),
      folder: 'Gastos',
      origin_display: row.description
    })));
  const logs = logRows.map((row) => ({
    ...row,
    type_label: getLogTypeLabel(row.log_type)
  }));
  const quotes = quoteRows.map((row) => ({
    ...row,
    status_label: getQuoteStatusLabel(row.status),
    lines: quoteLineRows.filter((line) => Number(line.quote_id) === Number(row.id))
  }));
  const knowledge = knowledgeRows.map((row) => ({
    ...row,
    assigned_display: row.assigned_name || 'Sin asignar',
    variance_hours: round2(toNumber(row.real_hours, 0) - toNumber(row.estimated_hours, 0))
  }));

  const taskSummary = buildTaskSummary(tasks);
  const scheduleDashboard = buildScheduleDashboard({ project, tasks, schedule });
  const commercialDashboard = buildCommercialDashboard(commercialRows);
  const timeline = buildProjectTimeline({ schedule, tasks, commercialRows });
  const financial = buildFinancialSummary({
    project,
    tasks,
    expenses,
    quotes
  });
  const taskMode = normalizeText(query.task_mode).toLowerCase();
  const expenseMode = normalizeText(query.expense_mode).toLowerCase();
  const selectedTask = tasks.find((task) => Number(task.id) === Number(normalizeId(query.task_id))) || null;
  const selectedExpense = expenses.find((expense) => Number(expense.id) === Number(normalizeId(query.expense_id))) || null;
  if (selectedTask) selectedTask.attachments = files.filter((file) => file.source_type === 'task' && Number(file.source_id) === Number(selectedTask.id));
  if (selectedExpense) selectedExpense.files = files.filter((file) => file.source_type === 'expense' && Number(file.source_id) === Number(selectedExpense.id));
  const fileFolders = ['Proyecto', 'Tareas', 'Gastos', 'Cotizaciones'].map((name) => ({
    name,
    files: files.filter((file) => file.folder === name)
  })).filter((folder) => folder.files.length);

  return {
    activeTab,
    detailTabs: DETAIL_TABS.map((tab) => ({
      ...tab,
      href: buildProjectDetailUrl(projectId, tab.key)
    })),
    project,
    projectStatuses: PROJECT_STATUSES,
    projectPriorities: PROJECT_PRIORITIES,
    scheduleStatuses: SCHEDULE_STATUSES,
    taskStatuses: TASK_STATUSES,
    paymentStatuses: EXPENSE_PAYMENT_STATUSES,
    accountingStatuses: ACCOUNTING_STATUSES,
    quoteStatuses: QUOTE_STATUSES,
    quoteEditableStatuses: QUOTE_STATUSES.filter((status) => status.key !== 'converted_project'),
    quotePdfFieldGroups: PROJECT_QUOTE_PDF_FIELD_GROUPS,
    quotePdfDefaultFields: PROJECT_QUOTE_PDF_DEFAULT_FIELDS,
    baseCurrency: companyCurrency.baseCurrency,
    currencyOptions: companyCurrency.allowedCurrencies,
    customers,
    users,
    schedule,
    scheduleDashboard,
    commercialDashboard,
    timeline,
    tasks,
    taskMode,
    selectedTask,
    taskSummary,
    expenses,
    expenseMode,
    selectedExpense,
    canManageExpenseLocks: canLockProjectExpenses({ session: { user: currentUser || null } }),
    files,
    fileFolders,
    logs,
    quotes,
    knowledge,
    knowledgeSearch,
    financial,
    canConvertQuote: quotes.some((quote) => quote.status === 'approved' && !quote.converted_invoice_id)
  };
}

async function refreshProjectFinancials(db, companyId, projectId) {
  const row = await getDb(
    db,
    `SELECT estimated_budget, sale_amount,
            (SELECT COALESCE(SUM(total_amount), 0) FROM project_expenses WHERE project_id = ? AND company_id = ?) AS expense_total
     FROM projects
     WHERE id = ? AND company_id = ?`,
    [projectId, companyId, projectId, companyId]
  );
  if (!row) return;
  const realCost = toNumber(row.expense_total, 0);
  const saleAmount = toNumber(row.sale_amount, 0);
  const estimatedBudget = toNumber(row.estimated_budget, 0);
  await runDb(
    db,
    `UPDATE projects
     SET real_cost = ?, profit_estimated = ?, profit_real = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [
      realCost,
      round2(saleAmount - estimatedBudget),
      round2(saleAmount - realCost),
      projectId,
      companyId
    ]
  );
}

async function syncProjectSaleAmountFromQuotes(db, companyId, projectId) {
  const [project, preferredQuote] = await Promise.all([
    getDb(
      db,
      `SELECT estimated_budget
       FROM projects
       WHERE id = ? AND company_id = ?`,
      [projectId, companyId]
    ),
    getDb(
      db,
      `SELECT total
       FROM project_quotes
       WHERE project_id = ? AND company_id = ? AND COALESCE(is_archived, 0) = 0
         AND status IN ('approved', 'converted')
       ORDER BY CASE status
         WHEN 'converted' THEN 1
         WHEN 'approved' THEN 2
         ELSE 3
       END,
       COALESCE(approved_at, updated_at, created_at) DESC,
       id DESC
       LIMIT 1`,
      [projectId, companyId]
    )
  ]);
  if (!project) return;
  const saleAmount = toNumber(preferredQuote ? preferredQuote.total : 0, 0);
  await runDb(
    db,
    `UPDATE projects
     SET sale_amount = ?, profit_estimated = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [saleAmount, round2(saleAmount - toNumber(project.estimated_budget, 0)), projectId, companyId]
  );
  await refreshProjectFinancials(db, companyId, projectId);
}

async function updateQuoteStatus({ db, companyId, quote, status, rejectionComment, userId }) {
  await runDb(
    db,
    `UPDATE project_quotes
     SET status = ?, approved_at = ?, rejection_comment = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [
      status,
      status === 'approved' ? new Date().toISOString() : null,
      status === 'rejected' ? rejectionComment : null,
      quote.id,
      companyId
    ]
  );
  const projectId = normalizeId(quote.project_id);
  if (projectId && (status === 'approved' || quote.status === 'approved' || quote.status === 'converted')) {
    await syncProjectSaleAmountFromQuotes(db, companyId, projectId);
  }
  if (projectId) {
    await createProjectLog({
      db,
      companyId,
      projectId,
      type: 'quote_status_changed',
      message: status === 'rejected'
        ? `Cotizacion ${quote.title} anulada. Motivo: ${rejectionComment}.`
        : `Cotizacion ${quote.title} marcada como ${getQuoteStatusLabel(status)}.`,
      createdBy: userId
    });
  }
}

async function createProjectFromQuote({ db, companyId, quote, userId }) {
  if (normalizeId(quote.project_id)) return null;
  const code = await generateProjectCode(db, companyId);
  const name = normalizeText(quote.title) || `Proyecto de cotizacion ${quote.id}`;
  const saleAmount = toNumber(quote.total, 0);
  const estimatedBudget = toNumber(quote.cost_estimated, 0);
  const insert = await runDb(
    db,
    `INSERT INTO projects
     (company_id, code, name, client_id, description, start_date, estimated_end_date, real_end_date, status, priority,
      estimated_budget, real_cost, sale_amount, profit_estimated, profit_real, notes, source_quote_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'planning', 'medium', ?, 0, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      companyId,
      code,
      name,
      normalizeId(quote.customer_id),
      normalizeText(quote.description),
      today(),
      normalizeDate(quote.valid_until),
      estimatedBudget,
      saleAmount,
      round2(saleAmount - estimatedBudget),
      normalizeText(quote.notes),
      quote.id,
      userId
    ]
  );
  await runDb(
    db,
    `UPDATE project_quotes
     SET project_id = ?, status = 'converted_project', is_archived = 1, archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [insert.lastID, quote.id, companyId]
  );
  await runDb(
    db,
    `UPDATE project_quote_lines
     SET project_id = ?
     WHERE quote_id = ? AND company_id = ?`,
    [insert.lastID, quote.id, companyId]
  );
  const tasksCreated = await createProjectTasksFromQuoteLines({
    db,
    companyId,
    projectId: insert.lastID,
    quoteId: quote.id,
    userId
  });
  await createProjectLog({
    db,
    companyId,
    projectId: insert.lastID,
    type: 'project_created',
    message: `Proyecto creado desde cotizacion: ${name}`,
    createdBy: userId,
    metadata: { code, quote_id: quote.id, tasks_created: tasksCreated }
  });
  return { projectId: insert.lastID, tasksCreated };
}

async function createProjectTasksFromQuoteLines({ db, companyId, projectId, quoteId, userId }) {
  const lines = await allDb(
    db,
    `SELECT *
     FROM project_quote_lines
     WHERE quote_id = ? AND company_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [quoteId, companyId]
  );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const taskColor = await getNextProjectTaskColor(db, companyId);
    const title = normalizeText(line.service_name) || normalizeText(line.description) || `Tarea ${index + 1}`;
    const details = [
      normalizeText(line.service_details),
      normalizeText(line.description) !== title ? normalizeText(line.description) : '',
      `Cantidad cotizada: ${toNumber(line.qty, 0)}${normalizeText(line.service_unit) ? ` ${normalizeText(line.service_unit)}` : ''}`
    ].filter(Boolean);
    const taskInsert = await runDb(
      db,
      `INSERT INTO project_tasks
       (project_id, company_id, title, description, assigned_to, status, priority, color, sort_order, quote_line_id, estimated_hours, real_hours, start_date, due_date, completed_at, complications, solution_applied, learned_notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'pending', 'medium', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [projectId, companyId, title, details.join('\n'), taskColor, index + 1, line.id, userId]
    );
    await runDb(
      db,
      `INSERT INTO project_expenses
       (project_id, company_id, task_id, quote_line_id, is_estimated, expense_date, category, description, amount, tax_amount, total_amount,
        payment_status, accounting_status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 'Costo cotizado', ?, ?, 0, ?, 'pending', 'omitted', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [projectId, companyId, taskInsert.lastID, line.id, today(), title, toNumber(line.subtotal_cost, 0), toNumber(line.subtotal_cost, 0), userId]
    );
  }
  return lines.length;
}

async function convertProjectQuoteToInvoice({
  db,
  companyId,
  quote,
  userId,
  parseCurrencyList,
  enqueueDbTransaction,
  commitTransaction,
  rollbackTransaction
}) {
  if (quote.converted_invoice_id) return { invoiceHeaderId: quote.converted_invoice_id };
  const projectId = normalizeId(quote.project_id);
  const [project, lines] = await Promise.all([
    projectId ? getProjectById(db, companyId, projectId) : Promise.resolve(null),
    allDb(
      db,
      `SELECT *
       FROM project_quote_lines
       WHERE quote_id = ? AND company_id = ?
       ORDER BY sort_order, id`,
      [quote.id, companyId]
    )
  ]);
  if (!lines.length) throw new Error('PROJECT_QUOTE_LINES_REQUIRED');

  const invoiceHeaderId = await withTransaction(
    db,
    enqueueDbTransaction,
    commitTransaction,
    rollbackTransaction,
    async () => {
      const company = await fetchCompanyCurrency(db, companyId, parseCurrencyList);
      const serviceItemId = await ensureProjectServiceItem(db, companyId);
      const currency = normalizeText(quote.currency).toUpperCase() || company.baseCurrency;
      const exchangeRate = currency === company.baseCurrency ? 1 : (toNumber(quote.exchange_rate, 1) || 1);
      const customerId = normalizeId(quote.customer_id) || normalizeId(project && project.client_id);
      const noteContext = project ? ` del proyecto ${project.code || project.name}` : '';
      const legacyInsert = await runDb(
        db,
        `INSERT INTO invoices
         (customer_id, subtotal, tax_rate, tax_amount, discount_type, discount_value, discount_amount, total, company_id,
          currency, exchange_rate, subtotal_base, tax_amount_base, discount_amount_base, total_base, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          customerId,
          quote.subtotal,
          quote.tax_rate,
          quote.tax_amount,
          quote.discount_type,
          quote.discount_value,
          quote.discount_amount,
          quote.total,
          companyId,
          currency,
          exchangeRate,
          quote.subtotal * exchangeRate,
          quote.tax_amount * exchangeRate,
          quote.discount_amount * exchangeRate,
          quote.total * exchangeRate
        ]
      );
      const headerInsert = await runDb(
        db,
        `INSERT INTO invoice_headers
         (legacy_invoice_id, company_id, invoice_number, invoice_type, source, customer_id, customer_name_snapshot, customer_code_snapshot,
          customer_email_snapshot, customer_phone_snapshot, customer_address_snapshot, issue_date, due_date, payment_method, invoice_language, status,
          subtotal, tax_total, discount_total, total, paid_total, balance_due, notes, currency, exchange_rate,
          subtotal_base, tax_amount_base, discount_amount_base, total_base, created_by, updated_by, created_at, updated_at, emitted_at)
         VALUES (?, ?, NULL, 'standard', 'project_quote', ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, 'es', 'issued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          legacyInsert.lastID,
          companyId,
          customerId,
          today(),
          quote.valid_until,
          quote.subtotal,
          quote.tax_amount,
          quote.discount_amount,
          quote.total,
          quote.total,
          normalizeText(quote.notes) || `Factura generada desde cotizacion${noteContext}.`,
          currency,
          exchangeRate,
          quote.subtotal * exchangeRate,
          quote.tax_amount * exchangeRate,
          quote.discount_amount * exchangeRate,
          quote.total * exchangeRate,
          userId,
          userId
        ]
      );
      await runDb(
        db,
        'UPDATE invoice_headers SET invoice_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
        [buildInvoiceNumber(headerInsert.lastID, today()), headerInsert.lastID, companyId]
      );

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        await runDb(
          db,
          `INSERT INTO invoice_items
           (invoice_id, header_id, item_id, qty, unit_price, line_total, company_id, line_type, description, sku_snapshot, barcode_snapshot,
            item_name_snapshot, category_name_snapshot, tax_rate, tax_amount, discount_type, discount_value, discount_amount, subtotal, total, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            legacyInsert.lastID,
            headerInsert.lastID,
            serviceItemId,
            line.qty,
            line.unit_price,
            line.total,
            companyId,
            line.description,
            line.description,
            line.tax_rate,
            line.tax_amount,
            line.discount_type,
            line.discount_value,
            normalizeLineDiscount(line),
            line.subtotal,
            line.total,
            index + 1
          ]
        );
      }

      await runDb(
        db,
        `INSERT INTO invoice_status_history
         (invoice_header_id, company_id, from_status, to_status, notes, changed_by, created_at)
         VALUES (?, ?, NULL, 'issued', ?, ?, CURRENT_TIMESTAMP)`,
        [
          headerInsert.lastID,
          companyId,
          `Factura creada desde cotizacion${noteContext}.`,
          userId
        ]
      );

      await runDb(
        db,
        `UPDATE project_quotes
         SET status = 'converted', converted_invoice_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ?`,
        [headerInsert.lastID, quote.id, companyId]
      );
      return headerInsert.lastID;
    }
  );

  if (projectId) {
    await syncProjectSaleAmountFromQuotes(db, companyId, projectId);
  }
  return { invoiceHeaderId };
}

async function ensureProjectServiceItem(db, companyId) {
  const existing = await getDb(
    db,
    `SELECT id
     FROM items
     WHERE company_id = ? AND sku = 'PRJ-SVC'
     LIMIT 1`,
    [companyId]
  );
  if (existing && existing.id) return existing.id;
  const inserted = await runDb(
    db,
    `INSERT INTO items
     (name, sku, item_code, code_manual, qty, min_stock, warehouse_location, barcode, price, category_id, brand_id, company_id, created_at)
     VALUES ('Servicio de proyecto', 'PRJ-SVC', 'PRJ-SVC', 1, 0, 0, NULL, NULL, 0, NULL, NULL, ?, CURRENT_TIMESTAMP)`,
    [companyId]
  );
  return inserted.lastID;
}

async function fetchCompanyCurrency(db, companyId, parseCurrencyList) {
  const company = await getDb(db, 'SELECT base_currency, currency, allowed_currencies FROM companies WHERE id = ?', [companyId]);
  const baseCurrency = normalizeText((company && (company.base_currency || company.currency)) || 'GTQ').toUpperCase() || 'GTQ';
  const allowedCurrencies = typeof parseCurrencyList === 'function'
    ? parseCurrencyList(company && company.allowed_currencies, baseCurrency)
    : [baseCurrency];
  return {
    baseCurrency,
    allowedCurrencies
  };
}

async function fetchProjectCompanyProfile(db, companyId, parseCurrencyList, buildFileUrl) {
  const company = await getDb(
    db,
    `SELECT id, name, legal_name, commercial_name, address, tax_address, nit, phone, email, logo,
            base_currency, allowed_currencies, currency, primary_color, secondary_color, theme_background_color
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
    primaryColor: normalizeText(company && company.primary_color) || '#24455d',
    secondaryColor: normalizeText(company && company.secondary_color) || '#2d7c7a',
    backgroundColor: normalizeText(company && company.theme_background_color)
  };
}

function resolveProjectQuoteCurrency(value, allowedCurrencies, fallback = 'GTQ') {
  const normalized = normalizeText(value).toUpperCase();
  const allowed = Array.isArray(allowedCurrencies) && allowedCurrencies.length
    ? allowedCurrencies.map((currency) => normalizeText(currency).toUpperCase()).filter(Boolean)
    : [normalizeText(fallback).toUpperCase() || 'GTQ'];
  const base = normalizeText(fallback).toUpperCase() || allowed[0] || 'GTQ';
  return allowed.includes(normalized) ? normalized : base;
}

function normalizeProjectQuotePdfFields(value, allowEmpty = false) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  const selected = values
    .flatMap((item) => String(item || '').split(','))
    .map((item) => normalizeText(item).toLowerCase())
    .filter((item) => PROJECT_QUOTE_PDF_FIELD_KEYS.includes(item));
  if (!selected.length && allowEmpty) return [];
  return selected.length ? Array.from(new Set(selected)) : PROJECT_QUOTE_PDF_DEFAULT_FIELDS.slice();
}

function parseProjectQuotePdfFieldsJson(value) {
  if (!value) return PROJECT_QUOTE_PDF_DEFAULT_FIELDS.slice();
  try {
    const parsed = JSON.parse(value);
    return normalizeProjectQuotePdfFields(parsed, Array.isArray(parsed));
  } catch (error) {
    return PROJECT_QUOTE_PDF_DEFAULT_FIELDS.slice();
  }
}

function hasProjectQuotePdfField(quoteDocument, key) {
  return !quoteDocument || !quoteDocument.pdfFields || quoteDocument.pdfFields.includes(key);
}

function buildProjectQuotePdfBundle({ project, quote, customer, lines, attachments }) {
  const title = normalizeText(quote && quote.title) || `Cotizacion ${quote && quote.id ? quote.id : ''}`.trim();
  const projectCode = normalizeText(project && project.code) || `PRJ-${project && project.id ? project.id : 'GEN'}`;
  const issueDate = normalizeDate(quote && quote.created_at) || today();
  const validUntil = normalizeDate(quote && quote.valid_until);
  const currency = normalizeText(quote && quote.currency).toUpperCase() || 'GTQ';
  const quoteId = normalizeId(quote && quote.id) || 0;
  const quoteNumber = `COT-${slugifyProjectQuotePdfName(projectCode, 'PRJ').toUpperCase()}-${String(quoteId || 0).padStart(4, '0')}`;
  const scopeText = normalizeText(quote && quote.description) || normalizeText(project && project.description);
  const notesText = normalizeText(quote && quote.notes);
  const combinedNotes = [scopeText, notesText].filter(Boolean).join('\n\n');
  const sanitizedLines = (lines || []).map((line) => {
    const serviceName = normalizeText(line && line.service_name);
    const description = normalizeText(line && line.description);
    const primaryText = serviceName || description || 'Servicio';
    const detailParts = [];
    if (serviceName && description && description !== serviceName) detailParts.push(description);
    if (normalizeText(line && line.service_details)) detailParts.push(normalizeText(line.service_details));
    if (normalizeText(line && line.service_unit)) detailParts.push(`Unidad: ${normalizeText(line.service_unit)}`);
    return {
      title: primaryText,
      details: detailParts.join(' · '),
      qty: toNumber(line && line.qty, 0),
      unitPrice: toNumber(line && line.unit_price, 0),
      taxRate: toNumber(line && line.tax_rate, 0),
      total: toNumber(line && line.total, 0)
    };
  });

  return {
    id: quoteId,
    quoteNumber,
    title,
    fileBaseName: `${title}-${quoteNumber}`,
    statusLabel: getQuoteStatusLabel(quote && quote.status),
    issueDate,
    validUntil,
    currency,
    exchangeRate: toNumber(quote && quote.exchange_rate, 1) || 1,
    pdfFields: parseProjectQuotePdfFieldsJson(quote && quote.pdf_fields_json),
    projectCode,
    projectName: normalizeText(project && project.name) || 'Proyecto',
    customer: {
      name: normalizeText(customer && customer.name) || 'Cliente no asignado',
      code: normalizeText(customer && customer.customer_code),
      phone: normalizeText(customer && customer.phone),
      email: normalizeText(customer && customer.email),
      address: normalizeText(customer && customer.address)
    },
    notes: combinedNotes || 'Cotizacion generada desde el modulo de proyectos.',
    costEstimated: toNumber(quote && quote.cost_estimated, 0),
    marginPercent: toNumber(quote && quote.margin_percent, 0),
    subtotal: toNumber(quote && quote.subtotal, 0),
    taxAmount: toNumber(quote && quote.tax_amount, 0),
    discountAmount: toNumber(quote && quote.discount_amount, 0),
    total: toNumber(quote && quote.total, 0),
    lines: sanitizedLines,
    attachments: Array.isArray(attachments) ? attachments : []
  };
}

function renderProjectQuotePdfToStream(quoteDocument, company, stream) {
  const doc = createProjectQuotePdfDocument();
  doc.pipe(stream);
  drawProjectQuotePdf(doc, quoteDocument, company);
  finalizeProjectQuotePdf(doc, company);
  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function createProjectQuotePdfDocument() {
  return new PDFDocument({
    size: 'A4',
    margins: {
      top: 34,
      right: 28,
      bottom: 38,
      left: 28
    },
    bufferPages: true
  });
}

function drawProjectQuotePdf(doc, quoteDocument, company) {
  const palette = buildProjectQuotePdfPalette(company);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;
  const measureHeight = (value, fontSize, width, options = {}) => {
    if (!value) return 0;
    doc.fontSize(fontSize);
    return doc.heightOfString(String(value), { width, ...options });
  };
  const drawPanel = (x, y, width, height, options = {}) => {
    drawProjectQuotePdfPanel(doc, x, y, width, height, {
      fill: options.fill || palette.panelFill,
      stroke: options.stroke || palette.lineBorder,
      radius: options.radius || 16,
      accentBarColor: options.accentBarColor || null
    });
  };
  const drawSectionLabel = (label, x, y, width) => {
    doc.fillColor(palette.accent).fontSize(8).text(String(label || '').toUpperCase(), x, y, { width });
  };
  const drawBoundedText = (value, x, y, options = {}) => {
    if (!value) return;
    doc.text(String(value), x, y, {
      ...options,
      ellipsis: options.ellipsis !== false
    });
  };
  const addContentPage = () => {
    doc.addPage();
    return drawHeader(true);
  };
  const drawHeader = (continued = false) => {
    if (!continued) {
      const headerHeight = 126;
      doc.rect(0, 0, doc.page.width, headerHeight).fill(palette.primary);
      drawProjectQuotePdfLogoBlock(doc, company, left, 28, 74, 58, {
        fill: palette.accent,
        stroke: palette.softAccent
      });

      const companyTextX = left + 92;
      const companyTextWidth = contentWidth - 294;
      const companyLines = [
        { value: company.name || 'Empresa', size: 20, color: '#ffffff' },
        { value: company.legalName || '', size: 9, color: '#d7e1ea' },
        { value: company.nit ? `NIT: ${company.nit}` : '', size: 9, color: '#d7e1ea' },
        { value: [company.phone, company.email].filter(Boolean).join(' · '), size: 9, color: '#d7e1ea' }
      ].filter((line) => line.value);

      let companyCursorY = 34;
      companyLines.forEach((line) => {
        doc.fillColor(line.color).fontSize(line.size).text(line.value, companyTextX, companyCursorY, {
          width: companyTextWidth
        });
        companyCursorY += measureHeight(line.value, line.size, companyTextWidth) + 3;
      });

      doc.fillColor('#ffffff').fontSize(13).text(quoteDocument.title, companyTextX, Math.max(companyCursorY + 4, 82), {
        width: companyTextWidth,
        lineGap: 1
      });

      const quoteCardWidth = 184;
      const quoteCardX = right - quoteCardWidth;
      drawPanel(quoteCardX, 26, quoteCardWidth, 78, {
        fill: '#ffffff',
        stroke: '#dbe5ec'
      });
      doc.roundedRect(quoteCardX + 18, 38, 88, 18, 9).fill(palette.accent);
      doc.fillColor('#ffffff').fontSize(8).text(quoteDocument.statusLabel.toUpperCase(), quoteCardX + 18, 43, {
        width: 88,
        align: 'center'
      });
      doc.fillColor(palette.primary).fontSize(10).text('COTIZACION', quoteCardX + 18, 63, {
        width: quoteCardWidth - 36
      });
      doc.fontSize(14).text(quoteDocument.quoteNumber, quoteCardX + 18, 78, {
        width: quoteCardWidth - 36
      });
      return headerHeight + 20;
    }

    drawPanel(left, doc.page.margins.top, contentWidth, 58, {
      fill: '#ffffff',
      stroke: palette.lineBorder,
      accentBarColor: palette.accent
    });
    doc.fillColor(palette.primary).fontSize(11).text('COTIZACION', left + 18, doc.page.margins.top + 14, {
      width: 120
    });
    doc.fontSize(15).text(quoteDocument.quoteNumber, left + 18, doc.page.margins.top + 28, {
      width: 200
    });
    doc.fillColor(palette.muted).fontSize(9).text(quoteDocument.title, right - 230, doc.page.margins.top + 20, {
      width: 212,
      align: 'right'
    });
    return doc.page.margins.top + 74;
  };
  const drawTableHeader = (startY) => {
    doc.roundedRect(left, startY, contentWidth, 30, 10).fill(palette.primary);
    const columns = getProjectQuotePdfColumns(left, right, quoteDocument);
    doc.fillColor('#ffffff').fontSize(9);
    columns.forEach((column) => {
      doc.text(column.label, column.x + 6, startY + 10, {
        width: column.width - 12,
        align: column.align || 'left'
      });
    });
    return { nextY: startY + 38, columns };
  };

  let cursorY = drawHeader(false);
  const showCustomer = hasProjectQuotePdfField(quoteDocument, 'customer');
  const customerWidth = showCustomer ? Math.floor(contentWidth * 0.58) : 0;
  const gap = 16;
  const metaWidth = showCustomer ? contentWidth - customerWidth - gap : contentWidth;
  const customerLines = [
    { value: quoteDocument.customer.name, size: 13, color: palette.ink },
    { value: quoteDocument.customer.code ? `Codigo: ${quoteDocument.customer.code}` : '', size: 9, color: palette.muted },
    { value: [quoteDocument.customer.phone, quoteDocument.customer.email].filter(Boolean).join(' · '), size: 9, color: palette.muted },
    { value: quoteDocument.customer.address || '', size: 9, color: palette.muted }
  ].filter((line) => line.value);
  const customerHeight = showCustomer
    ? Math.max(110, 38 + customerLines.reduce((total, line) => total + measureHeight(line.value, line.size, customerWidth - 34) + 6, 0))
    : 0;
  const metaLines = [
    hasProjectQuotePdfField(quoteDocument, 'project_code') ? `Proyecto: ${quoteDocument.projectCode}` : '',
    hasProjectQuotePdfField(quoteDocument, 'project_name') ? quoteDocument.projectName : '',
    hasProjectQuotePdfField(quoteDocument, 'issue_date') ? `Emision: ${quoteDocument.issueDate}` : '',
    hasProjectQuotePdfField(quoteDocument, 'valid_until') ? `Valida hasta: ${quoteDocument.validUntil || 'No definida'}` : '',
    hasProjectQuotePdfField(quoteDocument, 'currency') ? `Moneda: ${quoteDocument.currency}` : '',
    hasProjectQuotePdfField(quoteDocument, 'exchange_rate') ? `Tipo de cambio: ${quoteDocument.exchangeRate.toFixed(4)}` : ''
  ].filter(Boolean);
  const metaHeight = Math.max(110, 36 + metaLines.reduce((total, line) => total + measureHeight(line, 9, metaWidth - 28) + 6, 0));
  const infoHeight = Math.max(customerHeight, metaHeight);

  if (showCustomer) {
    drawPanel(left, cursorY, customerWidth, infoHeight, {
      accentBarColor: palette.accent
    });
    drawSectionLabel('Cliente', left + 20, cursorY + 16, customerWidth - 34);
    let customerCursorY = cursorY + 34;
    customerLines.forEach((line) => {
      doc.fillColor(line.color).fontSize(line.size).text(line.value, left + 16, customerCursorY, {
        width: customerWidth - 30,
        lineGap: 1
      });
      customerCursorY += measureHeight(line.value, line.size, customerWidth - 30, { lineGap: 1 }) + 6;
    });
  }

  const metaX = showCustomer ? left + customerWidth + gap : left;
  drawPanel(metaX, cursorY, metaWidth, infoHeight, {
    accentBarColor: palette.primary
  });
  drawSectionLabel('Resumen comercial', metaX + 20, cursorY + 16, metaWidth - 34);
  let metaCursorY = cursorY + 34;
  metaLines.forEach((line, index) => {
    const lineSize = index < 2 ? 10 : 9;
    const lineColor = index < 2 ? palette.ink : palette.muted;
    doc.fillColor(lineColor).fontSize(lineSize).text(line, metaX + 16, metaCursorY, {
      width: metaWidth - 30,
      lineGap: 1
    });
    metaCursorY += measureHeight(line, lineSize, metaWidth - 30, { lineGap: 1 }) + 6;
  });

  cursorY += infoHeight + 20;
  let headerResult = null;
  let columns = [];

  if (quoteDocument.lines.length) {
    headerResult = drawTableHeader(cursorY);
    columns = headerResult.columns;
    cursorY = headerResult.nextY;
  }

  quoteDocument.lines.forEach((line, index) => {
    const titleHeight = Math.min(
      measureHeight(line.title, 10, columns[0].width - 16, { lineGap: 1.2 }),
      32
    );
    const detailHeight = line.details && hasProjectQuotePdfField(quoteDocument, 'line_details')
      ? Math.min(measureHeight(line.details, 8, columns[0].width - 16, { lineGap: 1.1 }) + 4, 46)
      : 0;
    const rowHeight = Math.max(40, 16 + titleHeight + detailHeight);

    if (cursorY + rowHeight + 24 > pageBottom()) {
      cursorY = addContentPage();
      headerResult = drawTableHeader(cursorY);
      columns = headerResult.columns;
      cursorY = headerResult.nextY;
    }

    drawPanel(left, cursorY - 2, contentWidth, rowHeight, {
      fill: index % 2 === 0 ? '#fbfcfe' : '#ffffff',
      stroke: '#edf2f7',
      radius: 10
    });

    const titleY = cursorY + 8;
    doc.fillColor(palette.ink).fontSize(10);
    drawBoundedText(line.title, columns[0].x + 8, titleY, {
      width: columns[0].width - 16,
      height: titleHeight,
      lineGap: 1.2
    });
    if (line.details && hasProjectQuotePdfField(quoteDocument, 'line_details')) {
      doc.fillColor(palette.muted).fontSize(8);
      drawBoundedText(line.details, columns[0].x + 8, titleY + titleHeight + 4, {
        width: columns[0].width - 16,
        height: Math.max(0, detailHeight - 4),
        lineGap: 1.1
      });
    }

    const numericY = cursorY + Math.max(10, (rowHeight - 12) / 2);
    doc.fillColor(palette.ink).fontSize(10);
    columns.slice(1).forEach((column) => {
      let value = '';
      if (column.key === 'line_qty') value = line.qty.toFixed(2);
      if (column.key === 'line_unit_price') value = formatProjectQuotePdfMoney(quoteDocument.currency, line.unitPrice);
      if (column.key === 'line_tax_rate') value = `${line.taxRate.toFixed(2)}%`;
      if (column.key === 'line_total') value = formatProjectQuotePdfMoney(quoteDocument.currency, line.total);
      doc.text(value, column.x, numericY, {
        width: column.width,
        align: 'right'
      });
    });

    cursorY += rowHeight + 8;
  });

  const showNotes = hasProjectQuotePdfField(quoteDocument, 'notes');
  const attachments = Array.isArray(quoteDocument.attachments) ? quoteDocument.attachments : [];
  const totalsRows = [
    hasProjectQuotePdfField(quoteDocument, 'cost_estimated') ? { label: 'Costo estimado', value: formatProjectQuotePdfMoney(quoteDocument.currency, quoteDocument.costEstimated), emphasize: false } : null,
    hasProjectQuotePdfField(quoteDocument, 'margin_percent') ? { label: 'Margen estimado', value: `${quoteDocument.marginPercent.toFixed(2)}%`, emphasize: false } : null,
    hasProjectQuotePdfField(quoteDocument, 'subtotal') ? { label: 'Subtotal', value: formatProjectQuotePdfMoney(quoteDocument.currency, quoteDocument.subtotal), emphasize: false } : null,
    hasProjectQuotePdfField(quoteDocument, 'tax_amount') ? { label: 'Impuestos', value: formatProjectQuotePdfMoney(quoteDocument.currency, quoteDocument.taxAmount), emphasize: false } : null,
    hasProjectQuotePdfField(quoteDocument, 'discount_amount') ? { label: 'Descuento', value: formatProjectQuotePdfMoney(quoteDocument.currency, quoteDocument.discountAmount), emphasize: false } : null,
    hasProjectQuotePdfField(quoteDocument, 'total') ? { label: 'Total', value: formatProjectQuotePdfMoney(quoteDocument.currency, quoteDocument.total), emphasize: true } : null
  ].filter(Boolean);
  if (!showNotes && !totalsRows.length && !attachments.length) return;
  const notesWidth = showNotes && totalsRows.length ? Math.floor(contentWidth * 0.56) : (showNotes ? contentWidth : 0);
  const totalsWidth = showNotes && totalsRows.length ? contentWidth - notesWidth - gap : (totalsRows.length ? contentWidth : 0);
  const notesTextWidth = notesWidth - 30;
  const notesHeight = showNotes
    ? Math.min(Math.max(112, 40 + measureHeight(quoteDocument.notes, 9, notesTextWidth, { lineGap: 1.2 })), 220)
    : 0;
  const totalsHeight = 24 + totalsRows.length * 24;
  const bottomBlockHeight = Math.max(notesHeight, totalsHeight);

  if (bottomBlockHeight && cursorY + bottomBlockHeight + 40 > pageBottom()) {
    cursorY = addContentPage();
  }

  if (showNotes) {
    drawPanel(left, cursorY + 4, notesWidth, notesHeight, {
      accentBarColor: palette.accent
    });
    drawSectionLabel('Alcance y observaciones', left + 20, cursorY + 20, notesWidth - 36);
    doc.fillColor(palette.ink).fontSize(9);
    drawBoundedText(quoteDocument.notes, left + 16, cursorY + 38, {
      width: notesTextWidth,
      height: Math.max(0, notesHeight - 54),
      lineGap: 1.2
    });
  }

  const totalsX = showNotes ? left + notesWidth + gap : left;
  if (totalsRows.length) {
    drawPanel(totalsX, cursorY + 4, totalsWidth, totalsHeight, {
      fill: '#ffffff',
      stroke: palette.lineBorder
    });
  }
  let totalsCursorY = cursorY + 20;
  totalsRows.forEach((row) => {
    if (row.emphasize) {
      drawPanel(totalsX + 10, totalsCursorY - 4, totalsWidth - 20, 24, {
        fill: palette.softAccent,
        stroke: '#d7ebe6',
        radius: 10
      });
    }
    doc.fillColor(row.emphasize ? palette.primary : palette.muted).fontSize(row.emphasize ? 11 : 9).text(row.label, totalsX + 14, totalsCursorY, {
      width: totalsWidth - 108
    });
    doc.fillColor(row.emphasize ? palette.primary : palette.ink).fontSize(row.emphasize ? 11 : 9).text(row.value, totalsX + totalsWidth - 96, totalsCursorY, {
      width: 82,
      align: 'right'
    });
    totalsCursorY += 24;
  });

  if (bottomBlockHeight) cursorY += bottomBlockHeight + 26;
  if (!attachments.length) return;

  const attachmentTitleHeight = 40;
  if (cursorY + attachmentTitleHeight + 70 > pageBottom()) {
    cursorY = addContentPage();
  }
  drawSectionLabel('Soportes de cotizacion', left, cursorY, contentWidth);
  doc.fillColor(palette.ink).fontSize(12).text('Adjuntos incluidos como respaldo comercial', left, cursorY + 14, {
    width: contentWidth
  });
  cursorY += attachmentTitleHeight;

  attachments.forEach((attachment, index) => {
    const label = `Soporte ${index + 1}: ${attachment.name || 'Adjunto'}`;
    const dateText = attachment.uploadedAt ? normalizeDate(attachment.uploadedAt) : '';
    const meta = [attachment.type || 'archivo', dateText].filter(Boolean).join(' - ');
    let imageInfo = null;
    if (attachment.isImage && attachment.path) {
      try {
        const image = doc.openImage(attachment.path);
        const maxImageWidth = contentWidth - 32;
        const maxImageHeight = 250;
        const scale = Math.min(maxImageWidth / image.width, maxImageHeight / image.height, 1);
        imageInfo = {
          width: image.width * scale,
          height: image.height * scale
        };
      } catch (error) {
        imageInfo = null;
      }
    }
    const cardHeight = imageInfo ? imageInfo.height + 72 : 66;
    if (cursorY + cardHeight + 24 > pageBottom()) {
      cursorY = addContentPage();
    }

    drawPanel(left, cursorY, contentWidth, cardHeight, {
      fill: '#ffffff',
      stroke: palette.lineBorder,
      radius: 12,
      accentBarColor: palette.accent
    });
    doc.fillColor(palette.ink).fontSize(10);
    drawBoundedText(label, left + 16, cursorY + 16, {
      width: contentWidth - 32,
      height: 14
    });
    doc.fillColor(palette.muted).fontSize(8);
    drawBoundedText(meta || 'Archivo adjunto', left + 16, cursorY + 32, {
      width: contentWidth - 32,
      height: 12
    });
    if (imageInfo) {
      const imageX = left + 16;
      const imageY = cursorY + 54;
      try {
        doc.image(attachment.path, imageX, imageY, {
          width: imageInfo.width,
          height: imageInfo.height
        });
      } catch (error) {
        doc.fillColor(palette.muted).fontSize(8).text('No fue posible previsualizar la imagen adjunta.', imageX, imageY, {
          width: contentWidth - 32
        });
      }
    }
    cursorY += cardHeight + 12;
  });
}

function finalizeProjectQuotePdf(doc, company) {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index);
    drawProjectQuotePdfFooter(doc, company, index + 1, range.count);
  }
}

function drawProjectQuotePdfFooter(doc, company, pageNumber, pageCount) {
  const palette = buildProjectQuotePdfPalette(company);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const footerLineY = doc.page.height - doc.page.margins.bottom + 4;
  const footerText = [
    company && company.name ? company.name : 'Empresa',
    company && company.email ? company.email : '',
    company && company.phone ? company.phone : '',
    company && (company.taxAddress || company.address) ? (company.taxAddress || company.address) : ''
  ].filter(Boolean).join(' · ');

  doc.moveTo(left, footerLineY).lineTo(right, footerLineY).strokeColor(palette.lineBorder).stroke();
  doc.fillColor(palette.muted).fontSize(8);
  doc.text(footerText, left, footerLineY + 8, {
    width: right - left - 86
  });
  doc.text(`Pagina ${pageNumber} de ${pageCount}`, right - 86, footerLineY + 8, {
    width: 86,
    align: 'right'
  });
}

function getProjectQuotePdfColumns(left, right, quoteDocument) {
  const gap = 10;
  const optionalColumns = [
    { key: 'line_qty', label: 'Cant.', width: 50 },
    { key: 'line_unit_price', label: 'P. unitario', width: 92 },
    { key: 'line_tax_rate', label: 'IVA', width: 54 },
    { key: 'line_total', label: 'Total', width: 90 }
  ].filter((column) => hasProjectQuotePdfField(quoteDocument, column.key));
  const optionalWidth = optionalColumns.reduce((sum, column) => sum + column.width, 0);
  const optionalGaps = optionalColumns.length ? gap * optionalColumns.length : 0;
  const descriptionWidth = Math.max(180, right - left - optionalWidth - optionalGaps);
  const columns = [{ key: 'description', label: 'Servicio / descripcion', x: left, width: descriptionWidth }];
  let cursorX = left + descriptionWidth + gap;
  optionalColumns.forEach((column) => {
    columns.push({ ...column, x: cursorX, align: 'right' });
    cursorX += column.width + gap;
  });
  return columns;
}

function drawProjectQuotePdfLogoBlock(doc, company, x, y, width, height, options = {}) {
  if (company && company.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, x, y, {
        fit: [width, height],
        align: 'left',
        valign: 'center'
      });
      return;
    } catch (error) {
      // Fallback below.
    }
  }
  drawProjectQuotePdfPanel(doc, x, y, width, height, {
    fill: options.fill || '#3a556c',
    stroke: options.stroke || '#5a7388',
    radius: 14
  });
  doc.fillColor('#ffffff').fontSize(18).text((company && company.name ? company.name : 'ER').slice(0, 2).toUpperCase(), x, y + 18, {
    width,
    align: 'center'
  });
}

function drawProjectQuotePdfPanel(doc, x, y, width, height, options = {}) {
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

function buildProjectQuotePdfPalette(company) {
  const primary = normalizeProjectQuotePdfHexColor(company && company.primaryColor, '#24455d');
  const accent = normalizeProjectQuotePdfHexColor(company && company.secondaryColor, '#2d7c7a');
  return {
    primary,
    accent,
    panelFill: '#f8fafc',
    lineBorder: '#d9e4ea',
    ink: '#24313f',
    muted: '#5f7283',
    softAccent: mixProjectQuotePdfHexColors(accent, '#ffffff', 0.86)
  };
}

function isProjectQuotePdfHexColor(value) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalizeText(value));
}

function normalizeProjectQuotePdfHexColor(value, fallback = '') {
  const raw = normalizeText(value);
  if (!isProjectQuotePdfHexColor(raw)) return fallback;
  if (raw.length === 4) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return raw.toLowerCase();
}

function mixProjectQuotePdfHexColors(source, target, ratio) {
  const from = normalizeProjectQuotePdfHexColor(source);
  const to = normalizeProjectQuotePdfHexColor(target);
  if (!from) return to || '#ffffff';
  if (!to) return from;
  const weight = Math.max(0, Math.min(1, toNumber(ratio, 0)));
  const rgb = [0, 2, 4].map((offset) => {
    const start = parseInt(from.slice(1 + offset, 3 + offset), 16);
    const end = parseInt(to.slice(1 + offset, 3 + offset), 16);
    return Math.round(start + (end - start) * weight).toString(16).padStart(2, '0');
  });
  return `#${rgb.join('')}`;
}

function formatProjectQuotePdfMoney(currency, value) {
  return `${currency || 'GTQ'} ${toNumber(value, 0).toFixed(2)}`;
}

function slugifyProjectQuotePdfName(value, fallback = 'cotizacion') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

async function getProjectById(db, companyId, projectId) {
  return getDb(
    db,
    'SELECT * FROM projects WHERE id = ? AND company_id = ?',
    [projectId, companyId]
  );
}

async function createProjectLog({ db, companyId, projectId, type, message, createdBy, metadata }) {
  await runDb(
    db,
    `INSERT INTO project_logs
     (project_id, company_id, log_type, message, metadata_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      projectId,
      companyId,
      normalizeLogType(type),
      normalizeText(message),
      metadata ? JSON.stringify(metadata) : null,
      createdBy || null
    ]
  );
}

function buildProjectPayload(body, fallback = {}) {
  const estimatedBudget = toNumber(body.estimated_budget, toNumber(fallback.estimated_budget, 0));
  const realCost = toNumber(body.real_cost, toNumber(fallback.real_cost, 0));
  const saleAmount = toNumber(body.sale_amount, toNumber(fallback.sale_amount, 0));
  return {
    code: normalizeText(body.code) || normalizeText(fallback.code),
    name: normalizeText(body.name) || normalizeText(fallback.name),
    clientId: normalizeId(body.client_id) || null,
    description: normalizeText(body.description) || null,
    startDate: normalizeDate(body.start_date) || null,
    estimatedEndDate: normalizeDate(body.estimated_end_date) || null,
    realEndDate: normalizeDate(body.real_end_date) || fallback.real_end_date || null,
    status: normalizeProjectStatus(body.status || fallback.status),
    priority: normalizePriority(body.priority || fallback.priority),
    estimatedBudget,
    realCost,
    saleAmount,
    profitEstimated: round2(saleAmount - estimatedBudget),
    profitReal: round2(saleAmount - realCost),
    notes: normalizeText(body.notes) || null
  };
}

async function generateProjectCode(db, companyId) {
  const year = new Date().getFullYear();
  const prefix = `PRJ-${year}-`;
  const row = await getDb(
    db,
    `SELECT code
     FROM projects
     WHERE company_id = ? AND code LIKE ?
     ORDER BY id DESC
     LIMIT 1`,
    [companyId, `${prefix}%`]
  );
  const lastNumber = row && row.code
    ? Number(String(row.code).slice(prefix.length))
    : 0;
  const nextNumber = Number.isFinite(lastNumber) ? lastNumber + 1 : 1;
  return `${prefix}${String(nextNumber).padStart(4, '0')}`;
}

async function resolveUserName(db, companyId, userId) {
  if (!userId) return '';
  const user = await getDb(
    db,
    'SELECT username FROM users WHERE id = ? AND company_id = ?',
    [userId, companyId]
  );
  return user && user.username ? user.username : '';
}

function decorateProjectRow(row) {
  const project = { ...row };
  project.status_label = getStatusLabel(project.status);
  project.status_meta = getStatusMeta(project.status);
  project.priority_label = getPriorityLabel(project.priority);
  project.priority_meta = getPriorityMeta(project.priority);
  project.expense_total = toNumber(project.expense_total, 0);
  project.real_cost_resolved = toNumber(project.real_cost, project.expense_total);
  project.progress_percent = calculateProjectProgress(project);
  project.estimated_profit_resolved = round2(toNumber(project.sale_amount, 0) - toNumber(project.estimated_budget, 0));
  project.real_profit_resolved = round2(toNumber(project.sale_amount, 0) - project.real_cost_resolved);
  project.client_display = [project.client_code, project.client_name].filter(Boolean).join(' - ') || 'Sin cliente';
  project.isOverdue = Boolean(
    project.estimated_end_date
    && ['completed', 'cancelled'].indexOf(project.status) === -1
    && project.estimated_end_date < today()
  );
  return project;
}

function calculateProjectProgress(project) {
  const taskCount = toNumber(project.task_count, 0);
  const completedTasks = toNumber(project.completed_tasks, 0);
  if (taskCount > 0) {
    return clampPercentage((completedTasks / taskCount) * 100);
  }
  return clampPercentage(project.schedule_progress);
}

function buildScheduleTimeline(schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return [];
  const datedItems = schedule.filter((item) => item.start_date || item.estimated_end_date || item.real_end_date);
  const starts = datedItems.map((item) => new Date(item.start_date || item.estimated_end_date || item.real_end_date));
  const ends = datedItems.map((item) => new Date(item.real_end_date || item.estimated_end_date || item.start_date));
  const minDate = new Date(Math.min(...starts.map((date) => date.getTime()).filter(Number.isFinite)));
  const maxDate = new Date(Math.max(...ends.map((date) => date.getTime()).filter(Number.isFinite)));
  const hasValidRange = Number.isFinite(minDate.getTime()) && Number.isFinite(maxDate.getTime());
  const totalDays = hasValidRange ? Math.max(1, daysBetween(minDate, maxDate) + 1) : 1;
  return schedule.map((item) => {
    const start = new Date(item.start_date || item.estimated_end_date || item.real_end_date);
    const end = new Date(item.real_end_date || item.estimated_end_date || item.start_date);
    const hasDates = Number.isFinite(start.getTime()) && Number.isFinite(end.getTime());
    const offset = hasValidRange && hasDates ? Math.max(0, daysBetween(minDate, start)) : 0;
    const duration = hasDates ? Math.max(1, daysBetween(start, end) + 1) : 1;
    return {
      ...item,
      timeline_date: normalizeDate(item.start_date || item.estimated_end_date || item.real_end_date),
      offset_percent: round2((offset / totalDays) * 100),
      width_percent: hasDates ? round2((duration / totalDays) * 100) : 0
    };
  });
}

function buildProjectTimeline({ schedule, tasks, commercialRows }) {
  const scheduleItems = (schedule || []).map((item) => ({
    ...item,
    timeline_type: 'schedule',
    timeline_label: 'Actividad',
    action_kind: '',
    action_id: null,
    is_overdue: Boolean(
      item.estimated_end_date
      && item.estimated_end_date < today()
      && !item.real_end_date
      && !['completed', 'cancelled'].includes(item.status)
    )
  }));
  const taskItems = (tasks || []).map((task) => ({
      ...task,
      name: task.title,
      start_date: task.start_date || task.due_date || task.completed_at,
      estimated_end_date: task.due_date || task.completed_at || task.start_date,
      real_end_date: task.completed_at || '',
      responsible_display: task.assigned_display,
      timeline_type: 'task',
      timeline_label: 'Tarea',
      action_kind: 'task',
      action_id: task.id,
      is_overdue: Boolean(task.due_date && task.due_date < today() && !['completed', 'cancelled'].includes(task.status))
    }));
  const commercialItems = [];

  (commercialRows || []).forEach((row) => {
    const quoteWasSent = ['sent', 'approved', 'converted', 'converted_project'].includes(row.quote_status);
    const quoteDate = normalizeDate(row.valid_until) || normalizeDate(row.quote_created_at) || '';
    commercialItems.push({
      name: `Envio de cotizacion: ${row.quote_title || `Cotizacion ${row.quote_id}`}`,
      start_date: normalizeDate(row.quote_created_at) || quoteDate,
      estimated_end_date: quoteDate,
      real_end_date: quoteWasSent ? normalizeDate(row.quote_updated_at) : '',
      responsible_display: quoteWasSent ? 'Cotizacion enviada' : 'Pendiente de envio',
      status_label: quoteWasSent ? 'Completado' : 'Pendiente',
      progress_percent: quoteWasSent ? 100 : 0,
      timeline_type: 'quote',
      timeline_label: 'Enviar cotizacion',
      action_kind: '',
      action_id: null,
      is_overdue: Boolean(!quoteWasSent && quoteDate && quoteDate < today())
    });

    const invoiceWasCreated = Boolean(row.converted_invoice_id);
    const invoiceDate = normalizeDate(row.issue_date) || normalizeDate(row.quote_updated_at) || quoteDate;
    commercialItems.push({
      name: `Crear factura: ${row.quote_title || `Cotizacion ${row.quote_id}`}`,
      start_date: invoiceDate,
      estimated_end_date: invoiceDate,
      real_end_date: invoiceWasCreated ? invoiceDate : '',
      responsible_display: invoiceWasCreated ? (row.invoice_number || 'Factura creada') : 'Punto pendiente',
      status_label: invoiceWasCreated ? 'Completado' : 'Pendiente',
      progress_percent: invoiceWasCreated ? 100 : 0,
      timeline_type: 'invoice',
      timeline_label: 'Crear factura',
      action_kind: '',
      action_id: null,
      is_overdue: false
    });

    const collectionWasCompleted = invoiceWasCreated && toNumber(row.balance_due, 0) <= 0;
    const collectionDate = normalizeDate(row.due_date) || invoiceDate || quoteDate;
    commercialItems.push({
      name: `Cobrar cotizacion: ${row.quote_title || `Cotizacion ${row.quote_id}`}`,
      start_date: collectionDate,
      estimated_end_date: collectionDate,
      real_end_date: collectionWasCompleted ? (normalizeDate(row.paid_at) || collectionDate) : '',
      responsible_display: collectionWasCompleted
        ? 'Cobro completado'
        : (invoiceWasCreated ? `Saldo pendiente ${toNumber(row.balance_due, 0).toFixed(2)}` : 'Punto pendiente'),
      status_label: collectionWasCompleted ? 'Completado' : 'Pendiente',
      progress_percent: toNumber(row.invoice_total, 0) > 0
        ? clampPercentage((toNumber(row.paid_total, 0) / toNumber(row.invoice_total, 0)) * 100)
        : 0,
      timeline_type: 'collection',
      timeline_label: 'Cobrar cotizacion',
      action_kind: '',
      action_id: null,
      is_overdue: Boolean(invoiceWasCreated && !collectionWasCompleted && collectionDate && collectionDate < today())
    });
  });

  return buildScheduleTimeline([...scheduleItems, ...taskItems, ...commercialItems])
    .sort((a, b) => {
      const dateA = String(a.timeline_date || '');
      const dateB = String(b.timeline_date || '');
      if (!dateA && dateB) return 1;
      if (dateA && !dateB) return -1;
      return dateA.localeCompare(dateB) || String(a.name || '').localeCompare(String(b.name || ''));
    });
}

function buildScheduleDashboard({ project, tasks, schedule }) {
  const openTasks = (tasks || []).filter((task) => !['completed', 'cancelled'].includes(task.status));
  const datedTasks = (tasks || []).filter((task) => task.start_date || task.due_date);
  const overdueTasks = openTasks.filter((task) => task.due_date && task.due_date < today());
  const nextTask = openTasks
    .filter((task) => task.due_date)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))[0] || null;
  const completedTasks = (tasks || []).filter((task) => task.status === 'completed').length;
  return {
    totalTasks: (tasks || []).length,
    datedTasks: datedTasks.length,
    openTasks: openTasks.length,
    overdueTasks: overdueTasks.length,
    completedTasks,
    completionPercent: tasks && tasks.length ? clampPercentage((completedTasks / tasks.length) * 100) : 0,
    nextTask,
    activityCount: (schedule || []).length,
    startDate: project.start_date || '',
    endDate: project.real_end_date || project.estimated_end_date || ''
  };
}

function buildCommercialDashboard(commercialRows) {
  const rows = commercialRows || [];
  const invoiceCandidate = rows.find((row) => row.quote_status === 'approved' && !row.converted_invoice_id)
    || rows.find((row) => row.converted_invoice_id)
    || rows[0]
    || null;
  const sendCandidate = rows.find((row) => row.quote_status === 'draft')
    || rows.find((row) => !['sent', 'approved', 'converted', 'converted_project'].includes(row.quote_status))
    || null;
  const collectionCandidate = rows.find((row) => row.converted_invoice_id && toNumber(row.balance_due, 0) > 0)
    || rows.find((row) => row.converted_invoice_id)
    || null;
  return {
    invoiceCandidate,
    sendCandidate,
    collectionCandidate,
    hasQuote: rows.length > 0,
    invoicedCount: rows.filter((row) => row.converted_invoice_id).length,
    pendingCollection: round2(rows.reduce((sum, row) => sum + Math.max(0, toNumber(row.balance_due, 0)), 0))
  };
}

function buildTaskSummary(tasks) {
  const summary = {
    total: tasks.length,
    completed: 0,
    inProgress: 0,
    pending: 0,
    estimatedHours: 0,
    realHours: 0
  };
  tasks.forEach((task) => {
    if (task.status === 'completed') summary.completed += 1;
    if (task.status === 'in_progress') summary.inProgress += 1;
    if (task.status === 'pending') summary.pending += 1;
    summary.estimatedHours += toNumber(task.estimated_hours, 0);
    summary.realHours += toNumber(task.real_hours, 0);
  });
  summary.progressPercent = summary.total ? clampPercentage((summary.completed / summary.total) * 100) : 0;
  return summary;
}

function buildFinancialSummary({ project, tasks, expenses, quotes }) {
  const estimatedBudget = toNumber(project.estimated_budget, 0);
  const saleAmount = toNumber(project.sale_amount, 0);
  const realExpenses = round2(expenses.reduce((sum, item) => sum + toNumber(item.total_amount, 0), 0));
  const estimatedHours = round2(tasks.reduce((sum, task) => sum + toNumber(task.estimated_hours, 0), 0));
  const realHours = round2(tasks.reduce((sum, task) => sum + toNumber(task.real_hours, 0), 0));
  const approvedQuote = quotes.find((quote) => quote.status === 'approved') || quotes[0] || null;
  const quotedSale = approvedQuote ? toNumber(approvedQuote.total, 0) : saleAmount;
  return {
    estimatedBudget,
    realExpenses,
    quotedSale,
    estimatedProfit: round2(saleAmount - estimatedBudget),
    realProfit: round2(saleAmount - realExpenses),
    estimatedVsRealCostDiff: round2(realExpenses - estimatedBudget),
    estimatedHours,
    realHours,
    progressPercent: calculateProjectProgress(project),
    financialStatus: resolveFinancialStatus({ estimatedBudget, realExpenses, saleAmount }),
    approvedQuote
  };
}

function resolveFinancialStatus({ estimatedBudget, realExpenses, saleAmount }) {
  if (!saleAmount) return 'Sin venta definida';
  if (realExpenses > saleAmount) return 'En pérdida';
  if (realExpenses > estimatedBudget) return 'Sobre costo controlado';
  return 'Saludable';
}

function decorateDashboardTaskRow(row) {
  const dueDate = normalizeDate(row.due_date);
  const projectTaskCount = toNumber(row.project_task_count, 0);
  const projectCompletedTasks = toNumber(row.project_completed_tasks, 0);
  return {
    ...row,
    color: normalizeProjectTaskColor(row.color, row.id),
    status_label: getTaskStatusLabel(row.status),
    priority_label: getPriorityLabel(row.priority),
    priority_meta: getPriorityMeta(row.priority),
    assigned_display: row.assigned_name || 'Sin asignar',
    project_display: [row.project_code, row.project_name].filter(Boolean).join(' - ') || row.project_name || 'Sin proyecto',
    project_progress_percent: projectTaskCount
      ? clampPercentage((projectCompletedTasks / projectTaskCount) * 100)
      : 0,
    isOverdue: Boolean(
      dueDate
      && ['completed', 'cancelled'].indexOf(row.status) === -1
      && dueDate < today()
    )
  };
}

function decorateDashboardQuoteRow(row, quoteLineRows) {
  const lines = quoteLineRows
    .filter((line) => Number(line.quote_id) === Number(row.id))
    .map((line) => ({
      ...line,
      service_display: normalizeText(line.service_name) || normalizeText(line.description),
      service_meta: [normalizeText(line.service_unit), normalizeText(line.service_details)].filter(Boolean).join(' · ')
    }));
  return {
    ...row,
    rejection_comment: normalizeText(row.rejection_comment),
    status_label: getQuoteStatusLabel(row.status),
    pdf_fields: parseProjectQuotePdfFieldsJson(row.pdf_fields_json),
    project_display: [row.project_code, row.project_name].filter(Boolean).join(' - ') || row.project_name || 'Sin proyecto',
    customer_display: [row.customer_code, row.customer_name].filter(Boolean).join(' - ') || row.customer_name || 'Cliente sin definir',
    lines,
    line_count: lines.length,
    isArchived: Boolean(toNumber(row.is_archived, 0)),
    isExpired: Boolean(
      row.valid_until
      && ['approved', 'converted'].indexOf(row.status) === -1
      && normalizeDate(row.valid_until) < today()
    )
  };
}

function buildQuoteSummary(quotes) {
  return quotes.reduce((acc, quote) => {
    acc.total += 1;
    acc.totalAmount += toNumber(quote.total, 0);
    if (quote.status === 'draft') acc.draft += 1;
    if (quote.status === 'sent') acc.sent += 1;
    if (quote.status === 'approved') acc.approved += 1;
    if (quote.status === 'rejected') acc.rejected += 1;
    if (quote.status === 'converted') acc.converted += 1;
    if (quote.isArchived) acc.archived += 1;
    if (quote.isExpired) acc.expired += 1;
    return acc;
  }, {
    total: 0,
    draft: 0,
    sent: 0,
    approved: 0,
    rejected: 0,
    converted: 0,
    archived: 0,
    expired: 0,
    totalAmount: 0
  });
}

function parseQuoteLines(body) {
  const serviceNames = ensureArray(body.line_service_name);
  const serviceUnits = ensureArray(body.line_service_unit);
  const serviceDetails = ensureArray(body.line_service_details);
  const descriptions = ensureArray(body.line_description);
  const qtys = ensureArray(body.line_qty);
  const unitCosts = ensureArray(body.line_unit_cost);
  const marginPercents = ensureArray(body.line_margin_percent);
  const unitPrices = ensureArray(body.line_unit_price);
  const taxRates = ensureArray(body.line_tax_rate);
  const discountTypes = ensureArray(body.line_discount_type);
  const discountValues = ensureArray(body.line_discount_value);
  const lines = [];

  descriptions.forEach((description, index) => {
    const serviceName = normalizeText(serviceNames[index]);
    const serviceUnit = normalizeText(serviceUnits[index]);
    const serviceDetail = normalizeText(serviceDetails[index]);
    const lineDescription = normalizeText(description) || serviceName;
    const qty = toNumber(qtys[index], 0);
    if (!lineDescription || qty <= 0) return;
    const unitCost = toNumber(unitCosts[index], 0);
    const marginText = normalizeText(marginPercents[index]);
    const unitPriceInput = toNumber(unitPrices[index], NaN);
    const profitInput = parseQuoteLineProfitInput(marginText, unitCost);
    const unitPrice = profitInput
      ? round2(unitCost + profitInput.amount)
      : (Number.isFinite(unitPriceInput) ? unitPriceInput : unitCost);
    const profitPerUnit = round2(unitPrice - unitCost);
    const profitAmount = round2(qty * profitPerUnit);
    const marginPercent = profitInput && profitInput.isPercent
      ? profitInput.percent
      : (unitCost > 0 ? round2((profitPerUnit / unitCost) * 100) : 0);
    const taxRate = toNumber(taxRates[index], 0);
    const discountType = normalizeDiscountType(discountTypes[index]);
    const discountValue = toNumber(discountValues[index], 0);
    const subtotalCost = round2(qty * unitCost);
    const subtotal = round2(qty * unitPrice);
    const discountAmount = discountType === 'percent'
      ? round2(subtotal * (discountValue / 100))
      : round2(discountValue);
    const taxableBase = Math.max(0, subtotal - discountAmount);
    const taxAmount = round2(taxableBase * (taxRate / 100));
    const total = round2(taxableBase + taxAmount);
    lines.push({
      serviceName,
      serviceUnit,
      serviceDetail,
      description: lineDescription,
      qty,
      unitCost,
      marginPercent,
      profitAmount,
      unitPrice,
      taxRate,
      discountType,
      discountValue,
      subtotalCost,
      subtotal,
      discountAmount,
      taxAmount,
      total
    });
  });

  return lines;
}

function parseQuoteLineProfitInput(value, unitCost) {
  const text = normalizeText(value).replace(',', '.');
  if (!text) return null;
  const isPercent = text.includes('%');
  const numeric = Number(text.replace('%', '').trim());
  if (!Number.isFinite(numeric)) return null;
  const amount = isPercent && unitCost > 0
    ? round2(unitCost * (numeric / 100))
    : round2(numeric);
  return {
    amount,
    percent: unitCost > 0 ? round2((amount / unitCost) * 100) : 0,
    isPercent
  };
}

function computeQuoteTotals(lines, body) {
  const subtotal = round2(lines.reduce((sum, line) => sum + line.subtotal, 0));
  const costEstimated = round2(lines.reduce((sum, line) => sum + line.subtotalCost, 0));
  const lineDiscounts = round2(lines.reduce((sum, line) => sum + line.discountAmount, 0));
  const formDiscountType = normalizeDiscountType(body.discount_type);
  const formDiscountValue = toNumber(body.discount_value, 0);
  const extraDiscount = formDiscountType === 'percent'
    ? round2(subtotal * (formDiscountValue / 100))
    : round2(formDiscountValue);
  const discountAmount = round2(lineDiscounts + extraDiscount);
  const taxAmount = round2(lines.reduce((sum, line) => sum + line.taxAmount, 0));
  const total = round2(Math.max(0, subtotal - extraDiscount) + taxAmount - lineDiscounts);
  const marginPercentInput = toNumber(body.margin_percent, NaN);
  const marginPercent = Number.isFinite(marginPercentInput)
    ? marginPercentInput
    : (costEstimated > 0 ? round2(((total - costEstimated) / costEstimated) * 100) : 0);
  return {
    subtotal,
    costEstimated,
    taxRate: toNumber(body.tax_rate, 0),
    taxAmount,
    discountType: formDiscountType,
    discountValue: formDiscountValue,
    discountAmount,
    total,
    marginPercent
  };
}

async function createProjectTask({ db, companyId, projectId, body, userId }) {
  const title = normalizeText(body.title);
  if (!title) {
    throw new Error('PROJECT_TASK_TITLE_REQUIRED');
  }
  const nextOrderRow = await getDb(
    db,
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM project_tasks WHERE project_id = ? AND company_id = ?',
    [projectId, companyId]
  );
  const taskColor = await getNextProjectTaskColor(db, companyId);
  await runDb(
    db,
    `INSERT INTO project_tasks
     (project_id, company_id, title, description, assigned_to, status, priority, color, sort_order, estimated_hours, real_hours, start_date, due_date, completed_at, complications, solution_applied, learned_notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      projectId,
      companyId,
      title,
      normalizeText(body.description),
      normalizeId(body.assigned_to),
      normalizeTaskStatus(body.status),
      normalizePriority(body.priority),
      taskColor,
      toNumber(nextOrderRow && nextOrderRow.next_order, 1),
      toNullableNumber(body.estimated_hours),
      toNullableNumber(body.real_hours),
      normalizeDate(body.start_date),
      normalizeDate(body.due_date),
      null,
      null,
      null,
      null,
      userId
    ]
  );
  await createProjectLog({
    db,
    companyId,
    projectId,
    type: 'task_created',
    message: `Nueva tarea creada: ${title}.`,
    createdBy: userId
  });
}

async function backfillProjectTaskColors(db) {
  const rows = await allDb(
    db,
    `SELECT id, company_id
     FROM project_tasks
     WHERE color IS NULL OR TRIM(color) = ''
     ORDER BY company_id ASC, id ASC`
  );
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const color = await getNextProjectTaskColor(db, row.company_id);
    await runDb(db, 'UPDATE project_tasks SET color = ? WHERE id = ?', [color, row.id]);
  }
}

async function getNextProjectTaskColor(db, companyId) {
  const rows = await allDb(
    db,
    `SELECT color
     FROM project_tasks
     WHERE company_id = ? AND color IS NOT NULL AND TRIM(color) <> ''`,
    [companyId]
  );
  const usedColors = new Set(rows.map((row) => normalizeText(row.color).toLowerCase()).filter(Boolean));
  let index = usedColors.size;
  while (index < usedColors.size + 100000) {
    const candidate = buildProjectTaskColor(index);
    if (!usedColors.has(candidate.toLowerCase())) return candidate;
    index += 1;
  }
  return buildProjectTaskColor(Date.now());
}

function normalizeProjectTaskColor(value, taskId) {
  const normalized = normalizeText(value);
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : buildProjectTaskColor(toNumber(taskId, 0));
}

function buildProjectTaskColor(index) {
  const numericIndex = toNumber(index, 0);
  const hue = (numericIndex * 137.508) % 360;
  const saturation = 62 + (Math.floor(numericIndex / 360) % 3) * 8;
  const lightness = 42 + (Math.floor(numericIndex / 1080) % 3) * 7;
  return hslToHex(hue, saturation, lightness);
}

function hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs((2 * l) - 1)) * s;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const offset = l - (chroma / 2);
  const channels = segment < 1 ? [chroma, secondary, 0]
    : segment < 2 ? [secondary, chroma, 0]
      : segment < 3 ? [0, chroma, secondary]
        : segment < 4 ? [0, secondary, chroma]
          : segment < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return `#${channels.map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('')}`;
}

async function createProjectQuote({
  db,
  companyId,
  projectId,
  project,
  body,
  userId,
  enqueueDbTransaction,
  commitTransaction,
  rollbackTransaction,
  parseCurrencyList,
  files
}) {
  const lines = parseQuoteLines(body);
  if (!lines.length) {
    throw new Error('PROJECT_QUOTE_LINES_REQUIRED');
  }
  const totals = computeQuoteTotals(lines, body);
  const resolvedProjectId = normalizeId(projectId);
  const companyCurrency = await fetchCompanyCurrency(db, companyId, parseCurrencyList);
  const currency = resolveProjectQuoteCurrency(body.currency, companyCurrency.allowedCurrencies, companyCurrency.baseCurrency);
  const pdfFieldsJson = JSON.stringify(normalizeProjectQuotePdfFields(body.pdf_fields, Boolean(body.pdf_fields_submitted)));
  const title = normalizeText(body.title) || (project ? `Cotizacion ${project.code || project.name}` : 'Cotizacion general');
  const customerId = normalizeId(body.customer_id) || (project ? project.client_id : null) || null;
  const quote = await withTransaction(
    db,
    enqueueDbTransaction,
    commitTransaction,
    rollbackTransaction,
    async () => {
      const quoteInsert = await runDb(
        db,
        `INSERT INTO project_quotes
         (project_id, company_id, customer_id, title, description, valid_until, currency, exchange_rate, cost_estimated, margin_percent, tax_rate,
          discount_type, discount_value, discount_amount, subtotal, tax_amount, total, notes, pdf_fields_json, status, approved_at, converted_invoice_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          resolvedProjectId || 0,
          companyId,
          customerId,
          title,
          normalizeText(body.description) || (project ? project.description : null) || null,
          normalizeDate(body.valid_until),
          currency,
          toNumber(body.exchange_rate, 1) || 1,
          totals.costEstimated,
          totals.marginPercent,
          totals.taxRate,
          totals.discountType,
          totals.discountValue,
          totals.discountAmount,
          totals.subtotal,
          totals.taxAmount,
          totals.total,
          normalizeText(body.notes),
          pdfFieldsJson,
          normalizeQuoteStatus(body.status),
          userId
        ]
      );

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        await runDb(
          db,
          `INSERT INTO project_quote_lines
           (quote_id, project_id, company_id, line_type, service_name, service_unit, service_details, description, qty, unit_cost, margin_percent, profit_amount, unit_price, tax_rate, discount_type, discount_value,
            discount_amount, subtotal_cost, subtotal, tax_amount, total, sort_order, created_at)
           VALUES (?, ?, ?, 'service', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            quoteInsert.lastID,
            resolvedProjectId || 0,
            companyId,
            line.serviceName,
            line.serviceUnit,
            line.serviceDetail,
            line.description,
            line.qty,
            line.unitCost,
            line.marginPercent,
            line.profitAmount,
            line.unitPrice,
            line.taxRate,
            line.discountType,
            line.discountValue,
            line.discountAmount,
            line.subtotalCost,
            line.subtotal,
            line.taxAmount,
            line.total,
            index + 1
          ]
        );
      }
      await insertProjectQuoteAttachments({
        db,
        companyId,
        projectId: resolvedProjectId || 0,
        quoteId: quoteInsert.lastID,
        files,
        userId
      });
      return { id: quoteInsert.lastID, totals, title };
    }
  );

  if (project && (!project.sale_amount || normalizeQuoteStatus(body.status) === 'approved')) {
    await runDb(
      db,
      `UPDATE projects
       SET sale_amount = ?, profit_estimated = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [quote.totals.total, round2(quote.totals.total - toNumber(project.estimated_budget, 0)), resolvedProjectId, companyId]
    );
  }
  if (project) {
    await refreshProjectFinancials(db, companyId, resolvedProjectId);
    await createProjectLog({
      db,
      companyId,
      projectId: resolvedProjectId,
      type: 'quote_created',
      message: `Cotizacion creada: ${title}.`,
      createdBy: userId,
      metadata: { quote_id: quote.id, total: quote.totals.total }
    });
  }
  return quote;
}

async function updateProjectQuote({
  db,
  companyId,
  project,
  quote,
  body,
  userId,
  enqueueDbTransaction,
  commitTransaction,
  rollbackTransaction,
  parseCurrencyList,
  files
}) {
  const lines = parseQuoteLines(body);
  if (!lines.length) {
    throw new Error('PROJECT_QUOTE_LINES_REQUIRED');
  }
  const totals = computeQuoteTotals(lines, body);
  const quoteProjectId = normalizeId(quote.project_id);
  const companyCurrency = await fetchCompanyCurrency(db, companyId, parseCurrencyList);
  const currency = resolveProjectQuoteCurrency(
    body.currency || quote.currency,
    companyCurrency.allowedCurrencies,
    companyCurrency.baseCurrency
  );
  const pdfFieldsJson = JSON.stringify(normalizeProjectQuotePdfFields(body.pdf_fields, Boolean(body.pdf_fields_submitted)));
  const title = normalizeText(body.title) || quote.title || (project ? `Cotizacion ${project.code || project.name}` : 'Cotizacion general');
  const customerId = normalizeId(body.customer_id) || (project ? project.client_id : null) || null;
  const status = normalizeQuoteStatus(body.status || quote.status);
  await withTransaction(
    db,
    enqueueDbTransaction,
    commitTransaction,
    rollbackTransaction,
    async () => {
      await runDb(
        db,
        `UPDATE project_quotes
         SET customer_id = ?, title = ?, description = ?, valid_until = ?, currency = ?, exchange_rate = ?, cost_estimated = ?, margin_percent = ?, tax_rate = ?,
             discount_type = ?, discount_value = ?, discount_amount = ?, subtotal = ?, tax_amount = ?, total = ?, notes = ?, pdf_fields_json = ?, status = ?, approved_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ? AND company_id = ?`,
        [
          customerId,
          title,
          normalizeText(body.description) || (project ? project.description : null) || null,
          normalizeDate(body.valid_until),
          currency,
          toNumber(body.exchange_rate, toNumber(quote.exchange_rate, 1) || 1) || 1,
          totals.costEstimated,
          totals.marginPercent,
          totals.taxRate,
          totals.discountType,
          totals.discountValue,
          totals.discountAmount,
          totals.subtotal,
          totals.taxAmount,
          totals.total,
          normalizeText(body.notes),
          pdfFieldsJson,
          status,
          status === 'approved' ? (quote.approved_at || new Date().toISOString()) : null,
          quote.id,
          quoteProjectId || 0,
          companyId
        ]
      );
      await runDb(
        db,
        'DELETE FROM project_quote_lines WHERE quote_id = ? AND project_id = ? AND company_id = ?',
        [quote.id, quoteProjectId || 0, companyId]
      );
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        await runDb(
          db,
          `INSERT INTO project_quote_lines
           (quote_id, project_id, company_id, line_type, service_name, service_unit, service_details, description, qty, unit_cost, margin_percent, profit_amount, unit_price, tax_rate, discount_type, discount_value,
            discount_amount, subtotal_cost, subtotal, tax_amount, total, sort_order, created_at)
           VALUES (?, ?, ?, 'service', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            quote.id,
            quoteProjectId || 0,
            companyId,
            line.serviceName,
            line.serviceUnit,
            line.serviceDetail,
            line.description,
            line.qty,
            line.unitCost,
            line.marginPercent,
            line.profitAmount,
            line.unitPrice,
            line.taxRate,
            line.discountType,
            line.discountValue,
            line.discountAmount,
            line.subtotalCost,
            line.subtotal,
            line.taxAmount,
            line.total,
            index + 1
          ]
        );
      }
      await insertProjectQuoteAttachments({
        db,
        companyId,
        projectId: quoteProjectId || 0,
        quoteId: quote.id,
        files,
        userId
      });
    }
  );

  if (
    project
    && (
      !project.sale_amount
      || status === 'approved'
      || quote.status === 'approved'
      || toNumber(project.sale_amount, 0) === toNumber(quote.total, 0)
    )
  ) {
    await runDb(
      db,
      `UPDATE projects
       SET sale_amount = ?, profit_estimated = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [totals.total, round2(totals.total - toNumber(project.estimated_budget, 0)), quoteProjectId, companyId]
    );
  }
  if (project) {
    await refreshProjectFinancials(db, companyId, quoteProjectId);
    await createProjectLog({
      db,
      companyId,
      projectId: quoteProjectId,
      type: 'quote_updated',
      message: `Cotizacion actualizada: ${title}.`,
      createdBy: userId,
      metadata: { quote_id: quote.id, total: totals.total }
    });
  }
  return {
    id: quote.id,
    totals,
    title,
    status
  };
}

async function insertProjectQuoteAttachments({ db, companyId, projectId, quoteId, files, userId }) {
  const attachments = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!attachments.length || !quoteId) return;
  for (const file of attachments) {
    const storedPath = normalizeStoredPath(file.path);
    await runDb(
      db,
      `INSERT INTO project_files
       (project_id, company_id, filename, original_name, file_type, uploaded_by, uploaded_at, notes, source_type, source_id, source_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'quote', ?, 'Cotizacion', CURRENT_TIMESTAMP)`,
      [
        normalizeId(projectId) || 0,
        companyId,
        storedPath,
        file.originalname || file.filename,
        normalizeText(file.mimetype) || safeExtension(file.originalname),
        userId || null,
        'Soporte de cotizacion',
        quoteId
      ]
    );
  }
}

async function fetchProjectQuotePdfAttachments(db, companyId, quoteId) {
  if (!quoteId) return [];
  const rows = await allDb(
    db,
    `SELECT id, filename, original_name, file_type, uploaded_at, created_at
     FROM project_files
     WHERE company_id = ?
       AND source_type = 'quote'
       AND source_id = ?
     ORDER BY COALESCE(uploaded_at, created_at) ASC, id ASC`,
    [companyId, quoteId]
  );
  return rows.map((row) => {
    const mimeType = normalizeText(row.file_type);
    const fileName = normalizeText(row.original_name) || normalizeText(row.filename) || 'Soporte';
    return {
      id: row.id,
      name: fileName,
      type: mimeType || safeExtension(fileName) || 'archivo',
      path: resolveStoredUploadPath(row.filename),
      uploadedAt: row.uploaded_at || row.created_at,
      isImage: isProjectQuotePdfImage(row.filename, mimeType)
    };
  }).filter((attachment) => attachment.path);
}

function resolveStoredUploadPath(storedPath) {
  const normalized = normalizeText(storedPath).replace(/\\/g, '/');
  if (!normalized) return null;
  const absoluteRoot = path.resolve(path.join(process.cwd(), 'data', 'uploads'));
  const absolutePath = path.resolve(path.join(absoluteRoot, normalized));
  if (!absolutePath.startsWith(absoluteRoot)) return null;
  return fs.existsSync(absolutePath) ? absolutePath : null;
}

function isProjectQuotePdfImage(fileName, mimeType) {
  const normalizedMime = normalizeText(mimeType).toLowerCase();
  const ext = safeExtension(fileName).toLowerCase();
  return normalizedMime === 'image/png'
    || normalizedMime === 'image/jpeg'
    || ext === '.png'
    || ext === '.jpg'
    || ext === '.jpeg';
}

function normalizeLineDiscount(line) {
  if (!line) return 0;
  if (line.discount_type === 'percent') {
    return round2(toNumber(line.subtotal, 0) * (toNumber(line.discount_value, 0) / 100));
  }
  return toNumber(line.discount_value, 0);
}

function normalizeStoredPath(filePath) {
  const absoluteRoot = path.resolve(path.join(process.cwd(), 'data', 'uploads'));
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  return relative.replace(/\\/g, '/');
}

function normalizeProjectStatus(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'borrador':
      return 'draft';
    case 'en_planificacion':
    case 'planificacion':
      return 'planning';
    case 'en_proceso':
    case 'proceso':
      return 'in_progress';
    case 'en_pausa':
    case 'pausa':
      return 'paused';
    case 'finalizado':
      return 'completed';
    case 'cancelado':
      return 'cancelled';
    default:
      return PROJECT_STATUSES.some((status) => status.key === normalized) ? normalized : 'draft';
  }
}

function normalizeScheduleStatus(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'pendiente') return 'pending';
  if (normalized === 'en_proceso') return 'in_progress';
  if (normalized === 'finalizada') return 'completed';
  if (normalized === 'bloqueada') return 'blocked';
  return SCHEDULE_STATUSES.some((item) => item.key === normalized) ? normalized : 'pending';
}

function normalizeTaskStatus(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'pendiente') return 'pending';
  if (normalized === 'en_proceso') return 'in_progress';
  if (normalized === 'en_pausa') return 'paused';
  if (normalized === 'finalizada') return 'completed';
  if (normalized === 'cancelada') return 'cancelled';
  return TASK_STATUSES.some((item) => item.key === normalized) ? normalized : 'pending';
}

function normalizePriority(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'baja') return 'low';
  if (normalized === 'media') return 'medium';
  if (normalized === 'alta') return 'high';
  if (normalized === 'critica' || normalized === 'crítica') return 'critical';
  return PROJECT_PRIORITIES.some((item) => item.key === normalized) ? normalized : 'medium';
}

function normalizeExpensePaymentStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'pagado') return 'paid';
  if (normalized === 'parcial') return 'partial';
  return 'pending';
}

function normalizeQuoteStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'enviada') return 'sent';
  if (normalized === 'aprobada') return 'approved';
  if (normalized === 'rechazada') return 'rejected';
  if (normalized === 'transformada_a_proyecto') return 'converted_project';
  if (normalized === 'convertida') return 'converted';
  return QUOTE_STATUSES.some((item) => item.key === normalized) ? normalized : 'draft';
}

function normalizeLogType(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');
  return normalized || 'manual_note';
}

function normalizeDiscountType(value) {
  return normalizeText(value).toLowerCase() === 'percent' ? 'percent' : 'amount';
}

function normalizeDashboardView(value) {
  return normalizeText(value).toLowerCase() === 'list' ? 'list' : 'kanban';
}

function normalizeQuoteDashboardView(value) {
  const normalized = normalizeText(value).toLowerCase();
  return QUOTE_DASHBOARD_VIEWS.has(normalized) ? normalized : 'summary';
}

function normalizeDashboardSection(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'tasks') return 'tasks';
  if (normalized === 'quotes') return 'quotes';
  if (normalized === 'projects') return 'projects';
  if (normalized === 'summary') return 'summary';
  return 'summary';
}

function normalizeTaskDashboardStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized || normalized === 'all') return 'all';
  return TASK_STATUSES.some((item) => item.key === normalized) ? normalized : 'all';
}

function normalizeQuoteDashboardStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized || normalized === 'all') return 'all';
  return QUOTE_STATUSES.some((item) => item.key === normalized) ? normalized : 'all';
}

function normalizeQuoteDashboardScope(value) {
  const normalized = normalizeText(value).toLowerCase();
  return QUOTE_DASHBOARD_SCOPES.has(normalized) ? normalized : 'active';
}

function normalizeQuoteDashboardMode(value) {
  return normalizeText(value).toLowerCase() === 'edit' ? 'edit' : '';
}

function normalizeDashboardStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return 'all';
  return PROJECT_STATUSES.some((item) => item.key === normalized) ? normalized : 'all';
}

function normalizeDetailTab(value) {
  const normalized = normalizeText(value).toLowerCase();
  return DETAIL_TABS.some((tab) => tab.key === normalized) ? normalized : 'summary';
}

function getStatusMeta(status) {
  return PROJECT_STATUSES.find((item) => item.key === status) || PROJECT_STATUSES[0];
}

function getStatusLabel(status) {
  return getStatusMeta(status).label;
}

function getPriorityMeta(priority) {
  return PROJECT_PRIORITIES.find((item) => item.key === priority) || PROJECT_PRIORITIES[1];
}

function getPriorityLabel(priority) {
  return getPriorityMeta(priority).label;
}

function getScheduleStatusLabel(status) {
  const match = SCHEDULE_STATUSES.find((item) => item.key === status);
  return match ? match.label : 'Pendiente';
}

function getTaskStatusLabel(status) {
  const match = TASK_STATUSES.find((item) => item.key === status);
  return match ? match.label : 'Pendiente';
}

function getExpensePaymentStatusLabel(status) {
  const match = EXPENSE_PAYMENT_STATUSES.find((item) => item.key === status);
  return match ? match.label : 'Pendiente';
}

function getAccountingStatusLabel(status) {
  const match = ACCOUNTING_STATUSES.find((item) => item.key === status);
  return match ? match.label : 'Pendiente de enviar';
}

function getQuoteStatusLabel(status) {
  const match = QUOTE_STATUSES.find((item) => item.key === status);
  return match ? match.label : 'Borrador';
}

function getLogTypeLabel(type) {
  const lookup = {
    project_created: 'Creación',
    project_finalized: 'Cierre',
    status_changed: 'Cambio de estado',
    schedule_created: 'Cronograma',
    task_created: 'Nueva tarea',
    task_completed: 'Tarea finalizada',
    expense_created: 'Gasto',
    expense_updated: 'Gasto editado',
    expense_locked: 'Gasto bloqueado',
    expense_unlocked: 'Gasto desbloqueado',
    expense_sent_accounting: 'Contabilidad',
    quote_created: 'Cotización',
    quote_updated: 'Cotización actualizada',
    quote_status_changed: 'Estado de cotización',
    quote_archived: 'Cotización archivada',
    quote_restored: 'Cotización restaurada',
    quote_converted: 'Facturación',
    file_uploaded: 'Archivo',
    lesson_learned: 'Lección aprendida',
    important_comment: 'Comentario importante',
    manual_note: 'Nota manual'
  };
  return lookup[type] || 'Bitácora';
}

function buildProjectDetailUrl(projectId, tab) {
  return `/projects/${projectId}?tab=${encodeURIComponent(normalizeDetailTab(tab))}`;
}

function buildProjectsDashboardUrl(section, filters = {}) {
  const params = new URLSearchParams();
  if (section) params.set('section', section);
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (!text) return;
    params.set(key, text);
  });
  const queryString = params.toString();
  return queryString ? `/projects?${queryString}` : '/projects';
}

function resolveProjectsReturnTo(value, fallback) {
  const normalized = normalizeText(value);
  if (normalized.startsWith('/projects')) return normalized;
  return fallback;
}

function buildInvoiceNumber(headerId, issueDate) {
  const year = String(issueDate || today()).slice(0, 4);
  return `FAC-${year}-${String(headerId).padStart(6, '0')}`;
}

function daysBetween(from, to) {
  const safeFrom = new Date(from);
  const safeTo = new Date(to);
  return Math.floor((safeTo.getTime() - safeFrom.getTime()) / (24 * 60 * 60 * 1000));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return '';
  return normalized;
}

function uniqueIds(value) {
  return [...new Set(ensureArray(value).map((item) => normalizeId(item)).filter(Boolean))];
}

function normalizeQuoteBulkAction(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'invoice') return 'invoice';
  if (normalized === 'project') return 'project';
  return 'status';
}

function normalizeDate(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function normalizeId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value) {
  return Math.round((toNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function clampPercentage(value) {
  const numeric = toNumber(value, 0);
  if (numeric < 0) return 0;
  if (numeric > 100) return 100;
  return round2(numeric);
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function safeExtension(filename) {
  return path.extname(String(filename || '')).toLowerCase() || '.bin';
}

function getProjectFileFolder(sourceType) {
  const normalized = normalizeText(sourceType).toLowerCase();
  if (normalized === 'task') return 'Tareas';
  if (normalized === 'expense') return 'Gastos';
  if (normalized === 'quote') return 'Cotizaciones';
  return 'Proyecto';
}

async function createProjectFileRecord({
  db,
  projectId,
  companyId,
  file,
  userId,
  notes,
  sourceType = 'project',
  sourceId = null,
  sourceLabel = ''
}) {
  if (!file) return null;
  return runDb(
    db,
    `INSERT INTO project_files
     (project_id, company_id, filename, original_name, file_type, uploaded_by, uploaded_at, notes, source_type, source_id, source_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      projectId,
      companyId,
      normalizeStoredPath(file.path),
      file.originalname || file.filename,
      normalizeText(file.mimetype) || safeExtension(file.originalname),
      userId,
      normalizeText(notes),
      normalizeText(sourceType) || 'project',
      normalizeId(sourceId),
      normalizeText(sourceLabel)
    ]
  );
}

function getUserId(req) {
  return req && req.session && req.session.user ? req.session.user.id : null;
}

function ensureDir(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

async function ensureColumns(db, tableName, columns) {
  for (let index = 0; index < columns.length; index += 1) {
    const [columnName, typeDef] = columns[index];
    await ensureColumn(db, tableName, columnName, typeDef);
  }
}

async function ensureColumn(db, tableName, columnName, typeDef) {
  const info = await allDb(db, `PRAGMA table_info(${tableName})`);
  if ((info || []).some((column) => column.name === columnName)) return;
  await runDb(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${typeDef}`);
}

async function appendModuleToJsonColumn(db, tableName, columnName, moduleCode) {
  const table = await getDb(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  if (!table) return;
  const rows = await allDb(db, `SELECT rowid AS row_id, ${columnName} AS modules_json FROM ${tableName}`);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const current = parseJsonList(row.modules_json);
    if (!current.length) continue;
    if (current.includes(moduleCode)) continue;
    current.push(moduleCode);
    await runDb(
      db,
      `UPDATE ${tableName} SET ${columnName} = ? WHERE rowid = ?`,
      [JSON.stringify(current), row.row_id]
    );
  }
}

function parseJsonList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function canLockProjectExpenses(req) {
  const role = normalizeText(req && req.session && req.session.user && req.session.user.role).toLowerCase();
  return EXPENSE_LOCK_ROLES.has(role);
}

function isExpenseLocked(expense) {
  return Boolean(expense && Number(expense.is_locked || 0) === 1);
}

async function getProjectExpenseById(db, companyId, projectId, expenseId) {
  if (!companyId || !projectId || !expenseId) return null;
  return getDb(
    db,
    `SELECT *
     FROM project_expenses
     WHERE id = ? AND project_id = ? AND company_id = ?`,
    [expenseId, projectId, companyId]
  );
}

async function auditProjectExpenseAction({ logAction, req, companyId, action, expense, extra }) {
  if (typeof logAction !== 'function') return;
  logAction(
    getUserId(req),
    action,
    JSON.stringify({
      expense_id: expense && expense.id,
      description: expense && expense.description,
      ...extra
    }),
    companyId
  );
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
    db.run(sql, params, function onRun(error) {
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

module.exports = {
  registerProjectRoutes
};
