const fs = require('fs');
const path = require('path');

const DEFAULT_FILES = [path.join(__dirname, '..', 'locales', 'es.json')];
const targetFiles = process.argv.slice(2);
const files = targetFiles.length ? targetFiles : DEFAULT_FILES;

const MOJIBAKE_PATTERN = /Ã.|Â|â€|â€™|â€œ|â€|â€¦/;

function fixString(str) {
  let current = str;
  for (let i = 0; i < 4; i += 1) {
    if (!MOJIBAKE_PATTERN.test(current)) break;
    const next = Buffer.from(current, 'latin1').toString('utf8');
    if (next === current) break;
    current = next;
  }
  return current;
}

function walk(value, changes) {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, changes));
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([key, val]) => {
      out[key] = walk(val, changes);
    });
    return out;
  }
  if (typeof value === 'string') {
    const fixed = fixString(value);
    if (fixed !== value) changes.count += 1;
    return fixed;
  }
  return value;
}

files.forEach((filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const changes = { count: 0 };
  const fixed = walk(parsed, changes);
  fs.writeFileSync(filePath, `${JSON.stringify(fixed, null, 2)}\n`, 'utf8');
  console.log(`[i18n] ${path.basename(filePath)}: ${changes.count} textos corregidos`);
});
