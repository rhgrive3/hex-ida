import { bindCapturedAsyncEvents } from '../../runtime/captured-async.js';
/** Query-scoped ordering of ALREADY supplied events. A versioned host contract
 * is a premise, not a Swift/runtime implementation proof. Same actor, executor,
 * wall-clock time, or token text alone NEVER creates a happens-before edge.
 * No event capture, task execution, lifetime mutation or instrumentation here.
 */
import { snapshotContractData, recordFields, exactString, exactInteger, contractFail } from '../../core/identity/structured.js';
import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';

export const ASYNC_EVENT_SCHEMA = 'scpa-async-events/v1';
export const ASYNC_LIMITS = Object.freeze({ events: 512, edges: 2048, contracts: 32, depth: 128, bytes: 1048576 });
const RULES = Object.freeze({ 'task-spawn': ['spawn', 'task-start'], 'task-join': ['task-end', 'join'],
  'continuation-resume': ['resume', 'continuation-start'], 'queue-delivery': ['enqueue', 'dequeue'] });
const EVENT_KINDS = new Set(['spawn', 'task-start', 'task-end', 'join', 'resume', 'continuation-start', 'enqueue', 'dequeue',
  'allocate', 'use', 'dispose', 'other']);
const exactRef = (value, name) => exactString(value, name, 256);
function references(values, code) {
  if (!Array.isArray(values) || !values.length || values.length > 32) contractFail(code);
  values.forEach(v => exactRef(v, code));
  if (new Set(values).size !== values.length) contractFail(code);
}
function event(v) {
  recordFields(v, ['id', 'kind', 'strandId', 'sequence', 'taskId', 'actorId', 'executorId', 'token', 'objectId', 'objectGeneration', 'sourceReferences'], 'async-event-fields');
  exactRef(v.id, 'async-event-id');
  if (!EVENT_KINDS.has(v.kind)) contractFail('async-event-kind');
  for (const key of ['strandId', 'taskId', 'actorId', 'executorId', 'token', 'objectId', 'objectGeneration']) {
    if (v[key] != null) exactRef(v[key], `async-event-${key}`);
  }
  if (v.sequence != null) exactInteger(v.sequence, 'async-sequence', { min: 0, max: Number.MAX_SAFE_INTEGER });
  if ((v.objectId == null) !== (v.objectGeneration == null)) contractFail('async-object-generation-required');
  references(v.sourceReferences, 'async-event-source');
  return v;
}
const ruleMatches = (kind, a, b) => {
  if (kind === 'sequenced-before') return a.strandId != null && a.strandId === b.strandId
    && Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence) && a.sequence < b.sequence;
  const kinds = RULES[kind];
  if (!kinds || a.kind !== kinds[0] || b.kind !== kinds[1] || !a.token || a.token !== b.token) return false;
  // Tokens are scoped by a concrete generation. Equal textual tokens from a
  // recycled continuation/task must not link two different instances.
  return a.objectId != null && a.objectId === b.objectId && a.objectGeneration === b.objectGeneration;
};
async function path(from, to, graph, maximumDepth, work) {
  const queue = [from], parent = new Map([[from, null]]), depth = new Map([[from, 0]]);
  let cut = false;
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]; work.charge('workUnits');
    if (id === to) {
      const nodes = [], edges = []; let at = id;
      while (at !== null) { nodes.push(at); const p = parent.get(at); if (p) edges.push(p.edge); at = p?.from ?? null; }
      return { found: true, nodes: nodes.reverse(), edges: edges.reverse(), cut };
    }
    for (const edge of graph.get(id) ?? []) {
      work.charge('workUnits');
      if (parent.has(edge.to)) continue;
      if (depth.get(id) >= maximumDepth) { cut = true; continue; }
      parent.set(edge.to, { from: id, edge }); depth.set(edge.to, depth.get(id) + 1); queue.push(edge.to);
    }
    await work.yieldIfNeeded();
  }
  return { found: false, nodes: [], edges: [], cut };
}

export async function checkAsyncEventOrder(source, request, { work } = {}) {
  assertScopedAnalysisWork(work); work.checkpoint();
  const input = snapshotContractData(source, { maxBytes: ASYNC_LIMITS.bytes, maxNodes: 32768 });
  const query = snapshotContractData(request, { maxBytes: 8192, maxNodes: 128 });
  recordFields(input, ['schema', 'events', 'relations', 'contracts', 'remaining'], 'async-source-fields');
  recordFields(query, ['fromEventId', 'toEventId', 'maximumDepth', 'lifetime'], 'async-order-query-fields');
  exactRef(query.fromEventId, 'async-from'); exactRef(query.toEventId, 'async-to');
  const maxDepth = exactInteger(query.maximumDepth ?? 64, 'async-depth', { min: 1, max: ASYNC_LIMITS.depth });
  if (input.schema !== ASYNC_EVENT_SCHEMA || !Array.isArray(input.events) || input.events.length > ASYNC_LIMITS.events
    || !Array.isArray(input.relations) || input.relations.length > ASYNC_LIMITS.edges || !Array.isArray(input.contracts)
    || input.contracts.length > ASYNC_LIMITS.contracts || !Array.isArray(input.remaining) || input.remaining.length > 128) contractFail('async-source-budget-or-schema');
  input.remaining.forEach(v => exactRef(v, 'async-source-remaining'));
  work.charge('residentBytes', stableStringify(input).length * 2);
  const events = new Map(), contracts = new Map(), remaining = new Set(input.remaining), graph = new Map(), degrees = new Map();
  const ambiguousSequences = new Set(), sequences = new Set();
  for (const raw of input.events) {
    work.charge('workUnits'); const v = event(raw);
    if (events.has(v.id)) contractFail('async-duplicate-event');
    events.set(v.id, v); graph.set(v.id, []); degrees.set(v.id, 0);
    if (v.strandId != null && v.sequence != null) {
      const key = stableStringify([v.strandId, v.sequence]);
      if (sequences.has(key)) ambiguousSequences.add(v.strandId); sequences.add(key);
    }
  }
  for (const c of input.contracts) {
    recordFields(c, ['id', 'version', 'rule', 'sourceReferences'], 'async-contract-fields');
    exactRef(c.id, 'async-contract-id'); exactRef(c.version, 'async-contract-version'); exactRef(c.rule, 'async-contract-rule'); references(c.sourceReferences, 'async-contract-source');
    if (contracts.has(c.id)) contractFail('async-duplicate-contract');
    contracts.set(c.id, c);
  }
  // A one-use operation cannot acquire two competing partners by arrival order.
  const tokenCounts = new Map();
  for (const e of events.values()) if (e.token && e.objectId) {
    const key = stableStringify([e.kind, e.token, e.objectId, e.objectGeneration]);
    tokenCounts.set(key, (tokenCounts.get(key) ?? 0) + 1);
  }
  const ids = new Set(); let retainedEdges = 0;
  for (const r of input.relations) {
    work.charge('workUnits');
    recordFields(r, ['id', 'from', 'to', 'contractId', 'contractVersion', 'sourceReferences'], 'async-relation-fields');
    for (const key of ['id', 'from', 'to', 'contractId', 'contractVersion']) exactRef(r[key], `async-relation-${key}`);
    references(r.sourceReferences, 'async-relation-source');
    if (ids.has(r.id)) contractFail('async-duplicate-relation'); ids.add(r.id);
    const a = events.get(r.from), b = events.get(r.to), c = contracts.get(r.contractId);
    let reason = !a || !b ? 'event-outside-selected-scope' : !c || c.version !== r.contractVersion ? 'library-contract-version-unbound'
      : !ruleMatches(c.rule, a, b) ? 'event-rule-premises-unproved'
      : c.rule === 'sequenced-before' && ambiguousSequences.has(a.strandId) ? 'ambiguous-strand-sequence'
      : c.rule !== 'sequenced-before' && [a, b].some(e => tokenCounts.get(stableStringify([e.kind, e.token, e.objectId, e.objectGeneration])) !== 1)
        ? 'ambiguous-one-use-token' : null;
    if (reason) remaining.add(`${r.id}:${reason}`);
    else { graph.get(a.id).push({ ...r, rule: c.rule }); degrees.set(b.id, degrees.get(b.id) + 1); retainedEdges++; }
    await work.yieldIfNeeded();
  }
  // Reject cycles before path answers. A contradiction in an omitted branch
  // cannot be hidden by returning the first attractive path.
  const ready = [...degrees].filter(([, n]) => n === 0).map(([id]) => id); let visited = 0;
  for (let at = 0; at < ready.length; at++) {
    visited++; for (const edge of graph.get(ready[at])) {
      work.charge('workUnits'); const n = degrees.get(edge.to) - 1; degrees.set(edge.to, n); if (!n) ready.push(edge.to);
    }
    await work.yieldIfNeeded();
  }
  const consistent = visited === events.size;
  if (!consistent) remaining.add('event-order-cycle');
  let relation = 'unknown', witness = null;
  if (!events.has(query.fromEventId) || !events.has(query.toEventId)) remaining.add('query-event-outside-selected-scope');
  else if (consistent) {
    if (query.fromEventId === query.toEventId) relation = 'same-event';
    else {
      const forward = await path(query.fromEventId, query.toEventId, graph, maxDepth, work);
      if (forward.found) { relation = 'before-in-model'; witness = forward; }
      else {
        const backward = await path(query.toEventId, query.fromEventId, graph, maxDepth, work);
        if (backward.found) { relation = 'after-in-model'; witness = backward; }
        if (forward.cut || backward.cut) remaining.add('query-depth-cut');
      }
    }
  }
  let lifetime = null;
  if (query.lifetime !== undefined) {
    const l = query.lifetime; recordFields(l, ['objectId', 'objectGeneration', 'useEventId'], 'async-lifetime-fields');
    for (const key of ['objectId', 'objectGeneration', 'useEventId']) exactRef(l[key], `async-lifetime-${key}`);
    const use = events.get(l.useEventId), matching = [...events.values()].filter(e => e.objectId === l.objectId && e.objectGeneration === l.objectGeneration);
    const alloc = matching.filter(e => e.kind === 'allocate'), ends = matching.filter(e => e.kind === 'dispose');
    lifetime = { objectId: l.objectId, objectGeneration: l.objectGeneration, useEventId: l.useEventId, relation: 'unknown', lifetimeProven: false };
    if (consistent && use?.kind === 'use' && matching.includes(use) && alloc.length === 1 && ends.length === 1) {
      const started = await path(alloc[0].id, use.id, graph, maxDepth, work), ended = await path(use.id, ends[0].id, graph, maxDepth, work);
      const afterEnd = await path(ends[0].id, use.id, graph, maxDepth, work);
      lifetime = { ...lifetime, relation: started.found && ended.found ? 'between-captured-boundaries-in-model' : afterEnd.found ? 'after-captured-end-in-model' : 'unknown',
        paths: { allocationToUse: started, useToEnd: ended, endToUse: afterEnd } };
    } else remaining.add('lifetime-instance-or-boundaries-open');
  }
  work.checkpoint();
  return deepFreeze({ schema: 'scpa-async-order/v1', status: 'completed', consistent, relation, witness, lifetime,
    counts: { events: events.size, requestedEdges: input.relations.length, retainedEdges, rejectedEdges: input.relations.length - retainedEdges },
    remaining: [...remaining, 'library-contract-adequacy-unproved', 'capture-completeness-and-natural-reachability-unproved', 'static-universal-order-not-established'],
    exact: false, semanticProof: false, staticHappensBeforeProven: false, runtimeExecutionRequested: false, canonicalTruthChanged: false });
}

export async function queryAsyncEventOrder(request, { world, assumptions, snapshotId, work, getContext, getRuntimeContext = null, isCurrent } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  const input = snapshotContractData(request, { maxBytes: 8192, maxNodes: 128 });
  recordFields(input, ['runtimeSessionId', 'fromEventId', 'toEventId', 'maximumDepth', 'lifetime'], 'async-query-fields');
  exactRef(input.runtimeSessionId, 'async-runtime-session');
  if (typeof getContext !== 'function') return { status: 'unsupported', reason: 'current-async-event-owner-required', exact: false };
  const context = await work.await(signal => getContext(input.runtimeSessionId, { world, assumptions, snapshotId, signal, work }));
  if (context == null || context.status === 'unsupported') {
    work.checkpoint(); if (isCurrent?.() !== true) contractFail('async-owner-stale');
    return deepFreeze({ status: 'unsupported', reason: context == null ? 'current-async-event-owner-unavailable'
      : exactRef(context.reason, 'async-owner-unavailable-reason'), relation: 'unknown', exact: false,
      runtimeExecutionRequested: false, semanticProof: false, staticHappensBeforeProven: false, canonicalTruthChanged: false });
  }
  const current = () => isCurrent?.() === true && context?.isCurrent?.() === true;
  work.checkpoint(); if (!current()) contractFail('async-owner-stale');
  const binding = snapshotContractData(context.binding, { maxBytes: 8192, maxNodes: 128 });
  recordFields(binding, ['worldId', 'assumptionsId', 'snapshotId', 'runtimeSessionId', 'epoch', 'moduleGeneration', 'ownerRevision'], 'async-binding-fields');
  if (binding.worldId !== world.id || binding.assumptionsId !== assumptions.id || binding.snapshotId !== snapshotId
    || binding.runtimeSessionId !== input.runtimeSessionId) contractFail('async-owner-binding');
  exactInteger(binding.epoch, 'async-epoch', { min: 0, max: Number.MAX_SAFE_INTEGER });
  exactRef(binding.moduleGeneration, 'async-module-generation'); exactRef(binding.ownerRevision, 'async-owner-revision');
  const { runtimeSessionId: _session, ...query } = input;
  const source = snapshotContractData(context.source, { maxBytes: ASYNC_LIMITS.bytes, maxNodes: 32768 });
  const captured = context.runtimeCapture == null ? null : await bindCapturedAsyncEvents(context.runtimeCapture, source, binding,
    { world, assumptions, snapshotId, work, getContext: getRuntimeContext, isCurrent: current });
  work.checkpoint(); if (!current()) contractFail('async-owner-stale-before-publication');
  if (captured && captured.status !== 'bound') return deepFreeze({ status: 'unknown', reason: 'captured-async-source-not-fully-bound',
    binding, captured, relation: 'unknown', witness: null, lifetime: null, exact: false, semanticProof: false,
    staticHappensBeforeProven: false, runtimeExecutionRequested: false, canonicalTruthChanged: false, defaultActivation: false, releaseQualified: false });
  const value = await checkAsyncEventOrder(source, query, { work });
  work.checkpoint(); if (!current()) contractFail('async-owner-stale-before-publication');
  return deepFreeze({ ...value, binding, captured, defaultActivation: false, releaseQualified: false });
}
