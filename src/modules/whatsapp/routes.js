const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const multer = require('multer');
const { buildMensajeriaMetaTabs } = require('../mensajeria-meta/routes');
const { STORAGE_UPLOADS_DIR } = require('../../core/storage-paths');

const WHATSAPP_ATTACHMENT_LIMIT_BYTES = 16 * 1024 * 1024;
const META_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v19.0';
const TOKEN_ALGORITHM = 'aes-256-gcm';
const VALID_PROVIDERS = new Set(['official_api', 'qr_web']);
const VALID_ACCOUNT_STATUSES = new Set(['disconnected', 'connected', 'error', 'pending']);
const VALID_CONVERSATION_STATUSES = new Set(['open', 'pending', 'closed']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_MESSAGE_TYPES = new Set(['text', 'image', 'document', 'audio', 'video', 'location', 'template', 'button']);
const VALID_MESSAGE_STATUSES = new Set(['received', 'sent', 'delivered', 'read', 'failed']);

let isWhatsappSchemaInitialized = false;

function registerWhatsappRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    csrfMiddleware,
    getCompanyId,
    setFlash,
    logAction
  } = deps;

  const schemaReady = ensureWhatsappSchema(db).catch((error) => {
    console.error('[whatsapp] schema initialization failed', error);
    throw error;
  });

  const uploadRoot = path.resolve(path.join(STORAGE_UPLOADS_DIR, 'whatsapp'));
  ensureDir(uploadRoot);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadRoot),
      filename: (req, file, cb) => {
        const ext = safeExtension(file && file.originalname);
        cb(null, `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`);
      }
    }),
    limits: { fileSize: WHATSAPP_ATTACHMENT_LIMIT_BYTES },
    fileFilter: (req, file, cb) => cb(null, true)
  });

  const asyncRoute = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

  app.get(
    '/whatsapp',
    requireAuth,
    requirePermission('whatsapp', 'view'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const user = req.session.user || {};
      const filter = normalizeConversationFilter(req.query.filter);
      const search = clean(req.query.q);
      const conversationId = parseId(req.query.conversation || req.query.id);
      const access = resolveWhatsappAccess(req);
      const [account, conversations, users, tags] = await Promise.all([
        getAccount(db, companyId),
        listConversations(db, companyId, user.id, access, filter, search),
        listAssignableUsers(db, companyId),
        listCompanyTags(db, companyId)
      ]);

      const selectedConversation = conversations.find((row) => Number(row.id) === conversationId) || conversations[0] || null;
      const bundle = selectedConversation
        ? await getConversationBundle(db, companyId, selectedConversation.id, user.id, access)
        : null;
      const templates = await listTemplates(db, companyId);

      return res.render('whatsapp/index', {
        lang: res.locals.lang,
        csrfToken: res.locals.csrfToken,
        currentModule: 'mensajeria_meta',
        moduleTabs: buildWhatsappTabs('inbox'),
        activeTab: 'inbox',
        account,
        conversations,
        selectedConversation: bundle ? bundle.conversation : null,
        messages: bundle ? bundle.messages : [],
        notes: bundle ? bundle.notes : [],
        users,
        tags,
        templates,
        filter,
        search,
        access,
        uploadLimitMb: Math.floor(WHATSAPP_ATTACHMENT_LIMIT_BYTES / (1024 * 1024))
      });
    })
  );

  app.get(
    '/whatsapp/settings',
    requireAuth,
    requirePermission('whatsapp', 'manage'),
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const [account, templates] = await Promise.all([getAccount(db, companyId), listTemplates(db, companyId)]);
      return res.render('whatsapp/settings', {
        lang: res.locals.lang,
        csrfToken: res.locals.csrfToken,
        currentModule: 'mensajeria_meta',
        moduleTabs: buildWhatsappTabs('settings'),
        activeTab: 'settings',
        account,
        templates,
        generatedVerifyToken: account && account.webhook_verify_token ? account.webhook_verify_token : crypto.randomBytes(18).toString('hex')
      });
    })
  );

  app.post('/whatsapp/templates', requireAuth, requirePermission('whatsapp', 'manage'), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const userId = getSessionUserId(req);
    const templateId = parseId(req.body.template_id);
    const templateName = clean(req.body.template_name || req.body.name);
    const languageCode = clean(req.body.language_code || req.body.language) || 'es';
    const category = clean(req.body.category);
    const status = clean(req.body.status) || 'draft';
    const body = clean(req.body.body);
    const header = clean(req.body.header);
    const footer = clean(req.body.footer);
    const buttonsJson = clean(req.body.buttons_json);
    if (!templateName) {
      setFlash(req, 'error', 'Indica el nombre de la plantilla.');
      return res.redirect('/whatsapp/settings');
    }
    if (templateId) {
      await runDb(
        db,
        `UPDATE whatsapp_templates
         SET template_name = ?, name = ?, language_code = ?, language = ?, category = ?, status = ?, body = ?, header = ?, footer = ?, buttons_json = ?,
             updated_at = CURRENT_TIMESTAMP, updated_by = ?
         WHERE id = ? AND company_id = ?`,
        [templateName, templateName, languageCode, languageCode, category, status, body, header, footer, buttonsJson, userId, templateId, companyId]
      );
    } else {
      await runDb(
        db,
        `INSERT INTO whatsapp_templates
         (company_id, template_name, name, language_code, language, category, status, body, header, footer, buttons_json, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
        [companyId, templateName, templateName, languageCode, languageCode, category, status, body, header, footer, buttonsJson, userId, userId]
      );
    }
    setFlash(req, 'info', 'Plantilla guardada.');
    return res.redirect('/whatsapp/settings');
  }));

  app.post(
    '/whatsapp/settings',
    requireAuth,
    requirePermission('whatsapp', 'manage'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = getSessionUserId(req);
      const providerType = normalizeProvider(req.body.provider_type);
      const phoneNumber = clean(req.body.phone_number);
      const businessName = clean(req.body.business_name);
      const phoneNumberId = clean(req.body.phone_number_id);
      const businessAccountId = clean(req.body.whatsapp_business_account_id);
      const metaAppId = clean(req.body.meta_app_id);
      const verifyToken = clean(req.body.webhook_verify_token) || crypto.randomBytes(18).toString('hex');
      const webhookUrl = clean(req.body.webhook_url);
      const qrCode = providerType === 'qr_web' ? clean(req.body.qr_code) : null;
      const existing = await getRawAccount(db, companyId);
      const tokenInput = clean(req.body.access_token);
      const encryptedToken = tokenInput ? encryptSecret(tokenInput) : existing ? existing.access_token : null;
      const status = resolveSavedAccountStatus(existing, {
        providerType,
        phoneNumberId,
        businessAccountId,
        encryptedToken,
        tokenChanged: Boolean(tokenInput)
      });

      if (providerType === 'official_api' && (!phoneNumberId || !businessAccountId)) {
        setFlash(req, 'error', 'Para API oficial debes indicar Phone Number ID y WhatsApp Business Account ID.');
        return res.redirect('/whatsapp/settings');
      }

      if (existing) {
        await runDb(
          db,
          `UPDATE whatsapp_accounts
           SET provider_type = ?,
               business_name = ?,
               phone_number = ?,
               phone_number_id = ?,
               whatsapp_business_account_id = ?,
               meta_app_id = ?,
               access_token = ?,
               webhook_verify_token = ?,
               webhook_url = ?,
               status = ?,
               qr_code = ?,
               last_connected_at = CASE WHEN ? = 'connected' THEN COALESCE(last_connected_at, CURRENT_TIMESTAMP) ELSE last_connected_at END,
               updated_at = CURRENT_TIMESTAMP,
               updated_by = ?
           WHERE id = ? AND company_id = ?`,
          [providerType, businessName, phoneNumber, phoneNumberId, businessAccountId, metaAppId, encryptedToken, verifyToken, webhookUrl, status, qrCode, status, userId, existing.id, companyId]
        );
      } else {
        await runDb(
          db,
          `INSERT INTO whatsapp_accounts
           (company_id, provider_type, business_name, phone_number, phone_number_id, whatsapp_business_account_id, meta_app_id, access_token, webhook_verify_token, webhook_url, status, qr_code, last_connected_at, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'connected' THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
          [companyId, providerType, businessName, phoneNumber, phoneNumberId, businessAccountId, metaAppId, encryptedToken, verifyToken, webhookUrl, status, qrCode, status, userId, userId]
        );
      }

      if (typeof logAction === 'function') {
        logAction(userId, 'whatsapp_settings_updated', JSON.stringify({ providerType, status }), companyId);
      }
      setFlash(req, 'info', 'Datos guardados. Para confirmar la conexion, presiona "Verificar y conectar".');
      return res.redirect('/whatsapp/settings');
    })
  );

  app.post(
    '/whatsapp/settings/test',
    requireAuth,
    requirePermission('whatsapp', 'manage'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = getSessionUserId(req);
      const account = await getRawAccount(db, companyId);
      if (!account) {
        setFlash(req, 'error', 'Primero guarda la configuracion de WhatsApp.');
        return res.redirect('/whatsapp/settings');
      }
      if (account.provider_type !== 'official_api') {
        setFlash(req, 'error', 'La verificacion automatica solo aplica para Meta Cloud API.');
        return res.redirect('/whatsapp/settings');
      }
      try {
        const result = await verifyMetaPhoneNumber(account);
        const visiblePhone = clean(result.display_phone_number) || clean(account.phone_number);
        const businessName = clean(result.verified_name) || clean(account.business_name);
        await runDb(
          db,
          `UPDATE whatsapp_accounts
           SET status = 'connected',
               phone_number = COALESCE(NULLIF(?, ''), phone_number),
               business_name = COALESCE(NULLIF(?, ''), business_name),
               last_connected_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP,
               updated_by = ?
           WHERE id = ? AND company_id = ?`,
          [visiblePhone, businessName, userId, account.id, companyId]
        );
        setFlash(req, 'info', 'WhatsApp conectado y verificado con Meta.');
      } catch (error) {
        const message = scrubTokenFromError(error.message);
        await runDb(
          db,
          `UPDATE whatsapp_accounts
           SET status = 'error',
               updated_at = CURRENT_TIMESTAMP,
               updated_by = ?
           WHERE id = ? AND company_id = ?`,
          [userId, account.id, companyId]
        );
        await logWebhook(db, companyId, account.id, 'connection_test_error', { error: message }, null);
        setFlash(req, 'error', `No se pudo conectar con Meta: ${message}`);
      }
      return res.redirect('/whatsapp/settings');
    })
  );

  app.get('/whatsapp/conversations/:id', requireAuth, requirePermission('whatsapp', 'view'), asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    return res.redirect(`/whatsapp?conversation=${id}`);
  }));

  app.post(
    '/whatsapp/send-message',
    requireAuth,
    requirePermission('whatsapp', 'create'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = getSessionUserId(req);
      const conversationId = parseId(req.body.conversation_id);
      const body = clean(req.body.body);
      const access = resolveWhatsappAccess(req);
      const conversation = await getConversationForAccess(db, companyId, conversationId, userId, access);
      if (!conversation) return res.status(403).send('No tienes acceso a esta conversacion.');
      if (!body) {
        setFlash(req, 'error', 'Escribe un mensaje.');
        return res.redirect(`/whatsapp?conversation=${conversationId}`);
      }
      await createOutboundTextMessage(db, companyId, conversation, userId, body);
      return res.redirect(`/whatsapp?conversation=${conversation.id}`);
    })
  );

  app.post(
    '/whatsapp/send-template',
    requireAuth,
    requirePermission('whatsapp', 'create'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = getSessionUserId(req);
      const conversationId = parseId(req.body.conversation_id);
      const templateId = parseId(req.body.template_id);
      const languageCode = clean(req.body.language_code) || 'es';
      const access = resolveWhatsappAccess(req);
      const conversation = await getConversationForAccess(db, companyId, conversationId, userId, access);
      if (!conversation) return res.status(403).send('No tienes acceso a esta conversacion.');
      const template = await getDb(db, 'SELECT * FROM whatsapp_templates WHERE id = ? AND company_id = ?', [templateId, companyId]);
      if (!template) {
        setFlash(req, 'error', 'Plantilla no encontrada.');
        return res.redirect(`/whatsapp?conversation=${conversationId}`);
      }
      await createOutboundTemplateMessage(db, companyId, conversation, userId, template, languageCode);
      return res.redirect(`/whatsapp?conversation=${conversation.id}`);
    })
  );

  app.post(
    '/whatsapp/conversations/:id/message',
    requireAuth,
    requirePermission('whatsapp', 'create'),
    upload.single('attachment'),
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      await schemaReady;
      const companyId = getCompanyId(req);
      const userId = getSessionUserId(req);
      const conversationId = parseId(req.params.id);
      const access = resolveWhatsappAccess(req);
      const conversation = await getConversationForAccess(db, companyId, conversationId, userId, access);
      if (!conversation) return res.status(403).send('No tienes acceso a esta conversacion.');
      const account = await getAccount(db, companyId);
      const body = clean(req.body.body);
      const hasAttachment = Boolean(req.file);
      if (!body && !hasAttachment) {
        setFlash(req, 'error', 'Escribe un mensaje o adjunta un archivo.');
        return res.redirect(`/whatsapp?conversation=${conversationId}`);
      }

      const sendResult = body
        ? await sendTextThroughConfiguredAccount(db, companyId, account, conversation, body)
        : { providerMessageId: null, status: 'sent', errorMessage: null };

      const insert = await runDb(
        db,
        `INSERT INTO whatsapp_messages
         (company_id, conversation_id, contact_id, direction, message_type, body, media_url, provider_message_id, status, error_message, timestamp, created_by, created_at, updated_by)
         VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, ?)`,
        [
          companyId,
          conversation.id,
          conversation.contact_id,
          hasAttachment ? inferMessageType(req.file.mimetype, req.file.originalname) : 'text',
          body || null,
          req.file ? buildStoredUploadUrl(req.file) : null,
          sendResult.providerMessageId,
          sendResult.status,
          sendResult.errorMessage,
          userId,
          userId
        ]
      );

      if (req.file) {
        await runDb(
          db,
          `INSERT INTO whatsapp_message_attachments
           (company_id, message_id, original_name, stored_name, mime_type, size_bytes, file_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [companyId, insert.lastID, req.file.originalname || req.file.filename, req.file.filename, req.file.mimetype, req.file.size || 0, req.file.path]
        );
      }

      await touchConversationAfterMessage(db, companyId, conversation.id, body || (req.file && req.file.originalname) || 'Adjunto', 'outbound');
      return res.redirect(`/whatsapp?conversation=${conversation.id}`);
    })
  );

  app.post('/whatsapp/conversations/:id/assign', requireAuth, requirePermission('whatsapp', 'edit'), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const conversationId = parseId(req.params.id);
    const assignedUserId = parseId(req.body.assigned_user_id) || null;
    if (assignedUserId) {
      const user = await getDb(db, 'SELECT id FROM users WHERE id = ? AND company_id = ? AND is_active = 1', [assignedUserId, companyId]);
      if (!user) return res.status(400).send('Usuario invalido.');
    }
    await runDb(
      db,
      `UPDATE whatsapp_conversations
       SET assigned_user_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [assignedUserId, conversationId, companyId]
    );
    await runDb(
      db,
      `INSERT INTO whatsapp_user_assignments
       (company_id, conversation_id, user_id, assigned_by, created_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [companyId, conversationId, assignedUserId, getSessionUserId(req)]
    );
    setFlash(req, 'info', 'Conversacion reasignada.');
    return res.redirect(`/whatsapp?conversation=${conversationId}`);
  }));

  app.post('/whatsapp/conversations/:id/status', requireAuth, requirePermission('whatsapp', 'edit'), csrfMiddleware, asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const conversationId = parseId(req.params.id);
    const status = normalizeConversationStatus(req.body.status);
    const priority = normalizePriority(req.body.priority);
    await runDb(
      db,
      `UPDATE whatsapp_conversations
       SET status = ?, priority = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [status, priority, conversationId, companyId]
    );
    setFlash(req, 'info', 'Conversacion actualizada.');
    return res.redirect(`/whatsapp?conversation=${conversationId}`);
  }));

  app.post('/whatsapp/conversations/:id/note', requireAuth, requirePermission('whatsapp', 'create'), csrfMiddleware, asyncRoute(async (req, res) => {
    req.body.body = req.body.note || req.body.body;
    return handleConversationNote(req, res);
  }));

  app.post('/whatsapp/conversations/:id/notes', requireAuth, requirePermission('whatsapp', 'create'), csrfMiddleware, asyncRoute(handleConversationNote));

  app.post('/whatsapp/conversations/:id/tag', requireAuth, requirePermission('whatsapp', 'edit'), csrfMiddleware, asyncRoute(handleConversationTag));
  app.post('/whatsapp/conversations/:id/tags', requireAuth, requirePermission('whatsapp', 'edit'), csrfMiddleware, asyncRoute(handleConversationTag));

  async function handleConversationNote(req, res) {
    await schemaReady;
    const companyId = getCompanyId(req);
    const conversationId = parseId(req.params.id);
    const body = clean(req.body.body || req.body.note);
    if (body) {
      await runDb(
        db,
        `INSERT INTO whatsapp_conversation_notes
         (company_id, conversation_id, user_id, note, body, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
        [companyId, conversationId, getSessionUserId(req), body, body, getSessionUserId(req), getSessionUserId(req)]
      );
    }
    return res.redirect(`/whatsapp?conversation=${conversationId}`);
  }

  async function handleConversationTag(req, res) {
    await schemaReady;
    const companyId = getCompanyId(req);
    const conversationId = parseId(req.params.id);
    const label = clean(req.body.label || req.body.name);
    const color = clean(req.body.color) || '#0f766e';
    if (label) {
      const tag = await ensureWhatsappTag(db, companyId, label.slice(0, 60), color.slice(0, 24), getSessionUserId(req));
      await runDb(
        db,
        `INSERT INTO whatsapp_conversation_tags
         (company_id, conversation_id, tag_id, label, color, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
        [companyId, conversationId, tag.id, tag.name, tag.color, getSessionUserId(req), getSessionUserId(req)]
      );
    }
    return res.redirect(`/whatsapp?conversation=${conversationId}`);
  }

  app.get('/whatsapp/attachments/:id/download', requireAuth, requirePermission('whatsapp', 'view'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const attachmentId = parseId(req.params.id);
    const attachment = await getDb(
      db,
      `SELECT a.original_name, a.file_path
       FROM whatsapp_message_attachments a
       JOIN whatsapp_messages m ON m.id = a.message_id AND m.company_id = a.company_id
       JOIN whatsapp_conversations c ON c.id = m.conversation_id AND c.company_id = m.company_id
       WHERE a.id = ? AND a.company_id = ?`,
      [attachmentId, companyId]
    );
    if (!attachment || !isSafeFilePath(uploadRoot, attachment.file_path) || !fs.existsSync(attachment.file_path)) {
      return res.status(404).send('Adjunto no encontrado.');
    }
    return res.download(attachment.file_path, attachment.original_name || path.basename(attachment.file_path));
  }));

  app.get('/api/whatsapp/unread-count', requireAuth, requirePermission('whatsapp', 'view'), asyncRoute(async (req, res) => {
    await schemaReady;
    const companyId = getCompanyId(req);
    const access = resolveWhatsappAccess(req);
    const userId = getSessionUserId(req);
    const params = [companyId];
    let where = 'WHERE company_id = ? AND unread_count > 0';
    if (access.agentOnly) {
      where += ' AND assigned_user_id = ?';
      params.push(userId);
    }
    const row = await getDb(db, `SELECT COALESCE(SUM(unread_count), 0) AS total FROM whatsapp_conversations ${where}`, params);
    return res.json({ ok: true, unreadCount: Number(row && row.total) || 0 });
  }));

  app.get('/webhooks/whatsapp', asyncRoute(async (req, res) => {
    await schemaReady;
    const mode = clean(req.query['hub.mode']);
    const token = clean(req.query['hub.verify_token']);
    const challenge = req.query['hub.challenge'];
    const account = await getDb(
      db,
      `SELECT id FROM whatsapp_accounts
       WHERE webhook_verify_token = ? AND provider_type = 'official_api'
       LIMIT 1`,
      [token]
    );
    if (mode === 'subscribe' && token && account) {
      return res.status(200).send(String(challenge || ''));
    }
    return res.sendStatus(403);
  }));

  app.post('/webhooks/whatsapp', asyncRoute(async (req, res) => {
    await schemaReady;
    const payload = req.body || {};
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        await processWhatsappWebhookChange(db, change);
      }
    }
    return res.sendStatus(200);
  }));
}

async function ensureWhatsappSchema(db) {
  if (isWhatsappSchemaInitialized) return Promise.resolve();
  isWhatsappSchemaInitialized = true;
  const statements = [
        `CREATE TABLE IF NOT EXISTS whatsapp_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          provider_type TEXT NOT NULL DEFAULT 'official_api',
          business_name TEXT,
          phone_number TEXT,
          phone_number_id TEXT,
          whatsapp_business_account_id TEXT,
          meta_app_id TEXT,
          access_token TEXT,
          webhook_verify_token TEXT,
          webhook_url TEXT,
          status TEXT NOT NULL DEFAULT 'disconnected',
          qr_code TEXT,
          last_connected_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          updated_by INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          name TEXT,
          phone TEXT NOT NULL,
          email TEXT,
          country TEXT,
          source TEXT,
          last_message_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          updated_by INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          contact_id INTEGER NOT NULL,
          assigned_user_id INTEGER,
          status TEXT NOT NULL DEFAULT 'open',
          priority TEXT NOT NULL DEFAULT 'normal',
          last_message TEXT,
          last_message_at DATETIME,
          unread_count INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          updated_by INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          conversation_id INTEGER NOT NULL,
          contact_id INTEGER NOT NULL,
          direction TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'text',
          body TEXT,
          media_url TEXT,
          provider_message_id TEXT,
          status TEXT NOT NULL DEFAULT 'received',
          timestamp DATETIME,
          created_by INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_by INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_message_attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          message_id INTEGER NOT NULL,
          original_name TEXT,
          stored_name TEXT,
          mime_type TEXT,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          file_path TEXT,
          media_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_conversation_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          conversation_id INTEGER NOT NULL,
          user_id INTEGER,
          note TEXT,
          body TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          updated_by INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          color TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          updated_by INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_conversation_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          conversation_id INTEGER NOT NULL,
          tag_id INTEGER,
          label TEXT NOT NULL,
          color TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          updated_by INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_user_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          conversation_id INTEGER NOT NULL,
          user_id INTEGER,
          assigned_by INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_webhook_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER,
          account_id INTEGER,
          payload_json TEXT,
          event_type TEXT,
          provider_message_id TEXT,
          payload TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          updated_by INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS whatsapp_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          template_name TEXT,
          language_code TEXT NOT NULL DEFAULT 'es',
          name TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'es',
          category TEXT,
          body TEXT,
          header TEXT,
          footer TEXT,
          buttons_json TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          provider_template_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          updated_by INTEGER
        )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_accounts_company ON whatsapp_accounts (company_id)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_contacts_company_phone ON whatsapp_contacts (company_id, phone)',
        'CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_company ON whatsapp_conversations (company_id, status, assigned_user_id, last_message_at)',
        'CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages (company_id, conversation_id, timestamp, id)',
        'CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_provider ON whatsapp_messages (provider_message_id)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_tags_company_name ON whatsapp_tags (company_id, name)',
        'CREATE INDEX IF NOT EXISTS idx_whatsapp_tags_conversation ON whatsapp_conversation_tags (company_id, conversation_id)',
        'CREATE INDEX IF NOT EXISTS idx_whatsapp_notes_conversation ON whatsapp_conversation_notes (company_id, conversation_id)',
        `INSERT INTO permission_modules (code, name, description)
         VALUES ('whatsapp', 'WhatsApp / Mensajeria', 'Bandeja CRM para WhatsApp Business Cloud API')
         ON CONFLICT (code) DO NOTHING`,
        `INSERT OR IGNORE INTO module_actions (module_id, action_id)
         SELECT pm.id, pa.id
         FROM permission_modules pm, permission_actions pa
         WHERE pm.code = 'whatsapp' AND pa.code IN ('view', 'create', 'edit', 'manage')`
  ];
  await runStatements(db, statements);
  await migrateWhatsappSchema(db);
}

async function migrateWhatsappSchema(db) {
  const commonAudit = [
    ['created_by', 'INTEGER'],
    ['updated_by', 'INTEGER'],
    ['updated_at', 'DATETIME']
  ];
  const tableColumns = {
    whatsapp_accounts: [
      ['business_name', 'TEXT'],
      ['meta_app_id', 'TEXT'],
      ['webhook_url', 'TEXT'],
      ['qr_code', 'TEXT'],
      ...commonAudit
    ],
    whatsapp_contacts: [
      ['last_message_at', 'DATETIME'],
      ...commonAudit
    ],
    whatsapp_conversations: commonAudit,
    whatsapp_messages: [
      ['error_message', 'TEXT'],
      ['updated_at', 'DATETIME'],
      ['updated_by', 'INTEGER']
    ],
    whatsapp_conversation_notes: [
      ['note', 'TEXT'],
      ['body', 'TEXT'],
      ...commonAudit
    ],
    whatsapp_tags: commonAudit,
    whatsapp_conversation_tags: [
      ['tag_id', 'INTEGER'],
      ['label', 'TEXT'],
      ['color', 'TEXT'],
      ...commonAudit
    ],
    whatsapp_webhook_logs: [
      ['payload_json', 'TEXT'],
      ['provider_message_id', 'TEXT'],
      ['payload', 'TEXT'],
      ...commonAudit
    ],
    whatsapp_templates: [
      ['template_name', 'TEXT'],
      ['language_code', "TEXT NOT NULL DEFAULT 'es'"],
      ['name', 'TEXT'],
      ['language', "TEXT NOT NULL DEFAULT 'es'"],
      ['header', 'TEXT'],
      ['footer', 'TEXT'],
      ['buttons_json', 'TEXT'],
      ...commonAudit
    ]
  };
  for (const [table, columns] of Object.entries(tableColumns)) {
    for (const [column, definition] of columns) {
      await addColumnIfMissing(db, table, column, definition);
    }
  }
  await runStatements(db, [
    `UPDATE whatsapp_conversation_notes SET note = COALESCE(note, body) WHERE note IS NULL`,
    `UPDATE whatsapp_templates SET template_name = COALESCE(template_name, name), language_code = COALESCE(language_code, language, 'es')`,
    `UPDATE whatsapp_webhook_logs SET payload_json = COALESCE(payload_json, payload) WHERE payload_json IS NULL`
  ]);
}

async function processWhatsappWebhookChange(db, change) {
  const value = change && change.value ? change.value : {};
  const metadata = value.metadata || {};
  const phoneNumberId = clean(metadata.phone_number_id);
  const account = await getDb(db, 'SELECT * FROM whatsapp_accounts WHERE phone_number_id = ? LIMIT 1', [phoneNumberId]);
  const companyId = account ? Number(account.company_id) : null;
  const firstProviderId = extractFirstProviderMessageId(value);
  await logWebhook(db, companyId, account && account.id, clean(change.field) || 'message', value, firstProviderId);
  if (!account || !companyId) return;

  const contacts = Array.isArray(value.contacts) ? value.contacts : [];
  const contactNames = new Map();
  contacts.forEach((entry) => {
    const waId = normalizePhone(entry.wa_id);
    if (waId) contactNames.set(waId, clean(entry.profile && entry.profile.name));
  });

  const messages = Array.isArray(value.messages) ? value.messages : [];
  for (const message of messages) {
    const phone = normalizePhone(message.from);
    if (!phone) continue;
    const contact = await ensureWhatsappContact(db, companyId, phone, contactNames.get(phone));
    const conversation = await ensureWhatsappConversation(db, companyId, contact.id);
    const parsed = parseInboundMessage(message);
    await runDb(
      db,
      `INSERT INTO whatsapp_messages
       (company_id, conversation_id, contact_id, direction, message_type, body, media_url, provider_message_id, status, timestamp, created_at, updated_at)
       VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, 'received', datetime(?, 'unixepoch'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [companyId, conversation.id, contact.id, parsed.type, parsed.body, parsed.mediaUrl, clean(message.id), Number(message.timestamp || 0)]
    );
    await touchConversationAfterMessage(db, companyId, conversation.id, parsed.body || parsed.type, 'inbound');
  }

  const statuses = Array.isArray(value.statuses) ? value.statuses : [];
  for (const status of statuses) {
    const providerId = clean(status.id);
    if (!providerId) continue;
    await runDb(
      db,
      `UPDATE whatsapp_messages
       SET status = ?, timestamp = COALESCE(timestamp, datetime(?, 'unixepoch')), updated_at = CURRENT_TIMESTAMP
       WHERE provider_message_id = ? AND company_id = ?`,
      [normalizeMessageStatus(status.status), Number(status.timestamp || 0), providerId, companyId]
    );
  }
}

async function ensureWhatsappContact(db, companyId, phone, name) {
  const existing = await getDb(db, 'SELECT * FROM whatsapp_contacts WHERE company_id = ? AND phone = ? LIMIT 1', [companyId, phone]);
  if (existing) {
    if (name && name !== existing.name) {
      await runDb(db, 'UPDATE whatsapp_contacts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [name, existing.id, companyId]);
      return { ...existing, name };
    }
    return existing;
  }
  const insert = await runDb(
    db,
    `INSERT INTO whatsapp_contacts (company_id, name, phone, source, created_at, updated_at)
     VALUES (?, ?, ?, 'whatsapp', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, name || phone, phone]
  );
  return getDb(db, 'SELECT * FROM whatsapp_contacts WHERE id = ? AND company_id = ?', [insert.lastID, companyId]);
}

async function ensureWhatsappConversation(db, companyId, contactId) {
  const existing = await getDb(
    db,
    "SELECT * FROM whatsapp_conversations WHERE company_id = ? AND contact_id = ? AND status != 'closed' ORDER BY updated_at DESC, id DESC LIMIT 1",
    [companyId, contactId]
  );
  if (existing) return existing;
  const insert = await runDb(
    db,
    `INSERT INTO whatsapp_conversations
     (company_id, contact_id, status, priority, unread_count, created_at, updated_at)
     VALUES (?, ?, 'open', 'normal', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId, contactId]
  );
  return getDb(db, 'SELECT * FROM whatsapp_conversations WHERE id = ? AND company_id = ?', [insert.lastID, companyId]);
}

async function touchConversationAfterMessage(db, companyId, conversationId, preview, direction) {
  const unreadSql = direction === 'inbound' ? ', unread_count = unread_count + 1' : '';
  await runDb(
    db,
    `UPDATE whatsapp_conversations
     SET last_message = ?,
         last_message_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
         ${unreadSql}
     WHERE id = ? AND company_id = ?`,
    [String(preview || '').slice(0, 500), conversationId, companyId]
  );
  await runDb(
    db,
    `UPDATE whatsapp_contacts
     SET last_message_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = (SELECT contact_id FROM whatsapp_conversations WHERE id = ? AND company_id = ?)
       AND company_id = ?`,
    [conversationId, companyId, companyId]
  );
}

async function getConversationBundle(db, companyId, conversationId, userId, access) {
  const conversation = await getConversationForAccess(db, companyId, conversationId, userId, access);
  if (!conversation) return null;
  await runDb(db, 'UPDATE whatsapp_conversations SET unread_count = 0 WHERE id = ? AND company_id = ?', [conversationId, companyId]);
  const [messages, notes, tags] = await Promise.all([
    allDb(
      db,
      `SELECT m.*, a.id AS attachment_id, a.original_name, a.mime_type, a.size_bytes
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_message_attachments a ON a.message_id = m.id AND a.company_id = m.company_id
       WHERE m.company_id = ? AND m.conversation_id = ?
       ORDER BY COALESCE(m.timestamp, m.created_at) ASC, m.id ASC`,
      [companyId, conversationId]
    ),
    allDb(
      db,
      `SELECT n.*, u.username
       FROM whatsapp_conversation_notes n
       LEFT JOIN users u ON u.id = n.user_id AND u.company_id = n.company_id
       WHERE n.company_id = ? AND n.conversation_id = ?
       ORDER BY n.created_at DESC, n.id DESC`,
      [companyId, conversationId]
    ),
    allDb(
      db,
      `SELECT ct.*, COALESCE(t.name, ct.label) AS label, COALESCE(t.color, ct.color) AS color
       FROM whatsapp_conversation_tags ct
       LEFT JOIN whatsapp_tags t ON t.id = ct.tag_id AND t.company_id = ct.company_id
       WHERE ct.company_id = ? AND ct.conversation_id = ?
       ORDER BY ct.id DESC`,
      [companyId, conversationId]
    )
  ]);
  return { conversation: { ...conversation, tags }, messages, notes };
}

function listConversations(db, companyId, userId, access, filter, search) {
  const params = [companyId];
  const where = ['c.company_id = ?'];
  if (filter === 'open' || filter === 'pending' || filter === 'closed') {
    where.push('c.status = ?');
    params.push(filter);
  } else if (filter === 'unread') {
    where.push('c.unread_count > 0');
  } else if (filter === 'mine') {
    where.push('c.assigned_user_id = ?');
    params.push(userId);
  } else if (filter === 'unassigned') {
    where.push('c.assigned_user_id IS NULL');
  }
  if (access.agentOnly) {
    where.push('c.assigned_user_id = ?');
    params.push(userId);
  }
  if (search) {
    where.push('(ct.name LIKE ? OR ct.phone LIKE ? OR c.last_message LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  return allDb(
    db,
    `SELECT c.*,
            ct.name AS contact_name,
            ct.phone AS contact_phone,
            ct.email AS contact_email,
            ct.country AS contact_country,
            u.username AS assigned_username,
            (SELECT GROUP_CONCAT(label, '||') FROM whatsapp_conversation_tags t WHERE t.company_id = c.company_id AND t.conversation_id = c.id) AS tag_labels
     FROM whatsapp_conversations c
     JOIN whatsapp_contacts ct ON ct.id = c.contact_id AND ct.company_id = c.company_id
     LEFT JOIN users u ON u.id = c.assigned_user_id AND u.company_id = c.company_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(c.last_message_at, c.updated_at, c.created_at) DESC, c.id DESC
     LIMIT 200`,
    params
  );
}

function getConversationForAccess(db, companyId, conversationId, userId, access) {
  const params = [conversationId, companyId];
  let accessSql = '';
  if (access.agentOnly) {
    accessSql = ' AND c.assigned_user_id = ?';
    params.push(userId);
  }
  return getDb(
    db,
    `SELECT c.*,
            ct.name AS contact_name,
            ct.phone AS contact_phone,
            ct.email AS contact_email,
            ct.country AS contact_country,
            ct.source AS contact_source,
            u.username AS assigned_username
     FROM whatsapp_conversations c
     JOIN whatsapp_contacts ct ON ct.id = c.contact_id AND ct.company_id = c.company_id
     LEFT JOIN users u ON u.id = c.assigned_user_id AND u.company_id = c.company_id
     WHERE c.id = ? AND c.company_id = ? ${accessSql}
     LIMIT 1`,
    params
  );
}

function getAccount(db, companyId) {
  return getDb(
    db,
    `SELECT id, company_id, provider_type, business_name, phone_number, phone_number_id, whatsapp_business_account_id,
            meta_app_id, webhook_verify_token, webhook_url, status, qr_code, last_connected_at, created_at, updated_at,
            CASE WHEN access_token IS NOT NULL AND TRIM(access_token) <> '' THEN 1 ELSE 0 END AS has_access_token
     FROM whatsapp_accounts
     WHERE company_id = ?
     LIMIT 1`,
    [companyId]
  );
}

function getRawAccount(db, companyId) {
  return getDb(db, 'SELECT * FROM whatsapp_accounts WHERE company_id = ? LIMIT 1', [companyId]);
}

function resolveSavedAccountStatus(existing, next) {
  if (!existing) return 'pending';
  if (next.providerType !== 'official_api') return 'pending';
  const stillSameConnection =
    existing.provider_type === next.providerType &&
    clean(existing.phone_number_id) === next.phoneNumberId &&
    clean(existing.whatsapp_business_account_id) === next.businessAccountId &&
    !next.tokenChanged &&
    clean(existing.access_token) === clean(next.encryptedToken);
  return existing.status === 'connected' && stillSameConnection ? 'connected' : 'pending';
}

function listAssignableUsers(db, companyId) {
  return allDb(
    db,
    `SELECT id, username, role
     FROM users
     WHERE company_id = ? AND is_active = 1
     ORDER BY username COLLATE NOCASE ASC`,
    [companyId]
  );
}

function listCompanyTags(db, companyId) {
  return allDb(
    db,
    `SELECT name AS label, color, 0 AS total
     FROM whatsapp_tags
     WHERE company_id = ?
     ORDER BY name ASC
     LIMIT 50`,
    [companyId]
  );
}

function listTemplates(db, companyId) {
  return allDb(
    db,
    `SELECT id,
            COALESCE(template_name, name) AS template_name,
            COALESCE(language_code, language, 'es') AS language_code,
            category,
            status,
            body,
            header,
            footer,
            buttons_json
     FROM whatsapp_templates
     WHERE company_id = ?
     ORDER BY template_name COLLATE NOCASE ASC, language_code ASC`,
    [companyId]
  );
}

async function ensureWhatsappTag(db, companyId, name, color, userId) {
  const existing = await getDb(db, 'SELECT * FROM whatsapp_tags WHERE company_id = ? AND name = ? LIMIT 1', [companyId, name]);
  if (existing) {
    if (color && color !== existing.color) {
      await runDb(
        db,
        'UPDATE whatsapp_tags SET color = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND company_id = ?',
        [color, userId, existing.id, companyId]
      );
      return { ...existing, color };
    }
    return existing;
  }
  const insert = await runDb(
    db,
    `INSERT INTO whatsapp_tags (company_id, name, color, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
    [companyId, name, color, userId, userId]
  );
  return getDb(db, 'SELECT * FROM whatsapp_tags WHERE id = ? AND company_id = ?', [insert.lastID, companyId]);
}

async function createOutboundTextMessage(db, companyId, conversation, userId, body) {
  const account = await getRawAccount(db, companyId);
  const sendResult = await sendTextThroughConfiguredAccount(db, companyId, account, conversation, body);
  await runDb(
    db,
    `INSERT INTO whatsapp_messages
     (company_id, conversation_id, contact_id, direction, message_type, body, provider_message_id, status, error_message, timestamp, created_by, created_at, updated_by)
     VALUES (?, ?, ?, 'outbound', 'text', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, ?)`,
    [companyId, conversation.id, conversation.contact_id, body, sendResult.providerMessageId, sendResult.status, sendResult.errorMessage, userId, userId]
  );
  await touchConversationAfterMessage(db, companyId, conversation.id, body, 'outbound');
}

async function createOutboundTemplateMessage(db, companyId, conversation, userId, template, languageCode) {
  const account = await getRawAccount(db, companyId);
  const templateName = clean(template.template_name || template.name);
  let providerMessageId = null;
  let status = 'sent';
  let errorMessage = null;
  if (account && account.provider_type === 'official_api' && account.status === 'connected') {
    try {
      const response = await sendMetaTemplateMessage(account, conversation.contact_phone, templateName, languageCode || template.language_code || template.language || 'es');
      providerMessageId = response && response.messages && response.messages[0] ? response.messages[0].id : null;
    } catch (error) {
      status = 'failed';
      errorMessage = scrubTokenFromError(error.message);
      await logWebhook(db, companyId, account.id, 'outbound_template_error', { conversationId: conversation.id, error: errorMessage }, providerMessageId);
    }
  } else {
    status = 'failed';
    errorMessage = 'Cuenta oficial no conectada.';
  }
  const body = `Plantilla: ${templateName}`;
  await runDb(
    db,
    `INSERT INTO whatsapp_messages
     (company_id, conversation_id, contact_id, direction, message_type, body, provider_message_id, status, error_message, timestamp, created_by, created_at, updated_by)
     VALUES (?, ?, ?, 'outbound', 'template', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, ?)`,
    [companyId, conversation.id, conversation.contact_id, body, providerMessageId, status, errorMessage, userId, userId]
  );
  await touchConversationAfterMessage(db, companyId, conversation.id, body, 'outbound');
}

async function sendTextThroughConfiguredAccount(db, companyId, account, conversation, body) {
  let providerMessageId = null;
  let status = 'sent';
  let errorMessage = null;
  if (account && account.provider_type === 'official_api' && account.status === 'connected') {
    try {
      const lastInbound = await getDb(
        db,
        `SELECT COALESCE(timestamp, created_at) AS last_inbound_at
         FROM whatsapp_messages
         WHERE company_id = ? AND conversation_id = ? AND direction = 'inbound'
         ORDER BY datetime(COALESCE(timestamp, created_at)) DESC, id DESC
         LIMIT 1`,
        [companyId, conversation.id]
      );
      if (!isInsideWhatsApp24HourWindow(lastInbound && lastInbound.last_inbound_at)) {
        throw new Error('Fuera de la ventana de 24 horas. Envia una plantilla aprobada.');
      }
      const response = await sendMetaTextMessage(account, conversation.contact_phone, body);
      providerMessageId = response && response.messages && response.messages[0] ? response.messages[0].id : null;
    } catch (error) {
      status = 'failed';
      errorMessage = scrubTokenFromError(error.message);
      await logWebhook(db, companyId, account.id, 'outbound_error', { conversationId: conversation.id, error: errorMessage }, providerMessageId);
    }
  } else if (account && account.provider_type === 'qr_web') {
    status = 'sent';
  } else {
    status = 'failed';
    errorMessage = 'Cuenta oficial no conectada.';
  }
  return { providerMessageId, status, errorMessage };
}

function sendMetaTextMessage(account, toPhone, body) {
  const token = decryptSecret(account.access_token);
  if (!token || !account.phone_number_id) {
    return Promise.reject(new Error('whatsapp_account_not_configured'));
  }
  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to: normalizePhone(toPhone),
    type: 'text',
    text: { preview_url: false, body }
  });
  const options = {
    hostname: 'graph.facebook.com',
    path: `/${META_GRAPH_VERSION}/${encodeURIComponent(account.phone_number_id)}/messages`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  return requestJson(options, payload);
}

function sendMetaTemplateMessage(account, toPhone, templateName, languageCode) {
  const token = decryptSecret(account.access_token);
  if (!token || !account.phone_number_id || !templateName) {
    return Promise.reject(new Error('whatsapp_account_not_configured'));
  }
  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to: normalizePhone(toPhone),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || 'es' }
    }
  });
  const options = {
    hostname: 'graph.facebook.com',
    path: `/${META_GRAPH_VERSION}/${encodeURIComponent(account.phone_number_id)}/messages`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  return requestJson(options, payload);
}

function verifyMetaPhoneNumber(account) {
  const token = decryptSecret(account.access_token);
  if (!token || !account.phone_number_id) {
    return Promise.reject(new Error('Falta token o Phone Number ID.'));
  }
  const fields = 'id,display_phone_number,verified_name,code_verification_status,quality_rating';
  const options = {
    hostname: 'graph.facebook.com',
    path: `/${META_GRAPH_VERSION}/${encodeURIComponent(account.phone_number_id)}?fields=${encodeURIComponent(fields)}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`
    }
  };
  return requestJson(options);
}

function requestJson(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (error) {
          parsed = { raw };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        return reject(new Error(`meta_graph_${res.statusCode}: ${raw.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function encryptSecret(value) {
  const secret = process.env.WHATSAPP_TOKEN_SECRET || process.env.FILE_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!secret) return `plain:${value}`;
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(TOKEN_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.startsWith('plain:')) return text.slice(6);
  if (!text.startsWith('enc:')) return text;
  const secret = process.env.WHATSAPP_TOKEN_SECRET || process.env.FILE_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!secret) return '';
  const parts = text.split(':');
  if (parts.length !== 4) return '';
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const decipher = crypto.createDecipheriv(TOKEN_ALGORITHM, key, Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

function resolveWhatsappAccess(req) {
  const role = clean(req.session && req.session.user && req.session.user.role).toLowerCase();
  const isAdmin = Boolean(req.session && req.session.permissionMap && req.session.permissionMap.isAdmin) || role === 'admin' || role === 'administrator';
  const isSupervisor = ['supervisor', 'manager', 'administrador'].includes(role);
  return {
    isAdmin,
    isSupervisor,
    agentOnly: !(isAdmin || isSupervisor)
  };
}

function buildWhatsappTabs(active) {
  const tabKey = active === 'settings' ? 'whatsapp_settings' : 'whatsapp';
  return buildMensajeriaMetaTabs(tabKey);
}

function parseInboundMessage(message) {
  const type = VALID_MESSAGE_TYPES.has(clean(message.type)) ? clean(message.type) : 'text';
  if (type === 'text') return { type, body: clean(message.text && message.text.body), mediaUrl: null };
  if (type === 'location') {
    const loc = message.location || {};
    return { type, body: [loc.latitude, loc.longitude, loc.name, loc.address].filter(Boolean).join(' | '), mediaUrl: null };
  }
  const media = message[type] || {};
  return { type, body: clean(media.caption) || clean(media.filename) || type, mediaUrl: clean(media.id) };
}

function inferMessageType(mimeType, fileName) {
  const mime = clean(mimeType).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function normalizeConversationFilter(value) {
  const normalized = clean(value).toLowerCase();
  return ['all', 'open', 'pending', 'closed', 'unread', 'mine', 'unassigned'].includes(normalized) ? normalized : 'open';
}

function normalizeProvider(value) {
  const normalized = clean(value).toLowerCase();
  return VALID_PROVIDERS.has(normalized) ? normalized : 'official_api';
}

function normalizeAccountStatus(value, fallback = 'disconnected') {
  const normalized = clean(value).toLowerCase();
  return VALID_ACCOUNT_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeConversationStatus(value) {
  const normalized = clean(value).toLowerCase();
  return VALID_CONVERSATION_STATUSES.has(normalized) ? normalized : 'open';
}

function normalizeMessageStatus(value) {
  const normalized = clean(value).toLowerCase();
  return VALID_MESSAGE_STATUSES.has(normalized) ? normalized : 'sent';
}

function normalizePriority(value) {
  const normalized = clean(value).toLowerCase();
  return VALID_PRIORITIES.has(normalized) ? normalized : 'normal';
}

function normalizePhone(value) {
  return clean(value).replace(/[^\d]/g, '');
}

function getSessionUserId(req) {
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

function safeExtension(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return ext || '.bin';
}

function buildStoredUploadUrl(file) {
  return file ? `/whatsapp/attachments/pending/${file.filename}` : null;
}

function isInsideWhatsApp24HourWindow(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() <= 24 * 60 * 60 * 1000;
}

function scrubTokenFromError(message) {
  return clean(message).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 1000);
}

function extractFirstProviderMessageId(value) {
  const messages = Array.isArray(value && value.messages) ? value.messages : [];
  if (messages[0] && messages[0].id) return clean(messages[0].id);
  const statuses = Array.isArray(value && value.statuses) ? value.statuses : [];
  if (statuses[0] && statuses[0].id) return clean(statuses[0].id);
  return null;
}

function ensureDir(targetPath) {
  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
}

function isSafeFilePath(rootPath, filePath) {
  if (!rootPath || !filePath) return false;
  const safeRoot = path.resolve(rootPath);
  const safeFile = path.resolve(filePath);
  return safeFile === safeRoot || safeFile.startsWith(`${safeRoot}${path.sep}`);
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

function runStatements(db, statements) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let index = 0;
      const next = () => {
        if (index >= statements.length) return resolve();
        const statement = statements[index];
        index += 1;
        db.run(statement, (error) => {
          if (error) return reject(error);
          return next();
        });
      };
      next();
    });
  });
}

async function addColumnIfMissing(db, table, column, definition) {
  const columns = await allDb(db, `PRAGMA table_info(${table})`);
  if (columns.some((entry) => entry.name === column)) return;
  await runDb(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function logWebhook(db, companyId, accountId, eventType, payload, providerMessageId) {
  return runDb(
    db,
    `INSERT INTO whatsapp_webhook_logs (company_id, account_id, event_type, payload_json, payload, provider_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [companyId || null, accountId || null, eventType || 'webhook', JSON.stringify(payload || {}), JSON.stringify(payload || {}), providerMessageId || null]
  ).catch((error) => {
    console.error('[whatsapp] webhook log failed', error.message);
  });
}

module.exports = {
  registerWhatsappRoutes
};
