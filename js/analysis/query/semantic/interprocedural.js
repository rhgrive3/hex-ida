/**
 * Explicit-scope, context-labelled relational composition. This is not a new
 * IR, ABI inferencer, points-to engine or executable-path solver. It borrows
 * immutable canonical projections and accepts only a first-party ABI owner's
 * scope-bound value-port projection. Native base IR without enriched call
 * arguments/targets is reported as an open cut, not silently filled in.
 */
import { assertSummarySpecialization } from '../../summary/specialization.js';
import { bindScopedFlowInputs } from '../../scoped-flow-projection.js';
import { createEntityId, deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { snapshotContractData, recordFields, exactString, exactInteger, stringSet, contractFail } from '../../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';
import { assertCanonicalQueryProjection, composeCanonicalQueryProjections } from './projection.js';
import { classifyCallTargetProof } from '../../summary/contract.js';
import { indexScopedFunctionEntries, scopedCallTargetRows, assertNativeTargetDemand } from './call-targets.js';

export const SCOPED_FLOW_INTERFACE_SCHEMA = 'canonical-function-flow-interface/v1';
export const SCOPED_INTERPROCEDURAL_VERSION = '1.3.0';
const MAX_FUNCTIONS = 16, MAX_BRIDGES = 4096, MAX_GAPS = 4096;
const sameData = (a, b) => stableStringify(a) === stableStringify(b)
  && stableStringify(lossyTypeWitness(a)) === stableStringify(lossyTypeWitness(b));

function normalizePort(raw, output, projection) {
  recordFields(raw, output ? ['index', 'valueId', 'exitNodeId', 'evidenceIds'] : ['index', 'valueId', 'evidenceIds'], 'flow-interface-port-fields');
  const index = exactInteger(raw.index, 'flow-interface-port-index', { max: output ? 15 : 63 });
  const valueId = exactString(raw.valueId, 'flow-interface-value');
  const evidenceIds = stringSet(raw.evidenceIds, 'flow-interface-evidence', 32);
  if (!evidenceIds.length) contractFail('flow-interface-port-without-evidence');
  const references = projection.valueReferenceIds(valueId);
  if (!references.length || references.length > 32) return { index, valueId, evidenceIds, status: 'unresolved', reason: 'canonical-value-reference-unavailable' };
  if (!output) {
    // A local temporary is not a parameter merely because it shares a register.
    if (references.some((id) => projection.source(id)?.kind !== 'entry')) {
      return { index, valueId, evidenceIds, status: 'unresolved', reason: 'parameter-is-not-canonical-entry-value' };
    }
    return { index, valueId, evidenceIds, references, status: 'candidate-boundary' };
  }
  const exitNodeId = exactString(raw.exitNodeId, 'flow-interface-return-node');
  const operation = projection.entityReference('semantic-ir', exitNodeId);
  const node = operation ? projection.source(operation) : null;
  // The ABI owner is still responsible for showing that this input is the
  // function result rather than e.g. a return-branch address. No exact claim.
  if (node?.kind !== 'return' || !node.inputs?.includes(valueId)) return {
    index, valueId, exitNodeId, evidenceIds, status: 'unresolved', reason: 'return-value-not-an-explicit-return-input' };
  return { index, valueId, exitNodeId, evidenceIds, references, status: 'candidate-boundary' };
}

/** Payload comes from a host capability, never from a tool request. */
function captureInterface(value, projection, { world, assumptions, snapshotId }) {
  const input = snapshotContractData(value, { allowBigInt: true, maxBytes: 262144, maxNodes: 8192 });
  recordFields(input, ['schema', 'worldId', 'assumptionsId', 'snapshotId', 'binaryId', 'functionId',
    'producerArtifactId', 'ownerDigests', 'abiId', 'abiRevision', 'ownerRevision', 'parameters', 'returns', 'remaining'], 'flow-interface-fields');
  if (input.schema !== SCOPED_FLOW_INTERFACE_SCHEMA || input.worldId !== world.id || input.assumptionsId !== assumptions.id
    || input.snapshotId !== snapshotId || input.binaryId !== projection.inputIdentity.binaryId || input.functionId !== projection.functionId
    || !projection.inputIdentity.producerArtifactId || input.producerArtifactId !== projection.inputIdentity.producerArtifactId
    || !sameData(input.ownerDigests, projection.inputIdentity.ownerDigests)) contractFail('flow-interface-source-binding');
  // World profile spells the ABI and revision, not an arbitrary platform guess.
  exactString(input.abiId, 'flow-interface-abi'); exactString(input.abiRevision, 'flow-interface-abi-revision');
  exactString(input.ownerRevision, 'flow-interface-owner-revision');
  if (input.abiId !== world.profile.abi || input.abiRevision !== world.profile.abiRevision) contractFail('flow-interface-abi-world-mismatch');
  if (!Array.isArray(input.parameters) || input.parameters.length > 64
    || !Array.isArray(input.returns) || input.returns.length > 128) contractFail('flow-interface-port-count');
  const parameters = input.parameters.map((port) => normalizePort(port, false, projection));
  const returns = input.returns.map((port) => normalizePort(port, true, projection));
  const seen = new Set();
  for (const parameter of parameters) {
    if (seen.has(parameter.index)) contractFail('flow-interface-duplicate-parameter');
    seen.add(parameter.index);
  }
  const outputs = new Set();
  for (const result of returns) {
    const key = `${result.index}\u0000${result.exitNodeId ?? ''}\u0000${result.valueId}`;
    if (outputs.has(key)) contractFail('flow-interface-duplicate-return'); outputs.add(key);
  }
  const body = { ...input, parameters, returns, remaining: stringSet([
    ...stringSet(input.remaining ?? [], 'flow-interface-remaining', 64),
    'abi-port-meaning-not-independently-qualified', 'hidden-result-and-memory-ports-unmodelled',
  ]), exact: false, authority: 'bound-owner-port-projection-not-semantic-proof' };
  return deepFreeze({ ...body, digest: stableDigest({ body, typed: lossyTypeWitness(body) }) });
}

/**
 * Retains only the requested <=16 function projections. Loading is resumable
 * between functions; the final join is allocation/work/deadline bounded. The
 * canonical owners retain truth; this builder owns only navigation indices.
 */
export class ScopedInterproceduralProjectionBuilder {
  #world; #assumptions; #snapshotId; #locators; #load; #ports; #current;
  #entries = new Map(); #seen = []; #next = 0; #gaps = []; #omittedGaps = 0;
  #bridges = []; #iterator = null; #pending = null; #joining = false; #closed = false; #product = null;
  constructor({ functionIds, world, assumptions, snapshotId, loadProjection, getFunctionFlowInterface = null, isCurrent } = {}) {
    assertWorldScope(world); assertAssumptionSet(assumptions, world); exactString(snapshotId, 'flow-scope-snapshot');
    this.#locators = stringSet(functionIds, 'flow-scope-functions', MAX_FUNCTIONS);
    if (!this.#locators.length || typeof loadProjection !== 'function' || typeof isCurrent !== 'function'
      || getFunctionFlowInterface !== null && typeof getFunctionFlowInterface !== 'function') contractFail('flow-scope-host');
    this.#world = world; this.#assumptions = assumptions; this.#snapshotId = snapshotId;
    this.#load = loadProjection; this.#ports = getFunctionFlowInterface; this.#current = isCurrent;
  }
  #gap(gap) {
    if (this.#gaps.length < MAX_GAPS) this.#gaps.push(deepFreeze(gap)); else this.#omittedGaps++;
  }
  isCurrent() {
    if (this.#closed || this.#current() !== true) return false;
    for (const entry of this.#entries.values()) if (entry.isCurrent && entry.isCurrent() !== true) return false;
    return true;
  }
  captureInputFreshness() {
    if (!this.isCurrent()) contractFail('interprocedural-scope-stale');
    // Completed reports outlive the navigation Maps. Preserve the captured
    // input dependencies, without treating container release as an edge change.
    const current = this.#current, owners = [...this.#entries.values()].map(entry => entry.isCurrent).filter(Boolean);
    return () => current() === true && owners.every(check => check() === true);
  }
  #check(work) { work.checkpoint(); if (!this.isCurrent()) contractFail('interprocedural-scope-stale'); }
  get seen() { return this.#seen.map((entry) => ({ ...entry })); }
  #bridge(caller, callee, node, from, to, direction, index, port, proof) {
    const callSite = createEntityId({ binaryId: caller.projection.inputIdentity.binaryId, kind: 'scoped-call-context',
      identity: { callerProjectionId: caller.projection.id, callSiteId: node.id, calleeProjectionId: callee.projection.id } });
    const body = { from, to, kind: 'call-summary', relation: 'possible-dependence', executablePathProven: false,
      boundary: { direction, callSite, callerFunctionId: caller.projection.functionId, calleeFunctionId: callee.projection.functionId },
      witness: { owner: 'canonical-call-and-abi-value-ports', callSiteId: node.id, valueIndex: index,
        callerInput: caller.projection.inputIdentity, calleeInput: callee.projection.inputIdentity,
        interfaceDigest: callee.interface.digest, ownerRevision: callee.interface.ownerRevision,
        abiId: callee.interface.abiId, abiRevision: callee.interface.abiRevision,
        portValueId: port.valueId, exitNodeId: port.exitNodeId ?? null, evidenceIds: port.evidenceIds,
        targetReference: proof.scopedTargetReference ?? null,
        targetSetStatus: proof.exhaustive ? 'owner-declared-exhaustive-not-replayed' : 'open' },
      obligations: ['call-target-feasibility', 'abi-value-port-meaning', 'return-path-feasibility',
        'machine-observable-and-memory-closure', ...callee.interface.remaining] };
    return deepFreeze({ ...body, id: createEntityId({ binaryId: this.#world.binarySet[0].binaryId,
      kind: 'scoped-interprocedural-reference', identity: { version: SCOPED_INTERPROCEDURAL_VERSION, body } }) });
  }
  *#nativeInputRows(caller, callee, node, binding) {
    const call = caller.nativeInputs?.calls.find((entry) => entry.callSiteId === node.id);
    if (!call || !callee.nativeInputs) return;
    for (const actual of call.arguments) for (const parameter of callee.nativeInputs.parameters) {
      yield { kind: 'tick' };
      if (actual.register !== parameter.register || actual.widthBits !== parameter.widthBits) continue;
      const callSite = createEntityId({ binaryId: caller.projection.inputIdentity.binaryId, kind: 'scoped-call-context',
        identity: { callerProjectionId: caller.projection.id, callSiteId: node.id, calleeProjectionId: callee.projection.id } });
      for (const from of actual.references) for (const to of parameter.references) {
        const body = { from, to, kind: 'call-summary', relation: 'possible-dependence', executablePathProven: false,
          boundary: { direction: 'enter', callSite, callerFunctionId: caller.projection.functionId, calleeFunctionId: callee.projection.functionId },
          witness: { owner: 'existing-abi-and-compat-register-inputs', callSiteId: node.id,
            callerInput: caller.projection.inputIdentity, calleeInput: callee.projection.inputIdentity,
            callerInterfaceDigest: caller.nativeInputs.digest, calleeInterfaceDigest: callee.nativeInputs.digest,
            register: actual.register, widthBits: actual.widthBits, actual, parameter, targetReference: binding,
            specialization: caller.specializations?.find(row => row.callSiteId === node.id && row.functionId === callee.projection.functionId)?.id ?? null,
            conditionalInput: caller.specializations?.find(row => row.callSiteId === node.id && row.functionId === callee.projection.functionId)?.inputs.find(row => row.parameter.valueId === parameter.valueId) ?? null },
          obligations: ['call-target-feasibility', 'native-abi-input-meaning-not-independently-replayed',
            ...caller.nativeInputs.remaining, ...callee.nativeInputs.remaining] };
        yield { kind: 'bridge', value: deepFreeze({ ...body, id: createEntityId({ binaryId: this.#world.binarySet[0].binaryId,
          kind: 'scoped-native-input-reference', identity: { version: SCOPED_INTERPROCEDURAL_VERSION, body } }) }) };
      }
    }
    // Return ports are supplied by the existing ABI -> canonical IR -> SSA
    // owner chain. A register spelling or an unprototyped call is never enough.
    for (const returned of callee.nativeInputs.returns ?? []) for (const actual of call.returns ?? []) {
      yield { kind: 'tick' };
      if (returned.register !== actual.register || returned.widthBits !== actual.widthBits) continue;
      for (const from of returned.references) for (const to of actual.references) yield { kind: 'bridge',
        value: this.#nativePortBridge(caller, callee, node, from, to, 'return', 'return', { returned, actual, binding }) };
    }
    const memoryCall = caller.nativeInputs.memory?.calls.find(row => row.callSiteId === node.id);
    if (memoryCall) {
      // These are broad may-memory ports. Region/alias/byte semantics remain
      // with MemorySSA; no same-spelling region becomes an exact cross-frame alias.
      for (const actual of memoryCall.inputs) for (const parameter of callee.nativeInputs.memory?.entries ?? []) {
        yield { kind: 'tick' };
        for (const from of actual.references) for (const to of parameter.references) yield { kind: 'bridge',
          value: this.#nativePortBridge(caller, callee, node, from, to, 'enter', 'memory', { actual, parameter, binding }) };
      }
      for (const returned of callee.nativeInputs.memory?.exits ?? []) for (const actual of memoryCall.outputs) {
        yield { kind: 'tick' };
        for (const from of returned.references) for (const to of actual.references) yield { kind: 'bridge',
          value: this.#nativePortBridge(caller, callee, node, from, to, 'return', 'memory', { returned, actual, binding }) };
      }
    }
  }
  #nativePortBridge(caller, callee, node, from, to, direction, portKind, ports) {
    const callSite = createEntityId({ binaryId: caller.projection.inputIdentity.binaryId, kind: 'scoped-call-context',
      identity: { callerProjectionId: caller.projection.id, callSiteId: node.id, calleeProjectionId: callee.projection.id } });
    const body = { from, to, kind: 'call-summary', relation: 'possible-dependence', executablePathProven: false,
      ...(portKind === 'memory' ? { flowKinds: ['data', 'address', 'memory', 'capture', 'return'] } : {}),
      boundary: { direction, callSite, callerFunctionId: caller.projection.functionId, calleeFunctionId: callee.projection.functionId },
      witness: { owner: portKind === 'memory' ? 'existing-canonical-memoryssa-ports' : 'existing-canonical-abi-return-ports',
        callSiteId: node.id, portKind, callerInput: caller.projection.inputIdentity, calleeInput: callee.projection.inputIdentity,
        callerInterfaceDigest: caller.nativeInputs.digest, calleeInterfaceDigest: callee.nativeInputs.digest, ...ports },
      obligations: ['call-target-feasibility', 'return-path-feasibility',
        ...(portKind === 'memory' ? ['cross-frame-memory-alias-and-byte-coverage-unqualified'] : ['native-abi-return-meaning-not-independently-replayed']),
        ...caller.nativeInputs.remaining, ...callee.nativeInputs.remaining] };
    return deepFreeze({ ...body, id: createEntityId({ binaryId: this.#world.binarySet[0].binaryId,
      kind: 'scoped-native-boundary-reference', identity: { version: SCOPED_INTERPROCEDURAL_VERSION, body } }) });
  }
  *#joinRows() {
    const targetIndex = indexScopedFunctionEntries([...this.#entries.values()].map((entry) => entry.projection));
    for (const caller of this.#entries.values()) {
      const projection = caller.projection;
      for (let recordIndex = 0; recordIndex < projection.size; recordIndex++) {
        const record = projection.recordAt(recordIndex);
        yield { kind: 'tick' }; // even non-call scanning participates in budgets
        if (record.owner !== 'semantic-ir') continue;
        const node = projection.source(record.id);
        if (!node.call) continue;
        const proof = classifyCallTargetProof(node.call);
        if (!proof.exhaustive) yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'call-target-set-open' } };
        const targets = [], bindings = new Map();
        if (caller.nativeDemand) for (let tick = 0; tick < Math.min(64, node.call.targetValueIds?.length ?? 0) * 512; tick++) yield { kind: 'tick' };
        for (const binding of scopedCallTargetRows(projection, node, targetIndex, caller.nativeDemand)) {
          yield { kind: 'tick' };
          if (binding.reason) yield { kind: 'gap', value: { functionId: projection.functionId,
            entityId: node.id, reason: binding.reason, target: binding.targetFunctionId, address: binding.address } };
          if (binding.targetFunctionId && !bindings.has(binding.targetFunctionId)) {
            targets.push(binding.targetFunctionId); bindings.set(binding.targetFunctionId, binding);
          }
        }
        if (!targets.length) { yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'canonical-call-target-entities-unavailable' } }; continue; }
        if (targets.length > 64) { yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'call-target-fanout-cut' } }; continue; }
        const arguments_ = node.call.arguments ?? [], results = node.call.returns ?? [];
        if (arguments_.length > 64 || results.length > 16) { yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'call-value-port-budget' } }; continue; }
        for (const target of targets) {
          const callee = this.#entries.get(target);
          const targetProof = { ...proof, scopedTargetReference: bindings.get(target) };
          if (!callee) { yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'callee-outside-explicit-scope', target } }; continue; }
          if (!callee.interface) {
            if (caller.nativeInputs && callee.nativeInputs) {
              yield* this.#nativeInputRows(caller, callee, node, bindings.get(target));
              yield { kind: 'gap', value: { functionId: target, entityId: node.id, reason: 'native-abi-return-memory-exception-closure-open' } };
            } else yield { kind: 'gap', value: { functionId: target, entityId: node.id, reason: 'canonical-function-abi-ports-unavailable' } };
            continue;
          }
          if (!arguments_.length) yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'call-arguments-unenriched-or-zero-arity-unqualified' } };
          if (!results.length) yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'call-return-values-unenriched-or-void-unqualified' } };
          for (const port of callee.interface.parameters) {
            if (port.status !== 'candidate-boundary' || !arguments_[port.index]) {
              yield { kind: 'gap', value: { functionId: target, entityId: node.id, reason: port.reason ?? 'caller-argument-port-missing', index: port.index } }; continue;
            }
            const actuals = projection.valueReferenceIds(arguments_[port.index]);
            if (!actuals.length || actuals.length > 32) { yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'caller-argument-ssa-binding-unavailable' } }; continue; }
            for (const from of actuals) for (const to of port.references) yield {
              kind: 'bridge', value: this.#bridge(caller, callee, node, from, to, 'enter', port.index, port, targetProof) };
          }
          for (const port of callee.interface.returns) {
            if (port.status !== 'candidate-boundary' || !results[port.index]) {
              yield { kind: 'gap', value: { functionId: target, entityId: node.id, reason: port.reason ?? 'caller-return-port-missing', index: port.index } }; continue;
            }
            const actuals = projection.valueReferenceIds(results[port.index]);
            if (!actuals.length || actuals.length > 32) { yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'caller-return-ssa-binding-unavailable' } }; continue; }
            for (const from of port.references) for (const to of actuals) yield {
              kind: 'bridge', value: this.#bridge(caller, callee, node, from, to, 'return', port.index, port, targetProof) };
          }
          yield { kind: 'gap', value: { functionId: projection.functionId, entityId: node.id, reason: 'interprocedural-memory-exception-hidden-result-ports-open' } };
        }
      }
    }
  }
  async advance({ work } = {}) {
    assertScopedAnalysisWork(work); this.#check(work);
    if (this.#product) return { projection: this.#product, members: this.seen, composite: true, isCurrent: this.captureInputFreshness() };
    if (this.#next < this.#locators.length) {
      const locator = this.#locators[this.#next];
      work.charge('artifactsMaterialized');
      const loaded = await work.await((signal) => this.#load(locator, { work, signal })); this.#check(work);
      if (!loaded?.projection) this.#gap({ functionId: locator, reason: loaded?.reason ?? 'function-projection-unavailable' });
      else {
        const projection = assertCanonicalQueryProjection(loaded.projection, { world: this.#world, assumptions: this.#assumptions });
        let retained = false;
        try {
          if (this.#entries.has(projection.functionId)) contractFail('interprocedural-duplicate-function-identity');
          if (loaded.isCurrent !== undefined && typeof loaded.isCurrent !== 'function') contractFail('flow-projection-current-owner-hook');
          const entry = { locator, projection, interface: null, nativeInputs: null, nativeDemand: null, specializations: [], isCurrent: loaded.isCurrent ?? null };
          if (entry.isCurrent && entry.isCurrent() !== true) contractFail('interprocedural-scope-stale');
          if (loaded.nativeDemand) entry.nativeDemand = assertNativeTargetDemand(loaded.nativeDemand, projection);
          if (loaded.specializations) {
            if (!Array.isArray(loaded.specializations) || loaded.specializations.length > 32) contractFail('flow-specialization-limit');
            entry.specializations = loaded.specializations.map(value => assertSummarySpecialization(value, { world: this.#world, callerFunctionId: projection.functionId }));
          }
          if (loaded.nativeFlowInputs) entry.nativeInputs = bindScopedFlowInputs(loaded.nativeFlowInputs, projection, {
            world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshotId });
          if (loaded.nativeFlowReason) this.#gap({ functionId: projection.functionId, reason: loaded.nativeFlowReason });
          if (this.#ports) {
            const context = await work.await((signal) => this.#ports(locator, { signal, work, projection,
              world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshotId })); this.#check(work);
            if (context) {
              if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('flow-interface-current-owner-required');
              entry.interface = captureInterface(context.data, projection, { world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshotId });
              const projectionCurrent = entry.isCurrent;
              entry.isCurrent = () => context.isCurrent() === true && (!projectionCurrent || projectionCurrent() === true);
              if (entry.isCurrent() !== true) contractFail('flow-interface-changed-during-capture');
            }
          }
          this.#entries.set(projection.functionId, entry); retained = true;
          this.#seen.push({ locator, functionId: projection.functionId, projectionId: projection.id,
            producerArtifactId: projection.inputIdentity.producerArtifactId, ownerContentDigests: projection.inputIdentity.ownerDigests });
        } finally { if (!retained) projection.release(); }
      }
      this.#next++;
      // Commit one function before returning. The next continuation cannot
      // reload prior functions with a fresh budget or a new owner identity.
      return { pending: true, loadedFunctions: this.#next, requestedFunctions: this.#locators.length };
    }
    if (!this.#entries.size) return { reason: 'explicit-function-scope-unavailable' };
    this.#iterator ??= this.#joinRows();
    while (!this.#joining) {
      this.#check(work); work.charge('workUnits');
      this.#pending ??= this.#iterator.next();
      if (this.#pending.done) { this.#joining = true; this.#pending = null; break; }
      const row = this.#pending.value;
      if (row.kind === 'bridge') {
        if (this.#bridges.length >= MAX_BRIDGES) {
          this.#gap({ reason: 'interprocedural-bridge-budget', functionId: null });
          this.#joining = true; this.#pending = null; this.#iterator.return(); break;
        }
        work.charge('edges'); work.charge('residentBytes', stableStringify(row.value).length * 2 + 128);
        this.#bridges.push(row.value);
      } else if (row.kind === 'gap') this.#gap(row.value);
      this.#pending = null;
      await work.yieldIfNeeded();
    }
    // Keep truncation observable even when the frontier itself reached its cap.
    // Do not mutate retained gaps here: a paused composition may retry.
    const frontier = this.#omittedGaps
      ? [...this.#gaps.slice(0, MAX_GAPS - 1), { reason: 'interprocedural-frontier-truncated',
        count: this.#omittedGaps + Math.max(0, this.#gaps.length - (MAX_GAPS - 1)), functionId: null }]
      : this.#gaps;
    const product = await composeCanonicalQueryProjections([...this.#entries.values()].map((entry) => entry.projection),
      this.#bridges, frontier, { world: this.#world, assumptions: this.#assumptions, snapshotId: this.#snapshotId, work });
    try { this.#check(work); } catch (error) { product.release(); throw error; }
    this.#product = product;
    // The composite holds frozen owner rows, not the source Map containers.
    for (const entry of this.#entries.values()) entry.projection.release();
    this.#bridges = []; this.#iterator = null;
    return { projection: product, members: this.seen, composite: true, isCurrent: this.captureInputFreshness() };
  }
  close() {
    if (this.#closed) return;
    this.#closed = true; this.#iterator?.return(); this.#iterator = null; this.#pending = null;
    this.#product?.release(); this.#product = null;
    for (const entry of this.#entries.values()) entry.projection.release();
    this.#entries.clear(); this.#bridges = []; this.#gaps = [];
  }
}
