/** Resumable selected-callsite navigation. No new call/ABI facts are issued. */
import { ResourceBudget } from '../../../core/budgets/index.js';
import { ScopedAnalysisWork, normalizeQueryLimits, workStopStatus } from '../../../core/budgets/scoped-work.js';
import { createEntityId, deepFreeze, stableStringify } from '../../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { snapshotContractData, recordFields, exactInteger, exactString, stringSet, contractFail } from '../../../core/identity/structured.js';
import { assertCanonicalQueryProjection } from './projection.js';
import { indexScopedFunctionEntries, scopedCallTargetRows } from './call-targets.js';

export const SCOPED_CALL_GRAPH_SCHEMA = 'scoped-call-graph/v1';
export const SCOPED_CALL_GRAPH_LIMITS = Object.freeze({ functions: 16, results: 512, targets: 64,
  defaultPageCallsites: 16, maximumPageCallsites: 64, sessionSteps: 128 });
export function normalizeScopedCallGraph(value) {
  const input = snapshotContractData(value, { maxBytes: 65536, maxNodes: 1024 });
  recordFields(input, ['functionIds', 'resultLimit', 'targetLimit'], 'scoped-call-graph-fields');
  const functionIds = stringSet(input.functionIds, 'scoped-call-graph-functions', SCOPED_CALL_GRAPH_LIMITS.functions);
  if (!functionIds.length) contractFail('scoped-call-graph-empty-scope');
  return deepFreeze({ functionIds,
    resultLimit: exactInteger(input.resultLimit ?? 128, 'scoped-call-graph-result-limit', { min: 1, max: SCOPED_CALL_GRAPH_LIMITS.results }),
    targetLimit: exactInteger(input.targetLimit ?? 16, 'scoped-call-graph-target-limit', { min: 1, max: SCOPED_CALL_GRAPH_LIMITS.targets }) });
}
export class ScopedCallGraphSession {
  #query; #world; #assumptions; #snapshotId; #load; #current; #id; #ledger;
  #controller = new AbortController(); #projections = []; #members = []; #frontier = []; #omitted = 0;
  #next = 0; #scanFunction = 0; #scanRecord = 0; #index = null; #phase = 'load';
  #busy = false; #closed = false; #steps = 0; #total = 0; #terminal = null; #retained = 0;
  constructor({ query, world, assumptions, snapshotId, loadProjection, isCurrent } = {}) {
    this.#query = normalizeScopedCallGraph(query); this.#world = assertWorldScope(world);
    this.#assumptions = assertAssumptionSet(assumptions, world); this.#snapshotId = exactString(snapshotId, 'scoped-call-graph-snapshot');
    if (typeof loadProjection !== 'function' || typeof isCurrent !== 'function') contractFail('scoped-call-graph-host');
    this.#load = loadProjection; this.#current = isCurrent;
    this.#id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: SCOPED_CALL_GRAPH_SCHEMA,
      identity: { worldId: world.id, assumptionsId: assumptions.id, snapshotId, query: this.#query } });
    const limits = normalizeQueryLimits({ workUnits: 1000000, residentBytes: 64 * 1024 * 1024,
      bytesRead: 64 * 1024 * 1024, nodes: 131072, edges: 524288, results: 512,
      artifactsMaterialized: 256, pagesFetched: 4096, calls: 4096 });
    this.#ledger = new ResourceBudget(Object.fromEntries(Object.entries(limits).filter(([key]) => !['deadlineMs', 'yieldEvery'].includes(key))),
      { name: 'scoped-call-graph-session', signal: this.#controller.signal });
  }
  #check(work) {
    work.checkpoint();
    if (this.#closed) contractFail('scoped-call-graph-closed');
    if (this.#current() !== true) contractFail('scoped-call-graph-stale');
  }
  #gap(value) { if (this.#frontier.length < 256) this.#frontier.push(value); else this.#omitted++; }
  #release() {
    for (const projection of this.#projections) projection.release();
    this.#projections = []; this.#index = null; this.#retained = 0;
  }
  #finish(reason = null) { this.#terminal = reason; this.#phase = 'done'; this.#release(); }
  async step({ signal = null, limits = {}, maximumCallsites = SCOPED_CALL_GRAPH_LIMITS.defaultPageCallsites } = {}) {
    exactInteger(maximumCallsites, 'scoped-call-graph-page-limit', { min: 1, max: SCOPED_CALL_GRAPH_LIMITS.maximumPageCallsites });
    if (this.#busy || this.#closed) contractFail('scoped-call-graph-not-resumable');
    const work = new ScopedAnalysisWork({ signal, limits, parentBudget: this.#ledger, name: 'scoped-call-graph-step' });
    this.#busy = true;
    const calls = []; let executionStatus = 'paused';
    try {
      this.#check(work);
      if (++this.#steps > SCOPED_CALL_GRAPH_LIMITS.sessionSteps) this.#finish('session-step-limit');
      if (this.#retained) work.charge('residentBytes', this.#retained);
      if (this.#phase === 'load' && this.#next < this.#query.functionIds.length) {
        const locator = this.#query.functionIds[this.#next];
        const loaded = await work.await((childSignal) => this.#load(locator, { signal: childSignal, work }));
        let retained = false;
        try {
          this.#check(work);
          if (!loaded?.projection) this.#gap({ locator, reason: loaded?.reason ?? 'canonical-function-unavailable' });
          else {
            const projection = assertCanonicalQueryProjection(loaded.projection, { world: this.#world, assumptions: this.#assumptions });
            if (projection.inputIdentity.snapshotId !== this.#snapshotId || this.#members.some((member) => member.functionId === projection.functionId)) contractFail('scoped-call-graph-member-binding');
            this.#members.push({ locator, functionId: projection.functionId, projectionId: projection.id, inputIdentity: projection.inputIdentity });
            this.#projections.push(projection); retained = true;
            this.#retained += projection.size * 192 + projection.edgeCount * 96;
            for (const gap of projection.frontier) this.#gap({ functionId: projection.functionId, ...gap });
          }
          this.#next++;
        } finally { if (!retained) loaded?.projection?.release(); }
        if (this.#next >= this.#query.functionIds.length) this.#phase = 'scan';
      } else if (this.#phase === 'scan') {
        this.#index ??= indexScopedFunctionEntries(this.#projections);
        while (this.#scanFunction < this.#projections.length && calls.length < maximumCallsites) {
          this.#check(work);
          const projection = this.#projections[this.#scanFunction];
          if (this.#scanRecord >= projection.size) { this.#scanRecord = 0; this.#scanFunction++; continue; }
          work.charge('workUnits');
          const record = projection.recordAt(this.#scanRecord);
          if (record.owner === 'semantic-ir' && projection.source(record.id)?.call) {
            const node = projection.source(record.id), targets = []; let truncated = false;
            for (const target of scopedCallTargetRows(projection, node, this.#index)) {
              work.charge('workUnits');
              if (targets.length >= this.#query.targetLimit) { truncated = true; break; }
              targets.push(target);
            }
            const row = snapshotContractData({ callerFunctionId: projection.functionId, callSiteId: node.id,
              reference: record.reference, targets, targetsTruncated: truncated, exact: false,
              remaining: ['target-execution-feasibility', 'call-target-set-closure', 'abi-port-and-memory-effects',
                ...(truncated ? ['per-call-target-limit'] : [])] }, { allowBigInt: true, maxBytes: 1024 * 1024, maxNodes: 32768 });
            // A stopped step retries the current site, not earlier delivered rows.
            work.charge('residentBytes', stableStringify(row).length * 2 + 128); work.charge('results');
            calls.push(row); this.#total++;
            if (truncated) this.#gap({ functionId: projection.functionId, entityId: node.id, reason: 'per-call-target-limit' });
          }
          this.#scanRecord++;
          if (this.#total >= this.#query.resultLimit) { this.#finish('callsite-result-limit'); break; }
          await work.yieldIfNeeded();
        }
        if (this.#phase === 'scan' && this.#scanFunction >= this.#projections.length) this.#finish();
      }
      this.#check(work);
      executionStatus = this.#phase === 'done' ? this.#terminal ?? 'completed' : 'paused';
    } catch (error) {
      const stopped = workStopStatus(error, work.signal);
      if (error?.code === 'scoped-call-graph-stale' || error?.message === 'scoped-call-graph-stale') {
        executionStatus = 'stale'; this.#total -= calls.length; calls.length = 0; this.#finish('stale');
      } else if (stopped) {
        executionStatus = stopped; this.#gap({ reason: stopped });
        if (stopped === 'cancelled') { this.#total -= calls.length; calls.length = 0; this.#finish('cancelled'); }
        else if (Object.keys(this.#ledger.limits).some((key) => this.#ledger.remaining(key) === 0)) this.#finish('session-resource-limit');
      } else { this.close('failed'); throw error; }
    } finally { this.#busy = false; work.dispose(); }
    return deepFreeze({ schema: SCOPED_CALL_GRAPH_SCHEMA, id: this.#id, worldId: this.#world.id,
      assumptionsId: this.#assumptions.id, snapshotId: this.#snapshotId, executionStatus,
      calls, returned: calls.length, totalReturned: this.#total, members: this.#members.map((member) => ({ ...member })),
      scope: this.#query, loadedFunctions: this.#next, enumerationComplete: this.#phase === 'done' && this.#terminal === null,
      frontier: { entries: [...this.#frontier], omittedEntries: this.#omitted, closed: false },
      resumable: this.#phase !== 'done', exact: false, semanticClosure: 'unknown',
      authority: 'read-only-selected-callsite-navigation; no-summary-or-negative-callgraph-proof',
      cost: { step: work.cost(), total: this.#ledger.snapshot(), steps: this.#steps } });
  }
  close(reason = 'closed') {
    if (this.#closed) return;
    this.#closed = true; this.#finish(reason);
    if (!this.#controller.signal.aborted) this.#controller.abort(new Error(`scoped-call-graph-${reason}`));
  }
}
