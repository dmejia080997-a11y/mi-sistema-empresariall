CREATE TABLE IF NOT EXISTS transport_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  document_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  issue_date TEXT NULL,
  client_name TEXT NULL,
  shipper TEXT NULL,
  consignee TEXT NULL,
  origin TEXT NULL,
  destination TEXT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transport_document_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES transport_documents(id)
);

CREATE TABLE IF NOT EXISTS transport_document_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES transport_documents(id)
);

CREATE TABLE IF NOT EXISTS transport_document_merchandise (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES transport_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_transport_documents_company_type ON transport_documents (company_id, type);
CREATE INDEX IF NOT EXISTS idx_transport_documents_company_status ON transport_documents (company_id, status);
CREATE INDEX IF NOT EXISTS idx_transport_documents_company_date ON transport_documents (company_id, issue_date);
CREATE INDEX IF NOT EXISTS idx_transport_items_doc ON transport_document_items (company_id, document_id);
CREATE INDEX IF NOT EXISTS idx_transport_charges_doc ON transport_document_charges (company_id, document_id);
CREATE INDEX IF NOT EXISTS idx_transport_merchandise_doc ON transport_document_merchandise (company_id, document_id);
