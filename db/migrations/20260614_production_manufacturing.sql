ALTER TABLE items ADD COLUMN production_type TEXT NOT NULL DEFAULT 'supply';
ALTER TABLE items ADD COLUMN average_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN last_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN is_production_active INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS production_boms (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  finished_product_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  base_quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS production_bom_items (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  bom_id INTEGER NOT NULL,
  material_product_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  waste_percentage REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS production_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  order_number TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  bom_id INTEGER,
  quantity_planned REAL NOT NULL,
  quantity_finished REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  estimated_start_date TEXT,
  estimated_end_date TEXT,
  real_start_date TEXT,
  real_end_date TEXT,
  estimated_cost REAL NOT NULL DEFAULT 0,
  real_cost REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  notes TEXT,
  cancellation_reason TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS production_order_materials (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  production_order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity_required REAL NOT NULL DEFAULT 0,
  quantity_reserved REAL NOT NULL DEFAULT 0,
  quantity_consumed REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  waste_percentage REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS production_labor (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  production_order_id INTEGER NOT NULL,
  employee_id INTEGER,
  worker_name TEXT,
  hours REAL NOT NULL DEFAULT 0,
  hourly_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS production_overhead (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  production_order_id INTEGER NOT NULL,
  cost_type TEXT,
  description TEXT,
  amount REAL NOT NULL DEFAULT 0,
  distribution_method TEXT NOT NULL DEFAULT 'order',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS production_waste (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  production_order_id INTEGER,
  product_id INTEGER NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  reason TEXT,
  cost REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  movement_type TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  stock_before REAL NOT NULL DEFAULT 0,
  stock_after REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id INTEGER,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS production_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  table_name TEXT,
  record_id INTEGER,
  old_value TEXT,
  new_value TEXT,
  ip TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_production_boms_company_code ON production_boms (company_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS ux_production_orders_company_number ON production_orders (company_id, order_number);
CREATE INDEX IF NOT EXISTS idx_production_orders_company_status ON production_orders (company_id, status);
CREATE INDEX IF NOT EXISTS idx_production_materials_order ON production_order_materials (company_id, production_order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_production ON inventory_movements (company_id, movement_type, reference_id);
