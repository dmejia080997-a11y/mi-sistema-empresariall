const TYPES = ['MAWB', 'HAWB'];
const STATUSES = ['Borrador', 'Emitida', 'Anulada'];
const TYPE_META = {
  MAWB: { prefix: 'MAWB', label: 'Master Air Waybill', child: 'HAWB' },
  HAWB: { prefix: 'HAWB', label: 'House Air Waybill', child: null }
};

const AWB_FIELDS = [
  'parent_awb_id', 'tipo_awb', 'numero_awb', 'fecha_emision', 'estado', 'lugar_emision',
  'observaciones', 'condiciones_transporte', 'instrucciones_especiales',
  'shipper_nombre', 'shipper_nit', 'shipper_direccion', 'shipper_ciudad', 'shipper_pais', 'shipper_telefono', 'shipper_email', 'shipper_contacto',
  'consignee_nombre', 'consignee_nit', 'consignee_direccion', 'consignee_ciudad', 'consignee_pais', 'consignee_telefono', 'consignee_email', 'consignee_contacto',
  'notify_nombre', 'notify_direccion', 'notify_telefono', 'notify_email',
  'agent_nombre', 'agent_iata', 'agent_direccion', 'agent_telefono', 'agent_email',
  'destination_agent', 'destination_agent_address', 'destination_agent_phone', 'destination_agent_email',
  'airline_name', 'airline_code', 'airline_prefix',
  'airport_origin', 'airport_destination', 'airport_transit_1', 'airport_transit_2', 'airport_transit_3',
  'flight_number_1', 'flight_number_2', 'flight_number_3',
  'flight_date_1', 'flight_date_2', 'flight_date_3',
  'freight_prepaid', 'freight_collect', 'other_charges', 'currency', 'insurance_amount'
];

const CARGO_FIELDS = [
  'pieces', 'package_type', 'description_goods', 'hs_code', 'gross_weight', 'chargeable_weight',
  'volume_weight', 'dimensions', 'volume_cbm', 'declared_value_customs', 'declared_value_carriage',
  'handling_information', 'marks_numbers', 'dangerous_goods', 'un_number', 'imo_class', 'packing_group',
  'temperature_controlled', 'temperature_required'
];

const DIMENSION_FIELDS = ['quantity', 'length', 'width', 'height', 'unit', 'weight'];

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function onRun(err) {
    if (err) return reject(err);
    return resolve(this);
  }));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function nullable(value) {
  const text = clean(value);
  return text || null;
}

function numberValue(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function idValue(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]);
  return [];
}

function hasContent(row) {
  return Object.values(row || {}).some((value) => clean(value));
}

function normalizeType(value) {
  const type = clean(value || 'MAWB').toUpperCase();
  return TYPES.includes(type) ? type : 'MAWB';
}

function normalizeStatus(value) {
  const status = clean(value || 'Borrador');
  return STATUSES.includes(status) ? status : 'Borrador';
}

function normalizeDimensions(input) {
  return asArray(input).filter(hasContent).map((row) => {
    const out = {};
    DIMENSION_FIELDS.forEach((field) => { out[field] = row && row[field] !== undefined ? row[field] : null; });
    ['quantity', 'length', 'width', 'height', 'weight'].forEach((field) => { out[field] = numberValue(out[field]); });
    out.unit = clean(out.unit) || 'CM';
    return out;
  });
}

function computeDimensionTotals(dimensions) {
  return dimensions.reduce((totals, row) => {
    const qty = numberValue(row.quantity) || 1;
    const divisor = clean(row.unit).toUpperCase() === 'IN' ? 366 : 6000;
    totals.volume_weight += (numberValue(row.length) * numberValue(row.width) * numberValue(row.height) * qty) / divisor;
    totals.weight += numberValue(row.weight) * qty;
    return totals;
  }, { volume_weight: 0, weight: 0 });
}

function normalizeCargoItems(input) {
  return asArray(input).filter(hasContent).map((row) => {
    const out = {};
    CARGO_FIELDS.forEach((field) => { out[field] = row && row[field] !== undefined ? row[field] : null; });
    out.dimensions_rows = normalizeDimensions(row && row.dimensions_rows);
    const dimTotals = computeDimensionTotals(out.dimensions_rows);
    ['pieces', 'gross_weight', 'volume_weight', 'chargeable_weight', 'volume_cbm', 'declared_value_customs', 'declared_value_carriage'].forEach((field) => {
      out[field] = numberValue(out[field]);
    });
    if (dimTotals.volume_weight > 0) out.volume_weight = dimTotals.volume_weight;
    if (!out.gross_weight && dimTotals.weight > 0) out.gross_weight = dimTotals.weight;
    out.chargeable_weight = Math.max(numberValue(out.gross_weight), numberValue(out.volume_weight), numberValue(out.chargeable_weight));
    out.dangerous_goods = row && row.dangerous_goods ? 1 : 0;
    out.temperature_controlled = row && row.temperature_controlled ? 1 : 0;
    return out;
  });
}

function computeTotals(cargoItems) {
  return cargoItems.reduce((totals, item) => {
    totals.total_pieces += numberValue(item.pieces);
    totals.total_gross_weight += numberValue(item.gross_weight);
    totals.total_volume_weight += numberValue(item.volume_weight);
    totals.total_chargeable_weight += numberValue(item.chargeable_weight);
    totals.total_cbm += numberValue(item.volume_cbm);
    totals.total_declared_value += numberValue(item.declared_value_customs) + numberValue(item.declared_value_carriage);
    return totals;
  }, {
    total_pieces: 0,
    total_gross_weight: 0,
    total_volume_weight: 0,
    total_chargeable_weight: 0,
    total_cbm: 0,
    total_declared_value: 0
  });
}

function mapAwb(row) {
  if (!row) return null;
  return {
    ...row,
    type_label: TYPE_META[row.tipo_awb] ? TYPE_META[row.tipo_awb].label : row.tipo_awb,
    can_create_child: row.tipo_awb === 'MAWB',
    parent_awb_id: row.parent_awb_id || null
  };
}

async function ensureTables(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS air_waybills (
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
    shipper_nombre TEXT NULL, shipper_nit TEXT NULL, shipper_direccion TEXT NULL, shipper_ciudad TEXT NULL, shipper_pais TEXT NULL, shipper_telefono TEXT NULL, shipper_email TEXT NULL, shipper_contacto TEXT NULL,
    consignee_nombre TEXT NULL, consignee_nit TEXT NULL, consignee_direccion TEXT NULL, consignee_ciudad TEXT NULL, consignee_pais TEXT NULL, consignee_telefono TEXT NULL, consignee_email TEXT NULL, consignee_contacto TEXT NULL,
    notify_nombre TEXT NULL, notify_direccion TEXT NULL, notify_telefono TEXT NULL, notify_email TEXT NULL,
    agent_nombre TEXT NULL, agent_iata TEXT NULL, agent_direccion TEXT NULL, agent_telefono TEXT NULL, agent_email TEXT NULL,
    destination_agent TEXT NULL, destination_agent_address TEXT NULL, destination_agent_phone TEXT NULL, destination_agent_email TEXT NULL,
    airline_name TEXT NULL, airline_code TEXT NULL, airline_prefix TEXT NULL,
    airport_origin TEXT NULL, airport_destination TEXT NULL, airport_transit_1 TEXT NULL, airport_transit_2 TEXT NULL, airport_transit_3 TEXT NULL,
    flight_number_1 TEXT NULL, flight_number_2 TEXT NULL, flight_number_3 TEXT NULL,
    flight_date_1 TEXT NULL, flight_date_2 TEXT NULL, flight_date_3 TEXT NULL,
    freight_prepaid REAL DEFAULT 0, freight_collect REAL DEFAULT 0, other_charges REAL DEFAULT 0, currency TEXT DEFAULT 'USD', insurance_amount REAL DEFAULT 0,
    total_pieces REAL DEFAULT 0, total_gross_weight REAL DEFAULT 0, total_volume_weight REAL DEFAULT 0, total_chargeable_weight REAL DEFAULT 0, total_cbm REAL DEFAULT 0, total_declared_value REAL DEFAULT 0,
    created_by INTEGER NULL, updated_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_awb_id) REFERENCES air_waybills(id),
    UNIQUE (company_id, numero_awb)
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS awb_cargo_items (
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
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS awb_dimensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cargo_item_id INTEGER NOT NULL,
    quantity REAL DEFAULT 0,
    length REAL DEFAULT 0,
    width REAL DEFAULT 0,
    height REAL DEFAULT 0,
    unit TEXT DEFAULT 'CM',
    weight REAL DEFAULT 0,
    FOREIGN KEY (cargo_item_id) REFERENCES awb_cargo_items(id) ON DELETE CASCADE
  )`);
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_awb_company_type ON air_waybills (company_id, tipo_awb)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_awb_company_status ON air_waybills (company_id, estado)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_awb_parent ON air_waybills (company_id, parent_awb_id)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_awb_cargo_awb ON awb_cargo_items (awb_id)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_awb_dimensions_cargo ON awb_dimensions (cargo_item_id)');
}

async function nextNumber(db, companyId, type) {
  if (type === 'MAWB') {
    const row = await get(db, "SELECT numero_awb FROM air_waybills WHERE company_id = ? AND tipo_awb = 'MAWB' AND numero_awb LIKE '001-%' ORDER BY CAST(substr(numero_awb, 5) AS INTEGER) DESC LIMIT 1", [companyId]);
    const last = row && row.numero_awb ? Number(String(row.numero_awb).slice(4)) : 12345674;
    return `001-${String((Number.isFinite(last) ? last : 12345674) + 1).padStart(8, '0')}`;
  }
  const row = await get(db, "SELECT numero_awb FROM air_waybills WHERE company_id = ? AND tipo_awb = 'HAWB' AND numero_awb LIKE 'HAWB-%' ORDER BY CAST(substr(numero_awb, 6) AS INTEGER) DESC LIMIT 1", [companyId]);
  const last = row && row.numero_awb ? Number(String(row.numero_awb).replace(/^HAWB-/, '')) : 0;
  return `HAWB-${String((Number.isFinite(last) ? last : 0) + 1).padStart(6, '0')}`;
}

async function validateParent(db, companyId, type, parentId) {
  if (type === 'MAWB') {
    if (parentId) throw new Error('Una MAWB no puede tener AWB padre.');
    return null;
  }
  if (!parentId) throw new Error('Seleccione la MAWB padre.');
  const parent = await find(db, companyId, parentId);
  if (!parent) throw new Error('MAWB padre no encontrada.');
  if (parent.tipo_awb !== 'MAWB') throw new Error('Una HAWB solo puede depender de una MAWB.');
  return parent;
}

function normalizePayload(body, status) {
  const payload = {};
  AWB_FIELDS.forEach((field) => { payload[field] = body[field] !== undefined ? body[field] : null; });
  payload.tipo_awb = normalizeType(body.tipo_awb);
  payload.parent_awb_id = idValue(body.parent_awb_id);
  payload.numero_awb = nullable(body.numero_awb);
  payload.estado = normalizeStatus(status || body.estado);
  payload.fecha_emision = nullable(body.fecha_emision) || new Date().toISOString().slice(0, 10);
  ['freight_prepaid', 'freight_collect', 'other_charges', 'insurance_amount'].forEach((field) => { payload[field] = numberValue(payload[field]); });
  payload.currency = clean(payload.currency) || 'USD';
  return payload;
}

async function list(db, companyId, filters = {}) {
  const clauses = ['awb.company_id = ?'];
  const params = [companyId];
  [
    ['numero_awb', 'awb.numero_awb'], ['shipper', 'awb.shipper_nombre'], ['consignee', 'awb.consignee_nombre'],
    ['airline', 'awb.airline_name'], ['flight', 'awb.flight_number_1'], ['airport_origin', 'awb.airport_origin'],
    ['airport_destination', 'awb.airport_destination']
  ].forEach(([key, column]) => {
    if (clean(filters[key])) {
      clauses.push(`${column} LIKE ?`);
      params.push(`%${clean(filters[key])}%`);
    }
  });
  if (TYPES.includes(clean(filters.tipo_awb).toUpperCase())) {
    clauses.push('awb.tipo_awb = ?');
    params.push(clean(filters.tipo_awb).toUpperCase());
  }
  if (STATUSES.includes(clean(filters.estado))) {
    clauses.push('awb.estado = ?');
    params.push(clean(filters.estado));
  }
  if (idValue(filters.parent_awb_id)) {
    clauses.push('awb.parent_awb_id = ?');
    params.push(idValue(filters.parent_awb_id));
  }
  if (clean(filters.fecha_desde)) {
    clauses.push('date(awb.fecha_emision) >= date(?)');
    params.push(clean(filters.fecha_desde));
  }
  if (clean(filters.fecha_hasta)) {
    clauses.push('date(awb.fecha_emision) <= date(?)');
    params.push(clean(filters.fecha_hasta));
  }
  const rows = await all(db, `SELECT awb.*, parent.numero_awb AS parent_numero_awb
    FROM air_waybills awb
    LEFT JOIN air_waybills parent ON parent.id = awb.parent_awb_id AND parent.company_id = awb.company_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY COALESCE(awb.fecha_emision, awb.created_at) DESC, awb.id DESC`, params);
  return rows.map(mapAwb);
}

async function listChildren(db, companyId, parentId) {
  const rows = await all(db, 'SELECT * FROM air_waybills WHERE company_id = ? AND parent_awb_id = ? ORDER BY id', [companyId, parentId]);
  return rows.map(mapAwb);
}

async function find(db, companyId, id) {
  const row = await get(db, `SELECT awb.*, parent.numero_awb AS parent_numero_awb
    FROM air_waybills awb
    LEFT JOIN air_waybills parent ON parent.id = awb.parent_awb_id AND parent.company_id = awb.company_id
    WHERE awb.id = ? AND awb.company_id = ?`, [id, companyId]);
  if (!row) return null;
  const awb = mapAwb(row);
  awb.cargo_items = await all(db, 'SELECT * FROM awb_cargo_items WHERE awb_id = ? ORDER BY id', [id]);
  for (const item of awb.cargo_items) {
    item.dimensions_rows = await all(db, 'SELECT * FROM awb_dimensions WHERE cargo_item_id = ? ORDER BY id', [item.id]);
  }
  awb.children = await listChildren(db, companyId, id);
  return awb;
}

async function insertCargo(db, awbId, cargoItems) {
  for (const row of cargoItems) {
    const result = await run(db, `INSERT INTO awb_cargo_items (${['awb_id', ...CARGO_FIELDS].join(', ')})
      VALUES (${['?', ...CARGO_FIELDS.map(() => '?')].join(', ')})`,
      [awbId, ...CARGO_FIELDS.map((field) => row[field] === '' ? null : row[field])]
    );
    for (const dim of row.dimensions_rows || []) {
      await run(db, `INSERT INTO awb_dimensions (${['cargo_item_id', ...DIMENSION_FIELDS].join(', ')})
        VALUES (${['?', ...DIMENSION_FIELDS.map(() => '?')].join(', ')})`,
        [result.lastID, ...DIMENSION_FIELDS.map((field) => dim[field] === '' ? null : dim[field])]
      );
    }
  }
}

async function replaceCargo(db, awbId, cargoItems) {
  await run(db, 'DELETE FROM awb_cargo_items WHERE awb_id = ?', [awbId]);
  await insertCargo(db, awbId, cargoItems);
}

async function create(db, companyId, userId, body, status) {
  const payload = normalizePayload(body, status);
  await validateParent(db, companyId, payload.tipo_awb, payload.parent_awb_id);
  payload.numero_awb = payload.numero_awb || await nextNumber(db, companyId, payload.tipo_awb);
  const cargoItems = normalizeCargoItems(body.cargo_items);
  const totals = computeTotals(cargoItems);
  const columns = ['company_id', ...AWB_FIELDS, ...Object.keys(totals), 'created_by', 'updated_by'];
  const values = columns.map((column) => {
    if (column === 'company_id') return companyId;
    if (column === 'created_by' || column === 'updated_by') return userId || null;
    if (Object.prototype.hasOwnProperty.call(totals, column)) return totals[column];
    return payload[column] === '' ? null : payload[column];
  });
  const result = await run(db, `INSERT INTO air_waybills (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
  await insertCargo(db, result.lastID, cargoItems);
  return result.lastID;
}

async function update(db, companyId, id, userId, body, status) {
  const current = await find(db, companyId, id);
  if (!current) throw new Error('AWB no encontrada.');
  if (current.estado !== 'Borrador') throw new Error('Una AWB emitida o anulada no puede editarse.');
  const payload = normalizePayload({ ...body, tipo_awb: current.tipo_awb, parent_awb_id: current.parent_awb_id, numero_awb: current.numero_awb }, status);
  const cargoItems = normalizeCargoItems(body.cargo_items);
  const totals = computeTotals(cargoItems);
  const editableFields = AWB_FIELDS.filter((field) => !['parent_awb_id', 'tipo_awb', 'numero_awb'].includes(field));
  const setFields = [...editableFields, ...Object.keys(totals), 'updated_by'];
  await run(db, `UPDATE air_waybills SET ${setFields.map((field) => `${field} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND company_id = ? AND estado = 'Borrador'`,
  [...editableFields.map((field) => payload[field] === '' ? null : payload[field]), ...Object.keys(totals).map((field) => totals[field]), userId || null, id, companyId]);
  await replaceCargo(db, id, cargoItems);
}

async function setStatus(db, companyId, id, userId, status) {
  await run(db, 'UPDATE air_waybills SET estado = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [normalizeStatus(status), userId || null, id, companyId]);
}

async function createChildDraft(db, companyId, userId, parentId) {
  const parent = await validateParent(db, companyId, 'HAWB', parentId);
  const inherited = {
    tipo_awb: 'HAWB',
    parent_awb_id: parent.id,
    fecha_emision: new Date().toISOString().slice(0, 10),
    estado: 'Borrador',
    lugar_emision: parent.lugar_emision,
    agent_nombre: parent.agent_nombre,
    agent_iata: parent.agent_iata,
    agent_direccion: parent.agent_direccion,
    agent_telefono: parent.agent_telefono,
    agent_email: parent.agent_email,
    destination_agent: parent.destination_agent,
    destination_agent_address: parent.destination_agent_address,
    destination_agent_phone: parent.destination_agent_phone,
    destination_agent_email: parent.destination_agent_email,
    airline_name: parent.airline_name,
    airline_code: parent.airline_code,
    airline_prefix: parent.airline_prefix,
    airport_origin: parent.airport_origin,
    airport_destination: parent.airport_destination,
    airport_transit_1: parent.airport_transit_1,
    airport_transit_2: parent.airport_transit_2,
    airport_transit_3: parent.airport_transit_3,
    flight_number_1: parent.flight_number_1,
    flight_number_2: parent.flight_number_2,
    flight_number_3: parent.flight_number_3,
    flight_date_1: parent.flight_date_1,
    flight_date_2: parent.flight_date_2,
    flight_date_3: parent.flight_date_3,
    currency: parent.currency
  };
  return create(db, companyId, userId, inherited, 'Borrador');
}

async function duplicate(db, companyId, userId, sourceId, withChildren = false, parentOverride = null) {
  const source = await find(db, companyId, sourceId);
  if (!source) throw new Error('AWB no encontrada.');
  const data = { ...source, parent_awb_id: parentOverride === null ? source.parent_awb_id : parentOverride, numero_awb: null, estado: 'Borrador' };
  const newId = await create(db, companyId, userId, data, 'Borrador');
  if (withChildren && source.tipo_awb === 'MAWB') {
    for (const child of source.children || []) await duplicate(db, companyId, userId, child.id, false, newId);
  }
  return newId;
}

async function tree(db, companyId) {
  const rows = await all(db, 'SELECT * FROM air_waybills WHERE company_id = ? ORDER BY tipo_awb, id', [companyId]);
  const byId = new Map(rows.map((row) => [row.id, { ...mapAwb(row), children: [] }]));
  const roots = [];
  byId.forEach((node) => {
    if (node.parent_awb_id && byId.has(node.parent_awb_id)) byId.get(node.parent_awb_id).children.push(node);
    else roots.push(node);
  });
  return roots.filter((node) => node.tipo_awb === 'MAWB' || !node.parent_awb_id);
}

function validateForIssue(awb, cargoItems) {
  const missing = [];
  [
    ['shipper_nombre', 'Shipper'], ['consignee_nombre', 'Consignee'], ['airline_name', 'Aerolínea'],
    ['airport_origin', 'Aeropuerto origen'], ['airport_destination', 'Aeropuerto destino']
  ].forEach(([field, label]) => { if (!clean(awb[field])) missing.push(label); });
  if (!cargoItems.length) missing.push('Al menos un item de carga');
  if (!cargoItems.some((item) => numberValue(item.gross_weight) > 0)) missing.push('Peso bruto');
  if (!cargoItems.some((item) => numberValue(item.chargeable_weight) > 0)) missing.push('Peso cobrable');
  if (!cargoItems.some((item) => clean(item.description_goods))) missing.push('Descripcion de mercancia');
  return missing;
}

module.exports = {
  TYPES,
  STATUSES,
  TYPE_META,
  AWB_FIELDS,
  CARGO_FIELDS,
  DIMENSION_FIELDS,
  clean,
  normalizeCargoItems,
  normalizeDimensions,
  computeTotals,
  validateForIssue,
  ensureTables,
  list,
  find,
  create,
  update,
  setStatus,
  createChildDraft,
  duplicate,
  tree
};
