CREATE TABLE IF NOT EXISTS air_waybills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  parent_awb_id INTEGER NULL,
  tipo_awb TEXT NOT NULL CHECK (tipo_awb IN ('MAWB','HAWB')),
  numero_awb TEXT NOT NULL,
  fecha_emision TEXT NULL,
  estado TEXT NOT NULL DEFAULT 'Borrador',
  lugar_emision TEXT NULL,
  observaciones TEXT NULL,
  condiciones_transporte TEXT NULL,
  instrucciones_especiales TEXT NULL,
  shipper_nombre TEXT NULL,
  shipper_nit TEXT NULL,
  shipper_direccion TEXT NULL,
  shipper_ciudad TEXT NULL,
  shipper_pais TEXT NULL,
  shipper_telefono TEXT NULL,
  shipper_email TEXT NULL,
  shipper_contacto TEXT NULL,
  consignee_nombre TEXT NULL,
  consignee_nit TEXT NULL,
  consignee_direccion TEXT NULL,
  consignee_ciudad TEXT NULL,
  consignee_pais TEXT NULL,
  consignee_telefono TEXT NULL,
  consignee_email TEXT NULL,
  consignee_contacto TEXT NULL,
  notify_nombre TEXT NULL,
  notify_direccion TEXT NULL,
  notify_telefono TEXT NULL,
  notify_email TEXT NULL,
  agent_nombre TEXT NULL,
  agent_iata TEXT NULL,
  agent_direccion TEXT NULL,
  agent_telefono TEXT NULL,
  agent_email TEXT NULL,
  destination_agent TEXT NULL,
  destination_agent_address TEXT NULL,
  destination_agent_phone TEXT NULL,
  destination_agent_email TEXT NULL,
  airline_name TEXT NULL,
  airline_code TEXT NULL,
  airline_prefix TEXT NULL,
  airport_origin TEXT NULL,
  airport_destination TEXT NULL,
  airport_transit_1 TEXT NULL,
  airport_transit_2 TEXT NULL,
  airport_transit_3 TEXT NULL,
  flight_number_1 TEXT NULL,
  flight_number_2 TEXT NULL,
  flight_number_3 TEXT NULL,
  flight_date_1 TEXT NULL,
  flight_date_2 TEXT NULL,
  flight_date_3 TEXT NULL,
  freight_prepaid REAL DEFAULT 0,
  freight_collect REAL DEFAULT 0,
  other_charges REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  insurance_amount REAL DEFAULT 0,
  total_pieces REAL DEFAULT 0,
  total_gross_weight REAL DEFAULT 0,
  total_volume_weight REAL DEFAULT 0,
  total_chargeable_weight REAL DEFAULT 0,
  total_cbm REAL DEFAULT 0,
  total_declared_value REAL DEFAULT 0,
  created_by INTEGER NULL,
  updated_by INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_awb_id) REFERENCES air_waybills(id),
  UNIQUE (company_id, numero_awb)
);

CREATE TABLE IF NOT EXISTS awb_cargo_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  awb_id INTEGER NOT NULL,
  pieces REAL DEFAULT 0,
  package_type TEXT NULL,
  description_goods TEXT NULL,
  hs_code TEXT NULL,
  gross_weight REAL DEFAULT 0,
  chargeable_weight REAL DEFAULT 0,
  volume_weight REAL DEFAULT 0,
  dimensions TEXT NULL,
  volume_cbm REAL DEFAULT 0,
  declared_value_customs REAL DEFAULT 0,
  declared_value_carriage REAL DEFAULT 0,
  handling_information TEXT NULL,
  marks_numbers TEXT NULL,
  dangerous_goods INTEGER DEFAULT 0,
  un_number TEXT NULL,
  imo_class TEXT NULL,
  packing_group TEXT NULL,
  temperature_controlled INTEGER DEFAULT 0,
  temperature_required TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (awb_id) REFERENCES air_waybills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS awb_dimensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cargo_item_id INTEGER NOT NULL,
  quantity REAL DEFAULT 0,
  length REAL DEFAULT 0,
  width REAL DEFAULT 0,
  height REAL DEFAULT 0,
  unit TEXT DEFAULT 'CM',
  weight REAL DEFAULT 0,
  FOREIGN KEY (cargo_item_id) REFERENCES awb_cargo_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_awb_company_type ON air_waybills (company_id, tipo_awb);
CREATE INDEX IF NOT EXISTS idx_awb_company_status ON air_waybills (company_id, estado);
CREATE INDEX IF NOT EXISTS idx_awb_parent ON air_waybills (company_id, parent_awb_id);
CREATE INDEX IF NOT EXISTS idx_awb_cargo_awb ON awb_cargo_items (awb_id);
CREATE INDEX IF NOT EXISTS idx_awb_dimensions_cargo ON awb_dimensions (cargo_item_id);

INSERT OR IGNORE INTO permission_modules (code, name, description)
VALUES ('awb', 'Documentos de Transporte - Guías Aéreas / AWB', 'Guías aéreas MAWB y HAWB');

INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES
  ('ver','Ver','Ver AWB'),
  ('crear','Crear','Crear AWB'),
  ('editar','Editar','Editar AWB'),
  ('anular','Anular','Anular AWB'),
  ('imprimir','Imprimir','Imprimir AWB'),
  ('descargar_pdf','Descargar PDF','Descargar PDF de AWB'),
  ('crear_hija','Crear HAWB','Crear HAWB desde MAWB');

INSERT OR IGNORE INTO module_actions (module_id, action_id)
SELECT pm.id, pa.id
FROM permission_modules pm, permission_actions pa
WHERE pm.code = 'awb'
  AND pa.code IN ('ver','crear','editar','anular','imprimir','descargar_pdf','crear_hija');
