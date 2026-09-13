/** Bounded cursors over the existing KnowledgeDB. Tokens are one-use read
 * capabilities, not persisted facts. No second index or knowledge owner.
 */
import { stableStringify } from '../core/identity/index.js';
import { assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { snapshotContractData, exactInteger, exactString, contractFail } from '../core/identity/structured.js';
const OWNERS = new WeakMap(), TTL_MS = 60000, MAX_CURSORS = 16;
const now = () => globalThis.performance?.now?.() ?? Date.now();
function stateFor(owner) {
  let state = OWNERS.get(owner);
  if (!state) OWNERS.set(owner, state = new Map());
  for (const [token, value] of state) if (value.revision !== owner.revision || value.expires <= now()) state.delete(token);
  return state;
}
function token() {
  if (!globalThis.crypto?.getRandomValues) contractFail('knowledge-page-secure-random-required');
  return 'knpage_' + [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, '0')).join('');
}
export function cancelScopedKnowledgePage(owner, cursor) {
  exactString(cursor, 'knowledge-page-cursor', 128);
  return { cancelled: stateFor(owner).delete(cursor), authority: 'cursor-retirement-only' };
}
export async function readScopedKnowledgePage(owner, { limit = 64, cursor = null, scopeId = 'legacy-scoped-page', work } = {}, openDatabase) {
  assertScopedAnalysisWork(work); exactInteger(limit, 'knowledge-scoped-page-cap', { min: 1, max: 128 });
  exactString(scopeId, 'knowledge-page-scope', 512); work.checkpoint();
  const sessions = stateFor(owner), revision = owner.revision, records = [];
  let state;
  if (cursor !== null) {
    exactString(cursor, 'knowledge-page-cursor', 128); state = sessions.get(cursor);
    if (!state || state.scopeId !== scopeId || state.limit !== limit) contractFail('knowledge-page-cursor-stale-or-foreign');
    sessions.delete(cursor); // consume before any await; failure cannot rewind
  } else {
    if (sessions.size >= MAX_CURSORS) contractFail('knowledge-page-session-cap');
    state = { scopeId, limit, revision, expires: now() + TTL_MS, visited: 0, lastKey: null,
      iterator: owner.memory ? owner.memory.values() : null, pending: null };
  }
  const current = () => owner.revision === revision && state.expires > now();
  const check = () => { work.checkpoint(); if (!current()) contractFail('knowledge-page-generation-changed-or-expired'); };
  const take = record => {
    check(); work.charge('workUnits');
    const copy = snapshotContractData(record, { allowBigInt: true, maxBytes: 262144, maxNodes: 8192 });
    work.charge('residentBytes', stableStringify(copy).length * 2 + 64); records.push(copy);
  };
  let truncated = false;
  if (state.iterator) {
    while (true) {
      check(); work.charge('queueOperations');
      const next = state.pending ?? state.iterator.next(); state.pending = null;
      if (next.done) break;
      if (records.length >= limit) { state.pending = next; truncated = true; break; }
      take(next.value); await work.yieldIfNeeded();
    }
  } else {
    const db = await work.await(() => openDatabase()); check();
    await work.await(signal => new Promise((resolve, reject) => {
      const tx = db.transaction('functions', 'readonly');
      const request = tx.objectStore('functions').openCursor();
      let settled = false, readingEnded = false, seeking = state.lastKey !== null;
      const finish = error => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => { try { tx.abort(); } catch { /* transaction may have ended */ } finish(signal.reason ?? new Error('knowledge-page-cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      tx.oncomplete = () => finish(readingEnded ? null : new Error('knowledge-page-incomplete-transaction'));
      tx.onabort = () => finish(tx.error ?? new Error('knowledge-page-transaction-aborted'));
      tx.onerror = () => finish(tx.error ?? new Error('knowledge-page-transaction-failed'));
      request.onerror = () => finish(request.error ?? new Error('knowledge-page-cursor-failed'));
      request.onsuccess = () => {
        if (settled) return;
        try {
          check(); const row = request.result;
          if (!row) { readingEnded = true; return; }
          if (seeking) {
            // Continue directly to the saved primary key; do not rescan N
            // preceding rows or materialize all database keys on every page.
            const cmp = owner.indexedDB.cmp(row.key, state.lastKey);
            work.charge('queueOperations');
            if (cmp < 0) { row.continue(state.lastKey); return; }
            seeking = false;
            if (cmp === 0) { row.continue(); return; }
          }
          if (records.length >= limit) { truncated = true; readingEnded = true; return; }
          take(row.value); state.lastKey = structuredClone(row.key); row.continue();
        } catch (error) { try { tx.abort(); } catch { /* already ended */ } finish(error); }
      };
    }));
  }
  check(); state.visited += records.length;
  let continuation = null;
  if (truncated) {
    // Awaited work may have admitted other sessions since the initial check.
    if (stateFor(owner).size >= MAX_CURSORS) contractFail('knowledge-page-session-cap');
    continuation = token(); sessions.set(continuation, state);
  }
  return { records, revision, truncated, continuation, visited: state.visited,
    order: state.iterator ? 'owner-insertion-order' : 'owner-primary-key-order',
    isCurrent: current, negativeAnnotationsApplied: false, scopeId };
}
