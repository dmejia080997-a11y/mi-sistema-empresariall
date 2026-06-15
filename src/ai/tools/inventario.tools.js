const { all, get, like } = require('./_db');

module.exports = [
  {
    name: 'buscarProducto',
    description: 'Busca productos por nombre, SKU o codigo.',
    permission: ['inventory', 'view'],
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    execute: ({ q }, ctx) => all(ctx.db, `
      SELECT id, item_code, sku, name, qty, min_stock, price, warehouse_location
      FROM items
      WHERE company_id = ? AND (name LIKE ? OR sku LIKE ? OR item_code LIKE ? OR barcode LIKE ?)
      ORDER BY name COLLATE NOCASE LIMIT 25`, [ctx.companyId, like(q), like(q), like(q), like(q)])
  },
  {
    name: 'stockDisponible',
    description: 'Resume el stock disponible total y por productos principales.',
    permission: ['inventory', 'view'],
    parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    async execute({ q }, ctx) {
      const params = [ctx.companyId];
      let where = 'company_id = ?';
      if (q) {
        where += ' AND (name LIKE ? OR sku LIKE ? OR item_code LIKE ?)';
        params.push(like(q), like(q), like(q));
      }
      const summary = await get(ctx.db, `SELECT COUNT(*) AS productos, COALESCE(SUM(qty), 0) AS unidades FROM items WHERE ${where}`, params);
      const productos = await all(ctx.db, `SELECT id, sku, name, qty, min_stock FROM items WHERE ${where} ORDER BY qty DESC, name LIMIT 20`, params);
      return { resumen: summary, productos };
    }
  },
  {
    name: 'productosBajoMinimo',
    description: 'Lista productos con stock igual o menor al minimo.',
    permission: ['inventory', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT id, sku, name, qty, min_stock, warehouse_location
      FROM items
      WHERE company_id = ? AND qty <= min_stock
      ORDER BY qty ASC, name LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  }
];
