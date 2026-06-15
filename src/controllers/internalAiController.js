const path = require('path');
const internalAiService = require('../services/internalAiService');
const aiService = require('../ai/aiService');
const { buildToolContext } = require('../ai/permissions');

function registerInternalAiRoutes(app, deps) {
  const schemaReady = internalAiService.ensureSchema(deps.db).catch((err) => console.error('[ai-internal] schema initialization failed', err));
  const enterpriseSchemaReady = aiService.ensureSchema(deps.db).catch((err) => console.error('[ai] schema initialization failed', err));
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const jsonRoute = (handler) => asyncRoute(async (req, res) => {
    try {
      await schemaReady;
      return await handler(req, res);
    } catch (err) {
      const statusCode = Number(err.statusCode || 500);
      return res.status(statusCode >= 400 ? statusCode : 500).json({ ok: false, error: err.message || String(err) });
    }
  });

  function context(req) {
    return buildToolContext(req, deps);
  }

  function requireJsonAuth(req, res, next) {
    if (!req.session || !req.session.user || !deps.getCompanyId(req)) {
      return res.status(401).json({ ok: false, error: 'Sesión requerida.' });
    }
    if (!req.user) req.user = req.session.user;
    return next();
  }

  function hasAiAccess(req, action) {
    const map = req.session ? req.session.permissionMap : null;
    return deps.hasPermission(map, 'ai_internal', action) || deps.hasPermission(map, 'ai_empresarial', 'view');
  }

  function requireAiPage(req, res, next) {
    if (!req.session || !req.session.user || !deps.getCompanyId(req)) return res.redirect('/login');
    if (!hasAiAccess(req, 'ai_view')) return res.status(403).send('Forbidden');
    if (!req.user) req.user = req.session.user;
    return next();
  }

  function requireJsonAi(action) {
    return (req, res, next) => {
      if (!hasAiAccess(req, action)) return res.status(403).json({ ok: false, error: 'No tienes permiso para usar el Asistente.' });
      return next();
    };
  }

  function isGenericInternalAnswer(result) {
    const answer = String(result && result.answer ? result.answer : '').toLowerCase();
    return !result || (!result.intent && answer.includes('solo puedo ayudarte con informaci'));
  }

  function canFallbackToEnterprise(err) {
    const message = String(err && err.message ? err.message : '').toLowerCase();
    if (message.includes('no puedo ejecutar sql') || message.includes('comandos enviados')) return false;
    return Number(err && err.statusCode) === 400 || message.includes('solo puedo ayudarte con informaci');
  }

  function normalizeEnterpriseResponse(result) {
    const table = extractToolTable(result && result.tool_results);
    return {
      ok: true,
      answer: result && result.answer ? result.answer : 'Sin respuesta.',
      summary: result && result.answer ? result.answer : '',
      intent: null,
      rows: table.rows,
      columns: table.columns,
      totals: {},
      conversation_id: result && result.conversation ? result.conversation.id : null,
      tool_results: result && result.tool_results ? result.tool_results : [],
      provider: result && result.provider ? result.provider : 'ai_empresarial'
    };
  }

  function extractToolTable(toolResults) {
    const empty = { rows: [], columns: [] };
    if (!Array.isArray(toolResults)) return empty;
    for (const item of toolResults) {
      const result = item && item.result;
      const rows = findRows(result);
      if (rows.length) return { rows, columns: Object.keys(rows[0] || {}) };
    }
    return empty;
  }

  function findRows(value) {
    if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object');
    if (!value || typeof value !== 'object') return [];
    const preferredKeys = ['rows', 'clientes', 'facturas', 'productos', 'paquetes', 'proveedores', 'empleados', 'proyectos', 'ventas', 'cotizaciones', 'tareas'];
    for (const key of preferredKeys) {
      if (Array.isArray(value[key])) return value[key].filter((row) => row && typeof row === 'object');
    }
    return [];
  }

  async function askWithEnterpriseFallback(req, preferEnterprise) {
    const ctx = context(req);
    const question = req.body && (req.body.question || req.body.message || req.body.content);
    if (!preferEnterprise) {
      try {
        const internal = await internalAiService.ask(deps.db, ctx, question);
        if (!isGenericInternalAnswer(internal)) return internal;
      } catch (err) {
        if (!canFallbackToEnterprise(err)) throw err;
      }
    }
    await enterpriseSchemaReady;
    const enterprise = await aiService.sendMessage(deps.db, ctx, {
      conversationId: req.body && req.body.conversation_id,
      content: question,
      clientCompanyId: req.body && req.body.company_id,
      clientUserId: req.body && req.body.user_id
    });
    if (enterprise && enterprise.ok === false) {
      const error = new Error(enterprise.error || 'No se pudo completar la consulta.');
      error.statusCode = 500;
      throw error;
    }
    return normalizeEnterpriseResponse(enterprise);
  }

  app.get('/ai', deps.requireAuth, requireAiPage, asyncRoute(async (req, res) => {
    await schemaReady;
    const ctx = context(req);
    const [history, cards] = await Promise.all([
      internalAiService.listHistory(deps.db, ctx),
      internalAiService.dashboard(deps.db, ctx)
    ]);
    return res.render('ai/index', {
      title: 'Asistente',
      currentModule: 'ai_internal',
      csrfToken: res.locals.csrfToken,
      history,
      cards,
      companyId: ctx.companyId,
      userId: ctx.userId
    });
  }));

  app.get('/settings/ai', deps.requireAuth, deps.requirePermission('settings', 'manage'), asyncRoute(async (req, res) => {
    await schemaReady;
    const ctx = context(req);
    const intents = await internalAiService.listIntents(deps.db, ctx);
    return res.render('settings-ai', {
      title: 'Ajustes del asistente',
      currentModule: 'settings',
      csrfToken: res.locals.csrfToken,
      intents
    });
  }));

  app.post('/ai/ask', requireJsonAuth, requireJsonAi('ai_ask'), jsonRoute(async (req, res) => {
    const result = await askWithEnterpriseFallback(req, false);
    return res.json(result);
  }));

  app.post('/ai/export', requireJsonAuth, requireJsonAi('ai_export'), jsonRoute(async (req, res) => {
    const body = req.body || {};
    const result = await internalAiService.generateExport(deps.db, context(req), body.intent, body.format, body.question);
    return res.json(result);
  }));

  app.get('/ai/history', requireJsonAuth, requireJsonAi('ai_view'), jsonRoute(async (req, res) => {
    return res.json({ ok: true, history: await internalAiService.listHistory(deps.db, context(req)) });
  }));

  app.get('/ai/intents', requireJsonAuth, requireJsonAi('ai_view'), jsonRoute(async (req, res) => {
    return res.json({ ok: true, intents: await internalAiService.listIntents(deps.db, context(req)) });
  }));

  app.post('/ai/intents/:id/toggle', requireJsonAuth, requireJsonAi('ai_admin_intents'), jsonRoute(async (req, res) => {
    return res.json(await internalAiService.toggleIntent(deps.db, context(req), req.params.id));
  }));

  app.get('/ai/download/:company/:file', deps.requireAuth, requireAiPage, asyncRoute(async (req, res) => {
    const ctx = context(req);
    const companySegment = `company-${ctx.companyId}`;
    if (req.params.company !== companySegment) return res.status(403).send('Forbidden');
    const fileName = path.basename(req.params.file || '');
    if (!/^[a-z0-9_-]+-\d+\.(xlsx|csv|pdf)$/i.test(fileName)) return res.status(400).send('Archivo inválido');
    const filePath = path.join(process.cwd(), 'data', 'uploads', 'ai', companySegment, fileName);
    return res.download(filePath, fileName);
  }));

  app.get('/ai/health', jsonRoute(async (req, res) => res.json({ ok: true, provider: 'internal', internet: false })));

  app.post('/ai/chat', requireJsonAuth, requireJsonAi('ai_ask'), jsonRoute(async (req, res) => {
    const result = await askWithEnterpriseFallback(req, true);
    return res.json({ ok: true, answer: result.answer, intent: result.intent, rows: result.rows, columns: result.columns, totals: result.totals, conversation_id: result.conversation_id, tool_results: result.tool_results });
  }));

  app.post('/ai/messages', requireJsonAuth, requireJsonAi('ai_ask'), jsonRoute(async (req, res) => {
    const result = await askWithEnterpriseFallback(req, true);
    return res.json({ ok: true, answer: result.answer, intent: result.intent, rows: result.rows, columns: result.columns, totals: result.totals, conversation_id: result.conversation_id, tool_results: result.tool_results });
  }));
}

module.exports = { registerInternalAiRoutes };
