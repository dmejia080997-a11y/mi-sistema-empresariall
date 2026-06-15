const crypto = require('crypto');
const { getLeadDetails, scrubToken } = require('./meta-graph');

function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET || '';
  if (!secret) return false;
  const signature = clean(req.get('x-hub-signature-256'));
  if (!signature.startsWith('sha256=')) return false;
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return timingSafeEqual(signature, expected);
}

async function processMetaWebhook(db, payload, signatureValid) {
  const entries = Array.isArray(payload && payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const pageId = clean(entry.id);
    const page = await getPageByPageId(db, pageId);
    const companyId = page ? Number(page.company_id) : null;
    await logRawEvent(db, companyId, pageId, detectEntryType(entry), buildEntryEventId(entry), null, payload, signatureValid, null);
    if (page && Array.isArray(entry.messaging)) {
      for (const item of entry.messaging) {
        await handleMessagingEvent(db, page, item, signatureValid);
      }
    }
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (!page) continue;
      if (change.field === 'feed') await handleFeedChange(db, page, change, signatureValid);
      if (change.field === 'leadgen') await handleLeadgenChange(db, page, change, signatureValid);
    }
  }
}

async function handleMessagingEvent(db, page, item, signatureValid) {
  const senderId = clean(item.sender && item.sender.id);
  const recipientId = clean(item.recipient && item.recipient.id);
  const message = item.message || null;
  const postback = item.postback || null;
  const eventId = clean(item.timestamp ? `${page.page_id}:messaging:${senderId}:${item.timestamp}:${message && message.mid ? message.mid : postback && postback.mid ? postback.mid : ''}` : '');
  const messageId = clean(message && message.mid) || clean(postback && postback.mid) || eventId;
  await logRawEvent(db, page.company_id, page.page_id, postback ? 'messaging_postbacks' : 'messages', eventId, messageId, item, signatureValid, null);
  if (messageId && await hasMessage(db, page.company_id, messageId, eventId)) return;

  const body = clean(message && message.text) || clean(postback && postback.title) || clean(postback && postback.payload) || '[evento de Messenger]';
  const conversation = await ensureConversation(db, {
    companyId: page.company_id,
    metaPageId: page.id,
    pageId: page.page_id,
    channel: 'messenger',
    conversationType: 'message',
    customerId: senderId,
    customerName: senderId,
    lastMessage: body
  });
  await insertMessage(db, {
    companyId: page.company_id,
    conversationId: conversation.id,
    metaPageId: page.id,
    direction: 'inbound',
    messageType: postback ? 'postback' : 'text',
    body,
    messageId,
    eventId,
    senderId,
    recipientId,
    payload: item,
    status: 'received'
  });
}

async function handleFeedChange(db, page, change, signatureValid) {
  const value = change.value || {};
  const item = clean(value.item);
  if (item !== 'comment') return;
  const commentId = clean(value.comment_id);
  const postId = clean(value.post_id);
  const eventId = clean(value.id) || `${page.page_id}:comment:${commentId}`;
  const from = value.from || {};
  const customerId = clean(from.id) || clean(value.sender_id) || commentId;
  const body = clean(value.message) || '[comentario]';
  await logRawEvent(db, page.company_id, page.page_id, 'feed/comments', eventId, commentId, change, signatureValid, null);
  if (commentId && await hasMessage(db, page.company_id, commentId, eventId)) return;
  const conversation = await ensureConversation(db, {
    companyId: page.company_id,
    metaPageId: page.id,
    pageId: page.page_id,
    channel: 'facebook_comment',
    conversationType: 'comment',
    customerId,
    customerName: clean(from.name) || customerId,
    postId,
    commentId,
    parentId: clean(value.parent_id),
    lastMessage: body
  });
  await insertMessage(db, {
    companyId: page.company_id,
    conversationId: conversation.id,
    metaPageId: page.id,
    direction: 'inbound',
    messageType: 'comment',
    body,
    messageId: commentId,
    eventId,
    senderId: customerId,
    recipientId: page.page_id,
    postId,
    commentId,
    parentId: clean(value.parent_id),
    payload: change,
    status: 'received'
  });
}

async function handleLeadgenChange(db, page, change, signatureValid) {
  const value = change.value || {};
  const leadgenId = clean(value.leadgen_id);
  if (!leadgenId) return;
  const eventId = `${page.page_id}:leadgen:${leadgenId}`;
  await logRawEvent(db, page.company_id, page.page_id, 'leadgen', eventId, leadgenId, change, signatureValid, null);
  const existing = await getDb(db, 'SELECT id FROM lead_entries WHERE company_id = ? AND leadgen_id = ? LIMIT 1', [page.company_id, leadgenId]);
  if (existing) return;
  let details = value;
  let errorMessage = null;
  try {
    details = await getLeadDetails(page, leadgenId);
  } catch (error) {
    errorMessage = scrubToken(error.message).slice(0, 1000);
  }
  const fieldData = Array.isArray(details.field_data) ? details.field_data : [];
  const customerName = findField(fieldData, ['full_name', 'nombre', 'name']) || leadgenId;
  const customerEmail = findField(fieldData, ['email', 'correo']);
  const customerPhone = findField(fieldData, ['phone_number', 'telefono', 'phone']);
  const formId = clean(details.form_id || value.form_id);
  const form = await ensureLeadForm(db, page, formId);
  const conversation = await ensureConversation(db, {
    companyId: page.company_id,
    metaPageId: page.id,
    pageId: page.page_id,
    channel: 'facebook_lead',
    conversationType: 'lead',
    customerId: leadgenId,
    customerName,
    customerEmail,
    customerPhone,
    leadgenId,
    lastMessage: customerEmail || customerPhone || 'Nuevo lead'
  });
  await runDb(
    db,
    `INSERT OR IGNORE INTO lead_entries
     (company_id, lead_form_id, conversation_id, page_id, form_id, leadgen_id, field_data_json, raw_payload_json, status, created_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [page.company_id, form ? form.id : null, conversation.id, page.page_id, formId, leadgenId, JSON.stringify(fieldData), JSON.stringify(details), clean(details.created_time) || null]
  );
  if (errorMessage) {
    await logRawEvent(db, page.company_id, page.page_id, 'leadgen_error', `${eventId}:error`, leadgenId, { error: errorMessage }, signatureValid, errorMessage);
  }
}

async function ensureConversation(db, input) {
  const existing = await getDb(
    db,
    `SELECT * FROM conversations
     WHERE company_id = ? AND channel = ? AND conversation_type = ? AND page_id = ? AND customer_id = ?
     LIMIT 1`,
    [input.companyId, input.channel, input.conversationType, input.pageId, input.customerId]
  );
  if (existing) {
    await runDb(
      db,
      `UPDATE conversations
       SET customer_name = COALESCE(NULLIF(?, ''), customer_name),
           customer_email = COALESCE(NULLIF(?, ''), customer_email),
           customer_phone = COALESCE(NULLIF(?, ''), customer_phone),
           post_id = COALESCE(NULLIF(?, ''), post_id),
           comment_id = COALESCE(NULLIF(?, ''), comment_id),
           parent_id = COALESCE(NULLIF(?, ''), parent_id),
           leadgen_id = COALESCE(NULLIF(?, ''), leadgen_id),
           status = CASE WHEN status = 'closed' THEN status ELSE 'open' END,
           last_message = ?,
           last_message_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [input.customerName, input.customerEmail, input.customerPhone, input.postId, input.commentId, input.parentId, input.leadgenId, input.lastMessage, existing.id, input.companyId]
    );
    return { ...existing, id: existing.id };
  }
  const insert = await runDb(
    db,
    `INSERT INTO conversations
     (company_id, channel, conversation_type, meta_page_id, page_id, customer_id, customer_name, customer_email, customer_phone, post_id, comment_id, parent_id, leadgen_id, status, last_message, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [input.companyId, input.channel, input.conversationType, input.metaPageId, input.pageId, input.customerId, input.customerName, input.customerEmail, input.customerPhone, input.postId, input.commentId, input.parentId, input.leadgenId, input.lastMessage]
  );
  return getDb(db, 'SELECT * FROM conversations WHERE id = ? AND company_id = ?', [insert.lastID, input.companyId]);
}

async function insertMessage(db, input) {
  await runDb(
    db,
    `INSERT OR IGNORE INTO conversation_messages
     (company_id, conversation_id, meta_page_id, direction, message_type, body, message_id, event_id, sender_id, recipient_id, post_id, comment_id, parent_id, payload_json, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [input.companyId, input.conversationId, input.metaPageId, input.direction, input.messageType, input.body, input.messageId || null, input.eventId || null, input.senderId || null, input.recipientId || null, input.postId || null, input.commentId || null, input.parentId || null, JSON.stringify(input.payload || {}), input.status || 'received', input.createdBy || null]
  );
  await runDb(
    db,
    'UPDATE conversations SET last_message = ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
    [input.body, input.conversationId, input.companyId]
  );
}

async function ensureLeadForm(db, page, formId) {
  if (!formId) return null;
  await runDb(
    db,
    `INSERT OR IGNORE INTO lead_forms (company_id, meta_page_id, page_id, form_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [page.company_id, page.id, page.page_id, formId]
  );
  return getDb(db, 'SELECT * FROM lead_forms WHERE company_id = ? AND form_id = ? LIMIT 1', [page.company_id, formId]);
}

function hasMessage(db, companyId, messageId, eventId) {
  return getDb(
    db,
    `SELECT id FROM conversation_messages
     WHERE company_id = ? AND ((message_id IS NOT NULL AND message_id = ?) OR (event_id IS NOT NULL AND event_id = ?))
     LIMIT 1`,
    [companyId, messageId || '', eventId || '']
  );
}

function getPageByPageId(db, pageId) {
  return getDb(db, 'SELECT * FROM meta_pages WHERE page_id = ? AND is_active = 1 LIMIT 1', [pageId]);
}

function logRawEvent(db, companyId, pageId, eventType, eventId, messageId, payload, signatureValid, errorMessage) {
  return runDb(
    db,
    `INSERT OR IGNORE INTO meta_webhook_events
     (company_id, page_id, event_type, event_id, message_id, payload_json, signature_valid, processed_at, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
    [companyId || null, pageId || null, eventType || 'unknown', eventId || null, messageId || null, JSON.stringify(payload || {}), signatureValid ? 1 : 0, errorMessage || null]
  ).catch((error) => {
    console.error('[meta-inbox] webhook log failed', error.message);
  });
}

function detectEntryType(entry) {
  if (Array.isArray(entry.messaging)) return 'messaging';
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  return clean(changes[0] && changes[0].field) || 'entry';
}

function buildEntryEventId(entry) {
  return clean(entry.id) ? `${entry.id}:${entry.time || Date.now()}` : '';
}

function findField(fieldData, candidates) {
  const wanted = new Set(candidates.map((item) => clean(item).toLowerCase()));
  const found = fieldData.find((entry) => wanted.has(clean(entry.name).toLowerCase()));
  const values = Array.isArray(found && found.values) ? found.values : [];
  return clean(values[0]);
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

module.exports = {
  verifyMetaSignature,
  processMetaWebhook,
  ensureConversation,
  insertMessage
};
