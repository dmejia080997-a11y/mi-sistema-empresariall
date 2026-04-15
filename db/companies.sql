CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  nit TEXT,
  employees INTEGER,
  business_type TEXT,
  currency TEXT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  logo TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  accounting_framework TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
