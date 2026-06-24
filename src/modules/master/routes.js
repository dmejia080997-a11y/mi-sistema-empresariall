const { spawn } = require('child_process');
const path = require('path');

function registerMasterRoutes(app, deps) {
  const {
    db,
    requireMaster,
    masterSaasService,
    setFlash,
    getClientIp
  } = deps;

  async function renderMaster(req, res, view, extra = {}) {
    const companies = await masterSaasService.getCompaniesWithSaasInfo(db);
    const health = await masterSaasService.getSystemHealth(db);
    const stats = masterSaasService.dashboardStats(companies, health);
    return res.render(view, {
      companies,
      health,
      stats,
      backups: health.backups,
      latestBackup: health.latestBackup,
      ...extra
    });
  }

  app.get('/master', requireMaster, async (req, res, next) => {
    try {
      const tempReset = req.session ? req.session.master_reset_password : null;
      if (req.session && req.session.master_reset_password) delete req.session.master_reset_password;
      return renderMaster(req, res, 'master', { tempReset });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/master/monitoring', requireMaster, async (req, res, next) => {
    try {
      return renderMaster(req, res, 'master-monitoring');
    } catch (err) {
      return next(err);
    }
  });

  app.get('/master/backups', requireMaster, async (req, res, next) => {
    try {
      return renderMaster(req, res, 'master-backups');
    } catch (err) {
      return next(err);
    }
  });

  app.post('/master/backups/run', requireMaster, (req, res) => {
    const startedBy = req.session && req.session.masterUser ? req.session.masterUser.username : 'master';
    const child = spawn('npm', ['run', 'backup:all'], {
      cwd: path.resolve(__dirname, '..', '..'),
      shell: false,
      detached: false
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('close', (code) => {
      masterSaasService.logGlobalAudit(db, {
        action: code === 0 ? 'backup_run' : 'critical_error',
        module: 'backups',
        user_name: startedBy,
        description: `Backup manual finalizado con codigo ${code}. ${output.slice(-1000)}`,
        ip_address: typeof getClientIp === 'function' ? getClientIp(req) : req.ip
      });
      if (req.session) {
        req.session.flash = {
          type: code === 0 ? 'success' : 'error',
          message: code === 0 ? 'Backup ejecutado correctamente.' : 'El backup termino con errores. Revisa logs.'
        };
      }
    });
    if (req.session) {
      req.session.flash = { type: 'info', message: 'Backup iniciado. Actualiza esta pagina en unos minutos.' };
    }
    return res.redirect('/master/backups');
  });

  app.get('/master/audit', requireMaster, async (req, res, next) => {
    try {
      await masterSaasService.ensureGlobalAuditTable(db);
      const result = await db.query(
        `SELECT * FROM global_audit_logs ORDER BY created_at DESC, id DESC LIMIT 300`
      );
      const timeZone = process.env.APP_TIMEZONE || 'America/Guatemala';
      const auditLogs = (result.rows || []).map((log) => {
        const createdAt = new Date(log.created_at);
        const validDate = !Number.isNaN(createdAt.getTime());
        return {
          ...log,
          created_date_label: validDate
            ? new Intl.DateTimeFormat('es-GT', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              timeZone
            }).format(createdAt)
            : 'Fecha no disponible',
          created_time_label: validDate
            ? new Intl.DateTimeFormat('es-GT', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: true,
              timeZone
            }).format(createdAt)
            : ''
        };
      });
      return renderMaster(req, res, 'master-audit', { auditLogs });
    } catch (err) {
      return next(err);
    }
  });
}

module.exports = {
  registerMasterRoutes
};
