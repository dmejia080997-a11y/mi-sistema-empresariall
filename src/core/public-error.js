function isDatabaseError(error) {
  const code = String(error && error.code || '').trim();
  const message = String(error && error.message || error || '');
  return /^[0-9A-Z]{5}$/.test(code)
    || /\b(column|relation|table|constraint|operator)\b.*\b(does not exist|violates|failed)\b/i.test(message)
    || /\b(syntax error at or near|database error|SQLITE_ERROR|SQLSTATE)\b/i.test(message);
}

function publicErrorMessage(error, fallback = 'No se pudo completar la operación.') {
  if (!error || isDatabaseError(error)) return fallback;
  const message = String(error.message || error).trim();
  return message && message.length <= 300 ? message : fallback;
}

module.exports = {
  isDatabaseError,
  publicErrorMessage
};
