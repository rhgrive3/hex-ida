/** Canonical excluded-arm plans. An issued no-PHI flat-store-body packet may
 * be consumed only by the existing projection writer, which must additionally
 * commit exact copy correspondence and producer-bound removal tombstones.
 * Other bodies remain candidates: no instruction, PHI or CFG edit is allowed.
 */
import { stableDigest } from '../../core/identity/index.js';
import { readConditionalRegionStructure } from './conditional-region-structure.js';
import { readConditionalRegionReachabilityStructure } from './conditional-region-reachability.js';
import { queryRecord } from '../../symbolic/memory/data-input.js';
import { createQueryGuard, sameMemoryIdentity } from '../../symbolic/memory/query-state.js';
import { readConditionalRegionCondition } from './conditional-region-condition.js';

const issued = new WeakMap();
// Reading the private body packet is the explicit capability hand-off for a
// render caller.  A plan may still be carried for condition freshness without
// silently authorizing body deletion (the public predicate route does exactly
// that); callers that need the body must first obtain this private packet.
const bodyCapabilityRequests = new WeakSet();
const LIMITS = Object.freeze({ workItems:32768, allocationUnits:32768 });
const OPTION_KEYS = new Set(['identity','timeoutMs','limits','signal','isCancelled','getCurrentIdentity','now','conditionPlan','projection',
  'deterministic','deterministicTransforms']);
const freeze = Object.freeze;

export function readConditionalRegionErasure(plan, ir, identity) {
  const binding = issued.get(plan);
  try {
    if (!binding || binding.ir !== ir || !sameMemoryIdentity(binding.guard.identity, identity)) return null;
    binding.guard.check(identity);
    return readConditionalRegionReachabilityStructure(binding.reachability, ir, identity) === binding.structure
      && readConditionalRegionStructure(binding.structure, ir, identity)
      && (!binding.conditionPlan || readConditionalRegionCondition(binding.conditionPlan, binding.projection, binding.structure, identity))
      && sameMemoryIdentity(binding.guard.identity, identity) ? plan : null;
  } catch { return null; }
}

export function readRegionErasureCondition(plan, projection, ir, identity) {
  if (!readConditionalRegionErasure(plan, ir, identity)) return null;
  const binding = issued.get(plan);
  return binding.projection === projection
    ? readConditionalRegionCondition(binding.conditionPlan, projection, binding.structure, identity) : null;
}

/** Private capability for a narrow render-only deletion domain. Public plan
 * fields, matching hashes, or copied packet data cannot issue this authority. */
export function readRegionErasureBody(plan, projection, ir, identity) {
  if (!readConditionalRegionErasure(plan, ir, identity)) return null;
  const binding = issued.get(plan);
  if (binding.projection !== projection || !binding.body) return null;
  bodyCapabilityRequests.add(plan);
  return binding.body;
}

export function isRegionErasureBodyRequested(plan) {
  return !!plan && bodyCapabilityRequests.has(plan);
}

export function prepareConditionalRegionErasure(structure, reachability, ir, options = {}) {
  let guard;
  const reject = reason => freeze({ version:2, status:'partial', reason, transformAuthorization:false });
  try {
    const submitted = queryRecord(options);
    if (Object.keys(submitted).some(key => !OPTION_KEYS.has(key))) return reject('unsupported-region-erasure-option');
    guard = createQueryGuard(submitted, LIMITS); guard.check();
    if (!readConditionalRegionStructure(structure, ir, guard.identity)
      || readConditionalRegionReachabilityStructure(reachability, ir, guard.identity) !== structure) {
      return reject('unbound-region-reachability');
    }
    const dead = reachability.arms.filter(arm => arm.verdict === 'proved');
    const live = reachability.arms.filter(arm => arm.verdict === 'refuted' && arm.counterexampleValidated);
    if (dead.length !== 1 || live.length !== 1 || dead[0].role === live[0].role) return reject('no-single-unreachable-arm');
    const region = structure.region;
    const condition = submitted.conditionPlan == null && submitted.projection == null ? null
      : readConditionalRegionCondition(submitted.conditionPlan, submitted.projection, structure, guard.identity);
    if ((submitted.conditionPlan != null || submitted.projection != null) && !condition) return reject('unbound-region-condition');
    const erased = region.arms.find(arm => arm.role === dead[0].role);
    const retained = region.arms.find(arm => arm.role === live[0].role);
    guard.take('workItems', region.nodes.length + structure.instructions.length + structure.phis.length + structure.memoryPhis.length);
    guard.take('allocationUnits', region.nodes.length * 2 + erased.nodes.length);
    const removed = new Set(erased.nodes);
    // Production rendering may already omit a pure arm's unused statements.
    // Its issued predicate proof can still update the header through this
    // transaction; an empty body alone cannot create an erasure candidate.
    if (!removed.size && !condition) return reject('empty-unreachable-arm');
    if (removed.size !== erased.nodes.length || removed.has(region.header) || removed.has(region.separator)
      || removed.has(region.close) || retained.nodes.some(node => removed.has(node))) return reject('overlapping-region-erasure');
    const candidateNodes = region.nodes.filter(node => !removed.has(node));
    if (region.nodes.length - candidateNodes.length !== removed.size) return reject('unbound-erased-node');
    const spanDigest = nodes => stableDigest(nodes.map(node => {
      const data = queryRecord(node, guard, 128);
      return { kind:data.kind, indent:data.indent, text:data.text };
    }));
    const beforeHash = spanDigest(region.nodes), afterHash = spanDigest(candidateNodes);
    const planId = stableDigest({ kind:'unreachable-arm-body', identity:guard.identity, beforeHash, afterHash,
      branchId:region.branch.id, role:erased.role, queryHash:dead[0].queryHash,
      domainQueryHash:reachability.domainQueryHash, liveQueryHash:live[0].queryHash, conditionPlanId:condition?.plan.planId ?? null });
    // No PHI correspondence is inferred, even for equal incoming values. The
    // first deletion domain is a flat sequence of stores with a whole-entry
    // infeasibility proof. Nested controls, assignments and PHIs stay intact.
    const copiedArm = condition?.region.arms.find(arm => arm.original === erased);
    // No PHI correspondence is issued for render-only arm deletion. Even a
    // join PHI can still be printed as an unresolved local after one arm is
    // removed, so every PHI/MemoryPHI keeps body authority fail-closed until
    // an explicit live-PHI render correspondence is proved.
    const flatStores = condition && !structure.phis.length && !structure.memoryPhis.length
      && removed.size > 0 && removed.size <= 256 && copiedArm?.nodes.length === removed.size
      && copiedArm.nodes.every(node => node.kind === 'stmt' && node.semantic?.op === 'store')
      && erased.nodes.every(node => node.kind === 'stmt');
    const body = flatStores ? freeze({ scope:'unreachable-render-arm-body-no-phi', planId,
      nodes:copiedArm.nodes, originalNodes:erased.nodes, header:condition.header,
      condition, sourceCurrent:condition.sourceCurrent }) : null;
    const plan = freeze({ version:3, status:'complete', planId, beforeHash, afterHash, identity:guard.identity,
      scope:removed.size ? 'canonical-unreachable-arm-erasure-candidate' : 'canonical-conditional-predicate-candidate',
      transformAuthorization:false, renderValidation:'required', bodyValidation:body ? 'proved-no-phi-flat-stores' : 'required',
      conditionValidation:condition ? 'proved' : 'required', conditionPlanId:condition?.plan.planId ?? null,
      pendingValidation:freeze([...(condition ? [] : ['rendered-condition-equivalence','copied-region-carrier']),
        ...(body ? [] : ['live-phi-render-correspondence']),'removed-entity-provenance']), region,
      removedRole:erased.role, liveRole:retained.role, removedNodes:erased.nodes,
      candidateNodes:freeze(candidateNodes), retainedHeader:region.header,
      retainedInstructions:structure.instructions, retainedPhis:structure.phis,
      retainedMemoryPhis:structure.memoryPhis, retainedEdges:structure.cfgEdges,
      queryHash:dead[0].queryHash, liveQueryHash:live[0].queryHash, domainQueryHash:reachability.domainQueryHash,
      proofRule:'canonical-entry-path-excludes-selected-arm-render-equivalence-unproved' });
    guard.check();
    if (readConditionalRegionReachabilityStructure(reachability, ir, guard.identity) !== structure
      || !readConditionalRegionStructure(structure, ir, guard.identity)) return reject('stale-region-erasure');
    if (condition && !condition.isCurrent()) return reject('stale-region-condition');
    issued.set(plan, { ir, guard, structure, reachability, body, conditionPlan:submitted.conditionPlan, projection:submitted.projection });
    return plan;
  } catch (error) { return reject(guard?.reason() ?? error.reason ?? 'region-erasure-unavailable'); }
}
