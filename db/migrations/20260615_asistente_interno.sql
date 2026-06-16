CREATE TABLE IF NOT EXISTS ai_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  intent_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  module_required TEXT,
  permission_required TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, intent_key)
);

CREATE TABLE IF NOT EXISTS ai_chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  intent_detected TEXT,
  response_summary TEXT,
  export_generated INTEGER NOT NULL DEFAULT 0,
  export_file_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_allowed_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_key TEXT NOT NULL,
  module TEXT,
  permission_required TEXT,
  query_type TEXT NOT NULL DEFAULT 'report',
  sql_template TEXT NOT NULL,
  export_allowed INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(intent_key, query_type)
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_history_scope ON ai_chat_history (company_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_intents_scope ON ai_intents (company_id, enabled);

INSERT OR IGNORE INTO permission_modules (code, name, description)
VALUES ('ai_internal', 'Asistente', 'Asistente de reportes internos sin conexion externa');

UPDATE permission_modules
SET is_active = 0
WHERE code = 'ai_empresarial';

INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES
  ('ai_view', 'Ver asistente', 'Ver el Asistente'),
  ('ai_ask', 'Preguntar al asistente', 'Realizar consultas internas'),
  ('ai_export', 'Exportar desde asistente', 'Exportar resultados del Asistente'),
  ('ai_view_sales', 'Ver ventas en asistente', 'Consultar ventas desde el asistente'),
  ('ai_view_accounts_receivable', 'Ver cuentas por cobrar en asistente', 'Consultar cuentas por cobrar desde el asistente'),
  ('ai_view_inventory', 'Ver inventario en asistente', 'Consultar inventario desde el asistente'),
  ('ai_view_clients', 'Ver clientes en asistente', 'Consultar clientes desde el asistente'),
  ('ai_view_quotes', 'Ver cotizaciones en asistente', 'Consultar cotizaciones desde el asistente'),
  ('ai_view_projects', 'Ver proyectos en asistente', 'Consultar proyectos desde el asistente'),
  ('ai_view_production', 'Ver produccion en asistente', 'Consultar produccion desde el asistente'),
  ('ai_admin_intents', 'Administrar intenciones del asistente', 'Activar o desactivar intenciones internas');

INSERT OR IGNORE INTO module_actions (module_id, action_id)
SELECT pm.id, pa.id
FROM permission_modules pm, permission_actions pa
WHERE pm.code = 'ai_internal'
  AND pa.code IN (
    'ai_view',
    'ai_ask',
    'ai_export',
    'ai_view_sales',
    'ai_view_accounts_receivable',
    'ai_view_inventory',
    'ai_view_clients',
    'ai_view_quotes',
    'ai_view_projects',
    'ai_view_production',
    'ai_admin_intents'
  );
