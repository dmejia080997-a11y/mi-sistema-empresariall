function createRateLimiter({ sweepMs, maxIdleMs }) {
  let lastSweep = 0;

  function sweep(map, now) {
    if (now - lastSweep < sweepMs) return;
    lastSweep = now;
    for (const [key, value] of map.entries()) {
      if (!value || now - (value.lastSeen || 0) > maxIdleMs) {
        map.delete(key);
      }
    }
  }

  function hit(map, key, windowMs, max, now) {
    const safeNow = Number.isFinite(now) ? now : Date.now();
    sweep(map, safeNow);
    const entry = map.get(key) || { count: 0, resetAt: safeNow + windowMs, lastSeen: safeNow };
    if (safeNow > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = safeNow + windowMs;
    }
    entry.count += 1;
    entry.lastSeen = safeNow;
    map.set(key, entry);
    return entry.count <= max;
  }

  return { hit };
}

module.exports = {
  createRateLimiter
};
