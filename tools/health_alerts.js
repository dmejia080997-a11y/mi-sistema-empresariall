require('dotenv').config();

const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const path = require('path');
const { getDatabaseConfig } = require('../src/config/database');
const { sendAdminAlert, logAlert } = require('./alerts');

const ROOT_DIR = path.resolve(__dirname, '..');
const DISK_MIN_FREE_PERCENT = Number(process.env.ALERT_DISK_MIN_FREE_PERCENT || 10);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    ...options
  });
}

async function checkPostgres() {
  const config = getDatabaseConfig();
  const pool = new Pool({
    connectionString: config.url,
    ssl: config.ssl ? { rejectUnauthorized: false } : false
  });
  try {
    await pool.query('SELECT 1');
    return { name: 'PostgreSQL', ok: true };
  } finally {
    await pool.end();
  }
}

function checkPm2() {
  const result = run('pm2', ['jlist']);
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'pm2 jlist failed').trim());
  }
  const processes = JSON.parse(result.stdout || '[]');
  if (!processes.length) {
    throw new Error('No PM2 processes found.');
  }
  const unhealthy = processes.filter((proc) => !proc.pm2_env || proc.pm2_env.status !== 'online');
  if (unhealthy.length) {
    throw new Error(`PM2 unhealthy processes: ${unhealthy.map((proc) => proc.name || proc.pm_id).join(', ')}`);
  }
  return { name: 'PM2', ok: true, processes: processes.length };
}

function checkDisk() {
  const result = run('df', ['-Pk', ROOT_DIR]);
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'df failed').trim());
  }
  const lines = String(result.stdout || '').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('Could not parse df output.');
  const parts = lines[1].trim().split(/\s+/);
  const capacity = parts[4] || '';
  const usedPercent = Number(capacity.replace('%', ''));
  if (!Number.isFinite(usedPercent)) throw new Error(`Invalid disk usage: ${capacity}`);
  const freePercent = 100 - usedPercent;
  if (freePercent < DISK_MIN_FREE_PERCENT) {
    throw new Error(`Disk free space is ${freePercent}% below threshold ${DISK_MIN_FREE_PERCENT}%.`);
  }
  return { name: 'Disk', ok: true, freePercent, usedPercent };
}

async function alertFailure(checkName, error, extra = {}) {
  const message = `${checkName} check failed: ${error.message || error}`;
  logAlert(message);
  await sendAdminAlert(`[ALERTA] ${checkName} fallo`, message, {
    check: checkName,
    error: error.message || String(error),
    ...extra
  }).catch((alertErr) => {
    logAlert(`failed to send alert for ${checkName}: ${alertErr.message || alertErr}`);
  });
}

async function runCheck(name, fn) {
  try {
    const result = await fn();
    console.log(`${name}: OK`);
    return { name, ok: true, result };
  } catch (err) {
    console.log(`${name}: ERROR - ${err.message || err}`);
    await alertFailure(name, err);
    return { name, ok: false, error: err.message || String(err) };
  }
}

async function main() {
  const results = [];
  results.push(await runCheck('PostgreSQL', checkPostgres));
  results.push(await runCheck('PM2', checkPm2));
  results.push(await runCheck('Disk', checkDisk));

  const failed = results.filter((result) => !result.ok);
  console.log(`Resultado final: ${failed.length ? 'ERROR' : 'OK'}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Resultado final: ERROR');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
