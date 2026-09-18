import { ANONYMOUS_IDENTITY, safeIdentity } from './capabilities.js';
import { createAuthTransport } from './transport.js';
const STORAGE_KEY = 'hex.auth.userscript.session.v1';
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_STORAGE_TIMEOUT_MS = 5000;
const PRIVATE_STORAGE_MUTATIONS = new WeakMap();

/** Synchronous reads for existing controls; refresh/authorization are async. */
export class SessionAdminAuthProvider {
  constructor(client) { this.client = client; }
  getIdentity() { return this.client.getIdentity(); }
  refresh() { return this.client.refresh(); }
  subscribe(listener) { return this.client.subscribe(listener); }
  authorize(policy) { return this.client.authorize(policy); }
}
export function createSessionClient({ apiOrigin, privilegedManifest, manager = null, fetchRef, web = false, timeoutMs } = {}) {
  let bearer = null, identity = ANONYMOUS_IDENTITY, closed = false, epoch = 0, sequence = 0, applied = 0;
  const listeners = new Set();
  const request = createAuthTransport({ apiOrigin, manager, fetchRef, web, timeoutMs, token: () => bearer });
  const emit = (value) => {
    const next = safeIdentity(value);
    if (identity.authenticated && (!next.authenticated || next.discordId !== identity.discordId || next.role !== identity.role || (identity.admin && !next.admin))) epoch++;
    identity = next;
    for (const listener of listeners) { try { listener(identity); } catch {} }
    return identity;
  };
  const invalidate = () => { epoch++; return emit(ANONYMOUS_IDENTITY); };
  // In-flight older responses cannot resurrect a demoted/logged-out identity.
  // Concurrent successful reads do not invalidate one another's Dev operations.
  const readAuthority = async (operation) => {
    if (closed) throw new Error('HEX session closed.');
    const current = epoch, order = ++sequence;
    try {
      const value = await operation();
      if (closed || current !== epoch) throw new Error('Dev authorization changed.');
      if (order >= applied) { applied = order; emit(value); }
      return identity;
    } catch (error) {
      // Any authority failure from the current epoch is security-relevant. A
      // slower, older request can observe a demotion after a newer request has
      // already succeeded, so sequence order must never suppress fail-closed
      // invalidation. Invalidating the epoch also prevents concurrent stale
      // successes from restoring the prior Admin identity.
      if (!closed && current === epoch) { applied = Math.max(applied, order); invalidate(); }
      throw error;
    }
  };
  const refresh = async () => {
    if (closed) return ANONYMOUS_IDENTITY;
    if (!web && !bearer) return emit(ANONYMOUS_IDENTITY);
    try { return await readAuthority(() => request('/api/auth/me')); } catch { return identity; }
  };
  let mutationTail = Promise.resolve(), mutationCount = 0;
  function mutation(path, body) {
    // A web CSRF token is rotated by the server; serialize fetch-token + mutate
    // within this client, rather than racing simultaneous privileged RPC calls.
    if (mutationCount >= 16) return Promise.reject(new Error('HEX authorization is busy.'));
    mutationCount++;
    const run = async () => {
      if (closed) throw new Error('HEX session closed.');
      const csrf = web ? (await request('/api/auth/csrf')).csrfToken : null;
      return request(path, { method: 'POST', body, csrf });
    };
    const result = mutationTail.then(run, run);
    mutationTail = result.then(() => {}, () => {});
    return result.finally(() => { mutationCount--; });
  }
  const client = Object.freeze({
    getIdentity: () => identity,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async initialize() {
      const current = epoch;
      if (!web) {
        try {
          if (!manager || ['getValue', 'setValue', 'deleteValue', 'xmlHttpRequest'].some((name) => typeof manager[name] !== 'function')) throw new Error('GM private storage unavailable');
          const stored = await privateStorage(() => manager.getValue(STORAGE_KEY, null));
          if (!closed && current === epoch && typeof stored === 'string' && SECRET.test(stored)) bearer = stored;
        } catch { bearer = null; }
      }
      return refresh();
    },
    refresh,
    aiCapability: () => mutation('/api/auth/ai-capability', {}),
    async authorize(policy = 'normal') {
      if (closed || !['normal', 'yolo'].includes(policy) || !privilegedManifest?.buildId) throw new Error('Dev authorization denied.');
      const latest = await readAuthority(() => mutation('/api/auth/dev/authorize', { buildId: privilegedManifest.buildId, policy }));
      if (!latest.capabilities.canUseDevAgent || (policy === 'yolo' && !latest.capabilities.canUseDevYolo)) throw new Error('Dev authorization denied.');
      return latest;
    },
    async source(kind) {
      if (!['parent', 'child'].includes(kind) || closed) throw new Error('Invalid privileged extension.');
      const latest = await refresh();
      if (!latest.capabilities.canFetchPrivilegedDevSource || !privilegedManifest?.buildId) throw new Error('Dev authorization denied.');
      const current = epoch;
      try {
        const result = await request(`/_privileged/dev/${privilegedManifest.buildId}/${kind}.js`, { source: true });
        if (result.buildId !== privilegedManifest.buildId) throw new Error('Privileged build changed.');
        const expected = privilegedManifest[`${kind}Hash`];
        await verifySource(result.source, expected);
        if (closed || current !== epoch || !identity.capabilities.canFetchPrivilegedDevSource) throw new Error('Privileged authorization changed.');
        return Object.freeze({ source: result.source, hash: expected, buildId: result.buildId });
      } catch (error) { if (current === epoch) invalidate(); throw error; }
    },
    async logout() {
      // Clamp the local lifecycle immediately, including during a slow revoke.
      invalidate();
      try { await mutation('/auth/logout', {}); }
      finally { bearer = null; invalidate(); if (!web && manager?.deleteValue) await privateStorageMutation(manager, () => manager.deleteValue(STORAGE_KEY)).done; }
    },
    // Parent-only pairing API. It is never exposed through the child RPC.
    startPairing: (openerOrigin, signal) => request('/api/auth/userscript/start', { method: 'POST', body: { openerOrigin }, signal }),
    pollPairing: (transactionId, pollSecret, signal) => request('/api/auth/userscript/poll', { method: 'POST', body: { transactionId, pollSecret }, signal }),
    async completePairing(transactionId, pollSecret, completionProof, signal) {
      if (web || closed || !manager?.setValue) throw new Error('Userscript private storage unavailable.');
      const current = epoch;
      const result = await request('/api/auth/userscript/complete', { method: 'POST', body: { transactionId, pollSecret, completionProof }, signal });
      if (typeof result?.token !== 'string' || !SECRET.test(result.token)) throw new Error('Invalid HEX session.');
      if (closed || signal?.aborted || current !== epoch) throw new Error('Login was cancelled.');
      const token = result.token;
      bearer = token;
      const persistence = privateStorageMutation(manager, () => manager.setValue(STORAGE_KEY, token));
      try { await persistence.done; }
      catch {
        // A timed-out GM write keeps running.  Cleanup is ordered behind that
        // physical write, but only while this pairing still owns the newest
        // storage generation.  A newer pairing must never be deleted by an
        // older failure path.
        try { if (bearer === token) await mutation('/auth/logout', {}); }
        finally {
          if (bearer === token) { bearer = null; invalidate(); }
          try { await privateStorageCleanup(manager, persistence.generation, () => manager.deleteValue(STORAGE_KEY)); } catch {}
        }
        throw new Error('Unable to save the private HEX session.');
      }
      if (closed || signal?.aborted || current !== epoch) {
        // Cancellation during asynchronous GM storage must not survive reload,
        // unless a newer lifecycle generation already owns the same storage.
        try { await privateStorageCleanup(manager, persistence.generation, () => manager.deleteValue(STORAGE_KEY)); }
        finally { if (bearer === token) { bearer = null; invalidate(); } }
        throw new Error('Login was cancelled.');
      }
      await refresh();
    },
    close() { closed = true; bearer = null; invalidate(); listeners.clear(); },
  });
  return client;
}
function privateStorageMutation(manager, operation) {
  let state = PRIVATE_STORAGE_MUTATIONS.get(manager);
  if (!state) {
    state = { generation: 0, tail: Promise.resolve() };
    PRIVATE_STORAGE_MUTATIONS.set(manager, state);
  }
  const generation = ++state.generation;
  const actual = state.tail.then(
    () => Promise.resolve().then(operation),
    () => Promise.resolve().then(operation),
  );
  // Caller timeouts do not release ordering authority: a late physical GM
  // mutation must settle before any newer mutation against the same manager.
  state.tail = actual.then(() => {}, () => {});
  return { generation, done: privateStorage(() => actual) };
}
async function privateStorageCleanup(manager, generation, operation) {
  const state = PRIVATE_STORAGE_MUTATIONS.get(manager);
  if (!state || state.generation !== generation) return false;
  await privateStorageMutation(manager, operation).done;
  return true;
}
async function privateStorage(operation) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Private storage timed out.')), PRIVATE_STORAGE_TIMEOUT_MS); })]); }
  finally { clearTimeout(timer); }
}
export async function verifySource(source, expected) {
  if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Privileged source identity missing.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const actual = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('Privileged source integrity mismatch.');
}
