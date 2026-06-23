const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { STORAGE_UPLOADS_DIR } = require('../../core/storage-paths');

const CHAT_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
const CHAT_PROFILE_PHOTO_LIMIT_BYTES = 4 * 1024 * 1024;
const CHAT_NOTIFICATION_TYPE = 'chat_message';
const CHAT_PRESENCE_STATUSES = new Set(['online', 'busy', 'away']);

const CHAT_PROFILE_PHOTO_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const CHAT_PROFILE_PHOTO_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif'
]);

let isChatModuleInitialized = false;
const CHAT_STREAM_KEEPALIVE_MS = 25000;
const CHAT_TYPING_TTL_MS = 5000;
const chatRealtimeState = {
  streamsByThread: new Map(),
  typingByThread: new Map()
};

function getChatThreadKey(threadId) {
  return String(Number(threadId) || 0);
}

function getChatThreadStreamBucket(threadId) {
  const key = getChatThreadKey(threadId);
  let bucket = chatRealtimeState.streamsByThread.get(key);
  if (!bucket) {
    bucket = new Map();
    chatRealtimeState.streamsByThread.set(key, bucket);
  }
  return bucket;
}

function addChatStream(threadId, userId, res) {
  const threadBucket = getChatThreadStreamBucket(threadId);
  const normalizedUserId = Number(userId) || 0;
  let streamSet = threadBucket.get(normalizedUserId);
  if (!streamSet) {
    streamSet = new Set();
    threadBucket.set(normalizedUserId, streamSet);
  }
  streamSet.add(res);
}

function removeChatStream(threadId, userId, res) {
  const key = getChatThreadKey(threadId);
  const threadBucket = chatRealtimeState.streamsByThread.get(key);
  if (!threadBucket) return;
  const normalizedUserId = Number(userId) || 0;
  const streamSet = threadBucket.get(normalizedUserId);
  if (!streamSet) return;
  streamSet.delete(res);
  if (streamSet.size === 0) {
    threadBucket.delete(normalizedUserId);
  }
  if (threadBucket.size === 0) {
    chatRealtimeState.streamsByThread.delete(key);
  }
}

function hasActiveChatStream(threadId, userId) {
  const key = getChatThreadKey(threadId);
  const threadBucket = chatRealtimeState.streamsByThread.get(key);
  if (!threadBucket) return false;
  const streamSet = threadBucket.get(Number(userId) || 0);
  return Boolean(streamSet && streamSet.size > 0);
}

function sendChatSseEvent(res, eventName, payload) {
  if (!res || res.writableEnded) return;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
}

function broadcastChatThreadEvent(threadId, eventName, payload, options = {}) {
  const key = getChatThreadKey(threadId);
  const threadBucket = chatRealtimeState.streamsByThread.get(key);
  if (!threadBucket) return;
  const excludeUserId = Number(options.excludeUserId) || 0;
  const onlyUserId = Number(options.onlyUserId) || 0;
  threadBucket.forEach((streamSet, userId) => {
    if (onlyUserId && Number(userId) !== onlyUserId) return;
    if (excludeUserId && Number(userId) === excludeUserId) return;
    streamSet.forEach((res) => sendChatSseEvent(res, eventName, payload));
  });
}

function getChatTypingBucket(threadId) {
  const key = getChatThreadKey(threadId);
  let bucket = chatRealtimeState.typingByThread.get(key);
  if (!bucket) {
    bucket = new Map();
    chatRealtimeState.typingByThread.set(key, bucket);
  }
  return bucket;
}

function setChatTypingState(threadId, userId, displayName) {
  const normalizedUserId = Number(userId) || 0;
  if (!normalizedUserId) return;
  const bucket = getChatTypingBucket(threadId);
  bucket.set(normalizedUserId, {
    userId: normalizedUserId,
    displayName: String(displayName || '').trim(),
    updatedAt: Date.now()
  });
}

function clearChatTypingState(threadId, userId) {
  const key = getChatThreadKey(threadId);
  const bucket = chatRealtimeState.typingByThread.get(key);
  if (!bucket) return;
  bucket.delete(Number(userId) || 0);
  if (bucket.size === 0) {
    chatRealtimeState.typingByThread.delete(key);
  }
}

function listActiveChatTypers(threadId, excludeUserId = 0) {
  const key = getChatThreadKey(threadId);
  const bucket = chatRealtimeState.typingByThread.get(key);
  if (!bucket) return [];
  const now = Date.now();
  const normalizedExcludeUserId = Number(excludeUserId) || 0;
  const activeTypers = [];

  bucket.forEach((entry, userId) => {
    if (!entry || now - Number(entry.updatedAt || 0) > CHAT_TYPING_TTL_MS) {
      bucket.delete(userId);
      return;
    }
    if (normalizedExcludeUserId && Number(userId) === normalizedExcludeUserId) {
      return;
    }
    activeTypers.push({
      userId: Number(userId) || 0,
      displayName: entry.displayName || ''
    });
  });

  if (bucket.size === 0) {
    chatRealtimeState.typingByThread.delete(key);
  }

  return activeTypers;
}

function registerChatRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    csrfMiddleware,
    getCompanyId,
    setFlash
  } = deps;

  initializeChatModule(db);

  const chatUploadRoot = path.resolve(path.join(STORAGE_UPLOADS_DIR, 'chat'));
  const chatProfileUploadRoot = path.resolve(path.join(chatUploadRoot, 'profiles'));
  ensureDir(chatUploadRoot);
  ensureDir(chatProfileUploadRoot);

  const chatUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, chatUploadRoot),
      filename: (req, file, cb) => {
        const ext = safeExtension(file && file.originalname);
        const token = crypto.randomBytes(10).toString('hex');
        cb(null, `${Date.now()}-${token}${ext}`);
      }
    }),
    limits: { fileSize: CHAT_ATTACHMENT_LIMIT_BYTES },
    fileFilter: (req, file, cb) => cb(null, true)
  });

  const chatProfilePhotoUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, chatProfileUploadRoot),
      filename: (req, file, cb) => {
        const ext = safeExtension(file && file.originalname);
        const token = crypto.randomBytes(10).toString('hex');
        cb(null, `${Date.now()}-${token}${ext}`);
      }
    }),
    limits: { fileSize: CHAT_PROFILE_PHOTO_LIMIT_BYTES },
    fileFilter: (req, file, cb) => {
      if (isAllowedChatProfilePhoto(file)) return cb(null, true);
      const err = new Error('Tipo de imagen no permitido');
      err.code = 'CHAT_PROFILE_FILETYPE';
      return cb(err);
    }
  });

  const dbGet = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });

  const dbAll = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });

  const dbRun = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) return reject(err);
        return resolve({ lastID: this.lastID, changes: this.changes });
      });
    });

  const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  const getCurrentUserId = (req) => {
    const parsed = Number(req.session && req.session.user ? req.session.user.id : null);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };

  const wantsJsonResponse = (req) => {
    const requestedWith = trimText(req.get('x-requested-with')).toLowerCase();
    const accept = trimText(req.get('accept')).toLowerCase();
    return requestedWith === 'xmlhttprequest' || accept.includes('application/json');
  };

  const respondChatError = (req, res, statusCode, message, redirectUrl) => {
    if (wantsJsonResponse(req)) {
      return res.status(statusCode).json({
        ok: false,
        error: message
      });
    }
    if (statusCode >= 400 && statusCode < 500 && redirectUrl) {
      setFlash(req, 'error', message);
      return res.redirect(redirectUrl);
    }
    return res.status(statusCode).send(message);
  };

  const chatDisplayNameExpr = (alias) => `COALESCE(NULLIF(TRIM(${alias}.chat_display_name), ''), ${alias}.username)`;
  const chatPresenceExpr = (alias) => `CASE
      WHEN LOWER(COALESCE(${alias}.chat_presence_status, '')) IN ('online', 'busy', 'away')
        THEN LOWER(${alias}.chat_presence_status)
      ELSE 'online'
    END`;

  const singleAttachmentUpload = (req, res, next) => {
    chatUpload.single('attachment')(req, res, (err) => {
      if (!err) return next();
      const redirectUrl = Number(req.params && req.params.threadId) > 0 ? `/chat/${Number(req.params.threadId)}` : '/chat';
      const message = mapUploadError(err);
      if (wantsJsonResponse(req)) {
        return res.status(400).json({
          ok: false,
          error: message
        });
      }
      setFlash(req, 'error', message);
      return res.redirect(redirectUrl);
    });
  };

  const singleProfilePhotoUpload = (req, res, next) => {
    chatProfilePhotoUpload.single('profile_photo')(req, res, (err) => {
      if (!err) return next();
      const nextPath = safeInternalPath(req.body && req.body.next) || '/chat';
      const onboarding = toBoolean(req.body && req.body.onboarding);
      const redirectUrl = buildChatSettingsRedirectUrl(nextPath, onboarding);
      const message = mapProfileUploadError(err);
      setFlash(req, 'error', message);
      return res.redirect(redirectUrl);
    });
  };

  async function getUserById(companyId, userId) {
    return dbGet(
      `SELECT id,
              username,
              role,
              is_active,
              users.chat_display_name AS raw_display_name,
              ${chatDisplayNameExpr('users')} AS display_name,
              ${chatPresenceExpr('users')} AS presence_status,
              users.chat_profile_photo_path AS profile_photo_path,
              users.chat_profile_completed_at AS profile_completed_at
       FROM users
       WHERE id = ? AND company_id = ?`,
      [userId, companyId]
    );
  }

  async function findThreadForParticipants(companyId, userOneId, userTwoId) {
    return dbGet(
      `SELECT t.*,
              CASE WHEN t.participant_one_id = ? THEN t.participant_two_id ELSE t.participant_one_id END AS other_user_id,
              ${chatDisplayNameExpr('other')} AS other_display_name,
              other.username AS other_username,
              other.role AS other_role,
              ${chatPresenceExpr('other')} AS other_presence_status,
              other.chat_profile_photo_path AS other_profile_photo_path
       FROM chat_threads t
       JOIN users other
         ON other.id = CASE WHEN t.participant_one_id = ? THEN t.participant_two_id ELSE t.participant_one_id END
        AND other.company_id = t.company_id
       WHERE t.company_id = ?
         AND (
           (t.participant_one_id = ? AND t.participant_two_id = ?)
           OR
           (t.participant_one_id = ? AND t.participant_two_id = ?)
         )
       ORDER BY t.id ASC
       LIMIT 1`,
      [userOneId, userOneId, companyId, userOneId, userTwoId, userTwoId, userOneId]
    );
  }

  async function ensureThreadAccess(companyId, threadId, userId) {
    return dbGet(
      `SELECT t.*,
              CASE WHEN t.participant_one_id = ? THEN t.participant_two_id ELSE t.participant_one_id END AS other_user_id,
              ${chatDisplayNameExpr('other')} AS other_display_name,
              other.username AS other_username,
              other.role AS other_role,
              ${chatPresenceExpr('other')} AS other_presence_status,
              other.chat_profile_photo_path AS other_profile_photo_path
       FROM chat_threads t
       JOIN users other
         ON other.id = CASE WHEN t.participant_one_id = ? THEN t.participant_two_id ELSE t.participant_one_id END
        AND other.company_id = t.company_id
       WHERE t.id = ?
         AND t.company_id = ?
         AND (t.participant_one_id = ? OR t.participant_two_id = ?)
       LIMIT 1`,
      [userId, userId, threadId, companyId, userId, userId]
    );
  }

  async function getRecentThreads(companyId, userId) {
    return dbAll(
      `SELECT t.id,
              t.company_id,
              t.created_by,
              t.participant_one_id,
              t.participant_two_id,
              t.created_at,
              t.updated_at,
              CASE WHEN t.participant_one_id = ? THEN t.participant_two_id ELSE t.participant_one_id END AS other_user_id,
              ${chatDisplayNameExpr('other')} AS other_display_name,
              other.username AS other_username,
              other.role AS other_role,
              ${chatPresenceExpr('other')} AS other_presence_status,
              other.chat_profile_photo_path AS other_profile_photo_path,
              (
                SELECT body
                FROM chat_messages m
                WHERE m.thread_id = t.id AND m.company_id = t.company_id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS last_message_body,
              (
                SELECT ca.original_name
                FROM chat_messages m
                LEFT JOIN chat_attachments ca ON ca.id = m.attachment_id AND ca.company_id = m.company_id
                WHERE m.thread_id = t.id AND m.company_id = t.company_id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS last_attachment_name,
              (
                SELECT ca.mime_type
                FROM chat_messages m
                LEFT JOIN chat_attachments ca ON ca.id = m.attachment_id AND ca.company_id = m.company_id
                WHERE m.thread_id = t.id AND m.company_id = t.company_id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS last_attachment_mime,
              (
                SELECT m.created_at
                FROM chat_messages m
                WHERE m.thread_id = t.id AND m.company_id = t.company_id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS last_message_at,
              (
                SELECT COUNT(*)
                FROM chat_messages m
                WHERE m.thread_id = t.id
                  AND m.company_id = t.company_id
                  AND m.receiver_id = ?
                  AND m.is_read = 0
              ) AS unread_count
       FROM chat_threads t
       JOIN users other
         ON other.id = CASE WHEN t.participant_one_id = ? THEN t.participant_two_id ELSE t.participant_one_id END
        AND other.company_id = t.company_id
       WHERE t.company_id = ?
         AND (t.participant_one_id = ? OR t.participant_two_id = ?)
       ORDER BY COALESCE(
         (
           SELECT m.created_at
           FROM chat_messages m
           WHERE m.thread_id = t.id AND m.company_id = t.company_id
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT 1
         ),
         t.updated_at,
         t.created_at
       ) DESC,
       t.id DESC`,
      [userId, userId, userId, companyId, userId, userId]
    );
  }

  async function getCompanyUsers(companyId, currentUserId) {
    return dbAll(
      `SELECT id,
              username,
              role,
              is_active,
              ${chatDisplayNameExpr('users')} AS display_name,
              ${chatPresenceExpr('users')} AS presence_status,
              users.chat_profile_photo_path AS profile_photo_path
       FROM users
       WHERE company_id = ?
         AND id != ?
         AND is_active = 1
       ORDER BY ${chatDisplayNameExpr('users')} COLLATE NOCASE ASC`,
      [companyId, currentUserId]
    );
  }

  async function getThreadMessages(companyId, threadId) {
    return dbAll(
      `SELECT m.id,
              m.company_id,
              m.thread_id,
              m.sender_id,
              m.receiver_id,
              m.body,
              m.attachment_id,
              m.is_read,
              m.read_at,
              m.created_at,
              ${chatDisplayNameExpr('sender')} AS sender_display_name,
              sender.username AS sender_username,
              ${chatDisplayNameExpr('receiver')} AS receiver_display_name,
              receiver.username AS receiver_username,
              sender.chat_profile_photo_path AS sender_profile_photo_path,
              receiver.chat_profile_photo_path AS receiver_profile_photo_path,
              ca.original_name,
              ca.stored_name,
              ca.mime_type,
              ca.size_bytes,
              ca.file_path
       FROM chat_messages m
       JOIN users sender ON sender.id = m.sender_id AND sender.company_id = m.company_id
       JOIN users receiver ON receiver.id = m.receiver_id AND receiver.company_id = m.company_id
       LEFT JOIN chat_attachments ca ON ca.id = m.attachment_id AND ca.company_id = m.company_id
       WHERE m.company_id = ?
         AND m.thread_id = ?
       ORDER BY m.created_at ASC, m.id ASC`,
      [companyId, threadId]
    );
  }

  async function getMessageById(companyId, messageId) {
    return dbGet(
      `SELECT m.id,
              m.company_id,
              m.thread_id,
              m.sender_id,
              m.receiver_id,
              m.body,
              m.attachment_id,
              m.is_read,
              m.read_at,
              m.created_at,
              ${chatDisplayNameExpr('sender')} AS sender_display_name,
              sender.username AS sender_username,
              ${chatDisplayNameExpr('receiver')} AS receiver_display_name,
              receiver.username AS receiver_username,
              sender.chat_profile_photo_path AS sender_profile_photo_path,
              receiver.chat_profile_photo_path AS receiver_profile_photo_path,
              ca.original_name,
              ca.stored_name,
              ca.mime_type,
              ca.size_bytes,
              ca.file_path
       FROM chat_messages m
       JOIN users sender ON sender.id = m.sender_id AND sender.company_id = m.company_id
       JOIN users receiver ON receiver.id = m.receiver_id AND receiver.company_id = m.company_id
       LEFT JOIN chat_attachments ca ON ca.id = m.attachment_id AND ca.company_id = m.company_id
       WHERE m.company_id = ?
         AND m.id = ?
       LIMIT 1`,
      [companyId, messageId]
    );
  }

  function serializeChatMessage(message) {
    if (!message) return null;
    const attachmentId = Number(message.attachment_id || 0);
    const senderId = Number(message.sender_id || 0);
    const receiverId = Number(message.receiver_id || 0);
    return {
      id: Number(message.id || 0),
      companyId: Number(message.company_id || 0),
      threadId: Number(message.thread_id || 0),
      senderId,
      receiverId,
      senderDisplayName: message.sender_display_name || message.sender_username || '',
      senderUsername: message.sender_username || '',
      senderAvatarUrl: trimText(message.sender_profile_photo_path) ? `/chat/profile-photo/${senderId}` : null,
      receiverDisplayName: message.receiver_display_name || message.receiver_username || '',
      receiverUsername: message.receiver_username || '',
      receiverAvatarUrl: trimText(message.receiver_profile_photo_path) ? `/chat/profile-photo/${receiverId}` : null,
      body: message.body || '',
      isRead: Number(message.is_read) === 1,
      readAt: message.read_at || null,
      createdAt: message.created_at || null,
      attachment: attachmentId > 0 ? {
        id: attachmentId,
        originalName: message.original_name || message.stored_name || 'archivo',
        mimeType: message.mime_type || 'application/octet-stream',
        sizeBytes: Number(message.size_bytes || 0),
        isAudio: isAudioAttachment(message.mime_type, message.original_name || message.stored_name || ''),
        isImage: isImageAttachment(message.mime_type, message.original_name || message.stored_name || ''),
        isVideo: isVideoAttachment(message.mime_type, message.original_name || message.stored_name || ''),
        downloadUrl: `/chat/attachments/${attachmentId}/download`
      } : null
    };
  }

  async function markThreadRead(companyId, threadId, userId) {
    await dbRun(
      `UPDATE chat_messages
       SET is_read = 1,
           read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
       WHERE company_id = ?
         AND thread_id = ?
         AND receiver_id = ?
         AND is_read = 0`,
      [companyId, threadId, userId]
    );

    await dbRun(
      `UPDATE notifications
       SET is_read = 1,
           read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
       WHERE company_id = ?
         AND user_id = ?
         AND type = ?
         AND link_url = ?
         AND is_read = 0`,
      [companyId, userId, CHAT_NOTIFICATION_TYPE, `/chat/${threadId}`]
    );
  }

  async function createNotification(entry) {
    const companyId = Number(entry && entry.companyId);
    const userId = Number(entry && entry.userId);
    const type = trimText(entry && entry.type);
    const title = trimText(entry && entry.title);
    const message = trimText(entry && entry.message);
    const linkUrl = trimText(entry && entry.linkUrl);
    if (!companyId || !userId || !type || !title) return;
    await dbRun(
      `INSERT INTO notifications (company_id, user_id, type, title, message, link_url, is_read)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [companyId, userId, type, title, message || null, linkUrl || null]
    );
  }

  async function fetchNotifications(companyId, userId, filter) {
    const where = ['company_id = ?', 'user_id = ?'];
    const params = [companyId, userId];
    if (filter === 'unread') {
      where.push('is_read = 0');
    } else if (filter === 'read') {
      where.push('is_read = 1');
    }

    return dbAll(
      `SELECT id,
              company_id,
              user_id,
              type,
              title,
              message,
              link_url,
              is_read,
              created_at,
              read_at
       FROM notifications
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC`,
      params
    );
  }

  async function fetchNotificationCounts(companyId, userId) {
    const [all, unread, read] = await Promise.all([
      dbGet('SELECT COUNT(*) AS total FROM notifications WHERE company_id = ? AND user_id = ?', [companyId, userId]),
      dbGet('SELECT COUNT(*) AS total FROM notifications WHERE company_id = ? AND user_id = ? AND is_read = 0', [companyId, userId]),
      dbGet('SELECT COUNT(*) AS total FROM notifications WHERE company_id = ? AND user_id = ? AND is_read = 1', [companyId, userId])
    ]);

    return {
      all: Number(all && all.total) || 0,
      unread: Number(unread && unread.total) || 0,
      read: Number(read && read.total) || 0
    };
  }

  function buildChatSettingsRedirectUrl(nextPath, onboarding) {
    const safeNext = safeInternalPath(nextPath) || '/chat';
    const params = new URLSearchParams();
    params.set('next', safeNext);
    if (onboarding) {
      params.set('onboarding', '1');
    }
    return `/chat/settings?${params.toString()}`;
  }

  function getChatProfileRedirectUrl(req, fallbackPath) {
    const nextPath = safeInternalPath(fallbackPath) || safeInternalPath(req.originalUrl) || '/chat';
    return buildChatSettingsRedirectUrl(nextPath, true);
  }

  function syncSessionChatProfile(req, profile) {
    if (!req.session || !req.session.user || !profile) return;
    req.session.user.chat_display_name = profile.display_name || profile.username || '';
    req.session.user.chat_presence_status = normalizeChatPresenceStatus(profile.presence_status);
    req.session.user.chat_profile_photo_path = profile.profile_photo_path || null;
    req.session.user.chat_profile_completed_at = profile.profile_completed_at || null;
  }

  async function loadCurrentChatProfile(companyId, userId) {
    return getUserById(companyId, userId);
  }

  async function ensureChatProfileReady(req, res, companyId, currentUserId, fallbackPath) {
    const currentProfile = await loadCurrentChatProfile(companyId, currentUserId);
    if (!currentProfile) {
      respondChatError(req, res, 403, 'No se pudo cargar tu perfil de chat.', '/dashboard');
      return null;
    }
    syncSessionChatProfile(req, currentProfile);
    if (!isChatProfileComplete(currentProfile)) {
      if (wantsJsonResponse(req)) {
        res.status(409).json({
          ok: false,
          error: 'Completa tu perfil de chat antes de continuar.',
          redirectUrl: getChatProfileRedirectUrl(req, fallbackPath || '/chat')
        });
      } else {
        setFlash(req, 'error', 'Completa tu perfil de chat antes de usar las conversaciones.');
        res.redirect(getChatProfileRedirectUrl(req, fallbackPath || '/chat'));
      }
      return null;
    }
    return currentProfile;
  }

  app.get('/chat/settings', requireAuth, requirePermission('chat', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const chatProfile = await loadCurrentChatProfile(companyId, currentUserId);
    if (!chatProfile) {
      setFlash(req, 'error', 'No se pudo cargar tu perfil de chat.');
      return res.redirect('/dashboard');
    }

    syncSessionChatProfile(req, chatProfile);

    res.render('chat/settings', {
      chatProfile,
      chatProfileOnboarding: toBoolean(req.query.onboarding),
      chatProfileNext: safeInternalPath(req.query.next) || '/chat',
      chatPresenceChoices: ['online', 'busy', 'away']
    });
  }));

  app.post('/chat/settings', requireAuth, requirePermission('chat', 'view'), singleProfilePhotoUpload, csrfMiddleware, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const nextUrl = safeInternalPath(req.body.next) || '/chat';
    const onboarding = toBoolean(req.body.onboarding);
    const redirectUrl = buildChatSettingsRedirectUrl(nextUrl, onboarding);
    const currentProfile = await loadCurrentChatProfile(companyId, currentUserId);

    if (!currentProfile) {
      setFlash(req, 'error', 'No se pudo cargar tu perfil de chat.');
      return res.redirect('/dashboard');
    }

    const displayName = trimText(req.body.display_name);
    if (!displayName) {
      setFlash(req, 'error', 'Debes indicar el nombre que deseas mostrar en el chat.');
      return res.redirect(redirectUrl);
    }

    const presenceStatus = normalizeChatPresenceStatus(req.body.presence_status);
    const removePhoto = toBoolean(req.body.remove_photo);
    const previousPhotoPath = trimText(currentProfile.profile_photo_path) || null;
    const nextPhotoPath = req.file ? req.file.path : (removePhoto ? null : previousPhotoPath);

    await dbRun(
      `UPDATE users
       SET chat_display_name = ?,
           chat_presence_status = ?,
           chat_profile_photo_path = ?,
           chat_profile_completed_at = COALESCE(chat_profile_completed_at, CURRENT_TIMESTAMP)
       WHERE id = ? AND company_id = ?`,
      [displayName, presenceStatus, nextPhotoPath, currentUserId, companyId]
    );

    if (previousPhotoPath && previousPhotoPath !== nextPhotoPath) {
      safeUnlink(previousPhotoPath, chatProfileUploadRoot);
    }

    const updatedProfile = await loadCurrentChatProfile(companyId, currentUserId);
    syncSessionChatProfile(req, updatedProfile);

    setFlash(req, 'success', onboarding ? 'Perfil de chat configurado correctamente.' : 'Configuracion del chat guardada.');
    return res.redirect(nextUrl);
  }));

  app.get('/chat/profile-photo/:userId', requireAuth, requirePermission('chat', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const userId = Number(req.params.userId || 0);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(404).send('Imagen no encontrada.');
    }

    const profile = await loadCurrentChatProfile(companyId, userId);
    const filePath = profile ? trimText(profile.profile_photo_path) : '';
    if (!filePath || !isSafeFilePath(chatProfileUploadRoot, filePath) || !fs.existsSync(filePath)) {
      return res.status(404).send('Imagen no encontrada.');
    }

    return res.sendFile(filePath);
  }));

  app.get('/chat', requireAuth, requirePermission('chat', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const currentProfile = await ensureChatProfileReady(req, res, companyId, currentUserId, '/chat');
    if (!currentProfile) return;
    const chatView = trimText(req.query && req.query.view).toLowerCase() === 'new'
      ? 'new'
      : 'conversations';

    const [threads, users] = await Promise.all([
      getRecentThreads(companyId, currentUserId),
      chatView === 'new' ? getCompanyUsers(companyId, currentUserId) : Promise.resolve([])
    ]);

    res.render('chat/index', {
      chatThreads: threads,
      chatUsers: users,
      chatView,
      selectedThread: null,
      chatMessages: [],
      chatCurrentUserId: currentUserId,
      chatCurrentUserProfile: currentProfile,
      chatUploadLimitMb: Math.floor(CHAT_ATTACHMENT_LIMIT_BYTES / (1024 * 1024))
    });
  }));

  app.get('/chat/:threadId', requireAuth, requirePermission('chat', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const threadId = Number(req.params.threadId || 0);

    if (!Number.isInteger(threadId) || threadId <= 0) {
      setFlash(req, 'error', 'Conversacion invalida.');
      return res.redirect('/chat');
    }

    const currentProfile = await ensureChatProfileReady(req, res, companyId, currentUserId, `/chat/${threadId}`);
    if (!currentProfile) return;

    const thread = await ensureThreadAccess(companyId, threadId, currentUserId);
    if (!thread) {
      return res.status(403).send('No tienes acceso a esta conversacion.');
    }

    await markThreadRead(companyId, threadId, currentUserId);

    const [threads, messages] = await Promise.all([
      getRecentThreads(companyId, currentUserId),
      getThreadMessages(companyId, threadId)
    ]);

    res.render('chat/thread', {
      chatThreads: threads,
      chatUsers: [],
      chatView: 'conversations',
      selectedThread: thread,
      chatMessages: messages,
      chatCurrentUserId: currentUserId,
      chatCurrentUserProfile: currentProfile,
      chatUploadLimitMb: Math.floor(CHAT_ATTACHMENT_LIMIT_BYTES / (1024 * 1024))
    });
  }));

  app.get('/chat/:threadId/stream', requireAuth, requirePermission('chat', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const threadId = Number(req.params.threadId || 0);

    if (!Number.isInteger(threadId) || threadId <= 0) {
      return respondChatError(req, res, 404, 'Conversacion invalida.');
    }

    const thread = await ensureThreadAccess(companyId, threadId, currentUserId);
    if (!thread) {
      return respondChatError(req, res, 403, 'No tienes acceso a esta conversacion.');
    }

    await markThreadRead(companyId, threadId, currentUserId);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    addChatStream(threadId, currentUserId, res);
    sendChatSseEvent(res, 'ready', {
      ok: true,
      threadId,
      userId: currentUserId,
      activeTypers: listActiveChatTypers(threadId, currentUserId)
    });

    const keepAlive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepAlive);
        return;
      }
      res.write(': keepalive\n\n');
    }, CHAT_STREAM_KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepAlive);
      removeChatStream(threadId, currentUserId, res);
      clearChatTypingState(threadId, currentUserId);
      broadcastChatThreadEvent(threadId, 'typing', {
        threadId,
        userId: currentUserId,
        active: false
      }, { excludeUserId: currentUserId });
      if (!res.writableEnded) {
        res.end();
      }
    });
  }));

  app.post('/chat/start', requireAuth, requirePermission('chat', 'create'), csrfMiddleware, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const currentProfile = await ensureChatProfileReady(req, res, companyId, currentUserId, '/chat');
    if (!currentProfile) return;

    const targetUserId = Number(req.body.user_id || 0);

    if (!Number.isInteger(targetUserId) || targetUserId <= 0 || targetUserId === currentUserId) {
      setFlash(req, 'error', 'Selecciona un usuario valido para iniciar el chat.');
      return res.redirect('/chat');
    }

    const targetUser = await getUserById(companyId, targetUserId);
    if (!targetUser || Number(targetUser.is_active) === 0) {
      setFlash(req, 'error', 'El usuario seleccionado no pertenece a esta empresa o esta inactivo.');
      return res.redirect('/chat');
    }

    let thread = await findThreadForParticipants(companyId, currentUserId, targetUserId);
    if (!thread) {
      const participantOneId = Math.min(currentUserId, targetUserId);
      const participantTwoId = Math.max(currentUserId, targetUserId);
      const insertResult = await dbRun(
        `INSERT INTO chat_threads (
          company_id,
          created_by,
          participant_one_id,
          participant_two_id
        ) VALUES (?, ?, ?, ?)`,
        [companyId, currentUserId, participantOneId, participantTwoId]
      );
      thread = await ensureThreadAccess(companyId, insertResult.lastID, currentUserId);
    }

    return res.redirect(`/chat/${thread.id}`);
  }));

  app.post('/chat/:threadId/message', requireAuth, requirePermission('chat', 'create'), singleAttachmentUpload, csrfMiddleware, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const currentProfile = await ensureChatProfileReady(req, res, companyId, currentUserId, `/chat/${Number(req.params.threadId || 0)}`);
    if (!currentProfile) return;

    const threadId = Number(req.params.threadId || 0);
    const body = trimText(req.body.body);

    if (!Number.isInteger(threadId) || threadId <= 0) {
      return respondChatError(req, res, 400, 'Conversacion invalida.', '/chat');
    }

    const thread = await ensureThreadAccess(companyId, threadId, currentUserId);
    if (!thread) {
      return respondChatError(req, res, 403, 'No tienes acceso a esta conversacion.');
    }

    if (!body && !req.file) {
      return respondChatError(req, res, 400, 'Escribe un mensaje o adjunta un archivo antes de enviar.', `/chat/${threadId}`);
    }

    const receiverId = Number(thread.other_user_id || 0);
    if (!Number.isInteger(receiverId) || receiverId <= 0) {
      return respondChatError(req, res, 400, 'No se pudo resolver el destinatario de la conversacion.', `/chat/${threadId}`);
    }

    const insertMessage = await dbRun(
      `INSERT INTO chat_messages (
        company_id,
        thread_id,
        sender_id,
        receiver_id,
        body,
        attachment_id,
        is_read
      ) VALUES (?, ?, ?, ?, ?, NULL, 0)`,
      [companyId, threadId, currentUserId, receiverId, body || null]
    );

    let attachmentId = null;
    if (req.file) {
      const insertAttachment = await dbRun(
        `INSERT INTO chat_attachments (
          company_id,
          message_id,
          original_name,
          stored_name,
          mime_type,
          size_bytes,
          file_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          insertMessage.lastID,
          req.file.originalname || req.file.filename,
          req.file.filename,
          req.file.mimetype || 'application/octet-stream',
          Number(req.file.size) || 0,
          req.file.path
        ]
      );
      attachmentId = insertAttachment.lastID;

      await dbRun(
        `UPDATE chat_messages
         SET attachment_id = ?
         WHERE id = ? AND company_id = ?`,
        [attachmentId, insertMessage.lastID, companyId]
      );
    }

    await dbRun(
      `UPDATE chat_threads
       SET updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [threadId, companyId]
    );

    const receiverIsActiveInThread = hasActiveChatStream(threadId, receiverId);
    if (receiverIsActiveInThread) {
      await dbRun(
        `UPDATE chat_messages
         SET is_read = 1,
             read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE id = ?
           AND company_id = ?
           AND receiver_id = ?`,
        [insertMessage.lastID, companyId, receiverId]
      );
    }

    const sender = await getUserById(companyId, currentUserId);
    const preview = body || buildChatAttachmentPreview(req.file);
    if (!receiverIsActiveInThread) {
      await createNotification({
        companyId,
        userId: receiverId,
        type: CHAT_NOTIFICATION_TYPE,
        title: `Nuevo mensaje de ${sender ? (sender.display_name || sender.username) : 'un usuario'}`,
        message: preview.slice(0, 220),
        linkUrl: `/chat/${threadId}`
      });
    }

    const createdMessage = await getMessageById(companyId, insertMessage.lastID);
    const serializedMessage = serializeChatMessage(createdMessage);

    broadcastChatThreadEvent(threadId, 'message-created', {
      ok: true,
      threadId,
      message: serializedMessage
    });
    clearChatTypingState(threadId, currentUserId);
    broadcastChatThreadEvent(threadId, 'typing', {
      threadId,
      userId: currentUserId,
      active: false
    }, { excludeUserId: currentUserId });

    if (wantsJsonResponse(req)) {
      return res.json({
        ok: true,
        threadId,
        message: serializedMessage
      });
    }

    return res.redirect(`/chat/${threadId}`);
  }));

  app.post('/chat/:threadId/typing', requireAuth, requirePermission('chat', 'create'), csrfMiddleware, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const threadId = Number(req.params.threadId || 0);
    const currentProfile = await ensureChatProfileReady(req, res, companyId, currentUserId, `/chat/${threadId}`);
    if (!currentProfile) return;

    if (!Number.isInteger(threadId) || threadId <= 0) {
      return respondChatError(req, res, 400, 'Conversacion invalida.');
    }

    const thread = await ensureThreadAccess(companyId, threadId, currentUserId);
    if (!thread) {
      return respondChatError(req, res, 403, 'No tienes acceso a esta conversacion.');
    }

    const active = toBoolean(req.body && req.body.active);
    if (active) {
      setChatTypingState(threadId, currentUserId, currentProfile.display_name || currentProfile.username || '');
    } else {
      clearChatTypingState(threadId, currentUserId);
    }

    broadcastChatThreadEvent(threadId, 'typing', {
      threadId,
      userId: currentUserId,
      displayName: currentProfile.display_name || currentProfile.username || '',
      active
    }, { excludeUserId: currentUserId });

    return res.json({ ok: true });
  }));

  app.get('/chat/attachments/:id/download', requireAuth, requirePermission('chat', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const attachmentId = Number(req.params.id || 0);

    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      return res.status(404).send('Adjunto no encontrado.');
    }

    const attachment = await dbGet(
      `SELECT ca.id,
              ca.original_name,
              ca.file_path,
              cm.thread_id
       FROM chat_attachments ca
       JOIN chat_messages cm ON cm.id = ca.message_id AND cm.company_id = ca.company_id
       JOIN chat_threads ct ON ct.id = cm.thread_id AND ct.company_id = cm.company_id
       WHERE ca.id = ?
         AND ca.company_id = ?
         AND (
           ct.participant_one_id = ?
           OR
           ct.participant_two_id = ?
         )
       LIMIT 1`,
      [attachmentId, companyId, currentUserId, currentUserId]
    );

    if (!attachment || !isSafeFilePath(chatUploadRoot, attachment.file_path) || !fs.existsSync(attachment.file_path)) {
      return res.status(404).send('Adjunto no encontrado.');
    }

    return res.download(attachment.file_path, attachment.original_name || path.basename(attachment.file_path));
  }));

  app.get('/notifications', requireAuth, requirePermission('notifications', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const filter = normalizeNotificationFilter(req.query.filter);
    const [notifications, counts] = await Promise.all([
      fetchNotifications(companyId, currentUserId, filter),
      fetchNotificationCounts(companyId, currentUserId)
    ]);

    res.render('notifications/index', {
      notifications,
      notificationFilter: filter,
      notificationCounts: counts
    });
  }));

  app.post('/notifications/:id/read', requireAuth, requirePermission('notifications', 'view'), csrfMiddleware, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const notificationId = Number(req.params.id || 0);
    const nextUrl = safeInternalPath(req.body.next) || '/notifications';

    if (Number.isInteger(notificationId) && notificationId > 0) {
      await dbRun(
        `UPDATE notifications
         SET is_read = 1,
             read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE id = ?
           AND company_id = ?
           AND user_id = ?`,
        [notificationId, companyId, currentUserId]
      );
    }

    return res.redirect(nextUrl);
  }));

  app.post('/notifications/read-all', requireAuth, requirePermission('notifications', 'view'), csrfMiddleware, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const nextUrl = safeInternalPath(req.body.next) || '/notifications';

    await dbRun(
      `UPDATE notifications
       SET is_read = 1,
           read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
       WHERE company_id = ?
         AND user_id = ?
         AND is_read = 0`,
      [companyId, currentUserId]
    );

    return res.redirect(nextUrl);
  }));

  app.get('/api/notifications/unread-count', requireAuth, requirePermission('notifications', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const countRow = await dbGet(
      `SELECT COUNT(*) AS total
       FROM notifications
       WHERE company_id = ?
         AND user_id = ?
         AND is_read = 0`,
      [companyId, currentUserId]
    );

    return res.json({
      ok: true,
      unreadCount: Number(countRow && countRow.total) || 0
    });
  }));

  app.get('/api/notifications/latest', requireAuth, requirePermission('notifications', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const currentUserId = getCurrentUserId(req);
    const rows = await dbAll(
      `SELECT id,
              type,
              title,
              message,
              link_url,
              is_read,
              created_at,
              read_at
       FROM notifications
       WHERE company_id = ?
         AND user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 8`,
      [companyId, currentUserId]
    );

    return res.json({
      ok: true,
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        message: row.message,
        link_url: row.link_url || '/notifications',
        is_read: Number(row.is_read) === 1,
        created_at: row.created_at,
        read_at: row.read_at
      }))
    });
  }));
}

function initializeChatModule(db) {
  if (isChatModuleInitialized) return;
  isChatModuleInitialized = true;

  const ensureColumns = (table, columns) => {
    const safeTable = escapeSqlIdentifier(table);
    db.all(`PRAGMA table_info(${safeTable})`, (err, rows) => {
      if (err || !Array.isArray(rows)) return;
      const existing = new Set(rows.map((row) => row.name));
      columns.forEach((column) => {
        if (!column || !column.name || existing.has(column.name)) return;
        const safeColumn = escapeSqlIdentifier(column.name);
        db.run(`ALTER TABLE ${safeTable} ADD COLUMN ${safeColumn} ${column.type}`, (alterErr) => {
          if (alterErr && !isDuplicateColumnError(alterErr)) {
            console.error(`[chat] could not add column ${safeTable}.${safeColumn}`, alterErr.message);
          }
        });
      });
    });
  };

  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        participant_one_id INTEGER NOT NULL,
        participant_two_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        body TEXT,
        attachment_id INTEGER,
        is_read INTEGER NOT NULL DEFAULT 0,
        read_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS chat_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        file_path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        link_url TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        read_at DATETIME
      )`
    );

    ensureColumns('users', [
      { name: 'chat_display_name', type: 'TEXT' },
      { name: 'chat_presence_status', type: "TEXT NOT NULL DEFAULT 'offline'" },
      { name: 'chat_profile_photo_path', type: 'TEXT' },
      { name: 'chat_profile_completed_at', type: 'DATETIME' }
    ]);

    ensureColumns('chat_threads', [
      { name: 'company_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'created_by', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'participant_one_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'participant_two_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]);

    ensureColumns('chat_messages', [
      { name: 'company_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'thread_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'sender_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'receiver_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'body', type: 'TEXT' },
      { name: 'attachment_id', type: 'INTEGER' },
      { name: 'is_read', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'read_at', type: 'DATETIME' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]);

    ensureColumns('chat_attachments', [
      { name: 'company_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'message_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'original_name', type: 'TEXT' },
      { name: 'stored_name', type: 'TEXT' },
      { name: 'mime_type', type: 'TEXT' },
      { name: 'size_bytes', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'file_path', type: 'TEXT' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]);

    ensureColumns('notifications', [
      { name: 'company_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'user_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'type', type: 'TEXT' },
      { name: 'title', type: 'TEXT' },
      { name: 'message', type: 'TEXT' },
      { name: 'link_url', type: 'TEXT' },
      { name: 'is_read', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'read_at', type: 'DATETIME' }
    ]);

    db.run('CREATE INDEX IF NOT EXISTS idx_chat_threads_company ON chat_threads (company_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_threads_participants ON chat_threads (company_id, participant_one_id, participant_two_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (company_id, thread_id, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_messages_receiver ON chat_messages (company_id, receiver_id, is_read)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments (company_id, message_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (company_id, user_id, is_read, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications (company_id, type, created_at)');

    db.run(
      `INSERT INTO permission_modules (code, name, description) VALUES
       ('chat', 'Chat interno', 'Mensajeria interna entre usuarios de la misma empresa'),
       ('notifications', 'Notificaciones', 'Centro de notificaciones del sistema')
       ON CONFLICT (code) DO NOTHING`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'chat' AND pa.code IN ('view', 'create')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'notifications' AND pa.code IN ('view')`
    );
  });
}

function mapUploadError(err) {
  if (!err) return 'No se pudo cargar el archivo.';
  if (err.code === 'LIMIT_FILE_SIZE') {
    return `El archivo excede el maximo permitido de ${Math.floor(CHAT_ATTACHMENT_LIMIT_BYTES / (1024 * 1024))} MB.`;
  }
  if (err.code === 'CHAT_FILETYPE') {
    return 'Solo se permiten imagenes, audios, PDF, Word, Excel y texto plano.';
  }
  return 'No se pudo cargar el archivo adjunto.';
}

function mapProfileUploadError(err) {
  if (!err) return 'No se pudo cargar la foto.';
  if (err.code === 'LIMIT_FILE_SIZE') {
    return `La foto excede el maximo permitido de ${Math.floor(CHAT_PROFILE_PHOTO_LIMIT_BYTES / (1024 * 1024))} MB.`;
  }
  if (err.code === 'CHAT_PROFILE_FILETYPE') {
    return 'Solo se permiten imagenes JPG, PNG, WEBP o GIF.';
  }
  return 'No se pudo cargar la foto del perfil.';
}

function normalizeNotificationFilter(value) {
  const normalized = trimText(value).toLowerCase();
  if (normalized === 'unread' || normalized === 'read') return normalized;
  return 'all';
}

function safeInternalPath(value) {
  const text = trimText(value);
  if (!text || !text.startsWith('/')) return null;
  if (text.startsWith('//')) return null;
  return text;
}

function trimText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = trimText(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function ensureDir(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

function safeExtension(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return ext || '.bin';
}

function isAudioAttachment(mimeType, fileName) {
  const normalizedMime = trimText(mimeType).toLowerCase();
  if (normalizedMime.startsWith('audio/')) return true;
  const ext = safeExtension(fileName);
  return ['.webm', '.ogg', '.mp3', '.mp4', '.m4a', '.aac', '.wav'].includes(ext);
}

function isImageAttachment(mimeType, fileName) {
  const normalizedMime = trimText(mimeType).toLowerCase();
  if (normalizedMime.startsWith('image/')) return true;
  const ext = safeExtension(fileName);
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.heic', '.heif'].includes(ext);
}

function isVideoAttachment(mimeType, fileName) {
  const normalizedMime = trimText(mimeType).toLowerCase();
  if (normalizedMime.startsWith('video/')) return true;
  const ext = safeExtension(fileName);
  return ['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(ext);
}

function buildChatAttachmentPreview(file) {
  if (!file) return 'Adjunto: archivo';
  if (isImageAttachment(file.mimetype, file.originalname || file.filename)) {
    return 'Foto';
  }
  if (isVideoAttachment(file.mimetype, file.originalname || file.filename)) {
    return 'Video';
  }
  if (isAudioAttachment(file.mimetype, file.originalname || file.filename)) {
    return 'Audio de voz';
  }
  return `Adjunto: ${file.originalname || file.filename || 'archivo'}`;
}

function isAllowedChatAttachment(file) {
  return Boolean(file);
}

function isAllowedChatProfilePhoto(file) {
  const ext = safeExtension(file && file.originalname);
  if (file && file.mimetype && CHAT_PROFILE_PHOTO_MIME.has(file.mimetype)) return true;
  return CHAT_PROFILE_PHOTO_EXT.has(ext);
}

function isSafeFilePath(rootPath, filePath) {
  if (!rootPath || !filePath) return false;
  const safeRoot = path.resolve(rootPath);
  const safeFile = path.resolve(filePath);
  return safeFile === safeRoot || safeFile.startsWith(`${safeRoot}${path.sep}`);
}

function safeUnlink(filePath, rootPath) {
  if (!filePath || !rootPath) return;
  if (!isSafeFilePath(rootPath, filePath)) return;
  if (!fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    console.error('[chat] could not remove old profile photo', err.message);
  }
}

function normalizeChatPresenceStatus(value) {
  const normalized = trimText(value).toLowerCase();
  return CHAT_PRESENCE_STATUSES.has(normalized) ? normalized : 'online';
}

function isChatProfileComplete(user) {
  return Boolean(trimText(user && user.raw_display_name));
}

function isDuplicateColumnError(err) {
  if (!err || !err.message) return false;
  const message = String(err.message).toLowerCase();
  return message.includes('duplicate column') || message.includes('already exists');
}

function escapeSqlIdentifier(identifier) {
  const normalized = String(identifier || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return normalized;
}

module.exports = {
  registerChatRoutes
};
