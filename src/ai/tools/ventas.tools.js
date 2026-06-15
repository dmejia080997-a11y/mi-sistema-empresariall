const { all, get, run, clean, number } = require('./_db');

module.exports = [
  {
    name: 'ventasPorVendedor',
    description: 'Resume ventas por vendedor en un rango.',
    permission: ['sales', 'view'],
    parameters: { type: 'object', properties: { desde: { type: 'string' }, hasta: { type: 'string' } }, additionalProperties: false },
    execute: ({ desde, hasta }, ctx) => {
      const params = [ctx.companyId];
      let dateWhere = '';
      if (desde) { dateWhere += ' AND date(s.created_at) >= date(?)'; params.push(desde); }
      if (hasta) { dateWhere += ' AND date(s.created_at) <= date(?)'; params.push(hasta); }
      return all(ctx.db, `
        SELECT COALESCE(u.username, 'Sin vendedor') AS vendedor, COUNT(s.id) AS ventas, COALESCE(SUM(s.total), 0) AS total
        FROM sales s
        LEFT JOIN users u ON u.id = s.seller_user_id AND u.company_id = s.company_id
        WHERE s.company_id = ? ${dateWhere}
        GROUP BY s.seller_user_id, u.username
        ORDER BY total DESC LIMIT 30`, params);
    }
  },
  {
    name: 'topClientes',
    description: 'Lista clientes con mayor venta acumulada.',
    permission: ['sales', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 10 }, ctx) => all(ctx.db, `
      SELECT COALESCE(c.name, 'Sin cliente') AS cliente, COUNT(s.id) AS ventas, COALESCE(SUM(s.total), 0) AS total
      FROM sales s
      LEFT JOIN customers c ON c.id = s.cliente_id AND c.company_id = s.company_id
      WHERE s.company_id = ?
      GROUP BY s.cliente_id, c.name
      ORDER BY total DESC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 10, 50)])
  },
  {
    name: 'ventasMes',
    description: 'Resume ventas del mes actual desde el modulo Ventas.',
    permission: ['sales', 'view'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: (_, ctx) => all(ctx.db, `
      SELECT status, COUNT(*) AS ventas, COALESCE(SUM(total), 0) AS total
      FROM sales
      WHERE company_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
      GROUP BY status ORDER BY total DESC`, [ctx.companyId])
  },
  {
    name: 'ventasAnio',
    description: 'Resume ventas por mes del ano actual desde el modulo Ventas.',
    permission: ['sales', 'view'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: (_, ctx) => all(ctx.db, `
      SELECT strftime('%Y-%m', created_at) AS mes, COUNT(*) AS ventas, COALESCE(SUM(total), 0) AS total
      FROM sales
      WHERE company_id = ? AND strftime('%Y', created_at) = strftime('%Y', 'now')
      GROUP BY strftime('%Y-%m', created_at) ORDER BY mes`, [ctx.companyId])
  },
  {
    name: 'cotizacionesEnviadas',
    description: 'Cuenta cotizaciones enviadas en ventas y proyectos para la empresa actual.',
    permission: ['sales', 'view'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_, ctx) {
      const sentStatuses = ['sent', 'enviada', 'enviado'];
      const placeholders = sentStatuses.map(() => '?').join(',');
      const sales = await get(ctx.db, `
        SELECT COUNT(*) AS total
        FROM sales_quotes
        WHERE company_id = ? AND lower(trim(status)) IN (${placeholders})`,
        [ctx.companyId, ...sentStatuses]);
      const projects = await get(ctx.db, `
        SELECT COUNT(*) AS total
        FROM project_quotes
        WHERE company_id = ? AND lower(trim(status)) IN (${placeholders})`,
        [ctx.companyId, ...sentStatuses]);
      const salesTotal = Number(sales && sales.total ? sales.total : 0);
      const projectTotal = Number(projects && projects.total ? projects.total : 0);
      return {
        resumen: {
          cotizaciones_enviadas: salesTotal + projectTotal,
          ventas: salesTotal,
          proyectos: projectTotal
        },
        estados_contados: sentStatuses
      };
    }
  },
  {
    name: 'prepararCotizacion',
    description: 'Prepara un borrador de cotizacion sin guardarlo automaticamente.',
    permission: ['sales', 'create'],
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        descripcion: { type: 'string' },
        monto_estimado: { type: 'number' },
        moneda: { type: 'string' },
        validez_dias: { type: 'integer', minimum: 1, maximum: 90 }
      },
      required: ['cliente', 'descripcion'],
      additionalProperties: false
    },
    handler: (args) => ({
      tipo: 'borrador_cotizacion',
      cliente: clean(args.cliente, 180),
      descripcion: clean(args.descripcion, 1000),
      monto_estimado: Number(args.monto_estimado || 0),
      moneda: clean(args.moneda || 'USD', 10),
      validez_dias: Math.min(Math.max(Number(args.validez_dias || 15), 1), 90),
      estado: 'borrador_no_guardado',
      nota: 'Borrador preparado. Debe confirmarse o registrarse desde el modulo de ventas.'
    })
  },
  {
    name: 'crearCotizacion',
    description: 'Crea una cotizacion simple en el modulo Ventas con una linea de producto o servicio.',
    permission: ['sales', 'create'],
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre, codigo o correo del cliente existente.' },
        descripcion: { type: 'string', description: 'Producto o servicio a cotizar.' },
        cantidad: { type: 'number', minimum: 0.01 },
        precio_unitario: { type: 'number', minimum: 0 },
        moneda: { type: 'string' },
        validez_dias: { type: 'integer', minimum: 1, maximum: 90 },
        notas: { type: 'string' }
      },
      required: ['cliente', 'descripcion', 'precio_unitario'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      await ensureQuoteSchema(ctx.db);
      const cliente = clean(args.cliente, 180);
      const descripcion = clean(args.descripcion, 500);
      const cantidad = Math.max(number(args.cantidad, 1) || 1, 0.01);
      const precioUnitario = Math.max(number(args.precio_unitario, 0) || 0, 0);
      if (!cliente) return { error: 'Cliente requerido.' };
      if (!descripcion) return { error: 'Descripcion requerida.' };
      if (!precioUnitario) return { error: 'Precio unitario requerido.' };

      const customer = await findCustomer(ctx.db, ctx.companyId, cliente);
      if (!customer) {
        return {
          error: `No encontre un cliente activo que coincida con "${cliente}". Crea el cliente primero o indica el nombre/codigo exacto.`
        };
      }

      const subtotal = round2(cantidad * precioUnitario);
      const tax = 0;
      const total = round2(subtotal + tax);
      const validUntil = futureDate(Math.min(Math.max(Number(args.validez_dias || 15), 1), 90));
      const notes = clean(args.notas || `Cotizacion creada desde Asistente. Moneda: ${clean(args.moneda || 'USD', 10)}`, 1000);
      const sellerUserId = Number(ctx.userId || 0) || 0;

      const quote = await run(ctx.db, `
        INSERT INTO sales_quotes
         (company_id, opportunity_id, customer_id, prospect_id, seller_user_id, quote_number, status, subtotal, discount, tax, total, valid_until, notes, created_by, created_at, updated_at)
         VALUES (?, NULL, ?, NULL, ?, '', 'borrador', ?, 0, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [ctx.companyId, customer.id, sellerUserId, subtotal, tax, total, validUntil, notes, sellerUserId]);
      const quoteNumber = buildSequence('COT', quote.lastID);
      await run(ctx.db, 'UPDATE sales_quotes SET quote_number = ? WHERE id = ? AND company_id = ?', [quoteNumber, quote.lastID, ctx.companyId]);
      await run(ctx.db, `
        INSERT INTO sales_quote_lines
          (company_id, quote_id, line_type, item_id, description, qty, unit_price, subtotal, tax, total, sort_order)
          VALUES (?, ?, 'service', NULL, ?, ?, ?, ?, ?, ?, 1)`,
        [ctx.companyId, quote.lastID, descripcion, cantidad, precioUnitario, subtotal, tax, total]);

      return {
        id: quote.lastID,
        quote_number: quoteNumber,
        cliente: customer.name,
        descripcion,
        cantidad,
        precio_unitario: precioUnitario,
        subtotal,
        total,
        status: 'borrador',
        valid_until: validUntil,
        link: `/sales/quotes/${quote.lastID}/print`
      };
    }
  },
  {
    name: 'generarDocumento',
    description: 'Genera un documento empresarial textual sin guardar archivos ni eliminar datos.',
    permission: ['ai_empresarial', 'view'],
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string' },
        asunto: { type: 'string' },
        contenido_base: { type: 'string' }
      },
      required: ['tipo', 'asunto'],
      additionalProperties: false
    },
    handler: (args) => ({
      tipo: clean(args.tipo, 80),
      asunto: clean(args.asunto, 180),
      contenido_base: clean(args.contenido_base, 2000),
      estado: 'borrador_generado',
      nota: 'Documento preparado como texto. No se guardo ningun archivo automaticamente.'
    })
  }
];

async function ensureQuoteSchema(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS sales_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    opportunity_id INTEGER NULL,
    customer_id INTEGER NULL,
    prospect_id INTEGER NULL,
    seller_user_id INTEGER NOT NULL DEFAULT 0,
    quote_number TEXT NULL,
    status TEXT NOT NULL DEFAULT 'borrador',
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    valid_until TEXT NULL,
    notes TEXT NULL,
    created_by INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS sales_quote_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    quote_id INTEGER NOT NULL,
    line_type TEXT NOT NULL DEFAULT 'product',
    item_id INTEGER NULL,
    description TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
}

async function findCustomer(db, companyId, term) {
  const q = `%${clean(term, 180)}%`;
  return get(db, `
    SELECT id, customer_code, name, email, phone
    FROM customers
    WHERE company_id = ? AND COALESCE(is_voided, 0) = 0
      AND (name = ? OR customer_code = ? OR email = ? OR name LIKE ? OR customer_code LIKE ? OR email LIKE ?)
    ORDER BY
      CASE WHEN name = ? OR customer_code = ? OR email = ? THEN 0 ELSE 1 END,
      name COLLATE NOCASE
    LIMIT 1`,
    [companyId, term, term, term, q, q, q, term, term, term]);
}

function buildSequence(prefix, id) {
  return `${prefix}-${String(id || 0).padStart(5, '0')}`;
}

function futureDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 15));
  return date.toISOString().slice(0, 10);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
