const aiService = require('./aiService');
const { buildToolContext } = require('./permissions');
const { loadTools } = require('./toolRegistry');

function registerAiRoutes(app, deps) {
  aiService.ensureSchema(deps.db).catch((err) => console.error('[ai] schema initialization failed', err));

  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const asyncJsonRoute = (handler) => asyncRoute(async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      console.error('[AI ERROR]', err);
      const statusCode = err.statusCode && Number(err.statusCode) >= 400 ? Number(err.statusCode) : 500;
      return res.status(statusCode).json({
        ok: false,
        error: publicErrorMessage(err, 'No se pudo procesar la solicitud de IA.'),
        code: err.code || null,
        provider_error: err.providerError || null
      });
    }
  });

  function getMessageInput(req) {
    const body = req.body || {};
    return body.message || body.content || body.question || '';
  }

  function logRequestContext(req, context, message) {
    const tools = Array.from(loadTools().values());
    console.log('[AI] mensaje recibido:', message);
    console.log('[AI] user:', context.user && context.user.id ? context.user.id : context.userId);
    console.log('[AI] companyId:', context.companyId);
    console.log('[AI] tools cargadas:', tools.length);
  }

  function requireJsonAuth(req, res, next) {
    if (!req.session || !req.session.user || !deps.getCompanyId(req)) {
      return res.status(401).json({ ok: false, error: 'Sesion requerida.' });
    }
    if (!req.user) req.user = req.session.user;
    return next();
  }

  function requireJsonPermission(moduleCode, actionCode) {
    return (req, res, next) => {
      const map = req.session ? req.session.permissionMap : null;
      if (!deps.hasPermission(map, moduleCode, actionCode)) {
        return res.status(403).json({ ok: false, error: 'No tienes permisos para consultar esa información.' });
      }
      return next();
    };
  }

  app.get('/ai/health', asyncJsonRoute(async (req, res) => res.json({
    ok: true,
    aiEnabled: aiService.isEnabled(),
    model: aiService.getModel(),
    apiKeyConfigured: aiService.hasApiKey()
  })));

  app.get('/ai/test-openai', asyncJsonRoute(async (req, res) => {
    const answer = await aiService.testOpenAI();
    return res.json({ ok: true, answer });
  }));

  app.get('/ai/token', deps.requireAuth, (req, res) => {
    return res.json({ token: req.csrfToken() });
  });

  app.get('/ai/context', requireJsonAuth, (req, res) => {
    const context = buildToolContext(req, deps);
    return res.json({
      enabled: aiService.isEnabled(),
      permissions: req.session.permissionMap || null,
      tools: Array.from(loadTools().values()).map((tool) => ({ name: tool.name, module: tool.permission && tool.permission[0] })).filter(Boolean),
      company_id: context.companyId,
      user_id: context.userId
    });
  });

  app.get('/ai', deps.requireAuth, deps.requirePermission('ai_empresarial', 'view'), asyncRoute(async (req, res) => {
    const context = buildToolContext(req, deps);
    const conversations = await aiService.listConversations(deps.db, context);
    const activeId = Number(req.query.conversation_id || (conversations[0] && conversations[0].id) || 0);
    const messages = activeId ? await aiService.getMessages(deps.db, context, activeId) : [];
    return res.render('ai/index', {
      title: 'Asistente',
      currentModule: 'ai_empresarial',
      csrfToken: res.locals.csrfToken,
      conversations,
      activeConversationId: activeId || null,
      messages,
      aiEnabled: aiService.isEnabled(),
      apiKeyConfigured: aiService.hasApiKey(),
      aiModel: aiService.getModel(),
      companyId: context.companyId,
      userId: context.userId
    });
  }));

  app.get('/ai/conversations', requireJsonAuth, requireJsonPermission('ai_empresarial', 'view'), asyncRoute(async (req, res) => {
    const context = buildToolContext(req, deps);
    return res.json({ ok: true, conversations: await aiService.listConversations(deps.db, context) });
  }));

  app.post('/ai/conversations', requireJsonAuth, requireJsonPermission('ai_empresarial', 'view'), asyncJsonRoute(async (req, res) => {
    const context = buildToolContext(req, deps);
    const conversation = await aiService.createConversation(deps.db, context, req.body && req.body.title);
    return res.json({ ok: true, conversation });
  }));

  app.get('/ai/conversations/:id/messages', requireJsonAuth, requireJsonPermission('ai_empresarial', 'view'), asyncRoute(async (req, res) => {
    const context = buildToolContext(req, deps);
    return res.json({ ok: true, messages: await aiService.getMessages(deps.db, context, Number(req.params.id)) });
  }));

  app.post('/ai/messages', requireJsonAuth, requireJsonPermission('ai_empresarial', 'view'), asyncJsonRoute(async (req, res) => {
    const context = buildToolContext(req, deps);
    const message = getMessageInput(req);
    logRequestContext(req, context, message);
    const result = await aiService.sendMessage(deps.db, context, {
      conversationId: req.body.conversation_id,
      content: message,
      clientCompanyId: req.body.company_id,
      clientUserId: req.body.user_id
    });
    if (result && result.ok === false) return res.status(500).json({ ok: false, error: result.error });
    return res.json({ ok: true, ...result });
  }));

  app.post('/ai/chat', requireJsonAuth, requireJsonPermission('ai_empresarial', 'view'), asyncJsonRoute(async (req, res) => {
    const context = buildToolContext(req, deps);
    const message = getMessageInput(req);
    logRequestContext(req, context, message);
    const result = await aiService.sendMessage(deps.db, context, {
      conversationId: req.body.conversation_id,
      content: message,
      clientCompanyId: req.body.company_id,
      clientUserId: req.body.user_id
    });
    if (result && result.ok === false) {
      return res.status(500).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      answer: result.answer,
      conversation_id: result.conversation.id,
      tool_results: result.tool_results
    });
  }));
}

module.exports = { registerAiRoutes };
const { publicErrorMessage } = require('../core/public-error');
