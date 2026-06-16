const { all, get, run, clean, like } = require('./_db');

module.exports = [
  {
    name: 'buscarCliente',
    description: 'Busca clientes por nombre, codigo, documento, telefono o correo.',
    permission: ['customers', 'view'],
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    handler: ({ query }, ctx) => all(ctx.db, `
      SELECT id, customer_code, name, document_number, phone, mobile, email
      FROM customers
      WHERE company_id = ? AND COALESCE(is_voided, 0) = 0
        AND (name LIKE ? OR customer_code LIKE ? OR document_number LIKE ? OR phone LIKE ? OR mobile LIKE ? OR email LIKE ?)
      ORDER BY name COLLATE NOCASE LIMIT 20`, [ctx.companyId, like(query), like(query), like(query), like(query), like(query), like(query)])
  },
  {
    name: 'listarClientes',
    description: 'Lista clientes activos recientes.',
    permission: ['customers', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT id, customer_code, name, phone, email, created_at
      FROM customers
      WHERE company_id = ? AND COALESCE(is_voided, 0) = 0
      ORDER BY created_at DESC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  },
  {
    name: 'obtenerCliente',
    description: 'Obtiene el detalle basico de un cliente por id.',
    permission: ['customers', 'view'],
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
    execute: ({ id }, ctx) => get(ctx.db, `
      SELECT id, customer_code, name, document_type, document_number, phone, mobile, email, address, notes
      FROM customers WHERE id = ? AND company_id = ? AND COALESCE(is_voided, 0) = 0`, [id, ctx.companyId])
  },
  {
    name: 'crearCliente',
    description: 'Crea un cliente con datos basicos.',
    permission: ['customers', 'create'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        document_number: { type: 'string' },
        address: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['name'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const name = clean(args.name, 180);
      if (!name) return { error: 'Nombre requerido.' };
      const inserted = await run(ctx.db, `
        INSERT INTO customers (company_id, name, phone, email, document_number, address, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [ctx.companyId, name, clean(args.phone), clean(args.email), clean(args.document_number), clean(args.address, 500), clean(args.notes, 1000)]);
      return get(ctx.db, 'SELECT id, customer_code, name, phone, email FROM customers WHERE id = ? AND company_id = ?', [inserted.lastID, ctx.companyId]);
    }
  },
  {
    name: 'editarCliente',
    description: 'Edita datos basicos de un cliente existente.',
    permission: ['customers', 'edit'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        address: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['id'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const current = await get(ctx.db, 'SELECT * FROM customers WHERE id = ? AND company_id = ? AND COALESCE(is_voided, 0) = 0', [args.id, ctx.companyId]);
      if (!current) return { error: 'Cliente no encontrado.' };
      await run(ctx.db, `
        UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, notes = ?
        WHERE id = ? AND company_id = ?`,
        [
          clean(args.name || current.name, 180),
          clean(args.phone || current.phone),
          clean(args.email || current.email),
          clean(args.address || current.address, 500),
          clean(args.notes || current.notes, 1000),
          args.id,
          ctx.companyId
        ]);
      return get(ctx.db, 'SELECT id, customer_code, name, phone, email FROM customers WHERE id = ? AND company_id = ?', [args.id, ctx.companyId]);
    }
  }
];
