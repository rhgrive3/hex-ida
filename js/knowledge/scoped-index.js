/** Lazy retrieval cartridge owned by KnowledgeDB. The existing FunctionMatchIndex
 * supplies all fingerprint buckets/ranking. No new comparator or semantic owner.
 */
import { FunctionMatchIndex } from '../recognition/matcher.js';
import { createMatchBudget } from '../recognition/match-budget.js';
import { coarseTokens, FUNCTION_FINGERPRINT_VERSION, FUNCTION_FINGERPRINT_COMPARISON_VERSION } from '../fingerprint/index.js';
import { snapshotContractData, exactInteger, exactString, stringSet, contractFail } from '../core/identity/structured.js';
import { stableDigest, stableStringify, lossyTypeWitness, deepFreeze } from '../core/identity/index.js';
import { assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
const OWNERS = new WeakMap(), MAX_CACHE = 32, TTL_MS = 60000;
const now = () => globalThis.performance?.now?.() ?? Date.now();
const digest = value => stableDigest({ value, typed: lossyTypeWitness(value) });
const VERSION = 'knowledge-scoped-index/v1';
export function invalidateScopedKnowledgeIndex(owner) { OWNERS.delete(owner); }
function ownerState(owner) {
  let state = OWNERS.get(owner);
  if (!state || state.revision !== owner.revision) {
    state = { revision: owner.revision, ready: null, building: false, candidates: new Map() }; OWNERS.set(owner, state);
  }
  return state;
}
function detach(row, work) {
  const value = snapshotContractData(row, { allowBigInt: true, maxBytes: 262144, maxNodes: 8192 });
  work.charge('residentBytes', stableStringify(value).length * 2 + 64); return value;
}
export async function readScopedKnowledgeRecords(owner, ids, { revision, work }, openDatabase) {
  assertScopedAnalysisWork(work); const keys = stringSet(ids, 'knowledge-record-ids', 128);
  if (keys.length !== ids.length) contractFail('knowledge-record-ids-unique');
  const current = () => owner.revision === revision;
  if (!current()) contractFail('knowledge-records-stale');
  if (owner.memory) {
    const result = [];
    for (const id of ids) { work.charge('workUnits'); const row = owner.memory.get(id); if (!row || row.id !== id) contractFail('knowledge-index-record-missing'); result.push(detach(row, work)); }
    return result;
  }
  const db = await work.await(() => openDatabase());
  if (!current()) contractFail('knowledge-records-stale');
  const result = await work.await(signal => new Promise((resolve, reject) => {
    const tx = db.transaction('functions', 'readonly'), store = tx.objectStore('functions'), rows = new Map();
    let settled = false;
    const finish = error => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); error ? reject(error) : resolve(ids.map(id => rows.get(id))); };
    const abort = () => { try { tx.abort(); } catch {} finish(signal.reason ?? new Error('knowledge-records-cancelled')); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
    tx.onabort = () => finish(tx.error ?? new Error('knowledge-records-aborted'));
    tx.onerror = () => finish(tx.error ?? new Error('knowledge-records-error'));
    tx.oncomplete = () => finish();
    for (const id of ids) {
      const request = store.get(id);
      request.onerror = () => finish(request.error ?? new Error('knowledge-record-read-failed'));
      request.onsuccess = () => {
        if (settled) return;
        try { work.charge('workUnits'); const row = request.result;
          if (!row || row.id !== id || !current()) contractFail('knowledge-index-record-missing-or-stale'); rows.set(id, detach(row, work)); }
        catch (error) { try { tx.abort(); } catch {} finish(error); }
      };
    }
  }));
  if (!current()) contractFail('knowledge-records-stale'); return result;
}
async function build(owner, state, maximumRecords, work) {
  if (state.building) contractFail('knowledge-index-build-busy');
  state.building = true;
  const capturedRevision = owner.revision, scopeId = VERSION + ':' + capturedRevision + ':' + maximumRecords;
  const current = () => owner.revision === capturedRevision && ownerState(owner) === state;
  const budget = createMatchBudget({ signal: work.signal, maxPreprocessFunctions: maximumRecords,
    maxPreprocessEstimatedBytes: work.limits.residentBytes, maxPreprocessWork: work.limits.workUnits,
    maxIndexEntries: maximumRecords * 32,
    // MatchBudget accepts positive integer milliseconds. Passing a fractional
    // remainder silently selects its default, which can shrink OR extend this
    // caller's limit. Round down; the parent work remains the deadline owner.
    maxWallMs: Math.max(1, Math.floor(work.limits.deadlineMs - work.cost().elapsedMs)) });
  const index = new FunctionMatchIndex([], { mode: 'full', budget }), ids = [], fingerprints = [], unread = [];
  let cursor = null, visited = 0, complete = false, pages = 0, unreadCount = 0;
  try {
    while (visited < maximumRecords) {
      work.checkpoint(); if (!current()) contractFail('knowledge-index-build-stale');
      const page = await owner.scopedPage({ limit: Math.min(128, maximumRecords), cursor, scopeId, work });
      cursor = page.continuation; pages++;
      for (const row of page.records) {
        work.charge('workUnits'); visited++;
        if (row.fingerprint?.version !== FUNCTION_FINGERPRINT_VERSION || row.fingerprint?.schema !== 'hex.function-fingerprint') {
          unreadCount++; if (unread.length < 32) unread.push(row.id); continue;
        }
        if (!index.append(row.fingerprint)) contractFail('knowledge-index-preprocessing-budget');
        const id = exactString(row.id, 'knowledge-index-record-id'); ids.push(id); fingerprints.push(digest(row.fingerprint));
        work.charge('residentBytes', id.length * 2 + stableStringify(index.items[index.items.length - 1]).length * 2 + 128); await work.yieldIfNeeded();
      }
      if (!cursor) { complete = true; break; }
    }
    if (!current() || !index.complete) contractFail('knowledge-index-build-stale-or-incomplete');
    const ready = { index, ids, fingerprints, maximumRecords, revision: capturedRevision, visited, pages,
      complete, unread: unreadCount, unreadExamples: unread, expires: now() + TTL_MS };
    state.ready = ready; state.candidates.clear(); return ready;
  } finally { if (cursor) owner.cancelScopedPage(cursor); state.building = false; }
}

export async function queryScopedKnowledgeIndex(owner, fingerprint, { limit = 64, maximumRecords = 8192,
  maximumBucketScan = 1024, scopeId, work } = {}, readRecords) {
  assertScopedAnalysisWork(work); work.checkpoint();
  exactInteger(limit, 'knowledge-index-candidate-cap', { min: 1, max: 128 });
  exactInteger(maximumRecords, 'knowledge-index-build-cap', { min: 128, max: 65536 });
  // Fixed pages preserve one-use cursor page-size bindings on the final page.
  if (maximumRecords % 128 !== 0) contractFail('knowledge-index-build-page-multiple');
  exactInteger(maximumBucketScan, 'knowledge-index-bucket-cap', { min: limit, max: 4096 });
  exactString(scopeId, 'knowledge-index-scope', 512);
  const query = snapshotContractData(fingerprint, { allowBigInt: true, maxBytes: 262144, maxNodes: 8192 });
  if (query.schema !== 'hex.function-fingerprint' || query.version !== FUNCTION_FINGERPRINT_VERSION) contractFail('knowledge-index-query-version');
  const state = ownerState(owner), revision = state.revision;
  const current = () => owner.revision === revision && ownerState(owner) === state;
  let ready = state.ready, built = false;
  if (!ready || ready.maximumRecords !== maximumRecords || ready.expires <= now()) { ready = await build(owner, state, maximumRecords, work); built = true; }
  if (!current()) contractFail('knowledge-index-query-stale');
  // Reusing a candidate cut is conditioned on world/snapshot/query identity,
  // database generation and comparator/feature versions. It carries NO proof.
  const cacheKey = digest({ scopeId, fingerprint: query, limit, maximumBucketScan, maximumRecords,
    revision, version: VERSION, compareVersion: FUNCTION_FINGERPRINT_COMPARISON_VERSION });
  let cut = state.candidates.get(cacheKey), reused = !!cut;
  if (!cut) {
    const tokens = coarseTokens(query), populated = tokens.map(token => ({ token, count: ready.index.buckets.get(token)?.length ?? 0 })).filter(row => row.count);
    const charge = populated.slice().sort((a, b) => a.count - b.count).slice(0, 6).reduce((sum, row) => sum + Math.min(row.count, maximumBucketScan), 0);
    work.charge('workUnits', charge + tokens.length + 1); work.charge('queueOperations', charge);
    const selected = ready.index.candidates(query, { maxCandidates: limit, maxBucketScan: maximumBucketScan });
    work.checkpoint(); if (!current()) contractFail('knowledge-index-query-stale');
    cut = deepFreeze({ selected, buckets: populated.map(row => ({ layer: row.token.split(':', 1)[0], entries: row.count })),
      sampledBucketUpperBound: charge, id: cacheKey, authority: 'retrieval-candidate-cut-not-proof' });
    if (state.candidates.size >= MAX_CACHE) state.candidates.delete(state.candidates.keys().next().value);
    state.candidates.set(cacheKey, cut);
  }
  const selectedIds = cut.selected.map(index => ready.ids[index]);
  const records = await readRecords(selectedIds, { revision, work });
  if (!current() || ready !== state.ready) contractFail('knowledge-index-query-stale');
  for (let i = 0; i < records.length; i++) {
    work.charge('workUnits');
    if (records[i].id !== selectedIds[i] || digest(records[i].fingerprint) !== ready.fingerprints[cut.selected[i]]) contractFail('knowledge-index-record-drift');
  }
  return { records, revision, continuation: null, visited: ready.visited, truncated: true, scopeId, isCurrent: current,
    retrieval: { schema: VERSION, algorithm: 'existing-FunctionMatchIndex/coarseTokens', featureVersion: FUNCTION_FINGERPRINT_VERSION,
      maximumRecords, indexed: ready.ids.length, scanned: ready.visited, completeDatabaseScan: ready.complete,
      unread: ready.unread, unreadExamples: ready.unreadExamples, buckets: cut.buckets,
      sampledBucketUpperBound: reused ? 0 : cut.sampledBucketUpperBound, indexBuilt: built, candidateCutReused: reused,
      candidateCutId: cut.id, referenceUniverseClosed: false, recallAtK: null, exactIdentity: false,
      reason: 'bounded-hierarchical-feature-retrieval; not-exhaustive-semantic-equivalence', buildPages: built ? ready.pages : 0 } };
}
