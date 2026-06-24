const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encryptToken, decryptToken, maskToken } = require('./crypto');
const { buildMensajeriaMetaTabs } = require('../mensajeria-meta/routes');
const {
  buildFacebookOAuthUrl,
  exchangeOAuthCode,
  exchangeLongLivedUserToken,
  getUserPages,
  getPageInfo,
  subscribePageToApp,
  sendMessengerText,
  replyToComment,
  scrubToken,
  getGraphVersion
} = require('./meta-graph');
const { verifyMetaSignature, processMetaWebhook, insertMessage } = require('./webhook');

let schemaReadyPromise = null;

function registerMetaInboxRoutes(app, deps) {
  const { db, requireAuth, requirePermission, csrfMiddleware, getCompanyId, setFlash, logAction } = deps;
  schemaReadyPromise = ensureMetaInboxSchema(db);
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.get('/webhooks/meta', (req, res) => {
    const mode = clean(req.query['hub.mode']);
    const token = clean(req.query['hub.verify_token']);
    const challenge = clean(req.query['hub.challenge']);
    if (mode === 'subscribe' && token && token === clean(process.env.META_VERIFY_TOKEN)) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  app.post('/webhooks/meta', asyncRoute(async (req, res) => {
    await schemaReadyPromise;
    const signatureValid = verifyMetaSignature(req);
    if (!signatureValid) {
      await logWebhookFailure(db, req.body, 'invalid_signature');
      return res.sendStatus(403);
    }
    res.sendStatus(200);
    processMetaWebhook(db, req.body, signatureValid).catch((error) => {
      console.error('[meta-inbox] webhook processing failed', scrubToken(error.message));
    });
  }));

  app.get('/meta-inbox', requireAuth, requirePermission('meta_inbox', 'view'), asyncRoute(async (req, res) => {
    await schemaReadyPromise;
    const companyId = getCompanyId(req);
    const filters = normalizeInboxFilters(req.query);
    const selectedId = parseId(req.query.conversation || req.query.id);
    const [pages, users, tags, conversations, quickReplies] = await Promise.all([
      listPages(db, companyId),
      listUsers(db, companyId),
      listTags(db, companyId),
      listConversations(db, companyId, filters),
      listQuickReplies(db, companyId)
    ]);
    const selected = conversations.find((row) => Number(row.id) === selectedId) || conversations[0] || null;
    const bundle = selected ? await getConversationBundle(db, companyId, selected.id) : null;
    res.render('meta-inbox/index', {
      lang: res.locals.lang,
      csrfToken: res.locals.csrfToken,
      currentModule: 'mensajeria_meta',
      moduleTabs: buildTabs('inbox'),
      activeTab: 'inbox',
      filters,
      pages,
      users,
      tags,
      conversations,
      selectedConversation: bundle ? bundle.conversation : null,
      messages: bundle ? bundle.messages : [],
      notes: bundle ? bundle.notes : [],
      quickReplies,
      canReply: can(req, 'reply'),
      canAssign: can(req, 'assign'),
      canClose: can(req, 'close')
    });
  }));

  app.get('/meta-inbox/settings', requireAuth, requirePermission('meta_inbox', 'settings'), asyncRoute(async (req, res) => {
    await schemaReadyPromise;
    const companyId = getCompanyId(req);
    const [connection, pages] = await Promise.all([getConnection(db, companyId), listPages(db, companyId)]);
    res.render('meta-inbox/settings', {
      lang: res.locals.lang,
      csrfToken: res.locals.csrfToken,
      currentModule: 'mensajeria_meta',
      moduleTabs: buildTabs('settings'),
      activeTab: 'settings',
      connection: publicConnection(connection),
      pages,
      graphVersion: getGraphVersion(),
      appId: process.env.META_APP_ID || '',
      callbackUrl: `${clean(process.env.BASE_URL).replace(/\/$/, '') || 'https://MI-DOMINIO.com'}/webhooks/meta`,
      oauthRedirectUrl: getMetaOAuthRedirectUrl(req),
      oauthReady: Boolean(clean(process.env.META_APP_ID) && clean(process.env.META_APP_SECRET) && getPublicBaseUrl(req)),
      verifyTokenConfigured: Boolean(clean(process.env.META_VERIFY_TOKEN))
    });
  }));

  app.get('/meta-inbox/connect/facebook', requireAuth, requirePermission('meta_inbox', 'settings'), asyncRoute(async (req, res) => {
    await schemaReadyPromise;
    const appId = clean(process.env.META_APP_ID);
    const appSecret = clean(process.env.META_APP_SECRET);
    const redirectUri = getMetaOAuthRedirectUrl(req);
    if (!appId || !appSecret || !redirectUri) {
      setFlash(req, 'error', 'Configura META_APP_ID, META_APP_SECRET y BASE_URL publico antes de conectar Facebook.');
      return res.redirect('/meta-inbox/settings');
    }
    const state = crypto.randomBytes(24).toString('hex');
    req.session.metaOAuth = {
      state,
      companyId: getCompanyId(req),
      createdAt: Date.now()
    };
    const url = buildFacebookOAuthUrl({
      appId,
      redirectUri,
      state,
      scopes: getMetaOAuthScopes()
    });
    return res.redirect(url);
  }));

  app.get('/meta-inbox/oauth/callback', requireAuth, requirePermission('meta_inbox', 'settings'), asyncRoute(async (req, res) => {
    await schemaReadyPromise;
    const oauth = req.session.metaOAuth || {};
    delete req.session.metaOAuth;
    const companyId = getCompanyId(req);
    const expectedCompanyId = Number(oauth.companyId) || 0;
    const stateFresh = oauth.createdAt && Date.now() - Number(oauth.createdAt) <= 10 * 60 * 1000;
    if (!oauth.state || oauth.state !== clean(req.query.state) || expectedCompanyId !== companyId || !stateFresh) {
      setFlash(req, 'error', 'La conexion con Facebook expiro o no coincide con esta sesion. Intenta de nuevo.');
      return res.redirect('/meta-inbox/settings');
    }
    if (req.query.error || req.query.error_message) {
      setFlash(req, 'error', `Facebook cancelo la conexion: ${clean(req.query.error_message || req.query.error_description || req.query.error)}`);
      return res.redirect('/meta-inbox/settings');
    }
    const code = clean(req.query.code);
    if (!code) {
      setFlash(req, 'error', 'Facebook no devolvio un codigo de autorizacion.');
      return res.redirect('/meta-inbox/settings');
    }
    try {
      const appId = clean(process.env.META_APP_ID);
      const appSecret = clean(process.env.META_APP_SECRET);
      const redirectUri = getMetaOAuthRedirectUrl(req);
      const tokenResult = await exchangeOAuthCode({ appId, appSecret, redirectUri, code });
      const shortToken = clean(tokenResult.access_token);
      if (!shortToken) throw new Error('meta_oauth_token_missing');
      let token = shortToken;
      try {
        const longResult = await exchangeLongLivedUserToken({ appId, appSecret, accessToken: shortToken });
        token = clean(longResult.access_token) || shortToken;
      } catch (error) {
        console.warn('[meta-inbox] long lived token exchange failed', scrubToken(error.message));
      }
      const data = await getUserPages(token);
      const pages = Array.isArray(data.data) ? data.data : [];
      const connectionId = await upsertConnection(db, companyId, encryptToken(token), 'oauth_user', 'connected');
      let subscriptions = 0;
      for (const page of pages) {
        await upsertPage(db, companyId, connectionId, page);
        if (await trySubscribePage(page)) subscriptions += 1;
      }
      setFlash(req, 'info', `Facebook conectado. Paginas detectadas: ${pages.length}. Suscritas al webhook: ${subscriptions}. Activa las paginas que usaras.`);
      audit(logAction, req, companyId, 'meta_inbox_oauth_connect', { pages: pages.length, subscriptions });
    } catch (error) {
      const message = scrubToken(error.message).slice(0, 500);
      await upsertConnection(db, companyId, '', 'oauth_user', 'error');
      await logWebhookFailure(db, { error: message }, 'oauth_connect_error', companyId);
      setFlash(req, 'error', `No se pudo conectar Facebook: ${message}`);
    }
    return res.redirect('/meta-inbox/settings');
  }));

  app.post('/meta-inbox/settings/test', requireAuth, requirePermission('meta_inbox', 'settings'), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReadyPromise;
    const companyId = getCompanyId(req);
    const userToken = clean(req.body.user_access_token);
    const existing = await getConnection(db, companyId);
    const token = userToken || (existing ? decryptToken(existing.access_token_encrypted) : '');
    if (!token) {
      setFlash(req, 'error', 'Ingresa un token oficial de Meta para listar paginas.');
      return res.redirect('/meta-inbox/settings');
    }
    try {
      const data = await getUserPages(token);
      const pages = Array.isArray(data.data) ? data.data : [];
      const connectionId = await upsertConnection(db, companyId, userToken ? encryptToken(userToken) : existing.access_token_encrypted, 'user', 'connected');
      let subscriptions = 0;
      for (const page of pages) {
        await upsertPage(db, companyId, connectionId, page);
        if (await trySubscribePage(page)) subscriptions += 1;
      }
      setFlash(req, 'info', `Conexion probada. Paginas detectadas: ${pages.length}. Suscritas al webhook: ${subscriptions}.`);
      audit(logAction, req, companyId, 'meta_inbox_connection_test', { pages: pages.length, subscriptions });
    } catch (error) {
      const message = scrubToken(error.message).slice(0, 500);
      await upsertConnection(db, companyId, userToken ? encryptToken(userToken) : existing && existing.access_token_encrypted, 'user', 'error');
      await logWebhookFailure(db, { error: message }, 'connection_test_error', companyId);
      setFlash(req, 'error', `No se pudo conectar con Meta: ${message}`);
    }
    return res.redirect('/meta-inbox/settings');
  }));

  app.post('/meta-inbox/pages/:id/activate', requireAuth, requirePermission('meta_inbox', 'settings'), csrfMiddleware, asyncRoute(async (req, res) => {
    await setPageActive(db, getCompanyId(req), parseId(req.params.id), 1);
    setFlash(req, 'info', 'Pagina activada.');
    res.redirect('/meta-inbox/settings');
  }));

  app.post('/meta-inbox/pages/:id/deactivate', requireAuth, requirePermission('meta_inbox', 'settings'), csrfMiddleware, asyncRoute(async (req, res) => {
    await setPageActive(db, getCompanyId(req), parseId(req.params.id), 0);
    setFlash(req, 'info', 'Pagina desactivada.');
    res.redirect('/meta-inbox/settings');
  }));

  app.get('/meta-inbox/conversations/:id', requireAuth, requirePermission('meta_inbox', 'view'), asyncRoute(async (req, res) => {
    res.redirect(`/meta-inbox?conversation=${parseId(req.params.id)}`);
  }));

  app.post('/meta-inbox/conversations/:id/send', requireAuth, requirePermission('meta_inbox', 'reply'), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReadyPromise;
    const companyId = getCompanyId(req);
    const userId = currentUserId(req);
    const conversationId = parseId(req.params.id);
    const body = clean(req.body.body);
    if (!body) {
      setFlash(req, 'error', 'Escribe una respuesta.');
      return res.redirect(`/meta-inbox?conversation=${conversationId}`);
    }
    const conversation = await getConversation(db, companyId, conversationId);
    if (!conversation) return res.status(404).send('Conversacion no encontrada.');
    const page = await getPageForConversation(db, companyId, conversation);
    let providerMessageId = null;
    let status = 'sent';
    let errorMessage = null;
    try {
      if (conversation.conversation_type === 'comment') {
        const result = await replyToComment(page, conversation.comment_id, body);
        providerMessageId = clean(result.id);
      } else if (conversation.conversation_type === 'lead') {
        throw new Error('Los leads no tienen un canal de respuesta directo. Asigna el lead a un vendedor.');
      } else {
        const result = await sendMessengerText(page, conversation.customer_id, body);
        providerMessageId = clean(result.message_id) || clean(result.recipient_id);
      }
    } catch (error) {
      status = 'failed';
      errorMessage = scrubToken(error.message).slice(0, 1000);
    }
    await insertMessage(db, {
      companyId,
      conversationId,
      metaPageId: page ? page.id : null,
      direction: 'outbound',
      messageType: conversation.conversation_type === 'comment' ? 'comment_reply' : 'text',
      body,
      messageId: providerMessageId || null,
      senderId: conversation.page_id,
      recipientId: conversation.customer_id,
      commentId: conversation.comment_id,
      postId: conversation.post_id,
      payload: { providerMessageId, errorMessage },
      status,
      createdBy: userId
    });
    audit(logAction, req, companyId, 'meta_inbox_reply', { conversationId, status });
    if (errorMessage) setFlash(req, 'error', `Meta no acepto la respuesta: ${errorMessage}`);
    return res.redirect(`/meta-inbox?conversation=${conversationId}`);
  }));

  app.post('/meta-inbox/conversations/:id/assign', requireAuth, requirePermission('meta_inbox', 'assign'), csrfMiddleware, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const conversationId = parseId(req.params.id);
    const assignedUserId = parseId(req.body.assigned_user_id) || null;
    await runDb(db, 'UPDATE conversations SET assigned_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [assignedUserId, conversationId, companyId]);
    await runDb(db, 'INSERT INTO conversation_assignments (company_id, conversation_id, assigned_user_id, assigned_by, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', [companyId, conversationId, assignedUserId, currentUserId(req)]);
    await runDb(db, 'UPDATE lead_entries SET assigned_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND company_id = ?', [assignedUserId, conversationId, companyId]);
    audit(logAction, req, companyId, 'meta_inbox_assign', { conversationId, assignedUserId });
    setFlash(req, 'info', 'Conversacion asignada.');
    res.redirect(`/meta-inbox?conversation=${conversationId}`);
  }));

  app.post('/meta-inbox/conversations/:id/status', requireAuth, requirePermission('meta_inbox', 'close'), csrfMiddleware, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const conversationId = parseId(req.params.id);
    const status = normalizeStatus(req.body.status);
    await runDb(
      db,
      `UPDATE conversations
       SET status = ?,
           closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE NULL END,
           closed_by = CASE WHEN ? = 'closed' THEN ? ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [status, status, status, currentUserId(req), conversationId, companyId]
    );
    audit(logAction, req, companyId, 'meta_inbox_status', { conversationId, status });
    setFlash(req, 'info', 'Estado actualizado.');
    res.redirect(`/meta-inbox?conversation=${conversationId}`);
  }));

  app.post('/meta-inbox/conversations/:id/notes', requireAuth, requirePermission('meta_inbox', 'view'), csrfMiddleware, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const conversationId = parseId(req.params.id);
    const note = clean(req.body.note);
    if (note) {
      await runDb(db, 'INSERT INTO conversation_notes (company_id, conversation_id, note, created_by, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', [companyId, conversationId, note, currentUserId(req)]);
      audit(logAction, req, companyId, 'meta_inbox_note', { conversationId });
    }
    res.redirect(`/meta-inbox?conversation=${conversationId}`);
  }));

  app.post('/meta-inbox/conversations/:id/tags', requireAuth, requirePermission('meta_inbox', 'view'), csrfMiddleware, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    const conversationId = parseId(req.params.id);
    const label = clean(req.body.label);
    const color = clean(req.body.color) || '#2563eb';
    if (label) await runDb(db, 'INSERT INTO conversation_tags (company_id, conversation_id, label, color, created_by, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', [companyId, conversationId, label, color, currentUserId(req)]);
    res.redirect(`/meta-inbox?conversation=${conversationId}`);
  }));

  app.post('/meta-inbox/quick-replies', requireAuth, requirePermission('meta_inbox', 'reply'), csrfMiddleware, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    await runDb(db, 'INSERT INTO quick_replies (company_id, title, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [companyId, clean(req.body.title), clean(req.body.body), currentUserId(req)]);
    setFlash(req, 'info', 'Respuesta rapida guardada.');
    res.redirect('/meta-inbox');
  }));

  app.put('/meta-inbox/quick-replies/:id', requireAuth, requirePermission('meta_inbox', 'reply'), csrfMiddleware, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    await runDb(db, 'UPDATE quick_replies SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [clean(req.body.title), clean(req.body.body), parseId(req.params.id), companyId]);
    res.json({ ok: true });
  }));

  app.delete('/meta-inbox/quick-replies/:id', requireAuth, requirePermission('meta_inbox', 'reply'), csrfMiddleware, asyncRoute(async (req, res) => {
    const companyId = getCompanyId(req);
    await runDb(db, 'UPDATE quick_replies SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [parseId(req.params.id), companyId]);
    res.json({ ok: true });
  }));
}

async function ensureMetaInboxSchema(db) {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'db', 'migrations', '20260605_meta_inbox.sql'), 'utf8');
  for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
    await runDb(db, statement);
  }
  await runDb(db, "INSERT INTO permission_modules (code, name, description) VALUES ('meta_inbox', 'Centro de Mensajes / Meta Inbox', 'Bandeja oficial para Messenger, comentarios y Lead Ads de Meta') ON CONFLICT (code) DO NOTHING");
  await runDb(db, `INSERT INTO permission_actions (code, name, description) VALUES
    ('reply', 'Responder', 'Responder mensajes y comentarios'),
    ('assign', 'Asignar', 'Asignar conversaciones a usuarios'),
    ('close', 'Cerrar', 'Cambiar estado y cerrar conversaciones'),
    ('settings', 'Configurar Meta', 'Administrar conexion y paginas de Meta'),
    ('leads', 'Leads', 'Gestionar leads de Facebook Lead Ads') ON CONFLICT DO NOTHING`);
  await runDb(db, `INSERT INTO module_actions (module_id, action_id)
    SELECT pm.id, pa.id FROM permission_modules pm, permission_actions pa
    WHERE pm.code = 'meta_inbox' AND pa.code IN ('view','reply','assign','close','settings','leads') ON CONFLICT DO NOTHING`);
}

function listConversations(db, companyId, filters) {
  const where = ['c.company_id = ?'];
  const params = [companyId];
  if (filters.channel !== 'all') {
    where.push('c.channel = ?');
    params.push(filters.channel);
  }
  if (filters.status !== 'all') {
    where.push('c.status = ?');
    params.push(filters.status);
  }
  if (filters.pageId) {
    where.push('c.meta_page_id = ?');
    params.push(filters.pageId);
  }
  if (filters.userId) {
    where.push('c.assigned_user_id = ?');
    params.push(filters.userId);
  }
  if (filters.tag) {
    where.push('EXISTS (SELECT 1 FROM conversation_tags t WHERE t.company_id = c.company_id AND t.conversation_id = c.id AND t.label = ?)');
    params.push(filters.tag);
  }
  if (filters.dateFrom) {
    where.push('CAST(COALESCE(c.last_message_at, c.created_at) AS date) >= CAST(? AS date)');
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push('CAST(COALESCE(c.last_message_at, c.created_at) AS date) <= CAST(? AS date)');
    params.push(filters.dateTo);
  }
  if (filters.q) {
    where.push('(c.customer_name LIKE ? OR c.customer_email LIKE ? OR c.customer_phone LIKE ? OR c.customer_id LIKE ? OR c.last_message LIKE ?)');
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  return allDb(
    db,
    `SELECT c.*, p.page_name, u.username AS assigned_username,
            (SELECT COUNT(*) FROM conversation_messages m WHERE m.company_id = c.company_id AND m.conversation_id = c.id AND m.direction = 'inbound') AS inbound_count,
            (SELECT STRING_AGG(label, '||') FROM conversation_tags t WHERE t.company_id = c.company_id AND t.conversation_id = c.id) AS tag_labels
     FROM conversations c
     LEFT JOIN meta_pages p ON p.id = c.meta_page_id AND p.company_id = c.company_id
     LEFT JOIN users u ON u.id = c.assigned_user_id AND u.company_id = c.company_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(c.last_message_at, c.updated_at, c.created_at) DESC, c.id DESC
     LIMIT 250`,
    params
  );
}

async function getConversationBundle(db, companyId, id) {
  const conversation = await getConversation(db, companyId, id);
  if (!conversation) return null;
  conversation.tags = await allDb(db, 'SELECT * FROM conversation_tags WHERE company_id = ? AND conversation_id = ? ORDER BY created_at ASC', [companyId, id]);
  const [messages, notes] = await Promise.all([
    allDb(db, 'SELECT * FROM conversation_messages WHERE company_id = ? AND conversation_id = ? ORDER BY created_at ASC, id ASC', [companyId, id]),
    allDb(db, `SELECT n.*, u.username FROM conversation_notes n LEFT JOIN users u ON u.id = n.created_by AND u.company_id = n.company_id WHERE n.company_id = ? AND n.conversation_id = ? ORDER BY n.created_at DESC`, [companyId, id])
  ]);
  return { conversation, messages, notes };
}

function getConversation(db, companyId, id) {
  return getDb(
    db,
    `SELECT c.*, p.page_name, p.page_access_token_encrypted, u.username AS assigned_username
     FROM conversations c
     LEFT JOIN meta_pages p ON p.id = c.meta_page_id AND p.company_id = c.company_id
     LEFT JOIN users u ON u.id = c.assigned_user_id AND u.company_id = c.company_id
     WHERE c.id = ? AND c.company_id = ?
     LIMIT 1`,
    [id, companyId]
  );
}

function getPageForConversation(db, companyId, conversation) {
  return getDb(db, 'SELECT * FROM meta_pages WHERE id = ? AND company_id = ? AND is_active = 1 LIMIT 1', [conversation.meta_page_id, companyId]);
}

function listPages(db, companyId) {
  return allDb(
    db,
    `SELECT id, company_id, meta_connection_id, page_id, page_name, permissions, is_active, created_at, updated_at,
            CASE WHEN page_access_token_encrypted IS NOT NULL AND TRIM(page_access_token_encrypted) <> '' THEN 1 ELSE 0 END AS has_page_token
     FROM meta_pages
     WHERE company_id = ?
     ORDER BY page_name COLLATE NOCASE ASC`,
    [companyId]
  );
}

function listUsers(db, companyId) {
  return allDb(db, 'SELECT id, username, role FROM users WHERE company_id = ? AND is_active = 1 ORDER BY username COLLATE NOCASE ASC', [companyId]);
}

function listTags(db, companyId) {
  return allDb(db, 'SELECT label, color, COUNT(*) AS total FROM conversation_tags WHERE company_id = ? GROUP BY label, color ORDER BY label ASC LIMIT 80', [companyId]);
}

function listQuickReplies(db, companyId) {
  return allDb(db, 'SELECT * FROM quick_replies WHERE company_id = ? AND is_active = 1 ORDER BY title COLLATE NOCASE ASC', [companyId]);
}

function getConnection(db, companyId) {
  return getDb(db, 'SELECT * FROM meta_connections WHERE company_id = ? AND provider = ? ORDER BY id DESC LIMIT 1', [companyId, 'facebook']);
}

async function upsertConnection(db, companyId, encryptedToken, tokenType, status) {
  const existing = await getConnection(db, companyId);
  if (existing) {
    await runDb(db, 'UPDATE meta_connections SET access_token_encrypted = COALESCE(NULLIF(?, \'\'), access_token_encrypted), token_type = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [encryptedToken || '', tokenType, status, existing.id, companyId]);
    return existing.id;
  }
  const insert = await runDb(db, 'INSERT INTO meta_connections (company_id, provider, access_token_encrypted, token_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [companyId, 'facebook', encryptedToken || '', tokenType, status]);
  return insert.lastID;
}

async function upsertPage(db, companyId, connectionId, page) {
  const pageId = clean(page.id);
  const pageToken = clean(page.access_token);
  await runDb(
    db,
    `INSERT INTO meta_pages (company_id, meta_connection_id, page_id, page_name, page_access_token_encrypted, permissions, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(company_id, page_id) DO UPDATE SET
       meta_connection_id = excluded.meta_connection_id,
       page_name = excluded.page_name,
       page_access_token_encrypted = CASE WHEN excluded.page_access_token_encrypted IS NOT NULL AND excluded.page_access_token_encrypted <> '' THEN excluded.page_access_token_encrypted ELSE meta_pages.page_access_token_encrypted END,
       permissions = excluded.permissions,
       updated_at = CURRENT_TIMESTAMP`,
    [companyId, connectionId, pageId, clean(page.name), pageToken ? encryptToken(pageToken) : '', JSON.stringify(page.perms || page.tasks || [])]
  );
}

function setPageActive(db, companyId, id, active) {
  return runDb(db, 'UPDATE meta_pages SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [active ? 1 : 0, id, companyId]);
}

async function trySubscribePage(page) {
  const pageToken = clean(page && page.access_token);
  const pageId = clean(page && page.id);
  if (!pageToken || !pageId) return false;
  try {
    await subscribePageToApp(pageToken, pageId);
    return true;
  } catch (error) {
    console.warn('[meta-inbox] page subscription failed', pageId, scrubToken(error.message));
    return false;
  }
}

function publicConnection(connection) {
  if (!connection) return null;
  return {
    ...connection,
    access_token_encrypted: undefined,
    masked_token: maskToken(decryptToken(connection.access_token_encrypted))
  };
}

function normalizeInboxFilters(query) {
  return {
    channel: ['all', 'messenger', 'facebook_comment', 'facebook_lead'].includes(clean(query.channel)) ? clean(query.channel) : 'all',
    status: ['all', 'new', 'open', 'pending', 'closed'].includes(clean(query.status)) ? clean(query.status) : 'all',
    pageId: parseId(query.page_id),
    userId: parseId(query.user_id),
    tag: clean(query.tag),
    dateFrom: clean(query.date_from),
    dateTo: clean(query.date_to),
    q: clean(query.q)
  };
}

function normalizeStatus(value) {
  const normalized = clean(value).toLowerCase();
  return ['new', 'open', 'pending', 'closed'].includes(normalized) ? normalized : 'open';
}

function buildTabs(active) {
  const tabKey = active === 'settings' ? 'meta_settings' : 'meta_inbox';
  return buildMensajeriaMetaTabs(tabKey);
}

function getMetaOAuthScopes() {
  const custom = clean(process.env.META_OAUTH_SCOPES);
  if (custom) {
    return custom.split(',').map((scope) => clean(scope)).filter(Boolean);
  }
  return [
    'pages_show_list',
    'pages_manage_metadata',
    'pages_messaging',
    'pages_read_engagement',
    'pages_manage_engagement',
    'leads_retrieval'
  ];
}

function getMetaOAuthRedirectUrl(req) {
  const explicit = clean(process.env.META_REDIRECT_URI);
  if (explicit) return explicit;
  const baseUrl = getPublicBaseUrl(req);
  return baseUrl ? `${baseUrl}/meta-inbox/oauth/callback` : '';
}

function getPublicBaseUrl(req) {
  const configured = clean(process.env.BASE_URL).replace(/\/$/, '');
  if (configured && !/^https:\/\/MI-DOMINIO\.com$/i.test(configured)) return configured;
  if (req && req.protocol && req.get && req.get('host')) {
    const host = clean(req.get('host'));
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      return `${req.protocol}://${host}`;
    }
  }
  return '';
}

function can(req, action) {
  const map = req.session ? req.session.permissionMap : null;
  if (!map) return false;
  if (map.isAdmin) return true;
  return Boolean(map.modules && map.modules.meta_inbox && map.modules.meta_inbox[action]);
}

function audit(logAction, req, companyId, action, details) {
  if (typeof logAction === 'function') {
    logAction(currentUserId(req), action, JSON.stringify(details || {}), companyId);
  }
}

function logWebhookFailure(db, payload, eventType, companyId) {
  return runDb(
    db,
    `INSERT INTO meta_webhook_events (company_id, event_type, payload_json, signature_valid, error_message, created_at)
     VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`,
    [companyId || null, eventType || 'webhook_error', JSON.stringify(payload || {}), eventType || 'webhook_error']
  ).catch((error) => console.error('[meta-inbox] failed to log webhook failure', error.message));
}

function currentUserId(req) {
  return Number(req.session && req.session.user && req.session.user.id) || null;
}

function parseId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function allDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

module.exports = {
  registerMetaInboxRoutes
};
