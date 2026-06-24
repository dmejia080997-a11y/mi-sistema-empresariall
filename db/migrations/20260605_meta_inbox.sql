CREATE TABLE IF NOT EXISTS meta_connections (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'facebook',
  access_token_encrypted TEXT,
  token_type TEXT,
  expires_at TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meta_pages (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  meta_connection_id INTEGER,
  page_id TEXT NOT NULL,
  page_name TEXT,
  page_access_token_encrypted TEXT,
  permissions TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meta_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER,
  page_id TEXT,
  event_type TEXT,
  event_id TEXT,
  message_id TEXT,
  payload_json TEXT NOT NULL,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  processed_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  conversation_type TEXT NOT NULL DEFAULT 'message',
  meta_page_id INTEGER,
  page_id TEXT,
  customer_id TEXT,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  post_id TEXT,
  comment_id TEXT,
  parent_id TEXT,
  leadgen_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_user_id INTEGER,
  last_message TEXT,
  last_message_at TIMESTAMP,
  closed_at TIMESTAMP,
  closed_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  meta_page_id INTEGER,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  message_id TEXT,
  event_id TEXT,
  sender_id TEXT,
  recipient_id TEXT,
  post_id TEXT,
  comment_id TEXT,
  parent_id TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error_message TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_assignments (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  assigned_user_id INTEGER,
  assigned_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_tags (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  conversation_id INTEGER,
  label TEXT NOT NULL,
  color TEXT DEFAULT '#2563eb',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_notes (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lead_forms (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  meta_page_id INTEGER,
  page_id TEXT,
  form_id TEXT NOT NULL,
  form_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lead_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  lead_form_id INTEGER,
  conversation_id INTEGER,
  page_id TEXT,
  form_id TEXT,
  leadgen_id TEXT NOT NULL,
  field_data_json TEXT,
  raw_payload_json TEXT,
  assigned_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  created_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meta_connections_company ON meta_connections (company_id, provider, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_pages_company_page ON meta_pages (company_id, page_id);
CREATE INDEX IF NOT EXISTS idx_meta_pages_connection ON meta_pages (company_id, meta_connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_webhook_event_id ON meta_webhook_events (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_conversations_customer_channel ON conversations (company_id, channel, conversation_type, page_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_filters ON conversations (company_id, channel, status, assigned_user_id, last_message_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_messages_message_id ON conversation_messages (company_id, message_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_messages_event_id ON conversation_messages (company_id, event_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread ON conversation_messages (company_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_tags_lookup ON conversation_tags (company_id, conversation_id, label);
CREATE INDEX IF NOT EXISTS idx_conversation_notes_thread ON conversation_notes (company_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quick_replies_company ON quick_replies (company_id, is_active, title);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_forms_company_form ON lead_forms (company_id, form_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_entries_company_lead ON lead_entries (company_id, leadgen_id);
