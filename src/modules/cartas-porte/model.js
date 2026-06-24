const STATUSES = ['Borrador', 'Emitida', 'Anulada'];

const CARTA_FIELDS = [
  'fecha_emision', 'estado', 'idioma', 'tipo_servicio', 'tipo_transporte', 'lugar_emision',
  'observaciones', 'condiciones_transporte', 'instrucciones_especiales',
  'remitente_nombre', 'remitente_nit', 'remitente_direccion', 'remitente_telefono', 'remitente_email', 'remitente_contacto',
  'destinatario_nombre', 'destinatario_nit', 'destinatario_direccion', 'destinatario_telefono', 'destinatario_email', 'destinatario_contacto',
  'transportista_nombre', 'transportista_nit', 'transportista_direccion', 'transportista_telefono', 'transportista_email',
  'conductor_nombre', 'conductor_dpi', 'conductor_licencia', 'placa_vehiculo', 'marca_vehiculo', 'tipo_vehiculo',
  'placa_remolque', 'numero_contenedor', 'numero_marchamo',
  'origen_direccion', 'origen_municipio', 'origen_departamento', 'origen_pais',
  'destino_direccion', 'destino_municipio', 'destino_departamento', 'destino_pais',
  'fecha_recoleccion', 'hora_recoleccion', 'fecha_entrega_estimada', 'hora_entrega_estimada',
  'fecha_hora_recepcion', 'recibe_nombre', 'recibe_dpi'
];

const ITEM_FIELDS = [
  'cantidad_bultos', 'tipo_embalaje', 'descripcion_mercancia', 'peso_bruto',
  'peso_neto', 'volumen', 'valor_declarado', 'moneda', 'marcas_numeros',
  'hs_code', 'observaciones'
];

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve(this);
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

function dbValue(value) {
  return value === undefined || value === null || value === '' ? null : value;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeStatus(value) {
  const status = clean(value) || 'Borrador';
  return STATUSES.includes(status) ? status : 'Borrador';
}

function normalizeLanguage(value) {
  return clean(value) === 'en' ? 'en' : 'es';
}

function normalizePayload(raw) {
  const payload = {};
  CARTA_FIELDS.forEach((field) => {
    payload[field] = clean(raw[field]) || null;
  });
  payload.estado = normalizeStatus(payload.estado);
  payload.idioma = normalizeLanguage(payload.idioma);
  payload.fecha_emision = payload.fecha_emision || new Date().toISOString().slice(0, 10);
  return payload;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]);
  }
  return [];
}

function normalizeItems(rawItems) {
  return asArray(rawItems).map((item) => {
    const row = {};
    ITEM_FIELDS.forEach((field) => {
      row[field] = clean(item && item[field]);
    });
    row.cantidad_bultos = number(row.cantidad_bultos);
    row.peso_bruto = number(row.peso_bruto);
    row.peso_neto = number(row.peso_neto);
    row.volumen = number(row.volumen);
    row.valor_declarado = number(row.valor_declarado);
    row.moneda = row.moneda || 'USD';
    return row;
  }).filter((row) => ITEM_FIELDS.some((field) => clean(row[field])));
}

function computeTotals(items) {
  return items.reduce((totals, item) => {
    totals.total_bultos += number(item.cantidad_bultos);
    totals.total_peso_bruto += number(item.peso_bruto);
    totals.total_peso_neto += number(item.peso_neto);
    totals.total_volumen += number(item.volumen);
    totals.total_valor_declarado += number(item.valor_declarado);
    return totals;
  }, {
    total_bultos: 0,
    total_peso_bruto: 0,
    total_peso_neto: 0,
    total_volumen: 0,
    total_valor_declarado: 0
  });
}

async function ensureTables(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS cartas_porte (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    numero TEXT NOT NULL,
    fecha_emision TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'Borrador',
    idioma TEXT NOT NULL DEFAULT 'es',
    tipo_servicio TEXT, tipo_transporte TEXT, lugar_emision TEXT,
    observaciones TEXT, condiciones_transporte TEXT, instrucciones_especiales TEXT,
    created_by INTEGER, updated_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    remitente_nombre TEXT, remitente_nit TEXT, remitente_direccion TEXT, remitente_telefono TEXT, remitente_email TEXT, remitente_contacto TEXT,
    destinatario_nombre TEXT, destinatario_nit TEXT, destinatario_direccion TEXT, destinatario_telefono TEXT, destinatario_email TEXT, destinatario_contacto TEXT,
    transportista_nombre TEXT, transportista_nit TEXT, transportista_direccion TEXT, transportista_telefono TEXT, transportista_email TEXT,
    conductor_nombre TEXT, conductor_dpi TEXT, conductor_licencia TEXT, placa_vehiculo TEXT, marca_vehiculo TEXT, tipo_vehiculo TEXT,
    placa_remolque TEXT, numero_contenedor TEXT, numero_marchamo TEXT,
    origen_direccion TEXT, origen_municipio TEXT, origen_departamento TEXT, origen_pais TEXT,
    destino_direccion TEXT, destino_municipio TEXT, destino_departamento TEXT, destino_pais TEXT,
    fecha_recoleccion TEXT, hora_recoleccion TEXT, fecha_entrega_estimada TEXT, hora_entrega_estimada TEXT,
    total_bultos REAL NOT NULL DEFAULT 0, total_peso_bruto REAL NOT NULL DEFAULT 0, total_peso_neto REAL NOT NULL DEFAULT 0,
    total_volumen REAL NOT NULL DEFAULT 0, total_valor_declarado REAL NOT NULL DEFAULT 0,
    fecha_hora_recepcion TEXT, recibe_nombre TEXT, recibe_dpi TEXT,
    UNIQUE(company_id, numero)
  )`);
  const columns = await all(db, `SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'cartas_porte'
    ORDER BY ordinal_position`);
  if (!columns.some((column) => column.name === 'idioma')) {
    await run(db, "ALTER TABLE cartas_porte ADD COLUMN idioma TEXT NOT NULL DEFAULT 'es'");
  }
  await run(db, `CREATE TABLE IF NOT EXISTS cartas_porte_items (
    id BIGSERIAL PRIMARY KEY,
    carta_porte_id INTEGER NOT NULL,
    cantidad_bultos REAL, tipo_embalaje TEXT, descripcion_mercancia TEXT,
    peso_bruto REAL, peso_neto REAL, volumen REAL, valor_declarado REAL,
    moneda TEXT, marcas_numeros TEXT, hs_code TEXT, observaciones TEXT,
    FOREIGN KEY (carta_porte_id) REFERENCES cartas_porte(id)
  )`);
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_cartas_porte_company_estado ON cartas_porte (company_id, estado)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_cartas_porte_company_fecha ON cartas_porte (company_id, fecha_emision)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_cartas_porte_company_numero ON cartas_porte (company_id, numero)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_cartas_porte_items_carta ON cartas_porte_items (carta_porte_id)');
}

async function nextNumber(db, companyId) {
  const row = await get(
    db,
    "SELECT numero FROM cartas_porte WHERE company_id = ? AND numero LIKE 'CP-%' ORDER BY CAST(substr(numero, 4) AS INTEGER) DESC LIMIT 1",
    [companyId]
  );
  const last = row && row.numero ? Number(String(row.numero).replace(/^CP-/, '')) : 0;
  return `CP-${String((Number.isFinite(last) ? last : 0) + 1).padStart(6, '0')}`;
}

async function list(db, companyId, filters = {}) {
  const clauses = ['company_id = ?'];
  const params = [companyId];
  if (filters.archived) {
    clauses.push("estado = 'Anulada'");
  } else {
    clauses.push("estado != 'Anulada'");
  }
  if (clean(filters.numero)) {
    clauses.push('numero LIKE ?');
    params.push(`%${clean(filters.numero)}%`);
  }
  if (clean(filters.remitente)) {
    clauses.push('remitente_nombre LIKE ?');
    params.push(`%${clean(filters.remitente)}%`);
  }
  if (clean(filters.destinatario)) {
    clauses.push('destinatario_nombre LIKE ?');
    params.push(`%${clean(filters.destinatario)}%`);
  }
  if (clean(filters.fecha_desde)) {
    clauses.push('date(fecha_emision) >= date(?)');
    params.push(clean(filters.fecha_desde));
  }
  if (clean(filters.fecha_hasta)) {
    clauses.push('date(fecha_emision) <= date(?)');
    params.push(clean(filters.fecha_hasta));
  }
  if (!filters.archived && clean(filters.estado) && clean(filters.estado) !== 'Todos') {
    clauses.push('estado = ?');
    params.push(normalizeStatus(filters.estado));
  }
  if (clean(filters.placa)) {
    clauses.push('placa_vehiculo LIKE ?');
    params.push(`%${clean(filters.placa)}%`);
  }
  if (clean(filters.conductor)) {
    clauses.push('conductor_nombre LIKE ?');
    params.push(`%${clean(filters.conductor)}%`);
  }
  return all(db, `SELECT * FROM cartas_porte WHERE ${clauses.join(' AND ')} ORDER BY fecha_emision DESC, id DESC`, params);
}

async function find(db, companyId, id) {
  const carta = await get(db, 'SELECT * FROM cartas_porte WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!carta) return null;
  carta.items = await all(db, 'SELECT * FROM cartas_porte_items WHERE carta_porte_id = ? ORDER BY id', [id]);
  return carta;
}

async function insertItems(db, cartaId, items) {
  await run(db, 'DELETE FROM cartas_porte_items WHERE carta_porte_id = ?', [cartaId]);
  for (const item of items) {
    await run(
      db,
      `INSERT INTO cartas_porte_items (${ITEM_FIELDS.join(', ')}, carta_porte_id)
       VALUES (${ITEM_FIELDS.map(() => '?').join(', ')}, ?)`,
      [...ITEM_FIELDS.map((field) => dbValue(item[field])), cartaId]
    );
  }
}

async function create(db, companyId, userId, rawPayload, rawItems, forcedStatus) {
  const payload = normalizePayload(rawPayload);
  if (forcedStatus) payload.estado = forcedStatus;
  const items = normalizeItems(rawItems);
  const totals = computeTotals(items);
  const numero = await nextNumber(db, companyId);
  const fields = ['company_id', 'numero', ...CARTA_FIELDS, ...Object.keys(totals), 'created_by', 'updated_by'];
  const values = [
    companyId,
    numero,
    ...CARTA_FIELDS.map((field) => payload[field]),
    ...Object.values(totals),
    userId || null,
    userId || null
  ];
  const result = await run(
    db,
    `INSERT INTO cartas_porte (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    values
  );
  await insertItems(db, result.lastID, items);
  return result.lastID;
}

async function update(db, companyId, id, userId, rawPayload, rawItems, forcedStatus) {
  const current = await find(db, companyId, id);
  if (!current) throw new Error('Carta Porte no encontrada');
  if (current.estado !== 'Borrador') throw new Error('Solo se puede editar una carta en Borrador');
  const payload = normalizePayload(rawPayload);
  if (forcedStatus) payload.estado = forcedStatus;
  const items = normalizeItems(rawItems);
  const totals = computeTotals(items);
  const assignments = [...CARTA_FIELDS, ...Object.keys(totals), 'updated_by'].map((field) => `${field} = ?`);
  await run(
    db,
    `UPDATE cartas_porte SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ? AND estado = 'Borrador'`,
    [...CARTA_FIELDS.map((field) => payload[field]), ...Object.values(totals), userId || null, id, companyId]
  );
  await insertItems(db, id, items);
}

async function setStatus(db, companyId, id, userId, status) {
  await run(
    db,
    'UPDATE cartas_porte SET estado = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
    [normalizeStatus(status), userId || null, id, companyId]
  );
}

module.exports = {
  STATUSES,
  CARTA_FIELDS,
  ITEM_FIELDS,
  clean,
  normalizeLanguage,
  normalizeItems,
  computeTotals,
  ensureTables,
  list,
  find,
  create,
  update,
  setStatus
};
