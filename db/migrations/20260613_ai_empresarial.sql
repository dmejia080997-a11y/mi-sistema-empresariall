CREATE TABLE IF NOT EXISTS ai_conversations (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id)
);

CREATE TABLE IF NOT EXISTS ai_tool_logs (
  id BIGSERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  parameters TEXT,
  result TEXT,
  executed_by INTEGER,
  execution_ms INTEGER NOT NULL DEFAULT 0,
  company_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_company_user ON ai_conversations (company_id, user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_tool_logs_conversation ON ai_tool_logs (conversation_id, created_at);

INSERT INTO permission_modules (code, name, description)
VALUES ('ai_empresarial', 'Asistente', 'Asistente central con herramientas internas por modulo')
ON CONFLICT DO NOTHING;

INSERT INTO permission_actions (code, name, description) VALUES
  ('view', 'Ver', 'Acceso de lectura'),
  ('create', 'Crear', 'Crear registros'),
  ('manage', 'Administrar', 'Configuraciones')
ON CONFLICT DO NOTHING;

INSERT INTO module_actions (module_id, action_id)
SELECT pm.id, pa.id
FROM permission_modules pm, permission_actions pa
WHERE pm.code = 'ai_empresarial' AND pa.code IN ('view', 'create', 'manage')
ON CONFLICT DO NOTHING;
