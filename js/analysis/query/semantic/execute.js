/** Bounded restartable query execution over disposable canonical projections. */
import { ResourceBudget } from '../../../core/budgets/index.js';
import { ScopedAnalysisWork, normalizeQueryLimits, workStopStatus } from '../../../core/budgets/scoped-work.js';
import { createEntityId, deepFreeze } from '../../../core/identity/index.js';
import { snapshotContractData, exactInteger, exactString, compareIdentity, contractFail } from '../../../core/identity/structured.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { assertSemanticQueryPlan, evaluateSemanticQueryPlan } from './plan.js';
import { assertCanonicalQueryProjection } from './projection.js';
import { ScopedInterproceduralProjectionBuilder } from './interprocedural.js';

export const SEMANTIC_QUERY_RESULT_SCHEMA = 'semantic-query-result/v1';
const TOTAL_DEFAULTS = Object.freeze({ workUnits: 1000000, bytesRead: 64 * 1024 * 1024, residentBytes: 64 * 1024 * 1024,
  artifactsMaterialized: 1024, pagesFetched: 4096, queueOperations: 1000000, nodes: 131072, edges: 524288,
  results: 1024, calls: 4096, deadlineMs: 1000, yieldEvery: 256 });
const SESSIONS = new WeakSet();

class QueryFrontier {
  #rows = new Map(); #overflow = 0;
  add(reason, { functionId = null, entityId = null, detail = null } = {}) {
    exactString(reason, 'semantic-frontier-reason');
    const key = `${functionId ?? ''}\u0000${reason}`;
    let entry = this.#rows.get(key);
    if (!entry) {
      if (this.#rows.size >= 1024) { this.#overflow++; return; }
      entry = { reason, functionId, count: 0, samples: [] }; this.#rows.set(key, entry);
    }
    entry.count++;
    if (entry.samples.length < 4 && (entityId !== null || detail !== null)) entry.samples.push({ entityId, detail });
  }
  view() {
    return deepFreeze({ entries: [...this.#rows.values()].map((row) => ({ ...row, samples: row.samples.map((sample) => ({ ...sample })) })).sort((a, b) => compareIdentity(a.functionId ?? '', b.functionId ?? '') || compareIdentity(a.reason, b.reason)),
      omittedEntries: this.#overflow, closed: false });
  }
}

/**
 * Non-authoritative work state: one local function projection, or an explicitly
 * requested <=16-function reference scope, is retained. Prior function results contain versioned references; they are not a private
 * replacement of the program's Semantic IR, summaries, or EvidenceGraph.
 */
export class SemanticQueryExecution {
  #plan; #world; #assumptions; #load; #current; #ledger; #controller = new AbortController();
  #id; #frontier = new QueryFrontier(); #functionIndex = 0; #projection = null;
  #scan = 0; #sources = []; #sourceIndex = 0; #search = null; #phase = 'load';
  #busy = false; #closed = false; #steps = 0; #totalResults = 0; #totalPaths = 0;
  #maximumSteps; #seenFunctions = []; #terminalReason = null; #retainedBytes = 0;
  #scopeBuilder; #sinkMatches = new Map(); #onResult; #parentBudget;

  constructor({ plan, world, assumptions, loadProjection, isCurrent, totalLimits = {}, maximumSteps = 128, scopeBuilder = null, parentBudget = null, onResult = null } = {}) {
    assertWorldScope(world); assertAssumptionSet(assumptions, world); assertSemanticQueryPlan(plan, world, assumptions);
    if (typeof loadProjection !== 'function' || typeof isCurrent !== 'function') contractFail('semantic-execution-host-capabilities');
    if (scopeBuilder !== null && !(scopeBuilder instanceof ScopedInterproceduralProjectionBuilder)) contractFail('semantic-query-scope-builder');
    if (parentBudget !== null && !(parentBudget instanceof ResourceBudget) || onResult !== null && typeof onResult !== 'function') contractFail('semantic-query-parent-or-result-hook');
    this.#onResult = onResult; this.#parentBudget = parentBudget;
    this.#scopeBuilder = scopeBuilder;
    this.#maximumSteps = exactInteger(maximumSteps, 'semantic-execution-step-cap', { min: 1, max: 512 });
    this.#world = world; this.#assumptions = assumptions; this.#plan = plan; this.#load = loadProjection; this.#current = isCurrent;
    const limits = normalizeQueryLimits({ ...TOTAL_DEFAULTS, ...snapshotContractData(totalLimits) });
    const resources = Object.fromEntries(Object.entries(limits).filter(([key]) => !['deadlineMs', 'yieldEvery'].includes(key)));
    this.#ledger = new ResourceBudget(resources, { name: `semantic-query-session.${parentBudget?.children.size ?? 0}`, parent: parentBudget, signal: this.#controller.signal });
    if (!globalThis.crypto?.getRandomValues) contractFail('semantic-query-session-random-required');
    const nonce = [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map((n) => n.toString(16).padStart(8, '0')).join('');
    this.#id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: 'semantic-query-execution', identity: { planId: plan.id, nonce } });
    for (const requirement of plan.requirements) {
      if (requirement === 'bound-interprocedural-flow-summaries' && !scopeBuilder) this.#frontier.add('interprocedural-flow-owner-not-bound');
    }
    SESSIONS.add(this);
  }
  get id() { return this.#id; }
  get planId() { return this.#plan.id; }
  get worldId() { return this.#world.id; }
  get assumptionsId() { return this.#assumptions.id; }
  get done() { return this.#phase === 'done' || this.#closed; }
  #assertCurrent() {
    if (this.#closed) contractFail('semantic-query-session-closed');
    if (this.#current() !== true || this.#scopeBuilder && !this.#scopeBuilder.isCurrent()) { this.close('stale'); contractFail('semantic-query-world-stale'); }
  }
  #releaseProjection() {
    this.#projection?.release(); this.#projection = null; this.#retainedBytes = 0;
    this.#scan = 0; this.#sources = []; this.#sourceIndex = 0; this.#search = null; this.#sinkMatches.clear();
  }
  #nextFunction() {
    this.#releaseProjection();
    this.#functionIndex = this.#scopeBuilder ? this.#plan.query.scope.functionIds.length : this.#functionIndex + 1;
    this.#phase = this.#functionIndex >= this.#plan.query.scope.functionIds.length ? 'done' : 'load';
  }
  #finishLimited(reason) {
    this.#frontier.add(reason); this.#terminalReason = reason;
    this.#releaseProjection(); this.#phase = 'done';
  }
  async #emitRecord(record, results, work) {
    work.charge('results'); work.charge('residentBytes', 768);
    const value = this.#projection.present(record.id, this.#plan.query.projection);
    const safe = snapshotContractData(value, { allowBigInt: true, maxBytes: 262144, maxNodes: 8192 });
    const row = { kind: 'record-match', value: safe, certainty: 'canonical-field-match', executionFeasibility: 'not-checked' };
    const enriched = this.#onResult ? await this.#onResult(row, { projection: this.#projection, work }) : row;
    work.checkpoint(); this.#assertCurrent(); results.push(enriched);
    this.#totalResults++;
  }
  #pathFilter(record, startWaypoint, work) {
    const flow = this.#plan.query.flow, origin = this.#projection.origin(record.id);
    if (flow.avoid) {
      const excluded = evaluateSemanticQueryPlan(this.#plan, 'avoid', record, { work, origin });
      if (excluded === null) this.#frontier.add('path-exclusion-selector-unknown', { functionId: record.functionId, entityId: record.entityId });
      if (excluded !== false) return null;
    }
    let waypoint = startWaypoint;
    while (waypoint < flow.via.length) {
      const matches = evaluateSemanticQueryPlan(this.#plan, 'waypoint', record, { work, waypoint, origin });
      if (matches === null) this.#frontier.add('path-waypoint-selector-unknown', { functionId: record.functionId,
        entityId: record.entityId, detail: `waypoint:${waypoint}` });
      if (matches !== true) break;
      waypoint++;
    }
    return waypoint;
  }
  #visitKey(nodeId, context, waypoint) { return JSON.stringify([nodeId, context, waypoint]); }
  #startSearch(work) {
    const root = this.#sources[this.#sourceIndex], waypoint = this.#pathFilter(this.#projection.record(root), 0, work);
    const initial = { nodeId: root, parent: -1, edgeId: null, depth: 0, context: [], waypoint };
    this.#search = { root, queue: waypoint === null ? [] : [initial], cursor: 0,
      visited: new Set(waypoint === null ? [] : [this.#visitKey(root, [], waypoint)]), emittedSinks: new Set() };
  }
  async #emitPath(index, results, work) {
    const chain = [], edgeIds = [], waypointStates = [];
    let position = index;
    while (position >= 0) {
      const state = this.#search.queue[position];
      chain.push(state.nodeId); waypointStates.push(state.waypoint); if (state.edgeId) edgeIds.push(state.edgeId);
      position = state.parent;
      if (chain.length > this.#plan.query.flow.maxDepth + 1) contractFail('semantic-query-path-parent-cycle');
    }
    chain.reverse(); edgeIds.reverse(); waypointStates.reverse();
    work.charge('results'); work.charge('residentBytes', chain.length * 768 + edgeIds.length * 512);
    const edges = edgeIds.map((id) => this.#projection.edge(id));
    const vertices = chain.map((id) => this.#projection.present(id, this.#plan.query.projection));
    const value = { kind: 'possible-flow', direction: this.#plan.query.flow.direction, projectionId: this.#projection.id, source: chain[0], sink: chain.at(-1),
      vertices, edges: this.#plan.query.projection.includeWitnesses ? edges : edges.map(({ id, from, to, kind }) => ({ id, from, to, kind })),
      remaining: [...new Set(['path-feasibility', ...edges.flatMap((edge) => edge.obligations)])].sort(compareIdentity),
      certainty: 'possible-dependence', executablePathProven: false, exact: false,
      ...((this.#plan.query.flow.via.length || this.#plan.query.flow.avoid) ? { pathFilter: {
        semantics: 'ordered-in-traversal-direction; repeated-waypoints-may-share-a-vertex',
        authority: 'dependency-navigation-only; not-a-sanitization-or-executable-path-proof',
        waypointWitnesses: this.#plan.query.flow.via.map((_selector, index) => ({ index,
          vertex: chain[waypointStates.findIndex((completed) => completed > index)] })),
        exclusionChecked: this.#plan.query.flow.avoid !== null,
      } } : {}) };
    const row = snapshotContractData(value, { allowBigInt: true, maxBytes: 2 * 1024 * 1024, maxNodes: 65536 });
    const enriched = this.#onResult ? await this.#onResult(row, { projection: this.#projection, work }) : row;
    work.checkpoint(); this.#assertCurrent(); results.push(enriched);
    this.#totalPaths++; this.#totalResults++;
  }
  #transitionContext(context, edge, record) {
    if (!edge.boundary) return context;
    const direction = this.#plan.query.flow.direction;
    const entering = direction === 'forward' ? edge.boundary.direction === 'enter' : edge.boundary.direction === 'return';
    if (entering) {
      if (context.length >= this.#plan.query.flow.maxCallDepth) {
        this.#frontier.add('call-context-depth-cut', { functionId: record.functionId, entityId: record.entityId }); return null;
      }
      return [...context, edge.boundary.callSite];
    }
    if (!context.length) {
      // A source inside a callee has no known caller context. Never invent one
      // and accidentally return into every callsite that happens to share it.
      this.#frontier.add('unmatched-initial-caller-context', { functionId: record.functionId, entityId: record.entityId }); return null;
    }
    if (context.at(-1) !== edge.boundary.callSite) return null;
    return context.slice(0, -1);
  }
  async #searchOne(work, results) {
    if (!this.#search) this.#startSearch(work);
    const search = this.#search, flow = this.#plan.query.flow;
    if (search.cursor >= search.queue.length) {
      this.#sourceIndex++; this.#search = null;
      if (this.#sourceIndex >= this.#sources.length) this.#nextFunction();
      return;
    }
    work.charge('workUnits'); work.charge('queueOperations');
    const position = search.cursor, state = search.queue[position], record = this.#projection.record(state.nodeId);
    if (!this.#sinkMatches.has(record.id)) this.#sinkMatches.set(record.id,
      evaluateSemanticQueryPlan(this.#plan, 'sink', record, { work, origin: this.#projection.origin(record.id) }));
    const isSink = this.#sinkMatches.get(record.id);
    if (isSink === null) this.#frontier.add('sink-selector-unknown', { functionId: record.functionId, entityId: record.entityId });
    if (isSink === true && state.waypoint === flow.via.length && !search.emittedSinks.has(record.id)) {
      await this.#emitPath(position, results, work); search.emittedSinks.add(record.id);
      if (this.#totalPaths >= flow.maxPaths || this.#totalResults >= this.#plan.query.resultLimit) { this.#finishLimited('path-result-limit'); return; }
    }
    const adjacent = this.#projection.adjacent(record.id, flow.direction);
    if (state.depth >= flow.maxDepth) {
      if (adjacent.some((id) => flow.edgeKinds.includes(this.#projection.edge(id).kind))) this.#frontier.add('flow-depth-cut', { functionId: record.functionId, entityId: record.entityId });
      search.cursor++; return;
    }
    // Keep a per-node edge position so a deadline never drops the unvisited
    // suffix of a high-fanout adjacency list on resume.
    state.edgePosition ??= 0;
    while (state.edgePosition < adjacent.length) {
      work.charge('workUnits'); work.charge('edges');
      const edge = this.#projection.edge(adjacent[state.edgePosition]);
      if (flow.edgeKinds.includes(edge.kind)) {
        const target = flow.direction === 'forward' ? edge.to : edge.from;
        const context = this.#transitionContext(state.context, edge, record);
        if (context !== null) {
          const waypoint = this.#pathFilter(this.#projection.record(target), state.waypoint, work);
          const visitKey = this.#visitKey(target, context, waypoint);
          if (waypoint !== null && !search.visited.has(visitKey)) {
            work.charge('queueOperations'); work.charge('residentBytes', 176 + context.length * 128);
            search.visited.add(visitKey); search.queue.push({ nodeId: target, parent: position, edgeId: edge.id,
              depth: state.depth + 1, context, waypoint });
          }
        }
      }
      state.edgePosition++;
      await work.yieldIfNeeded();
    }
    search.cursor++;
  }
  /** A step has a finite deadline; total counters cannot reset between steps. */
  async step({ signal = null, limits = {}, maximumFunctions = 4 } = {}) {
    exactInteger(maximumFunctions, 'semantic-query-step-functions', { min: 1, max: 64 });
    if (this.#busy) contractFail('semantic-query-concurrent-resume');
    this.#assertCurrent();
    const work = new ScopedAnalysisWork({ limits, parentBudget: this.#ledger, signal, name: 'query-step' });
    this.#busy = true;
    const results = [], startFunction = this.#functionIndex;
    let executionStatus = 'paused';
    try {
      if (++this.#steps > this.#maximumSteps) { this.#finishLimited('session-step-limit'); executionStatus = 'budget-exhausted'; }
      // Resident accounting is intentionally conservative allocation accounting,
      // not a claim that it measures JavaScript engine peak RSS.
      if (this.#retainedBytes) work.charge('residentBytes', this.#retainedBytes);
      while (!this.done && this.#functionIndex - startFunction < maximumFunctions) {
        work.checkpoint(); this.#assertCurrent();
        if (this.#phase === 'load') {
          const locator = this.#plan.query.scope.functionIds[this.#functionIndex];
          work.charge('artifactsMaterialized');
          const loaded = await work.await((providerSignal) => this.#scopeBuilder
            ? this.#scopeBuilder.advance({ work })
            : this.#load(locator, { world: this.#world, assumptions: this.#assumptions, plan: this.#plan, work, signal: providerSignal }));
          this.#assertCurrent();
          if (loaded?.pending === true) break;
          if (!loaded?.projection) {
            this.#frontier.add(loaded?.reason ?? 'function-projection-unavailable', { functionId: locator });
            this.#nextFunction(); continue;
          }
          this.#projection = assertCanonicalQueryProjection(loaded.projection, { world: this.#world, assumptions: this.#assumptions });
          this.#retainedBytes = this.#projection.size * 512 + this.#projection.edgeCount * 384;
          if (loaded.composite) this.#seenFunctions.push(...loaded.members);
          else this.#seenFunctions.push({ locator, functionId: this.#projection.functionId, projectionId: this.#projection.id,
            producerArtifactId: this.#projection.inputIdentity.producerArtifactId, ownerContentDigests: this.#projection.inputIdentity.ownerDigests });
          for (const gap of this.#projection.frontier) this.#frontier.add(gap.reason, { functionId: gap.functionId ?? this.#projection.functionId, entityId: gap.entityId ?? null });
          this.#phase = 'scan';
        } else if (this.#phase === 'scan') {
          if (this.#scan >= this.#projection.size) {
            if (!this.#plan.query.flow || !this.#sources.length) this.#nextFunction();
            else this.#phase = 'flow';
            continue;
          }
          work.charge('workUnits');
          const record = this.#projection.recordAt(this.#scan);
          const match = evaluateSemanticQueryPlan(this.#plan, 'select', record, { work, origin: this.#projection.origin(record.id) });
          if (match === null) this.#frontier.add('source-selector-unknown', { functionId: record.functionId, entityId: record.entityId });
          if (match === true) {
            if (this.#plan.query.flow) {
              if (this.#sources.length < 256) this.#sources.push(record.id);
              else this.#frontier.add('flow-source-budget', { functionId: record.functionId });
            } else {
              await this.#emitRecord(record, results, work);
              if (this.#totalResults >= this.#plan.query.resultLimit) { this.#finishLimited('record-result-limit'); break; }
            }
          }
          this.#scan++;
        } else if (this.#phase === 'flow') await this.#searchOne(work, results);
        await work.yieldIfNeeded();
      }
      executionStatus = this.done ? this.#terminalReason ?? 'completed' : 'paused';
    } catch (error) {
      if (error?.code === 'semantic-query-world-stale' || error?.code === 'interprocedural-scope-stale' || error?.message === 'semantic-query-world-stale') executionStatus = 'stale';
      else {
        const stopped = workStopStatus(error, work.signal);
        if (!stopped) throw error;
        executionStatus = stopped;
        this.#frontier.add(stopped, { functionId: this.#plan.query.scope.functionIds[this.#functionIndex] ?? null });
        // Exhausting the total ledger cannot be fixed by resuming with a fresh
        // child deadline. Retain no unbounded zombie execution after that point.
        if (Object.keys(this.#ledger.limits).some((name) => this.#ledger.remaining(name) === 0)) this.#finishLimited('session-resource-limit');
      }
    } finally { this.#busy = false; work.dispose(); }
    const resumable = !this.done && executionStatus !== 'stale' && executionStatus !== 'cancelled';
    if (executionStatus === 'cancelled' || executionStatus === 'stale') {
      this.#totalResults -= results.length;
      this.#totalPaths -= results.filter((row) => row.kind === 'possible-flow').length;
      results.length = 0; this.close(executionStatus);
    }
    return deepFreeze({ schema: SEMANTIC_QUERY_RESULT_SCHEMA, sessionId: this.#id, planId: this.#plan.id,
      worldId: this.#world.id, assumptionsId: this.#assumptions.id, executionStatus,
      scopeMode: this.#scopeBuilder ? 'explicit-interprocedural' : 'function-local',
      completeness: this.#terminalReason ? 'truncated' : 'partial', enumerationComplete: this.done && !this.#terminalReason,
      semanticClosure: 'unknown', existence: this.#totalResults ? 'POSSIBLE' : 'UNKNOWN', exact: false,
      results, returned: results.length, totalResults: this.#totalResults, totalPaths: this.#totalPaths,
      frontier: this.#frontier.view(), functions: { completed: this.#functionIndex, requested: this.#plan.query.scope.functionIds.length, seen: (this.#scopeBuilder ? this.#scopeBuilder.seen : this.#seenFunctions).map((row) => ({ ...row })) },
      resumable, restartHint: { nextFunction: this.#functionIndex, phase: this.#phase, canonicalAuthority: false },
      cost: { step: work.cost(), total: this.#ledger.snapshot(), steps: this.#steps } });
  }
  close(reason = 'closed') {
    this.#closed = true; this.#terminalReason ??= reason; this.#releaseProjection(); this.#scopeBuilder?.close();
    if (this.#parentBudget) for (const [key, child] of this.#parentBudget.children) if (child === this.#ledger) this.#parentBudget.children.delete(key);
    if (!this.#controller.signal.aborted) this.#controller.abort(new Error(`semantic-query-${reason}`));
  }
}
export function isSemanticQueryExecution(value) { return SESSIONS.has(value); }
