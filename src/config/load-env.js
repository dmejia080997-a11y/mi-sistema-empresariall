const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function loadEnvironment() {
  const nodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
  process.env.NODE_ENV = nodeEnv;

  const filename = nodeEnv === 'development' ? '.env.development' : '.env';
  const envPath = path.join(ROOT_DIR, filename);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: nodeEnv === 'development' });
  }

  return { nodeEnv, envPath };
}

module.exports = loadEnvironment();
