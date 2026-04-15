require('dotenv').config();
const requiredInProd = ['SESSION_SECRET', 'MASTER_USER', 'MASTER_PASS', 'FILE_TOKEN_SECRET'];
const isProd = (process.env.NODE_ENV || 'development') === 'production';
let failed = false;
if (isProd) {
  requiredInProd.forEach((key) => {
    if (!process.env[key]) {
      console.error(`[selfcheck] Missing env var in production: ${key}`);
      failed = true;
    }
  });
} else {
  requiredInProd.forEach((key) => {
    if (!process.env[key]) {
      console.warn(`[selfcheck] Missing env var (dev ok): ${key}`);
    }
  });
}
if (failed) {
  process.exit(1);
}
console.log('[selfcheck] OK');