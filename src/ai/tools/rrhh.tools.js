const { all, like } = require('./_db');

module.exports = [
  {
    name: 'buscarEmpleado',
    description: 'Busca empleados por nombre, codigo, DPI, puesto o departamento.',
    permission: ['rrhh', 'view'],
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    execute: ({ q }, ctx) => all(ctx.db, `
      SELECT id, employee_code, first_name, last_name, position, department, employment_status, phone, email
      FROM hr_employees
      WHERE company_id = ? AND (employee_code LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR dpi_number LIKE ? OR position LIKE ? OR department LIKE ?)
      ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE LIMIT 20`,
      [ctx.companyId, like(q), like(q), like(q), like(q), like(q), like(q)])
  },
  {
    name: 'vacacionesPendientes',
    description: 'Lista vacaciones con dias disponibles.',
    permission: ['rrhh', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT v.id, e.employee_code, e.first_name, e.last_name, v.vacation_period, v.available_days, v.status
      FROM hr_vacations v
      JOIN hr_employees e ON e.id = v.employee_id AND e.company_id = v.company_id
      WHERE v.company_id = ? AND COALESCE(v.available_days, 0) > 0
      ORDER BY v.available_days DESC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  },
  {
    name: 'asistenciaEmpleado',
    description: 'Muestra asistencia reciente de un empleado.',
    permission: ['rrhh', 'view'],
    parameters: { type: 'object', properties: { empleado_id: { type: 'integer' }, limite: { type: 'integer', minimum: 1, maximum: 31 } }, required: ['empleado_id'], additionalProperties: false },
    execute: ({ empleado_id, limite = 10 }, ctx) => all(ctx.db, `
      SELECT a.attendance_date, a.check_in, a.lunch_out, a.lunch_in, a.check_out, a.attendance_status, a.notes
      FROM hr_attendance a
      WHERE a.company_id = ? AND a.employee_id = ?
      ORDER BY a.attendance_date DESC LIMIT ?`, [ctx.companyId, empleado_id, Math.min(Number(limite) || 10, 31)])
  }
];
