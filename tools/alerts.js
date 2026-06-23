require('dotenv').config();

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'logs');
const ALERT_LOG_FILE = path.join(LOG_DIR, 'alerts.log');

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logAlert(line) {
  ensureLogDir();
  fs.appendFileSync(ALERT_LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
}

function getAdminEmail() {
  return process.env.ALERT_ADMIN_EMAIL || process.env.ADMIN_EMAIL || process.env.SMTP_TO || '';
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 0);
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!host || !port || !from) return null;
  return {
    host,
    port,
    from,
    secure: port === 465,
    auth: process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  };
}

async function sendAdminAlert(subject, message, details = {}) {
  const to = getAdminEmail();
  const smtp = getSmtpConfig();
  const body = [
    message,
    '',
    'Detalles:',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      host: require('os').hostname(),
      ...details
    }, null, 2)
  ].join('\n');

  if (!to) {
    logAlert(`alert not sent: missing admin email subject="${subject}"`);
    return { sent: false, reason: 'missing_admin_email' };
  }
  if (!smtp) {
    logAlert(`alert not sent: missing smtp config subject="${subject}" to=${to}`);
    return { sent: false, reason: 'missing_smtp_config' };
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.auth
  });

  await transport.sendMail({
    from: smtp.from,
    to,
    subject,
    text: body
  });
  logAlert(`alert sent subject="${subject}" to=${to}`);
  return { sent: true };
}

module.exports = {
  sendAdminAlert,
  logAlert
};
