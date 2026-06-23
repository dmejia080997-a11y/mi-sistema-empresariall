const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { getDatabaseConfig } = require('../config/database');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const BACKUP_DIR = path.join(ROOT_DIR, 'storage', 'backups', 'postgres');
const UPLOADS_DIR = path.join(ROOT_DIR, 'storage', 'uploads');

function databaseUrlForName(baseUrl, databaseName) {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function maintenanceUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

function createPool(databaseName) {
  const config = getDatabaseConfig();
  return new Pool({
    connectionString: databaseName ? databaseUrlForName(config.url, databaseName) : config.url,
    ssl: config.ssl ? { rejectUnauthorized: false } : false
  });
}

function createMaintenancePool() {
  const config = getDatabaseConfig();
  return new Pool({
    connectionString: maintenanceUrl(config.url),
    ssl: config.ssl ? { rejectUnauthorized: false } : false
  });
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    ...options
  });
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function directorySize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return total;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(entryPath);
    if (entry.isFile()) total += fs.statSync(entryPath).size;
  }
  return total;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntil(value) {
  const date = parseDate(value);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.ceil((date.getTime() - today.getTime()) / 86400000);
}

function licenseStatus(company) {
  if (company.license_status === 'suspended' || Number(company.is_active) === 0) return 'suspended';
  const remaining = daysUntil(company.license_ends_at || company.active_until);
  if (remaining !== null && remaining < 0) return 'expired';
  if (remaining !== null && remaining <= 30) return 'expiring';
  return 'active';
}

function licenseStatusLabel(status) {
  return {
    active: 'Activa',
    suspended: 'Suspendida',
    expired: 'Vencida',
    expiring: 'Proxima a vencer'
  }[status] || 'Activa';
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^backup-all-\d{8}-\d{6}\.(tar\.gz|zip)$/i.test(name))
    .map((name) => {
      const filePath = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(filePath);
      return {
        name,
        path: filePath,
        size: stat.size,
        sizeLabel: formatBytes(stat.size),
        createdAt: stat.mtime,
        createdAtLabel: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function latestBackupForDatabase(databaseName) {
  const backups = listBackups();
  if (!databaseName || !backups.length) return null;
  for (const backup of backups) {
    const stamp = backup.name.replace(/\.(tar\.gz|zip)$/i, '');
    const stagingName = stamp;
    const manifestCandidates = [
      path.join(BACKUP_DIR, stagingName, 'manifest.json')
    ];
    for (const candidate of manifestCandidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if ((manifest.databases || []).some((db) => db.database === databaseName && !db.error)) return backup;
      } catch (err) {}
    }
  }
  return backups[0] || null;
}

async function databaseExists(databaseName) {
  if (!databaseName) return false;
  const pool = createMaintenancePool();
  try {
    const result = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1', [databaseName]);
    return result.rowCount > 0;
  } finally {
    await pool.end();
  }
}

async function tenantStats(company) {
  const stats = {
    databaseExists: false,
    connectionOk: false,
    users: 0,
    tables: 0,
    databaseSize: 0,
    databaseSizeLabel: '0 B',
    error: null
  };
  if (!company.database_name) {
    stats.error = 'sin database_name';
    return stats;
  }
  stats.databaseExists = await databaseExists(company.database_name);
  if (!stats.databaseExists) {
    stats.error = 'base no existe';
    return stats;
  }
  const pool = createPool(company.database_name);
  try {
    const tables = await pool.query(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
    );
    const users = await pool.query('SELECT COUNT(*)::int AS count FROM users').catch(() => ({ rows: [{ count: 0 }] }));
    const size = await pool.query('SELECT pg_database_size($1)::bigint AS size', [company.database_name]);
    stats.connectionOk = true;
    stats.tables = Number(tables.rows[0].count || 0);
    stats.users = Number(users.rows[0].count || 0);
    stats.databaseSize = Number(size.rows[0].size || 0);
    stats.databaseSizeLabel = formatBytes(stats.databaseSize);
  } catch (err) {
    stats.error = err.message;
  } finally {
    await pool.end();
  }
  return stats;
}

function companyHealth(company, tenant, backup) {
  const status = licenseStatus(company);
  const backupAgeHours = backup ? (Date.now() - backup.createdAt.getTime()) / 3600000 : null;
  if (!tenant.databaseExists || status === 'expired' || tenant.error) return 'red';
  if (backupAgeHours === null || backupAgeHours > 48 || status === 'expiring') return 'yellow';
  return 'green';
}

async function getCompaniesWithSaasInfo(masterDb) {
  const companies = await masterDb.query('SELECT * FROM companies ORDER BY created_at DESC NULLS LAST, id DESC');
  const rows = [];
  for (const company of companies.rows) {
    const tenant = await tenantStats(company);
    const backup = latestBackupForDatabase(company.database_name);
    const licStatus = licenseStatus(company);
    rows.push({
      ...company,
      plan: company.license_plan || 'Basico',
      users_count: tenant.users,
      users_max: company.license_max_users || 5,
      storage_used: tenant.databaseSize,
      storage_used_label: tenant.databaseSizeLabel,
      last_backup: backup ? backup.createdAtLabel : null,
      license_status_computed: licStatus,
      license_status_label: licenseStatusLabel(licStatus),
      health: companyHealth(company, tenant, backup),
      tenant
    });
  }
  return rows;
}

async function checkPostgres() {
  const pool = createPool();
  try {
    await pool.query('SELECT 1');
    return { ok: true, label: 'online' };
  } catch (err) {
    return { ok: false, label: 'offline', error: err.message };
  } finally {
    await pool.end().catch(() => {});
  }
}

function checkPm2() {
  const result = run('pm2', ['jlist']);
  if (result.error || result.status !== 0) return { ok: false, label: 'offline', error: result.error ? result.error.message : result.stderr };
  try {
    const processes = JSON.parse(result.stdout || '[]');
    const offline = processes.filter((proc) => !proc.pm2_env || proc.pm2_env.status !== 'online');
    return { ok: offline.length === 0, label: offline.length ? 'degraded' : 'online', processes, offline };
  } catch (err) {
    return { ok: false, label: 'error', error: err.message };
  }
}

function checkCron() {
  const systemctl = run('systemctl', ['is-active', 'cron']);
  if (systemctl.status === 0) return { ok: true, label: 'activo' };
  const crontab = run('crontab', ['-l']);
  if (crontab.status === 0 && String(crontab.stdout || '').trim()) return { ok: true, label: 'configurado' };
  return { ok: false, label: 'inactivo', error: systemctl.stderr || crontab.stderr || 'cron no detectado' };
}

function diskInfo() {
  const result = run('df', ['-Pk', ROOT_DIR]);
  if (result.status !== 0) return { ok: false, error: result.stderr || result.error && result.error.message };
  const lines = String(result.stdout || '').trim().split(/\r?\n/);
  const parts = lines[1] ? lines[1].trim().split(/\s+/) : [];
  const total = Number(parts[1] || 0) * 1024;
  const used = Number(parts[2] || 0) * 1024;
  const available = Number(parts[3] || 0) * 1024;
  const usedPercent = Number(String(parts[4] || '0').replace('%', ''));
  return {
    ok: available > 0,
    total,
    used,
    available,
    usedPercent,
    usedLabel: formatBytes(used),
    availableLabel: formatBytes(available),
    totalLabel: formatBytes(total)
  };
}

function pm2Errors() {
  const result = run('pm2', ['logs', '--nostream', '--lines', '40']);
  if (result.status !== 0) return [];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => /error|errored|exception|failed/i.test(line))
    .slice(-10);
}

async function getSystemHealth(masterDb) {
  const [postgres, companies] = await Promise.all([checkPostgres(), getCompaniesWithSaasInfo(masterDb)]);
  const backups = listBackups();
  const pm2 = checkPm2();
  const cron = checkCron();
  const disk = diskInfo();
  const uploadsSize = directorySize(UPLOADS_DIR);
  return {
    postgres,
    pm2,
    cron,
    disk,
    uptime: formatDuration(os.uptime()),
    uptimeSeconds: os.uptime(),
    cpu: { loadavg: os.loadavg(), cores: os.cpus().length },
    ram: {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem(),
      totalLabel: formatBytes(os.totalmem()),
      freeLabel: formatBytes(os.freemem()),
      usedLabel: formatBytes(os.totalmem() - os.freemem())
    },
    backups,
    latestBackup: backups[0] || null,
    pm2Errors: pm2Errors(),
    tenants: companies,
    uploadsSize,
    uploadsSizeLabel: formatBytes(uploadsSize)
  };
}

function dashboardStats(companies, health) {
  return {
    activeCompanies: companies.filter((c) => c.license_status_computed === 'active' || c.license_status_computed === 'expiring').length,
    suspendedCompanies: companies.filter((c) => c.license_status_computed === 'suspended').length,
    expiredCompanies: companies.filter((c) => c.license_status_computed === 'expired').length,
    totalUsers: companies.reduce((sum, c) => sum + Number(c.users_count || 0), 0),
    totalStorage: companies.reduce((sum, c) => sum + Number(c.storage_used || 0), 0) + Number(health.uploadsSize || 0),
    totalStorageLabel: formatBytes(companies.reduce((sum, c) => sum + Number(c.storage_used || 0), 0) + Number(health.uploadsSize || 0))
  };
}

async function ensureGlobalAuditTable(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS global_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NULL,
      user_id BIGINT NULL,
      user_name TEXT NULL,
      action TEXT NOT NULL,
      module TEXT NULL,
      description TEXT NULL,
      ip_address TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
}

async function logGlobalAudit(db, event) {
  try {
    await ensureGlobalAuditTable(db);
    await db.query(
      `INSERT INTO global_audit_logs
       (company_id, user_id, user_name, action, module, description, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.company_id || null,
        event.user_id || null,
        event.user_name || null,
        event.action,
        event.module || null,
        event.description || null,
        event.ip_address || null
      ]
    );
  } catch (err) {
    console.error('[global-audit] failed', err);
  }
}

module.exports = {
  createPool,
  getCompaniesWithSaasInfo,
  getSystemHealth,
  dashboardStats,
  listBackups,
  formatBytes,
  licenseStatus,
  licenseStatusLabel,
  ensureGlobalAuditTable,
  logGlobalAudit
};
