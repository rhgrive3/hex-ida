export const RUNTIME_BOOTSTRAP_ADMISSION = Object.freeze({
  windowMs: 60_000,
  maxGlobalPerWindow: 300,
  maxBucketPerWindow: 20,
  maxConcurrent: 8,
  maxOutstanding: 512,
  maxOutstandingPerBucket: 12,
  maxTrackedBuckets: 256,
  leaseTtlMs: 30_000,
  sweepPageSize: 128,
  requestSweepPages: 2,
  alarmSweepPages: 8,
});

const RATE_KEY = 'admission:rate';
const PREFIXES = Object.freeze(['nonce:', 'session:', 'lease:']);

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function freshRateState(now, policy) {
  return { windowStart: now, globalCount: 0, buckets: {} };
}

function normalizeRateState(value, now, policy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isFinite(value.windowStart) || !Number.isSafeInteger(value.globalCount)
    || value.globalCount < 0 || !value.buckets || typeof value.buckets !== 'object' || Array.isArray(value.buckets)) {
    return freshRateState(now, policy);
  }
  if (now - value.windowStart >= policy.windowMs || now < value.windowStart) return freshRateState(now, policy);
  const buckets = {};
  for (const [key, entry] of Object.entries(value.buckets)) {
    if (Object.keys(buckets).length >= policy.maxTrackedBuckets) break;
    if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.count) || entry.count < 0) continue;
    buckets[key] = { count: entry.count };
  }
  return { windowStart: value.windowStart, globalCount: value.globalCount, buckets };
}

function activeEntries(values, now) {
  return [...values.values()].filter((value) => value && Number(value.expiry) > now);
}

function admissionFailure(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

export async function beginRuntimeBootstrapIssuance(storage, input, {
  now = Date.now(),
  policy = RUNTIME_BOOTSTRAP_ADMISSION,
  randomId = () => crypto.randomUUID(),
} = {}) {
  const nonce = nonEmpty(input?.nonce);
  const sessionId = nonEmpty(input?.sessionId);
  const requestId = nonEmpty(input?.requestId);
  const bucket = nonEmpty(input?.bucket);
  const expiry = Number(input?.expiry);
  if (!nonce || !sessionId || !requestId || !bucket || !Number.isFinite(expiry) || expiry <= now) {
    return admissionFailure('bootstrap-admission-invalid');
  }

  await pruneRuntimeBootstrapState(storage, {
    now,
    policy,
    maxPagesPerPrefix: policy.requestSweepPages,
  });

  return storage.transaction(async (tx) => {
    const rate = normalizeRateState(await tx.get(RATE_KEY), now, policy);
    if (rate.globalCount >= policy.maxGlobalPerWindow) return admissionFailure('bootstrap-global-rate-limit');
    const existingBucket = rate.buckets[bucket];
    if (!existingBucket && Object.keys(rate.buckets).length >= policy.maxTrackedBuckets) {
      return admissionFailure('bootstrap-bucket-capacity');
    }
    const bucketState = existingBucket ?? { count: 0 };
    if (bucketState.count >= policy.maxBucketPerWindow) return admissionFailure('bootstrap-bucket-rate-limit');

    // Count the accepted-shape attempt before any replay/capacity decision so
    // a cheap replay flood cannot bypass the admission work budget. This state
    // is bounded to one global record plus maxTrackedBuckets counters.
    rate.globalCount += 1;
    rate.buckets[bucket] = { count: bucketState.count + 1 };
    await tx.put(RATE_KEY, rate);

    const nonceKey = `nonce:${nonce}`;
    const previousNonce = await tx.get(nonceKey);
    if (previousNonce && Number(previousNonce.expiry) > now) return admissionFailure('replayed-nonce');

    const leaseRecords = await tx.list({ prefix: 'lease:', limit: policy.maxConcurrent + 1 });
    // If more records exist than the admission cap, do not let expired rows at
    // the front of the keyspace hide later live leases. The alarm will sweep
    // them; until then, refusing is safer than under-counting concurrency.
    if (leaseRecords.size > policy.maxConcurrent) return admissionFailure('bootstrap-concurrency-limit');
    const leases = activeEntries(leaseRecords, now);
    if (leases.length >= policy.maxConcurrent) return admissionFailure('bootstrap-concurrency-limit');

    const sessionRecords = await tx.list({ prefix: 'session:', limit: policy.maxOutstanding + 1 });
    // Same fail-closed rule for retained sessions: when the bounded read cannot
    // prove that the entire outstanding set is within policy, admission waits
    // for the bounded alarm cleanup instead of guessing from a prefix.
    if (sessionRecords.size > policy.maxOutstanding) return admissionFailure('bootstrap-outstanding-limit');
    const sessions = activeEntries(sessionRecords, now);
    if (sessions.length >= policy.maxOutstanding) return admissionFailure('bootstrap-outstanding-limit');
    const bucketOutstanding = sessions.reduce((count, state) => count + (state.bucket === bucket ? 1 : 0), 0);
    if (bucketOutstanding >= policy.maxOutstandingPerBucket) return admissionFailure('bootstrap-bucket-outstanding-limit');

    const leaseId = randomId();
    const leaseExpiry = Math.min(expiry, now + policy.leaseTtlMs);
    await tx.put(nonceKey, { expiry, requestId, sessionId, bucket, status: 'reserved' });
    await tx.put(`session:${sessionId}`, { expiry, requestId, bucket, consumed: false, ready: false });
    await tx.put(`lease:${leaseId}`, { expiry: leaseExpiry, sessionId, nonce, requestId, bucket });
    return { ok: true, leaseId, leaseExpiry };
  });
}

export async function finishRuntimeBootstrapIssuance(storage, {
  leaseId,
  sessionId,
  now = Date.now(),
} = {}) {
  if (!nonEmpty(leaseId) || !nonEmpty(sessionId)) return admissionFailure('bootstrap-admission-invalid');
  return storage.transaction(async (tx) => {
    const lease = await tx.get(`lease:${leaseId}`);
    if (!lease || lease.sessionId !== sessionId || Number(lease.expiry) <= now) {
      return admissionFailure('bootstrap-issuance-lease-expired');
    }
    const session = await tx.get(`session:${sessionId}`);
    if (!session || Number(session.expiry) <= now) return admissionFailure('expired-session');
    await tx.put(`session:${sessionId}`, { ...session, ready: true });
    const nonce = await tx.get(`nonce:${lease.nonce}`);
    if (nonce && nonce.sessionId === sessionId) await tx.put(`nonce:${lease.nonce}`, { ...nonce, status: 'issued' });
    await tx.delete(`lease:${leaseId}`);
    return { ok: true };
  });
}

export async function abortRuntimeBootstrapIssuance(storage, {
  leaseId,
  sessionId,
} = {}) {
  if (!nonEmpty(leaseId) || !nonEmpty(sessionId)) return { aborted: false };
  return storage.transaction(async (tx) => {
    const lease = await tx.get(`lease:${leaseId}`);
    if (!lease || lease.sessionId !== sessionId) return { aborted: false };
    const keys = [`lease:${leaseId}`, `session:${sessionId}`];
    const nonceKey = `nonce:${lease.nonce}`;
    const nonce = await tx.get(nonceKey);
    if (nonce?.sessionId === sessionId) keys.push(nonceKey);
    await tx.delete(keys);
    return { aborted: true };
  });
}

export async function consumeRuntimeBootstrapSession(storage, {
  sessionId,
  requestId,
  now = Date.now(),
} = {}) {
  if (!nonEmpty(sessionId) || !nonEmpty(requestId)) return admissionFailure('expired-session');
  return storage.transaction(async (tx) => {
    const key = `session:${sessionId}`;
    const state = await tx.get(key);
    if (!state || Number(state.expiry) <= now || state.ready !== true) return admissionFailure('expired-session');
    if (state.consumed || state.requestId !== requestId) return admissionFailure('replayed-session');
    await tx.put(key, { ...state, consumed: true });
    return { ok: true };
  });
}

async function prunePrefix(storage, prefix, {
  now,
  pageSize,
  maxPages,
}) {
  let startAfter;
  let earliestExpiry = null;
  let more = false;
  let deleted = 0;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const options = { prefix, limit: pageSize };
    if (startAfter != null) options.startAfter = startAfter;
    const page = await storage.list(options);
    if (page.size === 0) { more = false; break; }
    const keys = [...page.keys()];
    startAfter = keys[keys.length - 1];
    const expired = [];
    for (const [key, value] of page) {
      const expiry = Number(value?.expiry);
      if (!Number.isFinite(expiry) || expiry <= now) expired.push(key);
      else earliestExpiry = earliestExpiry == null ? expiry : Math.min(earliestExpiry, expiry);
    }
    if (expired.length > 0) {
      await storage.delete(expired);
      deleted += expired.length;
    }
    more = page.size === pageSize;
    if (!more) break;
  }
  return { more, earliestExpiry, deleted };
}

export async function pruneRuntimeBootstrapState(storage, {
  now = Date.now(),
  policy = RUNTIME_BOOTSTRAP_ADMISSION,
  maxPagesPerPrefix = policy.requestSweepPages,
} = {}) {
  let more = false;
  let earliestExpiry = null;
  let deleted = 0;
  for (const prefix of PREFIXES) {
    const result = await prunePrefix(storage, prefix, {
      now,
      pageSize: policy.sweepPageSize,
      maxPages: maxPagesPerPrefix,
    });
    more ||= result.more;
    deleted += result.deleted;
    if (result.earliestExpiry != null) {
      earliestExpiry = earliestExpiry == null ? result.earliestExpiry : Math.min(earliestExpiry, result.earliestExpiry);
    }
  }
  return { more, earliestExpiry, deleted };
}
