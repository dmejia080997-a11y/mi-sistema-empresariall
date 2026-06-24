CREATE TABLE IF NOT EXISTS bills_of_lading (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  parent_bl_id INTEGER NULL,
  nivel_bl TEXT NOT NULL CHECK (nivel_bl IN ('MASTER','HOUSE','SUB_HOUSE')),
  numero_bl TEXT NOT NULL,
  fecha_emision TEXT NULL,
  estado TEXT NOT NULL DEFAULT 'Borrador',
  lugar_emision TEXT NULL,
  tipo_servicio TEXT NULL,
  modalidad TEXT NULL,
  incoterm TEXT NULL,
  moneda TEXT NULL,
  observaciones TEXT NULL,
  condiciones_transporte TEXT NULL,
  instrucciones_especiales TEXT NULL,
  shipper_nombre TEXT NULL,
  shipper_nit TEXT NULL,
  shipper_direccion TEXT NULL,
  shipper_telefono TEXT NULL,
  shipper_email TEXT NULL,
  shipper_contacto TEXT NULL,
  consignee_nombre TEXT NULL,
  consignee_nit TEXT NULL,
  consignee_direccion TEXT NULL,
  consignee_telefono TEXT NULL,
  consignee_email TEXT NULL,
  consignee_contacto TEXT NULL,
  notify_nombre TEXT NULL,
  notify_nit TEXT NULL,
  notify_direccion TEXT NULL,
  notify_telefono TEXT NULL,
  notify_email TEXT NULL,
  notify_contacto TEXT NULL,
  forwarder_nombre TEXT NULL,
  forwarder_nit TEXT NULL,
  forwarder_direccion TEXT NULL,
  forwarder_telefono TEXT NULL,
  forwarder_email TEXT NULL,
  carrier TEXT NULL,
  vessel TEXT NULL,
  voyage TEXT NULL,
  port_of_loading TEXT NULL,
  port_of_discharge TEXT NULL,
  place_of_receipt TEXT NULL,
  place_of_delivery TEXT NULL,
  final_destination TEXT NULL,
  etd TEXT NULL,
  eta TEXT NULL,
  freight_terms TEXT NULL,
  freight_payable_at TEXT NULL,
  number_of_originals TEXT NULL,
  ocean_freight REAL DEFAULT 0,
  charges REAL DEFAULT 0,
  total_containers INTEGER DEFAULT 0,
  total_packages REAL DEFAULT 0,
  total_gross_weight REAL DEFAULT 0,
  total_net_weight REAL DEFAULT 0,
  total_cbm REAL DEFAULT 0,
  total_declared_value REAL DEFAULT 0,
  created_by INTEGER NULL,
  updated_by INTEGER NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_bl_id) REFERENCES bills_of_lading(id),
  UNIQUE (company_id, numero_bl)
);

CREATE TABLE IF NOT EXISTS bl_containers (
  id BIGSERIAL PRIMARY KEY,
  bl_id INTEGER NOT NULL,
  container_number TEXT NULL,
  seal_number TEXT NULL,
  container_type TEXT NULL,
  tare_weight REAL DEFAULT 0,
  gross_weight REAL DEFAULT 0,
  net_weight REAL DEFAULT 0,
  volume_cbm REAL DEFAULT 0,
  package_quantity REAL DEFAULT 0,
  package_type TEXT NULL,
  marks_numbers TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bl_id) REFERENCES bills_of_lading(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bl_cargo_items (
  id BIGSERIAL PRIMARY KEY,
  bl_id INTEGER NOT NULL,
  container_id INTEGER NULL,
  quantity REAL DEFAULT 0,
  package_type TEXT NULL,
  description TEXT NULL,
  hs_code TEXT NULL,
  gross_weight REAL DEFAULT 0,
  net_weight REAL DEFAULT 0,
  volume_cbm REAL DEFAULT 0,
  value_declared REAL DEFAULT 0,
  marks_numbers TEXT NULL,
  dangerous_goods INTEGER DEFAULT 0,
  un_number TEXT NULL,
  imo_class TEXT NULL,
  temperature_controlled INTEGER DEFAULT 0,
  temperature TEXT NULL,
  observations TEXT NULL,
  FOREIGN KEY (bl_id) REFERENCES bills_of_lading(id) ON DELETE CASCADE,
  FOREIGN KEY (container_id) REFERENCES bl_containers(id)
);

CREATE INDEX IF NOT EXISTS idx_bl_company_level ON bills_of_lading (company_id, nivel_bl);
CREATE INDEX IF NOT EXISTS idx_bl_company_status ON bills_of_lading (company_id, estado);
CREATE INDEX IF NOT EXISTS idx_bl_parent ON bills_of_lading (company_id, parent_bl_id);
CREATE INDEX IF NOT EXISTS idx_bl_containers_bl ON bl_containers (bl_id);
CREATE INDEX IF NOT EXISTS idx_bl_cargo_bl ON bl_cargo_items (bl_id);

INSERT INTO permission_modules (code, name, description)
VALUES ('bl', 'Documentos de Transporte - Bill of Lading / BL', 'BL maritimos Master, House y Sub House')
ON CONFLICT DO NOTHING;

INSERT INTO permission_actions (code, name, description) VALUES
  ('ver','Ver','Ver BL'),
  ('crear','Crear','Crear BL'),
  ('editar','Editar','Editar BL'),
  ('anular','Anular','Anular BL'),
  ('imprimir','Imprimir','Imprimir BL'),
  ('descargar_pdf','Descargar PDF','Descargar PDF de BL'),
  ('crear_hijo','Crear BL Hijo','Crear House BL desde Master'),
  ('crear_nieto','Crear BL Nieto','Crear Sub House BL desde House')
ON CONFLICT DO NOTHING;

INSERT INTO module_actions (module_id, action_id)
SELECT pm.id, pa.id
FROM permission_modules pm, permission_actions pa
WHERE pm.code = 'bl'
  AND pa.code IN ('ver','crear','editar','anular','imprimir','descargar_pdf','crear_hijo','crear_nieto')
ON CONFLICT DO NOTHING;
