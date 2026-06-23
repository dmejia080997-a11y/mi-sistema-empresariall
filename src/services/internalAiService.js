const fs = require('fs');
const path = require('path');
const { STORAGE_UPLOADS_DIR } = require('../core/storage-paths');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const { stringify } = require('csv-stringify/sync');

const EXPORT_ROOT = path.join(STORAGE_UPLOADS_DIR, 'ai');
const BLOCKED_SQL = /\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|EXEC|PRAGMA|ATTACH)\b/i;
const SQL_LIKE = /\b(SELECT|FROM|WHERE|JOIN|UNION|TABLE|DATABASE)\b/i;
const EXTERNAL_TOPICS = [
  'clima', 'noticias', 'politica', 'política', 'internet', 'receta', 'recetas',
  'medicina', 'doctor', 'salud', 'gobierno', 'presidente', 'deporte', 'historia',
  'capital de', 'quien es', 'quién es', 'que es', 'qué es'
];

const INTENTS = [
  {
    key: 'clientes_activos',
    name: 'Clientes activos',
    module: 'customers',
    permission: 'ai_view_clients',
    export: true,
    description: 'Listado de clientes no anulados de la empresa actual.',
    phrases: ['clientes activos', 'dame clientes activos', 'exportar clientes activos', 'excel de clientes activos'],
    columns: ['Código cliente', 'Nombre', 'NIT', 'Teléfono', 'Correo', 'Dirección', 'Vendedor', 'Estado', 'Última compra']
  },
  {
    key: 'clientes_cotizados',
    name: 'Clientes cotizados',
    module: 'sales',
    permission: 'ai_view_quotes',
    export: true,
    description: 'Cotizaciones agrupadas por cliente o prospecto.',
    phrases: ['clientes cotizados', 'clientes que he cotizado', 'cotizaciones por cliente', 'a quien le he enviado cotizacion', 'a quién le he enviado cotización'],
    columns: ['Cliente', 'Cotizaciones', 'Total cotizado', 'Última cotización', 'Estado principal']
  },
  {
    key: 'ventas_mes',
    name: 'Ventas del mes',
    module: 'sales',
    permission: 'ai_view_sales',
    export: true,
    description: 'Ventas o facturas del rango solicitado.',
    phrases: ['ventas del mes', 'cuanto llevo vendido este mes', 'cuánto llevo vendido este mes', 'venta mensual', 'total vendido este mes'],
    columns: ['Fecha', 'Factura', 'Cliente', 'Vendedor', 'Producto/Servicio', 'Total', 'Estado']
  },
  {
    key: 'cuentas_por_cobrar',
    name: 'Cuentas por cobrar',
    module: 'billing',
    permission: 'ai_view_accounts_receivable',
    export: true,
    description: 'Facturas con saldo pendiente.',
    phrases: ['cuanto tengo por cobrar', 'cuánto tengo por cobrar', 'cuentas por cobrar', 'facturas pendientes de pago', 'clientes con saldo'],
    columns: ['Factura', 'Cliente', 'Fecha emisión', 'Fecha vencimiento', 'Total factura', 'Pagado', 'Saldo', 'Días vencidos', 'Vendedor']
  },
  {
    key: 'prospectos_por_vendedor',
    name: 'Prospectos por vendedor',
    module: 'sales',
    permission: 'ai_view_sales',
    export: true,
    description: 'Prospectos agrupados y detallados por vendedor.',
    phrases: ['prospectos por vendedor', 'leads por vendedor', 'clientes potenciales por vendedor'],
    columns: ['Vendedor', 'Prospecto', 'Teléfono', 'Correo', 'Estado', 'Último seguimiento', 'Próxima acción']
  },
  {
    key: 'cotizaciones_pendientes',
    name: 'Cotizaciones pendientes',
    module: 'sales',
    permission: 'ai_view_quotes',
    export: true,
    description: 'Cotizaciones abiertas, borrador o enviadas sin aceptación.',
    phrases: ['cotizaciones pendientes', 'cotizaciones abiertas', 'cotizaciones no aceptadas'],
    columns: ['Cotización', 'Cliente', 'Vendedor', 'Fecha', 'Válida hasta', 'Total', 'Estado']
  },
  {
    key: 'facturas_vencidas',
    name: 'Facturas vencidas',
    module: 'billing',
    permission: 'ai_view_accounts_receivable',
    export: true,
    description: 'Facturas vencidas con saldo pendiente.',
    phrases: ['facturas vencidas', 'facturas atrasadas', 'cobros vencidos'],
    columns: ['Factura', 'Cliente', 'Fecha emisión', 'Fecha vencimiento', 'Total factura', 'Pagado', 'Saldo', 'Días vencidos', 'Vendedor']
  },
  {
    key: 'inventario_disponible',
    name: 'Inventario disponible',
    module: 'inventory',
    permission: 'ai_view_inventory',
    export: true,
    description: 'Existencias actuales de productos.',
    phrases: ['inventario disponible', 'stock disponible', 'existencia de productos', 'existencias de productos'],
    columns: ['SKU', 'Producto', 'Categoría', 'Marca', 'Disponible', 'Mínimo', 'Precio']
  },
  {
    key: 'productos_mas_vendidos',
    name: 'Productos más vendidos',
    module: 'sales',
    permission: 'ai_view_sales',
    export: true,
    description: 'Ventas agrupadas por producto o servicio.',
    phrases: ['productos mas vendidos', 'productos más vendidos', 'top productos', 'articulos mas vendidos', 'artículos más vendidos'],
    columns: ['Producto/Servicio', 'Cantidad', 'Total vendido']
  },
  {
    key: 'vendedores_ranking',
    name: 'Ranking de vendedores',
    module: 'sales',
    permission: 'ai_view_sales',
    export: true,
    description: 'Ventas agrupadas por vendedor.',
    phrases: ['vendedor con mas ventas', 'vendedor con más ventas', 'ranking de vendedores', 'ventas por vendedor'],
    columns: ['Vendedor', 'Facturas/Ventas', 'Total vendido']
  },
  {
    key: 'proyectos_atrasados',
    name: 'Proyectos atrasados',
    module: 'projects',
    permission: 'ai_view_projects',
    export: true,
    description: 'Proyectos o tareas vencidas.',
    phrases: ['proyectos atrasados', 'tareas vencidas', 'proyectos pendientes'],
    columns: ['Proyecto', 'Tarea', 'Responsable', 'Fecha vencimiento', 'Estado', 'Días vencidos']
  },
  {
    key: 'produccion_en_proceso',
    name: 'Producción en proceso',
    module: 'production',
    permission: 'ai_view_production',
    export: true,
    description: 'Órdenes de producción activas.',
    phrases: ['produccion en proceso', 'producción en proceso', 'ordenes de produccion abiertas', 'órdenes de producción abiertas', 'fabricacion pendiente', 'fabricación pendiente'],
    columns: ['Orden', 'Producto', 'Cantidad planificada', 'Cantidad terminada', 'Estado', 'Inicio estimado', 'Fin estimado']
  }
];

const INTENT_MAP = new Map(INTENTS.map((intent) => [intent.key, intent]));

const INTENT_HINTS = {
  clientes_activos: ['cliente', 'clientes', 'activo', 'activos', 'listado', 'contactos'],
  clientes_cotizados: ['cotizado', 'cotizados', 'cotizacion', 'cotizaciones', 'cliente', 'prospecto'],
  ventas_mes: ['venta', 'ventas', 'vendido', 'facturado', 'facturacion', 'ingresos', 'monto'],
  cuentas_por_cobrar: ['cobrar', 'cobro', 'deben', 'deuda', 'saldo', 'pendiente', 'pendientes', 'pago'],
  prospectos_por_vendedor: ['prospecto', 'prospectos', 'lead', 'leads', 'vendedor', 'asesor'],
  cotizaciones_pendientes: ['cotizacion', 'cotizaciones', 'pendiente', 'pendientes', 'abierta', 'abiertas', 'enviada'],
  facturas_vencidas: ['factura', 'facturas', 'vencida', 'vencidas', 'atrasada', 'atrasadas', 'mora'],
  inventario_disponible: ['inventario', 'stock', 'existencia', 'existencias', 'disponible', 'productos', 'bodega'],
  productos_mas_vendidos: ['producto', 'productos', 'articulo', 'articulos', 'mas', 'top', 'vendidos', 'ranking'],
  vendedores_ranking: ['vendedor', 'vendedores', 'asesor', 'asesores', 'ranking', 'ventas', 'mejor'],
  proyectos_atrasados: ['proyecto', 'proyectos', 'tarea', 'tareas', 'atrasado', 'atrasados', 'vencido', 'vencidos'],
  produccion_en_proceso: ['produccion', 'fabricacion', 'orden', 'ordenes', 'proceso', 'pendiente', 'planta']
};

async function ensureSchema(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS ai_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    intent_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    module_required TEXT,
    permission_required TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, intent_key)
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS ai_chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    intent_detected TEXT,
    response_summary TEXT,
    export_generated INTEGER NOT NULL DEFAULT 0,
    export_file_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS ai_allowed_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_key TEXT NOT NULL,
    module TEXT,
    permission_required TEXT,
    query_type TEXT NOT NULL DEFAULT 'report',
    sql_template TEXT NOT NULL,
    export_allowed INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(intent_key, query_type)
  )`);
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_ai_chat_history_scope ON ai_chat_history (company_id, user_id, created_at)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_ai_intents_scope ON ai_intents (company_id, enabled)');
  await ensurePermissions(db);
  await seedAllowedQueries(db);
}

async function ensureCompanyIntents(db, companyId) {
  for (const intent of INTENTS) {
    await run(db, `INSERT OR IGNORE INTO ai_intents
      (company_id, intent_key, name, description, module_required, permission_required, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [companyId, intent.key, intent.name, intent.description, intent.module, intent.permission]);
  }
}

async function ask(db, context, question) {
  await ensureSchema(db);
  await ensureCompanyIntents(db, context.companyId);
  const cleanQuestion = clean(question, 1200);
  if (!cleanQuestion) throw statusError('Pregunta requerida.', 400);
  validateQuestionSafety(cleanQuestion);
  validateBasePermission(context, 'ai_ask');

  const dateRange = parseDateRange(cleanQuestion);
  const selection = await detectIntent(db, context.companyId, cleanQuestion);
  if (!selection) {
    const summary = 'Solo puedo ayudarte con información interna del sistema.';
    await saveChatHistory(db, context, cleanQuestion, null, summary, false, null);
    return { ok: true, answer: summary, summary, intent: null, rows: [], columns: [], totals: {}, dateRange };
  }
  validatePermission(context, selection.intent);
  const result = await executeIntent(db, selection.intent.key, { dateRange }, context);
  const response = formatResponse(selection.intent, result, dateRange);
  await saveChatHistory(db, context, cleanQuestion, selection.intent.key, response.summary, false, null);
  await audit(db, context, 'ai.ask', { question: cleanQuestion, intent: selection.intent.key, rows: result.rows.length });
  return { ok: true, intent: selection.intent.key, answer: response.answer, summary: response.summary, rows: result.rows, columns: result.columns, totals: result.totals, dateRange };
}

async function generateExport(db, context, intentKey, format, question) {
  await ensureSchema(db);
  await ensureCompanyIntents(db, context.companyId);
  validateBasePermission(context, 'ai_export');
  const intent = INTENT_MAP.get(clean(intentKey, 80));
  if (!intent) throw statusError('Intención no permitida.', 400);
  validatePermission(context, intent);
  const config = await getIntentConfig(db, context.companyId, intent.key);
  if (!config || Number(config.enabled) !== 1) throw statusError('La intención está desactivada.', 403);
  const dateRange = parseDateRange(question || '');
  const result = await executeIntent(db, intent.key, { dateRange }, context);
  const normalizedFormat = ['xlsx', 'csv', 'pdf'].includes(String(format || '').toLowerCase()) ? String(format).toLowerCase() : 'xlsx';
  const file = await writeExport(intent, result, context.companyId, normalizedFormat);
  await saveChatHistory(db, context, question || `Exportar ${intent.name}`, intent.key, `Exportación ${normalizedFormat.toUpperCase()} generada para ${intent.name}.`, true, file.publicPath);
  await audit(db, context, 'ai.export', { intent: intent.key, format: normalizedFormat, rows: result.rows.length, file: file.publicPath });
  return { ok: true, ...file, rows: result.rows.length };
}

async function listHistory(db, context) {
  await ensureSchema(db);
  return all(db, `SELECT id, question, intent_detected, response_summary, export_generated, export_file_path, created_at
    FROM ai_chat_history
    WHERE company_id = ? AND user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 100`, [context.companyId, context.userId]);
}

async function listIntents(db, context) {
  await ensureSchema(db);
  await ensureCompanyIntents(db, context.companyId);
  return all(db, `SELECT id, intent_key, name, description, module_required, permission_required, enabled, updated_at
    FROM ai_intents
    WHERE company_id = ?
    ORDER BY name`, [context.companyId]);
}

async function toggleIntent(db, context, id) {
  await ensureSchema(db);
  validateBasePermission(context, 'ai_admin_intents');
  const row = await get(db, 'SELECT * FROM ai_intents WHERE id = ? AND company_id = ?', [Number(id), context.companyId]);
  if (!row) throw statusError('Intención no encontrada.', 404);
  const enabled = Number(row.enabled) === 1 ? 0 : 1;
  await run(db, 'UPDATE ai_intents SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [enabled, row.id, context.companyId]);
  await audit(db, context, 'ai.intent_toggle', { intent: row.intent_key, enabled });
  return { ok: true, enabled };
}

async function dashboard(db, context) {
  await ensureSchema(db);
  await ensureCompanyIntents(db, context.companyId);
  const today = await get(db, `SELECT COUNT(*) AS total FROM ai_chat_history WHERE company_id = ? AND date(created_at) = date('now')`, [context.companyId]);
  const exports = await get(db, `SELECT COUNT(*) AS total FROM ai_chat_history WHERE company_id = ? AND export_generated = 1`, [context.companyId]);
  const active = await get(db, `SELECT COUNT(*) AS total FROM ai_intents WHERE company_id = ? AND enabled = 1`, [context.companyId]);
  const last = await get(db, `SELECT question, created_at FROM ai_chat_history WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [context.companyId]);
  return {
    todayQueries: Number(today && today.total || 0),
    exportsGenerated: Number(exports && exports.total || 0),
    activeIntents: Number(active && active.total || 0),
    lastQuestion: last ? last.question : 'Sin consultas',
    modules: INTENTS.map((intent) => intent.module).filter((value, index, arr) => arr.indexOf(value) === index)
  };
}

async function detectIntent(db, companyId, question) {
  const text = normalize(question);
  const configRows = await all(db, 'SELECT intent_key, enabled FROM ai_intents WHERE company_id = ?', [companyId]);
  const enabled = new Map(configRows.map((row) => [row.intent_key, Number(row.enabled) === 1]));
  let best = null;
  for (const intent of INTENTS) {
    if (enabled.has(intent.key) && !enabled.get(intent.key)) continue;
    let score = 0;
    for (const phrase of intent.phrases) {
      const p = normalize(phrase);
      if (text.includes(p)) score += 6 + p.length / 20;
      else score += phraseScore(text, p);
    }
    score += hintScore(text, intent.key);
    if (!best || score > best.score) best = { intent, score };
  }
  return best && best.score >= 1.8 ? best : null;
}

function validateQuestionSafety(question) {
  if (BLOCKED_SQL.test(question) || SQL_LIKE.test(question)) {
    throw statusError('No puedo ejecutar SQL ni comandos enviados por el usuario.', 400);
  }
  const text = normalize(question);
  if (EXTERNAL_TOPICS.some((topic) => text.includes(normalize(topic)))) {
    throw statusError('Solo puedo ayudarte con información interna del sistema.', 400);
  }
}

function validateBasePermission(context, action) {
  if (!context.companyId) throw statusError('company_id no encontrado en la sesión.', 400);
  if (!context.userId) throw statusError('Sesión requerida.', 401);
  if (!hasPermission(context, 'ai_internal', action) && !hasPermission(context, 'ai_empresarial', 'view')) {
    throw statusError('No tienes permiso para usar el Asistente.', 403);
  }
}

function validatePermission(context, intent) {
  if (!hasPermission(context, 'ai_internal', intent.permission) && !hasPermission(context, intent.module, 'view')) {
    throw statusError('No tienes permiso para consultar esa información.', 403);
  }
}

async function executeIntent(db, intentKey, params, context) {
  const executor = EXECUTORS[intentKey];
  if (!executor) throw statusError('Consulta no permitida.', 400);
  return executor(db, context.companyId, params.dateRange || parseDateRange('este mes'));
}

const EXECUTORS = {
  clientes_activos: async (db, companyId) => {
    const rows = await safeAll(db, `SELECT c.customer_code AS "Código cliente", c.name AS "Nombre", c.document_number AS "NIT",
      COALESCE(c.mobile, c.phone, '') AS "Teléfono", c.email AS "Correo", COALESCE(c.full_address, c.address, '') AS "Dirección",
      c.advisor AS "Vendedor", CASE WHEN COALESCE(c.is_voided,0)=0 THEN 'Activo' ELSE 'Anulado' END AS "Estado",
      (SELECT MAX(COALESCE(ih.issue_date, ih.created_at)) FROM invoice_headers ih WHERE ih.customer_id = c.id AND ih.company_id = c.company_id) AS "Última compra"
      FROM customers c
      WHERE c.company_id = ? AND COALESCE(c.is_voided,0) = 0
      ORDER BY c.name LIMIT 1000`, [companyId]);
    return result('clientes_activos', rows, { total: rows.length });
  },
  clientes_cotizados: async (db, companyId) => {
    const rows = await safeAll(db, `SELECT COALESCE(c.name, p.name, 'Sin cliente') AS "Cliente", COUNT(q.id) AS "Cotizaciones",
      SUM(q.total) AS "Total cotizado", MAX(q.created_at) AS "Última cotización", MAX(q.status) AS "Estado principal"
      FROM sales_quotes q
      LEFT JOIN customers c ON c.id = q.customer_id AND c.company_id = q.company_id
      LEFT JOIN sales_prospects p ON p.id = q.prospect_id AND p.company_id = q.company_id
      WHERE q.company_id = ?
      GROUP BY COALESCE(c.name, p.name, 'Sin cliente')
      ORDER BY COUNT(q.id) DESC, SUM(q.total) DESC LIMIT 500`, [companyId]);
    return result('clientes_cotizados', rows, { clientes: rows.length });
  },
  ventas_mes: async (db, companyId, range) => {
    const rows = await safeAll(db, `SELECT COALESCE(s.closed_at, s.created_at) AS "Fecha", COALESCE(ih.invoice_number, s.sale_number) AS "Factura",
      COALESCE(c.name, ih.customer_name_snapshot, 'Sin cliente') AS "Cliente", COALESCE(u.username, 'Sin vendedor') AS "Vendedor",
      COALESCE(sl.description, ii.description, ii.item_name_snapshot, 'Venta') AS "Producto/Servicio",
      COALESCE(sl.total, ii.total, s.total, ih.total, 0) AS "Total", COALESCE(ih.status, s.status) AS "Estado"
      FROM sales s
      LEFT JOIN sales_lines sl ON sl.sale_id = s.id AND sl.company_id = s.company_id
      LEFT JOIN invoice_headers ih ON ih.id = s.invoice_header_id AND ih.company_id = s.company_id
      LEFT JOIN invoice_items ii ON ii.header_id = ih.id AND ii.company_id = ih.company_id
      LEFT JOIN customers c ON c.id = COALESCE(s.cliente_id, ih.customer_id) AND c.company_id = s.company_id
      LEFT JOIN users u ON u.id = s.seller_user_id
      WHERE s.company_id = ? AND date(COALESCE(s.closed_at, s.created_at)) BETWEEN date(?) AND date(?)
      ORDER BY "Fecha" DESC LIMIT 1000`, [companyId, range.start, range.end]);
    const total = sum(rows, 'Total');
    return result('ventas_mes', rows, { total, count: uniqueCount(rows, 'Factura') || rows.length });
  },
  cuentas_por_cobrar: async (db, companyId) => receivables(db, companyId, false),
  prospectos_por_vendedor: async (db, companyId) => {
    const rows = await safeAll(db, `SELECT COALESCE(u.username, 'Sin vendedor') AS "Vendedor", p.name AS "Prospecto", p.phone AS "Teléfono",
      p.email AS "Correo", p.status AS "Estado", p.updated_at AS "Último seguimiento", '' AS "Próxima acción"
      FROM sales_prospects p
      LEFT JOIN users u ON u.id = p.assigned_user_id
      WHERE p.company_id = ?
      ORDER BY "Vendedor", p.updated_at DESC LIMIT 1000`, [companyId]);
    return result('prospectos_por_vendedor', rows, { prospectos: rows.length, vendedores: uniqueCount(rows, 'Vendedor') });
  },
  cotizaciones_pendientes: async (db, companyId) => {
    const rows = await safeAll(db, `SELECT q.quote_number AS "Cotización", COALESCE(c.name, p.name, 'Sin cliente') AS "Cliente",
      COALESCE(u.username, 'Sin vendedor') AS "Vendedor", q.created_at AS "Fecha", q.valid_until AS "Válida hasta",
      q.total AS "Total", q.status AS "Estado"
      FROM sales_quotes q
      LEFT JOIN customers c ON c.id = q.customer_id AND c.company_id = q.company_id
      LEFT JOIN sales_prospects p ON p.id = q.prospect_id AND p.company_id = q.company_id
      LEFT JOIN users u ON u.id = q.seller_user_id
      WHERE q.company_id = ? AND q.status IN ('borrador','enviada','sent','draft','pending','pendiente')
      ORDER BY q.created_at DESC LIMIT 1000`, [companyId]);
    return result('cotizaciones_pendientes', rows, { cotizaciones: rows.length, total: sum(rows, 'Total') });
  },
  facturas_vencidas: async (db, companyId) => receivables(db, companyId, true),
  inventario_disponible: async (db, companyId) => {
    const rows = await safeAll(db, `SELECT i.sku AS "SKU", i.name AS "Producto", c.name AS "Categoría", b.name AS "Marca",
      i.qty AS "Disponible", i.min_stock AS "Mínimo", i.price AS "Precio"
      FROM items i
      LEFT JOIN categories c ON c.id = i.category_id AND c.company_id = i.company_id
      LEFT JOIN brands b ON b.id = i.brand_id AND b.company_id = i.company_id
      WHERE i.company_id = ?
      ORDER BY i.name LIMIT 1000`, [companyId]);
    return result('inventario_disponible', rows, { productos: rows.length, unidades: sum(rows, 'Disponible') });
  },
  productos_mas_vendidos: async (db, companyId, range) => {
    const rows = await safeAll(db, `SELECT COALESCE(sl.description, i.name, 'Producto/Servicio') AS "Producto/Servicio",
      SUM(COALESCE(sl.qty, 0)) AS "Cantidad", SUM(COALESCE(sl.total, 0)) AS "Total vendido"
      FROM sales_lines sl
      JOIN sales s ON s.id = sl.sale_id AND s.company_id = sl.company_id
      LEFT JOIN items i ON i.id = sl.item_id AND i.company_id = sl.company_id
      WHERE sl.company_id = ? AND date(COALESCE(s.closed_at, s.created_at)) BETWEEN date(?) AND date(?)
      GROUP BY COALESCE(sl.description, i.name, 'Producto/Servicio')
      ORDER BY "Total vendido" DESC LIMIT 50`, [companyId, range.start, range.end]);
    return result('productos_mas_vendidos', rows, { productos: rows.length, total: sum(rows, 'Total vendido') });
  },
  vendedores_ranking: async (db, companyId, range) => {
    const rows = await safeAll(db, `SELECT COALESCE(u.username, 'Sin vendedor') AS "Vendedor", COUNT(s.id) AS "Facturas/Ventas",
      SUM(s.total) AS "Total vendido"
      FROM sales s
      LEFT JOIN users u ON u.id = s.seller_user_id
      WHERE s.company_id = ? AND date(COALESCE(s.closed_at, s.created_at)) BETWEEN date(?) AND date(?)
      GROUP BY COALESCE(u.username, 'Sin vendedor')
      ORDER BY "Total vendido" DESC LIMIT 100`, [companyId, range.start, range.end]);
    return result('vendedores_ranking', rows, { vendedores: rows.length, total: sum(rows, 'Total vendido') });
  },
  proyectos_atrasados: async (db, companyId) => {
    const rows = await safeAll(db, `SELECT p.name AS "Proyecto", COALESCE(t.title, p.name) AS "Tarea", COALESCE(u.username, '') AS "Responsable",
      COALESCE(t.due_date, p.estimated_end_date) AS "Fecha vencimiento", COALESCE(t.status, p.status) AS "Estado",
      CAST(julianday('now') - julianday(COALESCE(t.due_date, p.estimated_end_date)) AS INTEGER) AS "Días vencidos"
      FROM projects p
      LEFT JOIN project_tasks t ON t.project_id = p.id AND t.company_id = p.company_id
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE p.company_id = ?
        AND date(COALESCE(t.due_date, p.estimated_end_date)) < date('now')
        AND COALESCE(t.status, p.status) NOT IN ('completed','cancelled','finalizada','cancelado')
      ORDER BY "Días vencidos" DESC LIMIT 1000`, [companyId]);
    return result('proyectos_atrasados', rows, { atrasados: rows.length });
  },
  produccion_en_proceso: async (db, companyId) => {
    const rows = await safeAll(db, `SELECT po.order_number AS "Orden", i.name AS "Producto", po.quantity_planned AS "Cantidad planificada",
      po.quantity_finished AS "Cantidad terminada", po.status AS "Estado", po.estimated_start_date AS "Inicio estimado", po.estimated_end_date AS "Fin estimado"
      FROM production_orders po
      LEFT JOIN items i ON i.id = po.product_id AND i.company_id = po.company_id
      WHERE po.company_id = ? AND po.status IN ('draft','pending','in_production','paused')
      ORDER BY po.created_at DESC LIMIT 1000`, [companyId]);
    return result('produccion_en_proceso', rows, { ordenes: rows.length });
  }
};

async function receivables(db, companyId, overdueOnly) {
  const rows = await safeAll(db, `SELECT ih.invoice_number AS "Factura", COALESCE(c.name, ih.customer_name_snapshot, 'Sin cliente') AS "Cliente",
    ih.issue_date AS "Fecha emisión", ih.due_date AS "Fecha vencimiento", ih.total AS "Total factura", ih.paid_total AS "Pagado",
    ih.balance_due AS "Saldo", MAX(0, CAST(julianday('now') - julianday(COALESCE(ih.due_date, ih.issue_date, ih.created_at)) AS INTEGER)) AS "Días vencidos",
    COALESCE(u.username, '') AS "Vendedor"
    FROM invoice_headers ih
    LEFT JOIN customers c ON c.id = ih.customer_id AND c.company_id = ih.company_id
    LEFT JOIN sales s ON s.invoice_header_id = ih.id AND s.company_id = ih.company_id
    LEFT JOIN users u ON u.id = s.seller_user_id
    WHERE ih.company_id = ? AND COALESCE(ih.balance_due, ih.total - COALESCE(ih.paid_total,0), 0) > 0
      ${overdueOnly ? "AND date(COALESCE(ih.due_date, ih.issue_date, ih.created_at)) < date('now')" : ''}
    ORDER BY COALESCE(ih.due_date, ih.issue_date, ih.created_at) ASC LIMIT 1000`, [companyId]);
  return result(overdueOnly ? 'facturas_vencidas' : 'cuentas_por_cobrar', rows, { facturas: rows.length, saldo: sum(rows, 'Saldo') });
}

function result(intentKey, rows, totals) {
  const intent = INTENT_MAP.get(intentKey);
  return { rows, columns: intent ? intent.columns : Object.keys(rows[0] || {}), totals: totals || {} };
}

function formatResponse(intent, resultSet, dateRange) {
  if (!resultSet.rows.length) {
    return { summary: `No encontre datos para ${intent.name}.`, answer: `No encontre datos para ${intent.name}. Puedes probar con otro rango, por ejemplo "este mes", "mes pasado" o una fecha en formato YYYY-MM-DD a YYYY-MM-DD.` };
  }
  let summary = `Encontre ${resultSet.rows.length} registros para ${intent.name}.`;
  if (intent.key === 'ventas_mes') summary = `Este periodo llevas vendido Q${money(resultSet.totals.total)} en ${resultSet.totals.count} facturas/ventas.`;
  if (intent.key === 'cuentas_por_cobrar') summary = `Tienes Q${money(resultSet.totals.saldo)} por cobrar en ${resultSet.totals.facturas} facturas.`;
  if (intent.key === 'facturas_vencidas') summary = `Encontre ${resultSet.totals.facturas} facturas vencidas con saldo Q${money(resultSet.totals.saldo)}.`;
  if (intent.key === 'inventario_disponible') summary = `Encontre ${resultSet.totals.productos} productos con ${resultSet.totals.unidades} unidades disponibles.`;
  const totals = Object.entries(resultSet.totals || {})
    .map(([key, value]) => `${humanizeKey(key)}: ${typeof value === 'number' ? formatValue(value) : value}`)
    .join(' | ');
  const rangeText = dateRange && dateRange.start && dateRange.end && usesDateRange(intent.key)
    ? `Rango consultado: ${dateRange.start} al ${dateRange.end}.`
    : '';
  const top = resultSet.rows.slice(0, 10).map((row, idx) => `${idx + 1}. ${Object.entries(row).slice(0, 6).map(([k, v]) => `${k}: ${formatValue(v)}`).join(' | ')}`);
  const remaining = resultSet.rows.length > top.length ? `Mostrando ${top.length} de ${resultSet.rows.length}. Usa Excel, CSV o PDF para ver/exportar todo el resultado.` : '';
  const parts = [summary, rangeText, totals ? `Totales: ${totals}.` : '', top.length ? `Detalle principal:\n${top.join('\n')}` : '', remaining].filter(Boolean);
  return { summary, answer: parts.join('\n') };
}

function usesDateRange(intentKey) {
  return ['ventas_mes', 'productos_mas_vendidos', 'vendedores_ranking'].includes(intentKey);
}

function humanizeKey(key) {
  return String(key || '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseDateRange(text) {
  const value = normalize(text);
  const now = new Date();
  let start = new Date(now.getFullYear(), now.getMonth(), 1);
  let end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  if (value.includes('hoy')) start = end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (value.includes('ayer')) start = end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  else if (value.includes('mes pasado')) {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (value.includes('esta semana')) {
    const day = now.getDay() || 7;
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 7);
  } else if (value.includes('semana pasada')) {
    const day = now.getDay() || 7;
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day - 6);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  } else if (value.includes('este año') || value.includes('este ano')) {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31);
  } else if (value.includes('año pasado') || value.includes('ano pasado')) {
    start = new Date(now.getFullYear() - 1, 0, 1);
    end = new Date(now.getFullYear() - 1, 11, 31);
  }
  const explicit = String(text || '').match(/(\d{4}-\d{2}-\d{2})\s*(?:a|al|-|hasta)\s*(\d{4}-\d{2}-\d{2})/i);
  if (explicit) return { start: explicit[1], end: explicit[2] };
  return { start: iso(start), end: iso(end) };
}

async function writeExport(intent, resultSet, companyId, format) {
  const dir = path.join(EXPORT_ROOT, `company-${companyId}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${intent.key}-${Date.now()}`;
  const filePath = path.join(dir, `${base}.${format}`);
  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(resultSet.rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
    XLSX.writeFile(wb, filePath);
  } else if (format === 'csv') {
    fs.writeFileSync(filePath, stringify(resultSet.rows, { header: true }), 'utf8');
  } else {
    await writePdf(filePath, intent, resultSet.rows);
  }
  return { filePath, publicPath: `/ai/download/company-${companyId}/${base}.${format}`, fileName: path.basename(filePath), format };
}

function writePdf(filePath, intent, rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'LETTER' });
    const stream = fs.createWriteStream(filePath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.pipe(stream);
    doc.fontSize(16).text(`Asistente - ${intent.name}`);
    doc.moveDown();
    rows.slice(0, 120).forEach((row, index) => {
      doc.fontSize(9).text(`${index + 1}. ${Object.entries(row).map(([k, v]) => `${k}: ${formatValue(v)}`).join(' | ')}`);
    });
    doc.end();
  });
}

async function getIntentConfig(db, companyId, intentKey) {
  return get(db, 'SELECT * FROM ai_intents WHERE company_id = ? AND intent_key = ?', [companyId, intentKey]);
}

async function saveChatHistory(db, context, question, intent, summary, exported, filePath) {
  await run(db, `INSERT INTO ai_chat_history
    (company_id, user_id, question, intent_detected, response_summary, export_generated, export_file_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [context.companyId, context.userId, question, intent, clean(summary, 2000), exported ? 1 : 0, filePath || null]);
}

async function audit(db, context, action, details) {
  await run(db, 'INSERT INTO audit_logs (user_id, action, details, company_id) VALUES (?, ?, ?, ?)', [
    context.userId || null,
    action,
    JSON.stringify(details || {}),
    context.companyId || null
  ]).catch(() => {});
}

async function ensurePermissions(db) {
  await run(db, `INSERT INTO permission_modules (code, name, description)
    VALUES ('ai_internal', 'Asistente', 'Asistente de reportes internos sin conexión externa')
    ON CONFLICT (code) DO NOTHING`).catch(() => {});
  const actions = [
    ['ai_view', 'Ver asistente'], ['ai_ask', 'Preguntar al asistente'], ['ai_export', 'Exportar desde asistente'],
    ['ai_view_sales', 'Ver ventas en asistente'], ['ai_view_accounts_receivable', 'Ver cuentas por cobrar en asistente'],
    ['ai_view_inventory', 'Ver inventario en asistente'], ['ai_view_clients', 'Ver clientes en asistente'],
    ['ai_view_quotes', 'Ver cotizaciones en asistente'], ['ai_view_projects', 'Ver proyectos en asistente'],
    ['ai_view_production', 'Ver produccion en asistente'], ['ai_admin_intents', 'Administrar intenciones del asistente']
  ];
  for (const [code, name] of actions) {
    await run(db, 'INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES (?, ?, ?)', [code, name, name]).catch(() => {});
    await run(db, 'UPDATE permission_actions SET name = ?, description = ? WHERE code = ?', [name, name, code]).catch(() => {});
  }
  await run(db, "UPDATE permission_modules SET name = 'Asistente' WHERE code = 'ai_internal'").catch(() => {});
  await run(db, "UPDATE permission_modules SET is_active = 0 WHERE code = 'ai_empresarial'").catch(() => {});
  await run(db, `INSERT OR IGNORE INTO module_actions (module_id, action_id)
    SELECT pm.id, pa.id FROM permission_modules pm, permission_actions pa
    WHERE pm.code = 'ai_internal' AND pa.code IN (${actions.map(() => '?').join(',')})`, actions.map(([code]) => code)).catch(() => {});
}

async function seedAllowedQueries(db) {
  for (const intent of INTENTS) {
    await run(db, `INSERT OR IGNORE INTO ai_allowed_queries
      (intent_key, module, permission_required, query_type, sql_template, export_allowed, created_at, updated_at)
      VALUES (?, ?, ?, 'report', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [intent.key, intent.module, intent.permission, `Consulta interna predefinida: ${intent.key}`, intent.export ? 1 : 0]);
  }
}

function hasPermission(context, moduleCode, actionCode) {
  if (typeof context.hasPermission === 'function') return context.hasPermission(context.permissionMap, moduleCode, actionCode);
  const map = context.permissionMap || {};
  if (map.isAdmin) return true;
  return Boolean(map.modules && map.modules[moduleCode] && map.modules[moduleCode][actionCode]);
}

function safeAll(db, sql, params) {
  return all(db, sql, params).catch((err) => {
    if (/no such table|no such column|SQLITE_ERROR/i.test(String(err && err.message || err))) return [];
    throw err;
  });
}

function phraseScore(text, phrase) {
  const words = phrase.split(/\s+/).filter((word) => word.length > 2);
  if (!words.length) return 0;
  return words.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0) / words.length;
}

function hintScore(text, intentKey) {
  const hints = INTENT_HINTS[intentKey] || [];
  if (!hints.length) return 0;
  const matches = hints.reduce((total, hint) => total + (text.includes(hint) ? 1 : 0), 0);
  if (!matches) return 0;
  return Math.min(3.5, matches * 0.85);
}

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function clean(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function iso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function uniqueCount(rows, key) {
  return new Set(rows.map((row) => row[key]).filter(Boolean)).size;
}

function money(value) {
  return Number(value || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : money(value);
  return String(value);
}

function statusError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function onRun(err) {
    return err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
  }));
}

module.exports = {
  ask,
  dashboard,
  detectIntent,
  ensureCompanyIntents,
  ensureSchema,
  executeIntent,
  formatResponse,
  generateExport,
  listHistory,
  listIntents,
  parseDateRange,
  saveChatHistory,
  toggleIntent,
  validatePermission
};
