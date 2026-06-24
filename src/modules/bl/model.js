const LEVELS = ['MASTER', 'HOUSE', 'SUB_HOUSE'];
const STATUSES = ['Borrador', 'Emitido', 'Anulado'];
const MODALITIES = ['FCL', 'LCL', 'CONSOLIDADO'];
const FREIGHT_TERMS = ['PREPAID', 'COLLECT'];

const LEVEL_META = {
  MASTER: { prefix: 'MBL', label: 'Master BL', child: 'HOUSE' },
  HOUSE: { prefix: 'HBL', label: 'House BL', child: 'SUB_HOUSE' },
  SUB_HOUSE: { prefix: 'SHBL', label: 'Sub House BL', child: null }
};

const BL_FIELDS = [
  'parent_bl_id', 'nivel_bl', 'numero_bl', 'fecha_emision', 'estado', 'lugar_emision', 'tipo_servicio',
  'modalidad', 'incoterm', 'moneda', 'observaciones', 'condiciones_transporte', 'instrucciones_especiales',
  'shipper_nombre', 'shipper_nit', 'shipper_direccion', 'shipper_telefono', 'shipper_email', 'shipper_contacto',
  'consignee_nombre', 'consignee_nit', 'consignee_direccion', 'consignee_telefono', 'consignee_email', 'consignee_contacto',
  'notify_nombre', 'notify_nit', 'notify_direccion', 'notify_telefono', 'notify_email', 'notify_contacto',
  'forwarder_nombre', 'forwarder_nit', 'forwarder_direccion', 'forwarder_telefono', 'forwarder_email',
  'carrier', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'place_of_receipt', 'place_of_delivery',
  'final_destination', 'etd', 'eta', 'freight_terms', 'freight_payable_at', 'number_of_originals',
  'ocean_freight', 'charges'
];

const CONTAINER_FIELDS = [
  'container_number', 'seal_number', 'container_type', 'tare_weight', 'gross_weight', 'net_weight',
  'volume_cbm', 'package_quantity', 'package_type', 'marks_numbers'
];

const CARGO_FIELDS = [
  'container_id', 'quantity', 'package_type', 'description', 'hs_code', 'gross_weight', 'net_weight',
  'volume_cbm', 'value_declared', 'marks_numbers', 'dangerous_goods', 'un_number', 'imo_class',
  'temperature_controlled', 'temperature', 'observations'
];

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
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
  if (typeof value === 'object') {
    return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]);
  }
  return [];
}

function normalizeLevel(value) {
  const level = clean(value || 'MASTER').toUpperCase();
  return LEVELS.includes(level) ? level : 'MASTER';
}

function normalizeStatus(value) {
  const status = clean(value || 'Borrador');
  return STATUSES.includes(status) ? status : 'Borrador';
}

function normalizeModality(value) {
  const modality = clean(value).toUpperCase();
  return MODALITIES.includes(modality) ? modality : null;
}

function normalizeFreightTerms(value) {
  const terms = clean(value).toUpperCase();
  return FREIGHT_TERMS.includes(terms) ? terms : null;
}

function hasContent(row) {
  return Object.values(row || {}).some((value) => clean(value));
}

function normalizeContainers(input) {
  return asArray(input).filter(hasContent).map((row) => {
    const out = {};
    out.id = row && row.id ? Number(row.id) : null;
    CONTAINER_FIELDS.forEach((field) => {
      out[field] = row && row[field] !== undefined ? row[field] : null;
    });
    ['tare_weight', 'gross_weight', 'net_weight', 'volume_cbm', 'package_quantity'].forEach((field) => {
      out[field] = numberValue(out[field]);
    });
    return out;
  });
}

function normalizeCargoItems(input) {
  return asArray(input).filter(hasContent).map((row) => {
    const out = {};
    CARGO_FIELDS.forEach((field) => {
      out[field] = row && row[field] !== undefined ? row[field] : null;
    });
    out.container_id = idValue(out.container_id);
    ['quantity', 'gross_weight', 'net_weight', 'volume_cbm', 'value_declared'].forEach((field) => {
      out[field] = numberValue(out[field]);
    });
    out.dangerous_goods = row && row.dangerous_goods ? 1 : 0;
    out.temperature_controlled = row && row.temperature_controlled ? 1 : 0;
    return out;
  });
}

function computeTotals(containers, cargoItems) {
  const totalPackages = cargoItems.reduce((sum, item) => sum + numberValue(item.quantity), 0)
    || containers.reduce((sum, item) => sum + numberValue(item.package_quantity), 0);
  return {
    total_containers: containers.length,
    total_packages: totalPackages,
    total_gross_weight: cargoItems.reduce((sum, item) => sum + numberValue(item.gross_weight), 0)
      || containers.reduce((sum, item) => sum + numberValue(item.gross_weight), 0),
    total_net_weight: cargoItems.reduce((sum, item) => sum + numberValue(item.net_weight), 0)
      || containers.reduce((sum, item) => sum + numberValue(item.net_weight), 0),
    total_cbm: cargoItems.reduce((sum, item) => sum + numberValue(item.volume_cbm), 0)
      || containers.reduce((sum, item) => sum + numberValue(item.volume_cbm), 0),
    total_declared_value: cargoItems.reduce((sum, item) => sum + numberValue(item.value_declared), 0)
  };
}

function mapBl(row) {
  if (!row) return null;
  return {
    ...row,
    type_label: LEVEL_META[row.nivel_bl] ? LEVEL_META[row.nivel_bl].label : row.nivel_bl,
    can_create_child: row.nivel_bl !== 'SUB_HOUSE',
    parent_bl_id: row.parent_bl_id || null
  };
}

async function ensureTables(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS bills_of_lading (
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
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS bl_containers (
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
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS bl_cargo_items (
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
  )`);
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_bl_company_level ON bills_of_lading (company_id, nivel_bl)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_bl_company_status ON bills_of_lading (company_id, estado)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_bl_parent ON bills_of_lading (company_id, parent_bl_id)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_bl_containers_bl ON bl_containers (bl_id)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_bl_cargo_bl ON bl_cargo_items (bl_id)');
}

async function nextNumber(db, companyId, level) {
  const prefix = LEVEL_META[level].prefix;
  const rows = await all(db, 'SELECT numero_bl FROM bills_of_lading WHERE company_id = ? AND nivel_bl = ?', [companyId, level]);
  const max = rows.reduce((current, row) => {
    const match = String(row.numero_bl || '').match(new RegExp(`^${prefix}-(\\d+)$`));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(6, '0')}`;
}

async function validateParent(db, companyId, level, parentId) {
  if (level === 'MASTER') {
    if (parentId) throw new Error('Un BL Master no puede tener BL padre.');
    return null;
  }
  if (!parentId) throw new Error('Seleccione el BL padre.');
  const parent = await find(db, companyId, parentId);
  if (!parent) throw new Error('BL padre no encontrado.');
  if (level === 'HOUSE' && parent.nivel_bl !== 'MASTER') throw new Error('Un House BL solo puede depender de un Master BL.');
  if (level === 'SUB_HOUSE' && parent.nivel_bl !== 'HOUSE') throw new Error('Un Sub House BL solo puede depender de un House BL.');
  if (parent.nivel_bl === 'SUB_HOUSE') throw new Error('Un Sub House BL no puede tener hijos.');
  return parent;
}

function normalizePayload(body, status) {
  const level = normalizeLevel(body.nivel_bl);
  const payload = {};
  BL_FIELDS.forEach((field) => {
    payload[field] = body[field] !== undefined ? body[field] : null;
  });
  payload.nivel_bl = level;
  payload.parent_bl_id = idValue(body.parent_bl_id);
  payload.numero_bl = nullable(body.numero_bl);
  payload.estado = normalizeStatus(status || body.estado);
  payload.fecha_emision = nullable(body.fecha_emision);
  payload.modalidad = normalizeModality(body.modalidad);
  payload.freight_terms = normalizeFreightTerms(body.freight_terms);
  payload.ocean_freight = numberValue(body.ocean_freight);
  payload.charges = numberValue(body.charges);
  return payload;
}

async function list(db, companyId, filters = {}) {
  const clauses = ['bl.company_id = ?'];
  const params = [companyId];
  const likeFields = [
    ['numero_bl', 'bl.numero_bl'],
    ['shipper', 'bl.shipper_nombre'],
    ['consignee', 'bl.consignee_nombre'],
    ['vessel', 'bl.vessel'],
    ['voyage', 'bl.voyage'],
    ['port_of_loading', 'bl.port_of_loading'],
    ['port_of_discharge', 'bl.port_of_discharge']
  ];
  likeFields.forEach(([key, column]) => {
    if (clean(filters[key])) {
      clauses.push(`${column} LIKE ?`);
      params.push(`%${clean(filters[key])}%`);
    }
  });
  if (LEVELS.includes(clean(filters.nivel_bl))) {
    clauses.push('bl.nivel_bl = ?');
    params.push(clean(filters.nivel_bl));
  }
  if (STATUSES.includes(clean(filters.estado))) {
    clauses.push('bl.estado = ?');
    params.push(clean(filters.estado));
  }
  if (idValue(filters.parent_bl_id)) {
    clauses.push('bl.parent_bl_id = ?');
    params.push(idValue(filters.parent_bl_id));
  }
  if (clean(filters.fecha_desde)) {
    clauses.push('bl.fecha_emision >= ?');
    params.push(clean(filters.fecha_desde));
  }
  if (clean(filters.fecha_hasta)) {
    clauses.push('bl.fecha_emision <= ?');
    params.push(clean(filters.fecha_hasta));
  }
  const rows = await all(db, `SELECT bl.*, parent.numero_bl AS parent_numero_bl
    FROM bills_of_lading bl
    LEFT JOIN bills_of_lading parent ON parent.id = bl.parent_bl_id AND parent.company_id = bl.company_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY COALESCE(NULLIF(bl.fecha_emision, ''), CAST(bl.created_at AS TEXT)) DESC, bl.id DESC`, params);
  return rows.map(mapBl);
}

async function find(db, companyId, id) {
  const row = await get(db, `SELECT bl.*, parent.numero_bl AS parent_numero_bl, parent.nivel_bl AS parent_nivel_bl
    FROM bills_of_lading bl
    LEFT JOIN bills_of_lading parent ON parent.id = bl.parent_bl_id AND parent.company_id = bl.company_id
    WHERE bl.id = ? AND bl.company_id = ?`, [id, companyId]);
  if (!row) return null;
  const bl = mapBl(row);
  bl.containers = await all(db, 'SELECT * FROM bl_containers WHERE bl_id = ? ORDER BY id', [id]);
  bl.cargo_items = await all(db, 'SELECT * FROM bl_cargo_items WHERE bl_id = ? ORDER BY id', [id]);
  bl.children = await listChildren(db, companyId, id);
  bl.master = bl.nivel_bl === 'SUB_HOUSE' ? await getMasterForSubHouse(db, companyId, id) : null;
  return bl;
}

async function getMasterForSubHouse(db, companyId, id) {
  return get(db, `SELECT master.id, master.numero_bl, master.nivel_bl
    FROM bills_of_lading sub
    JOIN bills_of_lading house ON house.id = sub.parent_bl_id AND house.company_id = sub.company_id
    JOIN bills_of_lading master ON master.id = house.parent_bl_id AND master.company_id = sub.company_id
    WHERE sub.id = ? AND sub.company_id = ?`, [id, companyId]);
}

async function listChildren(db, companyId, parentId) {
  const rows = await all(db, 'SELECT * FROM bills_of_lading WHERE company_id = ? AND parent_bl_id = ? ORDER BY id', [companyId, parentId]);
  return rows.map(mapBl);
}

async function insertChildren(db, blId, containers, cargoItems) {
  const containerIdMap = new Map();
  for (let index = 0; index < containers.length; index += 1) {
    const row = containers[index];
    const result = await run(db, `INSERT INTO bl_containers
      (${['bl_id', ...CONTAINER_FIELDS].join(', ')})
      VALUES (${['?', ...CONTAINER_FIELDS.map(() => '?')].join(', ')})`,
      [blId, ...CONTAINER_FIELDS.map((field) => row[field] === '' ? null : row[field])]
    );
    if (row.id) containerIdMap.set(Number(row.id), result.lastID);
    containerIdMap.set(index + 1, result.lastID);
  }
  for (const row of cargoItems) {
    const containerId = row.container_id && containerIdMap.get(Number(row.container_id)) ? containerIdMap.get(Number(row.container_id)) : null;
    await run(db, `INSERT INTO bl_cargo_items
      (${['bl_id', ...CARGO_FIELDS].join(', ')})
      VALUES (${['?', ...CARGO_FIELDS.map(() => '?')].join(', ')})`,
      [blId, ...CARGO_FIELDS.map((field) => field === 'container_id' ? containerId : (row[field] === '' ? null : row[field]))]
    );
  }
}

async function replaceChildren(db, blId, containers, cargoItems) {
  await run(db, 'DELETE FROM bl_cargo_items WHERE bl_id = ?', [blId]);
  await run(db, 'DELETE FROM bl_containers WHERE bl_id = ?', [blId]);
  await insertChildren(db, blId, containers, cargoItems);
}

async function create(db, companyId, userId, body, status) {
  const payload = normalizePayload(body, status);
  await validateParent(db, companyId, payload.nivel_bl, payload.parent_bl_id);
  payload.numero_bl = payload.numero_bl || await nextNumber(db, companyId, payload.nivel_bl);
  const containers = normalizeContainers(body.containers);
  const cargoItems = normalizeCargoItems(body.cargo_items);
  const totals = computeTotals(containers, cargoItems);
  const columns = ['company_id', ...BL_FIELDS, ...Object.keys(totals), 'created_by', 'updated_by'];
  const values = columns.map((column) => {
    if (column === 'company_id') return companyId;
    if (column === 'created_by' || column === 'updated_by') return userId || null;
    if (Object.prototype.hasOwnProperty.call(totals, column)) return totals[column];
    return payload[column] === '' ? null : payload[column];
  });
  const result = await run(db, `INSERT INTO bills_of_lading (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
  await insertChildren(db, result.lastID, containers, cargoItems);
  return result.lastID;
}

async function update(db, companyId, id, userId, body, status) {
  const current = await find(db, companyId, id);
  if (!current) throw new Error('BL no encontrado.');
  if (current.estado !== 'Borrador') throw new Error('Un BL emitido o anulado no puede editarse.');
  const payload = normalizePayload({ ...body, nivel_bl: current.nivel_bl, parent_bl_id: current.parent_bl_id, numero_bl: current.numero_bl }, status);
  await validateParent(db, companyId, payload.nivel_bl, payload.parent_bl_id);
  const containers = normalizeContainers(body.containers);
  const cargoItems = normalizeCargoItems(body.cargo_items);
  const totals = computeTotals(containers, cargoItems);
  const editableFields = BL_FIELDS.filter((field) => !['parent_bl_id', 'nivel_bl', 'numero_bl'].includes(field));
  const setFields = [...editableFields, ...Object.keys(totals), 'updated_by'];
  await run(db, `UPDATE bills_of_lading SET ${setFields.map((field) => `${field} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND company_id = ? AND estado = 'Borrador'`,
    [
      ...editableFields.map((field) => payload[field] === '' ? null : payload[field]),
      ...Object.keys(totals).map((field) => totals[field]),
      userId || null,
      id,
      companyId
    ]);
  await replaceChildren(db, id, containers, cargoItems);
}

async function setStatus(db, companyId, id, userId, status) {
  if (!STATUSES.includes(status)) throw new Error('Estado invalido.');
  await run(db, 'UPDATE bills_of_lading SET estado = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [status, userId || null, id, companyId]);
}

async function createChildDraft(db, companyId, userId, parentId, childLevel) {
  const parent = await validateParent(db, companyId, normalizeLevel(childLevel), parentId);
  const inherited = {
    nivel_bl: childLevel,
    parent_bl_id: parent.id,
    fecha_emision: new Date().toISOString().slice(0, 10),
    estado: 'Borrador',
    lugar_emision: parent.lugar_emision,
    tipo_servicio: parent.tipo_servicio,
    modalidad: parent.modalidad,
    incoterm: parent.incoterm,
    moneda: parent.moneda,
    carrier: parent.carrier,
    vessel: parent.vessel,
    voyage: parent.voyage,
    port_of_loading: parent.port_of_loading,
    port_of_discharge: parent.port_of_discharge,
    place_of_receipt: parent.place_of_receipt,
    place_of_delivery: parent.place_of_delivery,
    final_destination: parent.final_destination,
    etd: parent.etd,
    eta: parent.eta,
    freight_terms: parent.freight_terms,
    freight_payable_at: parent.freight_payable_at,
    number_of_originals: parent.number_of_originals,
    ocean_freight: parent.ocean_freight,
    charges: parent.charges,
    containers: parent.containers || [],
    cargo_items: parent.cargo_items || []
  };
  return create(db, companyId, userId, inherited, 'Borrador');
}

async function duplicate(db, companyId, userId, sourceId, withChildren = false, parentOverride = null) {
  const source = await find(db, companyId, sourceId);
  if (!source) throw new Error('BL no encontrado.');
  const data = { ...source, parent_bl_id: parentOverride === null ? source.parent_bl_id : parentOverride, numero_bl: null, estado: 'Borrador' };
  const newId = await create(db, companyId, userId, data, 'Borrador');
  if (withChildren) {
    for (const child of source.children || []) {
      await duplicate(db, companyId, userId, child.id, true, newId);
    }
  }
  return newId;
}

async function tree(db, companyId) {
  const rows = await all(db, 'SELECT * FROM bills_of_lading WHERE company_id = ? ORDER BY nivel_bl, id', [companyId]);
  const byId = new Map(rows.map((row) => [row.id, { ...mapBl(row), children: [] }]));
  const roots = [];
  byId.forEach((node) => {
    if (node.parent_bl_id && byId.has(node.parent_bl_id)) byId.get(node.parent_bl_id).children.push(node);
    else roots.push(node);
  });
  return roots.filter((node) => node.nivel_bl === 'MASTER' || !node.parent_bl_id);
}

function validateForIssue(bl, containers, cargoItems) {
  const missing = [];
  [
    ['shipper_nombre', 'Shipper'],
    ['consignee_nombre', 'Consignee'],
    ['notify_nombre', 'Notify Party'],
    ['carrier', 'Carrier'],
    ['vessel', 'Vessel'],
    ['voyage', 'Voyage'],
    ['port_of_loading', 'Port of Loading'],
    ['port_of_discharge', 'Port of Discharge'],
    ['place_of_receipt', 'Place of Receipt'],
    ['place_of_delivery', 'Place of Delivery']
  ].forEach(([field, label]) => {
    if (!clean(bl[field])) missing.push(label);
  });
  if (!containers.length && !cargoItems.length) missing.push('Al menos un contenedor o mercancia');
  const totals = computeTotals(containers, cargoItems);
  if (totals.total_packages <= 0) missing.push('Total de bultos');
  if (totals.total_gross_weight <= 0) missing.push('Peso bruto');
  if (!cargoItems.some((item) => clean(item.description))) missing.push('Descripcion de mercancia');
  return missing;
}

module.exports = {
  LEVELS,
  STATUSES,
  MODALITIES,
  FREIGHT_TERMS,
  LEVEL_META,
  clean,
  normalizeContainers,
  normalizeCargoItems,
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
