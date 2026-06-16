CREATE TABLE IF NOT EXISTS production_order_boms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  production_order_id INTEGER NOT NULL,
  bom_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity_planned REAL NOT NULL DEFAULT 0,
  quantity_finished REAL NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_production_order_boms_order ON production_order_boms (company_id, production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_order_boms_product ON production_order_boms (company_id, product_id);
