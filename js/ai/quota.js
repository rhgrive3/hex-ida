export const AI_QUOTA = Object.freeze({
  windowMs: 60_000,
  ipRateLimit: 30,
  sessionRateLimit: 30,
  ipConcurrencyLimit: 4,
  sessionConcurrencyLimit: 2,
  leaseMs: 120_000,
});

const MAX_SESSION_ID = 128;

export function normalizeQuotaSessionId(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, MAX_SESSION_ID) : '';
  return text || 'anonymous';
}

function finiteInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function setOwn(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizedSession(raw, windowStarted) {
  if (!raw || Number(raw.windowStarted) !== windowStarted) return { windowStarted, count: 0 };
  return { windowStarted, count: finiteInt(raw.count) };
}

export function normalizeQuotaState(raw, now = Date.now(), config = AI_QUOTA) {
  const t = finiteInt(now);
  const windowMs = finiteInt(config.windowMs, AI_QUOTA.windowMs) || AI_QUOTA.windowMs;
  const leaseMs = finiteInt(config.leaseMs, AI_QUOTA.leaseMs) || AI_QUOTA.leaseMs;
  let windowStarted = finiteInt(raw?.windowStarted, t);
  let count = finiteInt(raw?.count);
  let sessions = raw?.sessions && typeof raw.sessions === 'object'
    ? Object.fromEntries(Object.entries(raw.sessions))
    : {};
  const hadPriorWindow = raw?.windowStarted != null;
  const isRollback = hadPriorWindow && t < windowStarted;
  if (t - windowStarted >= windowMs) {
    windowStarted = t;
    count = 0;
    sessions = {};
  } else if (isRollback) {
    // Clock rollback: keep the prior window/counters so a backward correction
    // alone never re-grants rate budget. Leases are handled below against the
    // same rollback anchor so both quotas share one correction policy.
  } else if (!hadPriorWindow) {
    windowStarted = t;
  }

  // Effective clock for expiry decisions. On rollback the persisted
  // windowStarted is the newest trustworthy timestamp, so leases expire
  // against it instead of the rolled-back wall clock (which would extend
  // their real lifetime). Survivor expiry is additionally capped at
  // t + leaseMs so wall-clock lifetime never exceeds the configured lease.
  const expiryThreshold = isRollback ? windowStarted : t;
  const expiryCap = t + leaseMs;
  const leases = {};
  if (raw?.leases && typeof raw.leases === 'object') {
    for (const [token, lease] of Object.entries(raw.leases)) {
      const expiresAt = finiteInt(lease?.expiresAt);
      if (!token || expiresAt <= expiryThreshold) continue;
      const capped = Math.min(expiresAt, expiryCap);
      if (capped <= expiryThreshold) continue;
      setOwn(leases, token, {
        sessionId: normalizeQuotaSessionId(lease?.sessionId),
        expiresAt: capped,
      });
    }
  }
  return { windowStarted, count, sessions, leases };
}

function activeForSession(leases, sessionId) {
  let n = 0;
  for (const lease of Object.values(leases || {})) if (lease.sessionId === sessionId) n++;
  return n;
}

function firstLeaseExpiry(leases, sessionId = null) {
  let min = null;
  for (const lease of Object.values(leases || {})) {
    if (sessionId != null && lease.sessionId !== sessionId) continue;
    if (min == null || lease.expiresAt < min) min = lease.expiresAt;
  }
  return min;
}

export function acquireQuotaState(raw, request = {}, config = AI_QUOTA) {
  const now = finiteInt(request.now, Date.now());
  const state = normalizeQuotaState(raw, now, config);
  const sessionId = normalizeQuotaSessionId(request.sessionId);
  const session = normalizedSession(state.sessions[sessionId], state.windowStarted);
  const windowMs = finiteInt(config.windowMs, AI_QUOTA.windowMs) || AI_QUOTA.windowMs;
  const ipRateLimit = finiteInt(config.ipRateLimit, AI_QUOTA.ipRateLimit);
  const sessionRateLimit = finiteInt(config.sessionRateLimit, AI_QUOTA.sessionRateLimit);
  const ipConcurrencyLimit = finiteInt(config.ipConcurrencyLimit, AI_QUOTA.ipConcurrencyLimit);
  const sessionConcurrencyLimit = finiteInt(config.sessionConcurrencyLimit, AI_QUOTA.sessionConcurrencyLimit);
  const leaseMs = finiteInt(config.leaseMs, AI_QUOTA.leaseMs) || AI_QUOTA.leaseMs;
  const active = Object.keys(state.leases).length;
  const sessionActive = activeForSession(state.leases, sessionId);
  // On clock rollback the persisted windowStarted is newer than the wall
  // clock; advisories must not include the rollback span.
  const effectiveNow = state.windowStarted > now ? state.windowStarted : now;

  if (state.count >= ipRateLimit || session.count >= sessionRateLimit) {
    const retryAfterMs = Math.max(1, state.windowStarted + windowMs - effectiveNow);
    return { state, result: { allowed: false, reason: 'rate', retryAfterMs, active, sessionActive } };
  }
  if (active >= ipConcurrencyLimit || sessionActive >= sessionConcurrencyLimit) {
    const expiry = active >= ipConcurrencyLimit
      ? firstLeaseExpiry(state.leases)
      : firstLeaseExpiry(state.leases, sessionId);
    return {
      state,
      result: {
        allowed: false,
        reason: 'concurrency',
        retryAfterMs: Math.max(1, (expiry ?? (effectiveNow + leaseMs)) - effectiveNow),
        active,
        sessionActive,
      },
    };
  }

  const token = typeof request.token === 'string' ? request.token.trim() : '';
  if (!token) throw new TypeError('quota acquisition requires a lease token');
  const existingLease = hasOwn(state.leases, token) ? state.leases[token] : null;
  if (existingLease) {
    return {
      state,
      result: {
        allowed: false,
        reason: 'concurrency',
        retryAfterMs: Math.max(1, existingLease.expiresAt - effectiveNow),
        active,
        sessionActive,
      },
    };
  }
  state.count++;
  session.count++;
  setOwn(state.sessions, sessionId, session);
  setOwn(state.leases, token, { sessionId, expiresAt: now + leaseMs });
  return {
    state,
    result: {
      allowed: true,
      token,
      retryAfterMs: 0,
      remaining: Math.max(0, ipRateLimit - state.count),
      active: active + 1,
      sessionActive: sessionActive + 1,
    },
  };
}

export function releaseQuotaState(raw, token, now = Date.now(), config = AI_QUOTA) {
  const state = normalizeQuotaState(raw, now, config);
  const key = typeof token === 'string' ? token.trim() : '';
  const released = !!(key && hasOwn(state.leases, key));
  if (released) delete state.leases[key];
  return { state, released };
}
