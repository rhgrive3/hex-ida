/** Bounded restartable query execution over disposable canonical projections. */
import { ResourceBudget } from '../../../core/budgets/index.js';
import { ScopedAnalysisWork, normalizeQueryLimits, workStopStatus } from '../../../core/budgets/scoped-work.js';
import { createEntityId, deepFreeze } from '../../../core/identity/index.js';
import { snapshotContractData, exactInteger, exactString, compareIdentity, contractFail } from '../../../core/identity/structured.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { assertSemanticQueryPlan, evaluateSemanticQueryPlan } from './plan.js';
import { assertCanonicalQueryProjection } from './projection.js';
import { ScopedInterproceduralProjectionBuilder } from './interprocedural.js';
import { flowKindMask, flowKindsFromMask, flowStateKey, transferBalancedFlow, createScopedFlowClosure } from './balanced-flow.js';

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
  #flowScopes = []; #flowSearches = []; #flowCuts = new Set(); #ownerCurrents = [];

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
      if (requirement === 'bound-interprocedural-flow-summaries' && !scopeBuilder) {
        this.#frontier.add('interprocedural-flow-owner-not-bound'); this.#flowCuts.add('interprocedural-flow-owner-not-bound');
      }
    }
    SESSIONS.add(this);
  }
  get id() { return this.#id; }
  get planId() { return this.#plan.id; }
  get worldId() { return this.#world.id; }
  get assumptionsId() { return this.#assumptions.id; }
  get done() { return this.#phase === 'done' || this.#closed; }
  #ownersCurrent() {
    return this.#current() === true && (!this.#scopeBuilder || this.#scopeBuilder.isCurrent())
      && this.#ownerCurrents.every(current => current() === true);
  }
  #assertCurrent() {
    if (this.#closed) contractFail('semantic-query-session-closed');
    if (!this.#ownersCurrent()) { this.close('stale'); contractFail('semantic-query-world-stale'); }
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
    this.#flowCuts.add(reason);
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
      if (excluded === null) this.#flowCuts.add('path-exclusion-selector-unknown');
      if (excluded !== false) return null;
    }
    let waypoint = startWaypoint;
    while (waypoint < flow.via.length) {
      const matches = evaluateSemanticQueryPlan(this.#plan, 'waypoint', record, { work, waypoint, origin });
      if (matches === null) this.#frontier.add('path-waypoint-selector-unknown', { functionId: record.functionId,
        entityId: record.entityId, detail: `waypoint:${waypoint}` });
      if (matches === null) this.#flowCuts.add('path-waypoint-selector-unknown');
      if (matches !== true) break;
      waypoint++;
    }
    return waypoint;
  }
  #startSearch(work) {
    const root = this.#sources[this.#sourceIndex], waypoint = this.#pathFilter(this.#projection.record(root), 0, work);
    const kindMask = flowKindMask(this.#plan.query.flow.flowKinds ?? undefined);
    const initial = { nodeId: root, parent: -1, edgeId: null, depth: 0, context: [], waypoint, kindMask };
    this.#search = { root, queue: waypoint === null ? [] : [initial], cursor: 0,
      visited: new Set(waypoint === null ? [] : [flowStateKey(root, [], waypoint, kindMask)]), emittedSinks: new Map(), examinedEdges: 0 };
  }
  async #emitPath(index, results, work, kindMask) {
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
      flowKinds: this.#plan.query.flow.flowKinds === null ? null : flowKindsFromMask(kindMask),
      flowKindPolicy: this.#plan.query.flow.flowKinds === null ? 'mixed-dependence-navigation' : 'homogeneous-kind-selection',
      callContext: { policy: 'balanced-callsite-prefix',
        pendingCalls: [...this.#search.queue[index].context], everyReturnMatched: true },
      vertices, edges: this.#plan.query.projection.includeWitnesses ? edges
        : edges.map(({ id, from, to, kind, flowKinds }) => ({ id, from, to, kind, ...(flowKinds ? { flowKinds } : {}) })),
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
  async #searchOne(work, results) {
    if (!this.#search) this.#startSearch(work);
    const search = this.#search, flow = this.#plan.query.flow;
    if (search.cursor >= search.queue.length) {
      if (this.#flowSearches.length < 1024) this.#flowSearches.push({ projectionId: this.#projection.id,
        source: search.root, visitedStates: search.visited.size, examinedEdges: search.examinedEdges,
        reachedSinks: [...search.emittedSinks].map(([sink, mask]) => ({ sink, flowKinds: flow.flowKinds === null ? null : flowKindsFromMask(mask) })) });
      else this.#flowCuts.add('flow-closure-source-report-budget');
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
    if (isSink === null) this.#flowCuts.add('sink-selector-unknown');
    const newKinds = state.kindMask & ~(search.emittedSinks.get(record.id) ?? 0);
    if (isSink === true && state.waypoint === flow.via.length && newKinds) {
      await this.#emitPath(position, results, work, newKinds);
      search.emittedSinks.set(record.id, (search.emittedSinks.get(record.id) ?? 0) | newKinds);
      if (this.#totalPaths >= flow.maxPaths || this.#totalResults >= this.#plan.query.resultLimit) { this.#finishLimited('path-result-limit'); return; }
    }
    const adjacent = this.#projection.adjacent(record.id, flow.direction);
    if (state.depth >= flow.maxDepth) {
      // A simultaneous path-depth and context-depth boundary is still a cut.
      // Keep the edge cursor here as well, so a small page can resume a large
      // excluded adjacency instead of rescanning it indefinitely.
      state.edgePosition ??= 0;
      while (state.edgePosition < adjacent.length) {
        work.charge('workUnits');
        const edge = this.#projection.edge(adjacent[state.edgePosition]);
        const transition = flow.edgeKinds.includes(edge.kind) ? transferBalancedFlow(state, edge, flow) : null;
        search.examinedEdges++; state.edgePosition++;
        if (transition?.cut || transition?.state) {
          const reason = transition.cut ?? 'flow-depth-cut';
          this.#frontier.add(reason, { functionId: record.functionId, entityId: record.entityId }); this.#flowCuts.add(reason);
          break;
        }
        await work.yieldIfNeeded();
      }
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
        const transition = transferBalancedFlow(state, edge, flow);
        if (transition.cut) {
          this.#frontier.add(transition.cut, { functionId: record.functionId, entityId: record.entityId });
          this.#flowCuts.add(transition.cut);
        }
        if (transition.state !== null) {
          const { context, kindMask } = transition.state;
          const waypoint = this.#pathFilter(this.#projection.record(target), state.waypoint, work);
          const visitKey = flowStateKey(target, context, waypoint, kindMask);
          if (waypoint !== null && !search.visited.has(visitKey)) {
            work.charge('queueOperations'); work.charge('residentBytes', 176 + context.length * 128);
            search.visited.add(visitKey); search.queue.push({ nodeId: target, parent: position, edgeId: edge.id,
              depth: state.depth + 1, context, waypoint, kindMask });
          }
        }
      }
      search.examinedEdges++;
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
            this.#flowCuts.add(loaded?.reason ?? 'function-projection-unavailable');
            this.#nextFunction(); continue;
          }
          this.#projection = assertCanonicalQueryProjection(loaded.projection, { world: this.#world, assumptions: this.#assumptions });
          if (loaded.isCurrent !== undefined && typeof loaded.isCurrent !== 'function') contractFail('semantic-query-owner-current-hook');
          if (loaded.isCurrent) this.#ownerCurrents.push(loaded.isCurrent);
          this.#assertCurrent();
          this.#retainedBytes = this.#projection.size * 512 + this.#projection.edgeCount * 384;
          if (this.#plan.query.flow) this.#flowScopes.push({ projectionId: this.#projection.id, inputIdentity: this.#projection.inputIdentity });
          if (loaded.composite) this.#seenFunctions.push(...loaded.members);
          else this.#seenFunctions.push({ locator, functionId: this.#projection.functionId, projectionId: this.#projection.id,
            producerArtifactId: this.#projection.inputIdentity.producerArtifactId, ownerContentDigests: this.#projection.inputIdentity.ownerDigests });
          for (const gap of this.#projection.frontier) {
            this.#frontier.add(gap.reason, { functionId: gap.functionId ?? this.#projection.functionId, entityId: gap.entityId ?? null });
            // A relation-level negative remains distinct from whole-world or
            // semantic admission, but missing owner rows/cuts still veto it.
            if (!['whole-world-closure-not-qualified', 'canonical-producer-artifact-unbound',
              'interprocedural-context-and-boundary-qualification-pending'].includes(gap.reason)) this.#flowCuts.add(gap.reason);
          }
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
          if (match === null) this.#flowCuts.add('source-selector-unknown');
          if (match === true) {
            if (this.#plan.query.flow) {
              if (this.#sources.length < 256) this.#sources.push(record.id);
              else { this.#frontier.add('flow-source-budget', { functionId: record.functionId }); this.#flowCuts.add('flow-source-budget'); }
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
    const flowClosure = this.#plan.query.flow && !this.#closed ? createScopedFlowClosure({ plan: this.#plan,
      scopes: this.#flowScopes, searches: this.#flowSearches, cuts: [...this.#flowCuts].sort(),
      enumerationComplete: this.done && !this.#terminalReason, possiblePaths: this.#totalPaths,
      isCurrent: () => this.#current() === true && this.#ownerCurrents.every(current => current() === true) }) : null;
    return deepFreeze({ schema: SEMANTIC_QUERY_RESULT_SCHEMA, sessionId: this.#id, planId: this.#plan.id,
      worldId: this.#world.id, assumptionsId: this.#assumptions.id, executionStatus,
      scopeMode: this.#scopeBuilder ? 'explicit-interprocedural' : 'function-local',
      completeness: this.#terminalReason ? 'truncated' : 'partial', enumerationComplete: this.done && !this.#terminalReason,
      semanticClosure: 'unknown', existence: this.#totalResults ? 'POSSIBLE' : 'UNKNOWN', exact: false,
      ...(flowClosure ? { flowClosure } : {}),
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
