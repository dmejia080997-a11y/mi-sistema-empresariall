const crypto = require('crypto');

const TOKEN_ALGORITHM = 'aes-256-gcm';

function getTokenSecret() {
  return process.env.META_TOKEN_SECRET || process.env.FILE_TOKEN_SECRET || process.env.SESSION_SECRET || '';
}

function encryptToken(value) {
  const text = clean(value);
  if (!text) return '';
  const secret = getTokenSecret();
  if (!secret) return `plain:${text}`;
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(TOKEN_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptToken(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.startsWith('plain:')) return text.slice(6);
  if (!text.startsWith('enc:')) return text;
  const secret = getTokenSecret();
  if (!secret) return '';
  const parts = text.split(':');
  if (parts.length !== 4) return '';
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const decipher = crypto.createDecipheriv(TOKEN_ALGORITHM, key, Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

function maskToken(value) {
  const token = clean(value);
  if (!token) return '';
  if (token.length <= 10) return `${token.slice(0, 2)}...`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

module.exports = {
  encryptToken,
  decryptToken,
  maskToken
};
