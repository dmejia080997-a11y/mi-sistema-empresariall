const { all, get, like } = require('./_db');

module.exports = [
  {
    name: 'buscarProveedor',
    description: 'Busca proveedores por codigo, nombre, NIT, telefono o correo.',
    permission: ['suppliers', 'view'],
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    execute: ({ q }, ctx) => all(ctx.db, `
      SELECT id, code, trade_name, legal_name, tax_id, phone, email, status
      FROM suppliers
      WHERE company_id = ? AND (code LIKE ? OR trade_name LIKE ? OR legal_name LIKE ? OR tax_id LIKE ? OR phone LIKE ? OR email LIKE ?)
      ORDER BY updated_at DESC LIMIT 20`, [ctx.companyId, like(q), like(q), like(q), like(q), like(q), like(q)])
  },
  {
    name: 'listarProveedores',
    description: 'Lista proveedores recientes.',
    permission: ['suppliers', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT id, code, trade_name, supplier_type, country, status, primary_currency
      FROM suppliers
      WHERE company_id = ?
      ORDER BY updated_at DESC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  },
  {
    name: 'saldoProveedor',
    description: 'Calcula saldo pendiente de un proveedor por id.',
    permission: ['suppliers', 'view'],
    parameters: { type: 'object', properties: { proveedor_id: { type: 'integer' } }, required: ['proveedor_id'], additionalProperties: false },
    async execute({ proveedor_id }, ctx) {
      const supplier = await get(ctx.db, 'SELECT id, code, trade_name FROM suppliers WHERE id = ? AND company_id = ?', [proveedor_id, ctx.companyId]);
      if (!supplier) return { error: 'Proveedor no encontrado.' };
      const balance = await get(ctx.db, `
        SELECT COUNT(*) AS documentos, COALESCE(SUM(total), 0) AS total,
               COALESCE(SUM((SELECT SUM(bp.amount) FROM bill_payments bp WHERE bp.bill_id = b.id AND bp.company_id = b.company_id)), 0) AS pagado
        FROM bills b
        WHERE b.company_id = ? AND b.supplier_id = ? AND b.status NOT IN ('voided', 'cancelled')`, [ctx.companyId, proveedor_id]);
      return { proveedor: supplier, saldo: { ...balance, pendiente: Number(balance.total || 0) - Number(balance.pagado || 0) } };
    }
  }
];
