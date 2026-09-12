/** Query-local branch feasibility from the existing complete executor.
 * Does not authorize region deletion, PHI rewiring, or copied-AST changes.
 */
import { readConditionalRegionStructure } from './conditional-region-structure.js';
import { queryArray, queryRecord } from '../../symbolic/memory/data-input.js';
import { createQueryGuard, sameMemoryIdentity } from '../../symbolic/memory/query-state.js';

const issued = new WeakMap();
const LIMITS = Object.freeze({ workItems:262144, allocationUnits:262144, queries:3 });
const OPTION_KEYS = new Set(['identity', 'timeoutMs', 'limits', 'signal', 'isCancelled', 'getCurrentIdentity', 'now',
  'addressBits', 'endian', 'backendTier', 'maxPaths', 'maxSteps', 'maxBranches', 'maxBlockVisits']);
const ORDINARY = new Set(['branch', 'fallthrough', 'conditional-true', 'conditional-false']);
const freeze = Object.freeze;

export function readConditionalRegionReachability(result, ir, identity) {
  const binding = issued.get(result);
  try {
    if (!binding || binding.ir !== ir || !sameMemoryIdentity(binding.guard.identity, identity)) return null;
    binding.guard.check(identity);
    return readConditionalRegionStructure(binding.structure, ir, identity)
      && sameMemoryIdentity(binding.guard.identity, identity) && binding.executionCurrent() ? result : null;
  } catch { return null; }
}

/** The exact structural input belongs to the private proof, not to matching
 * branch IDs or a caller-provided pairing of otherwise valid capabilities. */
export function readConditionalRegionReachabilityStructure(result, ir, identity) {
  return readConditionalRegionReachability(result, ir, identity) ? issued.get(result).structure : null;
}

export async function prepareConditionalRegionReachability(structure, ir, options = {}) {
  let guard, session;
  const reject = reason => freeze({ version:1, status:'partial', reason, arms:freeze([]), transformAuthorization:false });
  try {
    const submitted = queryRecord(options);
    if (Object.keys(submitted).some(key => !OPTION_KEYS.has(key))) return reject('unsupported-reachability-option');
    guard = createQueryGuard(submitted, LIMITS); guard.check();
    if (!readConditionalRegionStructure(structure, ir, guard.identity)) return reject('unissued-or-stale-structure');
    const addressBits = submitted.addressBits ?? 64, endian = submitted.endian ?? 'little';
    if (!Number.isSafeInteger(addressBits) || addressBits < 1 || addressBits > 64
        || !['little', 'big'].includes(endian)) return reject('invalid-memory-domain');
    guard.take('workItems', structure.cfgEdges.length + structure.blocks.length);
    if (structure.cfgEdges.some(edge => edge.kinds.some(kind => !ORDINARY.has(kind)))) return reject('nonordinary-function-edge');
    if (structure.blocks.some(block => block.isEntry === true && block !== structure.functionEntry)) return reject('multiple-function-entries');
    // A terminal-path union is not an induction certificate for a loop. Check
    // acyclicity of the already-issued CFG inventory, without inventing edges.
    guard.take('allocationUnits', structure.blocks.length * 3 + structure.cfgEdges.length);
    const incoming = new Map(structure.blocks.map(block => [block.index, 0])), outgoing = new Map();
    for (const edge of structure.cfgEdges) {
      incoming.set(edge.to, incoming.get(edge.to) + 1);
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge.to);
    }
    const queue = [...incoming].filter(([, count]) => count === 0).map(([index]) => index);
    let visited = 0;
    for (let offset = 0; offset < queue.length; offset++) {
      visited++; guard.take('workItems');
      for (const target of outgoing.get(queue[offset]) ?? []) {
        guard.take('workItems'); incoming.set(target, incoming.get(target) - 1);
        if (incoming.get(target) === 0) queue.push(target);
      }
    }
    if (visited !== structure.blocks.length) return reject('loop-reachability-proof-required');
    const [{ symbolicExecute }, { isExecutionResult, isExecutionSnapshot }, { validateExecutionContract },
      { verifyConditionalEdgeFeasibility }, { createProductionSolverRegistry }, expr, { scalarOperation },
      { prepareCanonicalRegisterStateBindings }] = await Promise.all([
      import('../../symbolic/executor.js'), import('../../symbolic/memory/execution-snapshot.js'),
      import('../../symbolic/memory/execution-contract.js'), import('../../symbolic/verify/edge-feasibility.js'),
      import('../../symbolic/solver/registry.js'), import('../../symbolic/expr/index.js'),
      import('../../symbolic/translate/scalar.js'),
      import('../../ir-core.js'),
    ]);
    guard.check();
    if (!readConditionalRegionStructure(structure, ir, guard.identity)) return reject('stale-structure');
    const charge = { chargeExecution(work = 1, allocation = 0) {
      guard.take('workItems', work); guard.take('allocationUnits', allocation);
    } };
    const addressMap = validateExecutionContract(ir, charge);
    const branch = structure.region.branch, data = queryRecord(branch, guard, 128);
    const targetAddress = queryRecord(data.extra, guard).target;
    const addressKey = value => typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value) : null;
    if (addressMap.get(addressKey(targetAddress)) !== structure.region.selection.yes) return reject('executor-producer-target-mismatch');
    // The executor trace carries row/address, not a rendered predicate or C AST
    // index. Require their unique exact canonical CBR identity before matching.
    const branchIndex = [], stateBindings = prepareCanonicalRegisterStateBindings(ir, guard.identity);
    if (stateBindings?.status === 'unavailable') return reject('unproved-state-effects');
    if (stateBindings) guard.take('allocationUnits', stateBindings.size + stateBindings.observationCount);
    const stateCurrent = () => {
      if (!stateBindings) return true;
      guard.take('workItems', stateBindings.workItems);
      return stateBindings.isCurrent();
    };
    if (!stateCurrent()) return reject('unproved-state-effects');
    for (const block of structure.blocks) for (const inst of queryArray(queryRecord(block, guard, 128).insts, guard)) {
      const current = queryRecord(inst, guard, 128);
      const extra = queryRecord(current.extra ?? {}, guard), attributes = queryRecord(extra.attributes ?? {}, guard);
      const machine = attributes.machineEffects == null ? null : queryRecord(attributes.machineEffects, guard);
      if (current.op === 'mov' && ['register-read', 'register-write'].includes(machine?.operationKind)
          && !stateBindings?.get(inst)) return reject('unproved-state-effects');
      for (const source of [current, extra, attributes, machine].filter(Boolean)) {
        const stateKeys = ['stateRead', 'stateWrite', 'unknownEffects', 'publicStateIdentity', 'statePreservation']
          .filter(key => source[key] != null && source[key] !== false);
        if (stateKeys.length) {
          // Only the actual pipeline's SSA-to-MOV binding establishes an
          // ordinary register assignment. Other/hidden state remains unknown.
          if (source !== extra || stateKeys.some(key => ['unknownEffects','statePreservation'].includes(key))) return reject('unproved-state-effects');
          const binding = stateBindings?.get(inst);
          if (!binding || (binding.kind === 'state-read'
            ? extra.stateRead !== binding.state || extra.stateWrite != null
            : extra.stateWrite !== binding.state || extra.stateRead != null)) return reject('unproved-state-effects');
        }
        if (['possibleFaults', 'faults'].some(key => source[key] != null && queryArray(source[key], guard).length)) {
          return reject('unproved-machine-effects');
        }
        if (source.undefinedResult != null) return reject('unproved-undefined-result');
      }
      if (machine && (machine.bundleCompleteness !== 'exact'
          || machine.possibleFaults != null && queryArray(machine.possibleFaults, guard).length)) return reject('unproved-machine-effects');
      if (['load', 'store'].includes(current.op)) {
        const memory = extra.memoryAccess == null ? null : queryRecord(extra.memoryAccess, guard);
        if (!memory || extra.completeness !== 'complete' || memory.atomic !== false || memory.volatility !== false
            || !['none', 'unknown'].includes(memory.ordering) || memory.endian !== endian || memory.addressSpace !== guard.identity.addressSpace
            || ![8, 16, 32, 64].includes(memory.widthBits) || !Array.isArray(memory.faults)
            || queryArray(memory.faults, guard).length) return reject('unproved-memory-effects');
        // A stricter alignment than byte alignment needs an address proof,
        // which this feasibility preparation does not silently assume.
        if (memory.alignment != null && memory.alignment !== 1) return reject('unproved-memory-alignment');
      }
      const operation = scalarOperation(current);
      if (current.op === 'bin' && ['urem', 'srem'].includes(operation)) return reject('unproved-remainder-effects');
      if (current.op === 'bin' && ['udiv', 'sdiv'].includes(operation)) {
        const policy = machine?.operationMetadata == null ? null : queryRecord(machine.operationMetadata, guard);
        if (!machine || extra.completeness !== 'complete' || machine.bundleCompleteness !== 'exact'
            || policy?.divisionByZero !== 'returns-zero' || policy.widthBits !== current.dst?.bits
            || policy.signedOverflow !== (operation === 'sdiv' ? 'wraps-min-div-minus-one' : 'not-applicable')) {
          return reject('unproved-division-effects');
        }
      }
      if (current.op !== 'cbr') continue;
      const destination = addressMap.get(addressKey(extra.target));
      const edges = structure.cfgEdges.filter(edge => edge.from === current.block);
      guard.take('workItems', structure.cfgEdges.length);
      const yesEdge = edges.find(edge => edge.to === destination), noEdge = edges.find(edge => edge.to !== destination);
      if (edges.length !== 2 || !yesEdge || !noEdge || yesEdge.kinds.length !== 1 || yesEdge.kinds[0] !== 'conditional-true'
          || !noEdge.kinds.includes('conditional-false') || noEdge.kinds.some(kind => !['conditional-false', 'fallthrough'].includes(kind))
          || extra.targetBlock != null && extra.targetBlock !== destination
          || extra.fallthroughBlock != null && extra.fallthroughBlock !== noEdge.to
          || extra.fallthrough != null && addressMap.get(addressKey(extra.fallthrough)) !== noEdge.to) return reject('inconsistent-branch-endpoints');
      guard.take('workItems', branchIndex.length);
      if (!Number.isSafeInteger(current.row) || current.row < 0 || addressKey(current.address) == null
          || branchIndex.some(other => other.row === current.row && other.address === addressKey(current.address))) {
        return reject('ambiguous-branch-trace-identity');
      }
      guard.take('allocationUnits'); branchIndex.push({ instruction:inst, row:current.row, address:addressKey(current.address) });
    }
    const timeout = () => Math.max(0, Math.floor(guard.remainingMilliseconds()));
    if (!stateCurrent()) return reject('unproved-state-effects');
    const used = guard.metrics();
    // Reserve the whole child allowance before execution. Its published metrics
    // precede final capture publication and cannot refund that unseen work.
    const executionLimits = {
      workItems:Math.min(250000, Math.max(0, guard.limits.workItems - used.workItems
        - Math.max(4096, (stateBindings?.workItems ?? 0) * 5))),
      allocationUnits:Math.max(0, guard.limits.allocationUnits - used.allocationUnits - 4096),
    };
    guard.take('workItems', executionLimits.workItems); guard.take('allocationUnits', executionLimits.allocationUnits);
    const execution = symbolicExecute(ir, {
      byteMemory:{ identity:guard.identity, addressBits, endian, signal:submitted.signal,
        isCancelled:submitted.isCancelled, getCurrentIdentity:submitted.getCurrentIdentity, timeoutMs:timeout(),
        now:submitted.now, limits:executionLimits },
      timeoutMs:timeout(), signal:submitted.signal, isCancelled:submitted.isCancelled, captureValues:true,
      ...Object.fromEntries(['maxPaths', 'maxSteps', 'maxBranches', 'maxBlockVisits']
        .filter(key => Object.hasOwn(submitted, key)).map(key => [key, submitted[key]])),
    });
    // Charge/check caller lifecycle first, then validate both observations so
    // callbacks cannot mutate an already-checked execution behind this read.
    const executionCurrent = () => isExecutionResult(execution, guard.identity, ir)
      && (!stateBindings || stateBindings.isCurrent());
    const checkedExecutionCurrent = () => {
      if (stateBindings) guard.take('workItems', stateBindings.workItems);
      return executionCurrent();
    };
    guard.check();
    if (!checkedExecutionCurrent() || execution.status !== 'complete' || execution.truncated || !execution.paths.length) {
      return reject(execution.reason ?? 'incomplete-execution');
    }
    if (execution.assumptions.length || execution.memoryObservationRequests.length) return reject('conditional-execution-assumptions');
    const terms = [], armTerms = { yes:[], no:[] }, traversals = { yes:[], no:[] };
    for (const [pathIndex, path] of execution.paths.entries()) {
      guard.take('workItems');
      if (path.status !== 'complete' || !isExecutionSnapshot(path.snapshot, guard.identity, ir)
          || path.snapshot.assumptions.length || path.constraints.length !== path.takenBranches.length) {
        return reject('incomplete-path-binding');
      }
      const conditions = queryArray(path.constraints, guard);
      if (conditions.some(condition => condition.sort?.kind !== 'bool')) return reject('nonboolean-path-condition');
      const term = conditions.length ? expr.createConnective('and', ...conditions) : expr.createBool(true);
      guard.take('allocationUnits', conditions.length + 1); terms.push(term);
      const roles = new Set();
      let targetVisits = 0;
      for (const step of path.takenBranches) {
        guard.take('workItems', branchIndex.length);
        const matches = branchIndex.filter(item => item.row === step.row && item.address === addressKey(step.address));
        if (matches.length !== 1 || typeof step.taken !== 'boolean') return reject('unbound-execution-branch');
        if (matches[0].instruction === branch) {
          if (++targetVisits > 1) return reject('repeated-target-traversal');
          roles.add(step.taken ? 'yes' : 'no');
        }
      }
      for (const role of roles) { armTerms[role].push(term); traversals[role].push(pathIndex); }
    }
    const union = values => values.length ? expr.createConnective('or', ...values) : expr.createBool(false);
    const registry = createProductionSolverRegistry({ backendTier:submitted.backendTier ?? 'tiered' });
    session = registry.getDefaultBackend().createSession();
    const verify = async (condition, toBlock) => {
      guard.take('queries');
      const result = await verifyConditionalEdgeFeasibility({ ir, fromBlock:structure.functionEntry.index,
        toBlock, edgeCondition:condition, preconditions:[], session,
        options:{ signal:submitted.signal, timeoutMs:timeout(), architecture:guard.identity.architecture,
          semanticIrVersion:guard.identity.semanticsVersion, bitWidth:addressBits,
          proofScope:{ kind:'canonical-executor-entry-path-union', identity:guard.identity,
            branchId:data.id, terminalPaths:execution.paths.length, assumptions:[] } },
      });
      guard.check();
      if (!readConditionalRegionStructure(structure, ir, guard.identity) || !checkedExecutionCurrent()) guard.fail('stale-proof-input');
      return result;
    };
    // A complete-looking but empty feasible domain must not mint two vacuous
    // unreachable-arm decisions. SAT models are checked by the existing judge.
    const domain = await verify(union(terms), structure.functionEntry.index);
    if (domain.verdict !== 'refuted' || domain.counterexampleValidation?.valid !== true) return reject('unconfirmed-execution-domain');
    const arms = [];
    for (const role of ['yes', 'no']) {
      const proof = await verify(union(armTerms[role]), structure.region.selection[role]);
      arms.push(freeze({ role, verdict:proof.verdict, reason:proof.reasonCode ?? null,
        terminalPaths:freeze(traversals[role]), queryHash:proof.queryHash, solverStatus:proof.solverStatus,
        backendId:session.backend.id, backendVersion:session.backend.version,
        proofAuthority:session.backend.proofAuthority, capabilityFingerprint:session.backend.capabilityFingerprint(),
        counterexampleValidated:proof.counterexampleValidation?.valid === true }));
    }
    await session.dispose(); session = null;
    guard.check();
    if (!readConditionalRegionStructure(structure, ir, guard.identity) || !checkedExecutionCurrent()) return reject('stale-proof-input');
    const complete = arms.every(arm => arm.verdict === 'proved' || arm.verdict === 'refuted' && arm.counterexampleValidated);
    const result = freeze({ version:1, status:complete ? 'complete' : 'partial',
      scope:'acyclic-canonical-executor-entry-path-feasibility', transformAuthorization:false,
      semanticRegionValidation:'required', arms:freeze(arms), terminalPathCount:execution.paths.length,
      domainQueryHash:domain.queryHash, assumptions:freeze([]) });
    if (complete) issued.set(result, { structure, ir, guard, executionCurrent });
    return result;
  } catch (error) { return reject(guard?.reason() ?? error.reason ?? 'reachability-unavailable'); }
  finally { if (session) { try { await session.dispose(); } catch { /* No capability was issued on this path. */ } } }
}
