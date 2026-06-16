const { all, get, run, clean } = require('./_db');

module.exports = [
  {
    name: 'proyectosActivos',
    description: 'Lista proyectos activos.',
    permission: ['projects', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT id, code, name, status, priority, estimated_end_date, sale_amount, real_cost
      FROM projects
      WHERE company_id = ? AND status IN ('planning', 'in_progress', 'paused')
      ORDER BY estimated_end_date ASC, updated_at DESC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  },
  {
    name: 'proyectosAtrasados',
    description: 'Lista proyectos activos con fecha estimada vencida.',
    permission: ['projects', 'view'],
    parameters: { type: 'object', properties: { limite: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    execute: ({ limite = 20 }, ctx) => all(ctx.db, `
      SELECT id, code, name, status, priority, estimated_end_date
      FROM projects
      WHERE company_id = ? AND estimated_end_date IS NOT NULL AND estimated_end_date < date('now')
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY estimated_end_date ASC LIMIT ?`, [ctx.companyId, Math.min(Number(limite) || 20, 50)])
  },
  {
    name: 'crearTarea',
    description: 'Crea una tarea dentro de un proyecto.',
    permission: ['projects', 'create'],
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer' },
        title: { type: 'string' },
        description: { type: 'string' },
        due_date: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }
      },
      required: ['project_id', 'title'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const project = await get(ctx.db, 'SELECT id, name FROM projects WHERE id = ? AND company_id = ?', [args.project_id, ctx.companyId]);
      if (!project) return { error: 'Proyecto no encontrado.' };
      const inserted = await run(ctx.db, `
        INSERT INTO project_tasks (project_id, company_id, title, description, status, priority, due_date, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [project.id, ctx.companyId, clean(args.title, 180), clean(args.description, 1000), clean(args.priority) || 'medium', clean(args.due_date, 20) || null, ctx.userId]);
      return get(ctx.db, 'SELECT id, project_id, title, status, priority, due_date FROM project_tasks WHERE id = ? AND company_id = ?', [inserted.lastID, ctx.companyId]);
    }
  }
];
