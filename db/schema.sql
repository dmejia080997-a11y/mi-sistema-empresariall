CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',
  company_id INTEGER NULL,
  launcher_type TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT NOT NULL,
  item_code TEXT NULL,
  code_manual INTEGER NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 5,
  warehouse_location TEXT NULL,
  barcode TEXT NULL,
  price REAL NOT NULL DEFAULT 0,
  category_id INTEGER NULL,
  brand_id INTEGER NULL,
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NULL,
  code_manual INTEGER NOT NULL DEFAULT 0,
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NULL,
  code_manual INTEGER NOT NULL DEFAULT 0,
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NULL,
  action TEXT NOT NULL,
  details TEXT NULL,
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NULL,
  customer_code TEXT NULL,
  document_type TEXT,
  document_number TEXT,
  name TEXT NOT NULL,
  first_name TEXT NULL,
  last_name TEXT NULL,
  full_address TEXT NULL,
  house_number TEXT NULL,
  street_number TEXT NULL,
  zone TEXT NULL,
  municipality TEXT NULL,
  department TEXT NULL,
  country TEXT NULL,
  phone TEXT NULL,
  mobile TEXT NULL,
  email TEXT NULL,
  payment_method TEXT NULL,
  communication_type TEXT NULL,
  advisor TEXT NULL,
  sat_verified INTEGER DEFAULT 0,
  sat_name TEXT NULL,
  sat_checked_at DATETIME NULL,
  address TEXT NULL,
  notes TEXT NULL,
  portal_code TEXT NULL,
  portal_password_hash TEXT NULL,
  portal_password_reset_required INTEGER DEFAULT 0,
  is_voided INTEGER NOT NULL DEFAULT 0,
  voided_at DATETIME NULL,
  voided_by INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS consignatarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  company_id INTEGER NULL,
  document_type TEXT,
  document_number TEXT,
  name TEXT NOT NULL,
  full_address TEXT NULL,
  zone TEXT NULL,
  municipality TEXT NULL,
  department TEXT NULL,
  country TEXT NULL,
  phone TEXT NULL,
  mobile TEXT NULL,
  email TEXT NULL,
  sat_verified INTEGER DEFAULT 0,
  sat_name TEXT NULL,
  sat_checked_at DATETIME NULL,
  notes TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 12,
  tax_amount REAL NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'amount',
  discount_value REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  company_id INTEGER NULL,
  currency TEXT NULL,
  exchange_rate REAL NULL,
  subtotal_base REAL NULL,
  tax_amount_base REAL NULL,
  discount_amount_base REAL NULL,
  total_base REAL NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_code TEXT NULL,
  customer_id INTEGER NULL,
  consignatario_id INTEGER NULL,
  sender_name TEXT NULL,
  store_name TEXT NULL,
  description TEXT NULL,
  delivery_address TEXT NULL,
  delivery_municipality TEXT NULL,
  delivery_department TEXT NULL,
  delivery_phone TEXT NULL,
  weight_lbs REAL NULL,
  length_cm REAL NULL,
  width_cm REAL NULL,
  height_cm REAL NULL,
  declared_value REAL NULL,
  shipping_type TEXT NULL,
  branch_destination TEXT NULL,
  delivery_type TEXT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  invoice_status TEXT NOT NULL DEFAULT 'pending',
  carrier TEXT NULL,
  tracking_number TEXT NULL,
  received_at DATETIME NULL,
  invoice_file TEXT NULL,
  notes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'Recibido en bodega',
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  paciente_nombre TEXT NOT NULL,
  telefono TEXT NULL,
  motivo TEXT NULL,
  doctor_id INTEGER NOT NULL,
  fecha_hora TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  duration_min INTEGER NOT NULL DEFAULT 30,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NULL,
  specialty TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS manifests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  airway_bill_number TEXT NULL,
  notes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER NULL,
  closed_by INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (closed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS awbs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  awb_type TEXT NULL,
  awb_number TEXT NOT NULL,
  awb_date TEXT NULL,
  issuing_carrier TEXT NULL,
  agent_name TEXT NULL,
  agent_iata_code TEXT NULL,
  agent_cass_code TEXT NULL,
  shipper_name TEXT NULL,
  shipper_address TEXT NULL,
  consignee_name TEXT NULL,
  consignee_address TEXT NULL,
  accounting_information TEXT NULL,
  reference_number TEXT NULL,
  optional_shipping_info_1 TEXT NULL,
  optional_shipping_info_2 TEXT NULL,
  airport_of_departure TEXT NULL,
  airport_of_destination TEXT NULL,
  carrier_code TEXT NULL,
  flight_number TEXT NULL,
  departure_airport TEXT NULL,
  departure_date TEXT NULL,
  arrival_airport TEXT NULL,
  arrival_date TEXT NULL,
  currency TEXT NULL,
  charges_code TEXT NULL,
  weight_valuation_charge_type TEXT NULL,
  other_charges_type TEXT NULL,
  declared_value_carriage TEXT NULL,
  declared_value_customs TEXT NULL,
  insurance_amount REAL NULL,
  handling_information TEXT NULL,
  special_handling_details TEXT NULL,
  ssr TEXT NULL,
  osi TEXT NULL,
  total_pieces INTEGER NULL,
  gross_weight REAL NULL,
  chargeable_weight REAL NULL,
  goods_description TEXT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS awb_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  awb_id INTEGER NOT NULL,
  pieces INTEGER NULL,
  gross_weight REAL NULL,
  dimensions TEXT NULL,
  goods_description TEXT NULL,
  rate_class TEXT NULL,
  chargeable_weight REAL NULL,
  rate REAL NULL,
  total REAL NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (awb_id) REFERENCES awbs(id)
);

CREATE TABLE IF NOT EXISTS awb_manifests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  awb_id INTEGER NOT NULL,
  manifest_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (awb_id, manifest_id),
  FOREIGN KEY (awb_id) REFERENCES awbs(id),
  FOREIGN KEY (manifest_id) REFERENCES manifests(id)
);

CREATE TABLE IF NOT EXISTS manifest_pieces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_id INTEGER NOT NULL,
  piece_number INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manifest_id) REFERENCES manifests(id)
);

CREATE TABLE IF NOT EXISTS manifest_piece_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_piece_id INTEGER NOT NULL,
  package_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manifest_piece_id) REFERENCES manifest_pieces(id),
  FOREIGN KEY (package_id) REFERENCES packages(id)
);

CREATE TABLE IF NOT EXISTS package_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (package_id) REFERENCES packages(id)
);

CREATE TABLE IF NOT EXISTS package_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  old_status TEXT NULL,
  new_status TEXT NULL,
  changed_by INTEGER NULL,
  notes TEXT NULL,
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (package_id) REFERENCES packages(id),
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS package_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL,
  comment TEXT NOT NULL,
  created_by INTEGER NULL,
  company_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (package_id) REFERENCES packages(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS carrier_receptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  tracking_number TEXT NOT NULL,
  carrier TEXT NOT NULL,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  received_by TEXT NULL,
  notes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  package_id INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (package_id) REFERENCES packages(id)
);

CREATE TABLE IF NOT EXISTS carrier_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  carriers_text TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS package_sender_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  sender_name TEXT NULL,
  store_name TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS launcher_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  text TEXT NULL,
  color TEXT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

-- Contabilidad NIF
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'mayor',
  subtype TEXT NULL,
  framework TEXT NULL,
  category_id INTEGER NULL,
  parent_id INTEGER NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  depreciable INTEGER NOT NULL DEFAULT 0,
  is_depreciation INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  entry_date DATETIME NOT NULL,
  description TEXT NULL,
  user_id INTEGER NULL,
  memo TEXT NULL,
  source_type TEXT NULL,
  source_id INTEGER NULL,
  currency TEXT NULL,
  exchange_rate REAL NULL,
  tax_rate REAL NULL,
  tax_amount REAL NULL,
  tax_type TEXT NULL,
  status TEXT NOT NULL DEFAULT 'posted',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS journal_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  line_memo TEXT NULL,
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0,
  currency TEXT NULL,
  exchange_rate REAL NULL,
  debit_base REAL DEFAULT 0,
  credit_base REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS financial_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  period_start TEXT NULL,
  period_end TEXT NULL,
  data_json TEXT NULL,
  created_by INTEGER NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  framework TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_category_assignments_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  company_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  previous_category_id INTEGER,
  new_category_id INTEGER,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  framework TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  target_category_code TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bank_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  bank_name TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_sync DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  txn_date DATETIME NULL,
  description TEXT NULL,
  amount REAL NULL,
  currency TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_help_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NULL,
  module_code TEXT NOT NULL,
  module_name TEXT NOT NULL,
  description TEXT NULL,
  actions_json TEXT NULL,
  faqs_json TEXT NULL,
  help_json TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, module_code)
);

CREATE INDEX IF NOT EXISTS idx_ai_help_modules_company ON ai_help_modules (company_id);
CREATE INDEX IF NOT EXISTS idx_ai_help_modules_code ON ai_help_modules (module_code);

CREATE TABLE IF NOT EXISTS hr_job_descriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  position_name TEXT NOT NULL,
  department TEXT NOT NULL,
  immediate_boss_title TEXT,
  job_objective TEXT,
  main_functions TEXT,
  secondary_functions TEXT,
  academic_requirements TEXT,
  required_experience TEXT,
  skills TEXT,
  competencies TEXT,
  work_schedule TEXT,
  suggested_salary REAL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'Activa',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dpi_number TEXT,
  dpi_issued_at TEXT,
  marital_status TEXT,
  married_last_name TEXT,
  gender TEXT,
  birth_date TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  education_level TEXT,
  ethnicity TEXT,
  languages TEXT,
  position TEXT,
  department TEXT,
  immediate_boss_id INTEGER,
  employee_code TEXT NOT NULL,
  hire_date TEXT,
  employment_status TEXT NOT NULL DEFAULT 'Activo',
  contract_type TEXT,
  salary_base REAL DEFAULT 0,
  bonus_amount REAL DEFAULT 0,
  payroll_calculation_type TEXT,
  bank_account_number TEXT,
  bank_account_type TEXT,
  bank_name TEXT,
  photo_path TEXT,
  job_application_path TEXT,
  notes TEXT,
  job_description_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_employee_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  attachment_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  contract_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  work_schedule TEXT,
  workday_type TEXT,
  salary REAL DEFAULT 0,
  bonus_amount REAL DEFAULT 0,
  workplace TEXT,
  probation_period TEXT,
  main_functions TEXT,
  extra_clauses TEXT,
  observations TEXT,
  generated_contract_text TEXT,
  status TEXT NOT NULL DEFAULT 'Borrador',
  pdf_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_salaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  effective_date TEXT NOT NULL,
  salary_base REAL DEFAULT 0,
  bonus_amount REAL DEFAULT 0,
  extra_bonus REAL DEFAULT 0,
  fixed_deductions REAL DEFAULT 0,
  payment_method TEXT,
  bank_account_number TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'Vigente',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_overtime (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  overtime_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  total_hours REAL DEFAULT 0,
  overtime_type TEXT,
  reason TEXT,
  approved_by TEXT,
  status TEXT NOT NULL DEFAULT 'Pendiente',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  attendance_date TEXT NOT NULL,
  check_in TEXT,
  lunch_out TEXT,
  lunch_in TEXT,
  check_out TEXT,
  attendance_status TEXT NOT NULL DEFAULT 'Presente',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  warning_date TEXT NOT NULL,
  warning_type TEXT,
  reason TEXT NOT NULL,
  detailed_description TEXT,
  corrective_action TEXT,
  issued_by TEXT,
  attachment_path TEXT,
  status TEXT NOT NULL DEFAULT 'Emitida',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  permission_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  total_days REAL DEFAULT 0,
  with_pay INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  approved_by TEXT,
  attachment_path TEXT,
  status TEXT NOT NULL DEFAULT 'Pendiente',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_vacations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  vacation_period TEXT,
  hire_date_snapshot TEXT,
  earned_days REAL DEFAULT 0,
  used_days REAL DEFAULT 0,
  available_days REAL DEFAULT 0,
  vacation_start TEXT NOT NULL,
  vacation_end TEXT NOT NULL,
  return_date TEXT,
  status TEXT NOT NULL DEFAULT 'Pendiente',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hr_employees_company ON hr_employees (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_employees_company_code ON hr_employees (company_id, employee_code);
CREATE INDEX IF NOT EXISTS idx_hr_employees_company_dept ON hr_employees (company_id, department);
CREATE INDEX IF NOT EXISTS idx_hr_employee_attachments_company ON hr_employee_attachments (company_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_contracts_company_employee ON hr_contracts (company_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_salaries_company_employee ON hr_salaries (company_id, employee_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_hr_overtime_company_employee ON hr_overtime (company_id, employee_id, overtime_date);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_company_employee ON hr_attendance (company_id, employee_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_hr_warnings_company_employee ON hr_warnings (company_id, employee_id, warning_date);
CREATE INDEX IF NOT EXISTS idx_hr_permissions_company_employee ON hr_permissions (company_id, employee_id, start_date);
CREATE INDEX IF NOT EXISTS idx_hr_vacations_company_employee ON hr_vacations (company_id, employee_id, vacation_start);
CREATE INDEX IF NOT EXISTS idx_hr_descriptions_company_dept ON hr_job_descriptions (company_id, department);
