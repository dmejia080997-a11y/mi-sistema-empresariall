const { all, like } = require('./_db');

module.exports = [
  {
    name: 'buscarTracking',
    description: 'Busca paquetes por tracking, codigo interno o portal.',
    permission: ['packages', 'view'],
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    execute: ({ q }, ctx) => all(ctx.db, `
      SELECT p.id, p.internal_code, p.tracking_number, p.status, p.customer_id, c.name AS customer_name, p.received_at
      FROM packages p
      LEFT JOIN customers c ON c.id = p.customer_id AND c.company_id = p.company_id
      WHERE p.company_id = ? AND (p.tracking_number LIKE ? OR p.internal_code LIKE ? OR p.description LIKE ?)
      ORDER BY p.created_at DESC LIMIT 20`, [ctx.companyId, like(q), like(q), like(q)])
  },
  {
    name: 'paquetesPendientes',
    description: 'Lista paquetes pendientes o en transito.',
    permission: ['packages', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT id, internal_code, tracking_number, status, received_at, description
      FROM packages
      WHERE company_id = ? AND COALESCE(status, '') NOT IN ('Entregado', 'Entregado al cliente', 'Cancelado')
      ORDER BY received_at DESC, created_at DESC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  },
  {
    name: 'paquetesUrgentes',
    description: 'Lista paquetes antiguos pendientes que requieren seguimiento.',
    permission: ['packages', 'view'],
    parameters: { type: 'object', properties: { dias: { type: 'integer', minimum: 1, maximum: 90 } }, additionalProperties: false },
    execute: ({ dias = 7 }, ctx) => all(ctx.db, `
      SELECT id, internal_code, tracking_number, status, received_at, description
      FROM packages
      WHERE company_id = ? AND COALESCE(status, '') NOT IN ('Entregado', 'Entregado al cliente', 'Cancelado')
        AND COALESCE(received_at::date, created_at::date) <= CURRENT_DATE - (?::integer * INTERVAL '1 day')
      ORDER BY received_at ASC LIMIT 30`, [ctx.companyId, Math.min(Number(dias) || 7, 90)])
  }
];
