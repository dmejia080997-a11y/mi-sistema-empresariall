const { all, get, like } = require('./_db');

module.exports = [
  {
    name: 'buscarFactura',
    description: 'Busca facturas por numero, cliente o id.',
    permission: ['billing', 'view'],
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    execute: ({ q }, ctx) => all(ctx.db, `
      SELECT ih.id, ih.invoice_number, ih.customer_name_snapshot AS customer_name, ih.status, ih.total, ih.balance_due, ih.issue_date, ih.due_date
      FROM invoice_headers ih
      WHERE ih.company_id = ? AND (ih.invoice_number LIKE ? OR ih.customer_name_snapshot LIKE ? OR CAST(ih.id AS TEXT) = ?)
      ORDER BY ih.created_at DESC LIMIT 20`, [ctx.companyId, like(q), like(q), String(q || '').trim()])
  },
  {
    name: 'facturasPendientes',
    description: 'Lista facturas con saldo pendiente.',
    permission: ['billing', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT id, invoice_number, customer_name_snapshot AS customer_name, status, total, balance_due, due_date
      FROM invoice_headers
      WHERE company_id = ? AND COALESCE(balance_due, total, 0) > 0 AND status NOT IN ('voided', 'cancelled', 'paid')
      ORDER BY due_date ASC, created_at DESC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  },
  {
    name: 'facturasVencidas',
    description: 'Lista facturas vencidas con saldo pendiente.',
    permission: ['billing', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT id, invoice_number, customer_name_snapshot AS customer_name, status, total, balance_due, due_date
      FROM invoice_headers
      WHERE company_id = ? AND due_date IS NOT NULL AND due_date < date('now')
        AND COALESCE(balance_due, total, 0) > 0 AND status NOT IN ('voided', 'cancelled', 'paid')
      ORDER BY due_date ASC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  },
  {
    name: 'ventasMesActual',
    description: 'Resume ventas/facturacion del mes actual.',
    permission: ['billing', 'view'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: (_, ctx) => get(ctx.db, `
      SELECT COUNT(*) AS facturas, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(balance_due), 0) AS saldo_pendiente
      FROM invoice_headers
      WHERE company_id = ? AND strftime('%Y-%m', issue_date) = strftime('%Y-%m', 'now') AND status NOT IN ('voided', 'cancelled')`,
      [ctx.companyId])
  },
  {
    name: 'ventasAnuales',
    description: 'Resume ventas por mes del ano actual.',
    permission: ['billing', 'view'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: (_, ctx) => all(ctx.db, `
      SELECT strftime('%Y-%m', issue_date) AS mes, COUNT(*) AS facturas, COALESCE(SUM(total), 0) AS total
      FROM invoice_headers
      WHERE company_id = ? AND strftime('%Y', issue_date) = strftime('%Y', 'now') AND status NOT IN ('voided', 'cancelled')
      GROUP BY strftime('%Y-%m', issue_date) ORDER BY mes`, [ctx.companyId])
  }
];
