/** Candidate for one precise projection change: the body of an arm excluded
 * by the issued canonical entry-path proof. The producer's rendered condition
 * is not yet proved equivalent to that CBR, so this never authorizes deletion.
 */
import { stableDigest } from '../../core/identity/index.js';
import { readConditionalRegionStructure } from './conditional-region-structure.js';
import { readConditionalRegionReachabilityStructure } from './conditional-region-reachability.js';
import { queryRecord } from '../../symbolic/memory/data-input.js';
import { createQueryGuard, sameMemoryIdentity } from '../../symbolic/memory/query-state.js';

const issued = new WeakMap();
const LIMITS = Object.freeze({ workItems:32768, allocationUnits:32768 });
const OPTION_KEYS = new Set(['identity','timeoutMs','limits','signal','isCancelled','getCurrentIdentity','now']);
const freeze = Object.freeze;

export function readConditionalRegionErasure(plan, ir, identity) {
  const binding = issued.get(plan);
  try {
    if (!binding || binding.ir !== ir || !sameMemoryIdentity(binding.guard.identity, identity)) return null;
    binding.guard.check(identity);
    return readConditionalRegionReachabilityStructure(binding.reachability, ir, identity) === binding.structure
      && readConditionalRegionStructure(binding.structure, ir, identity)
      && sameMemoryIdentity(binding.guard.identity, identity) ? plan : null;
  } catch { return null; }
}

export function prepareConditionalRegionErasure(structure, reachability, ir, options = {}) {
  let guard;
  const reject = reason => freeze({ version:1, status:'partial', reason, transformAuthorization:false });
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
    const erased = region.arms.find(arm => arm.role === dead[0].role);
    const retained = region.arms.find(arm => arm.role === live[0].role);
    guard.take('workItems', region.nodes.length + structure.instructions.length + structure.phis.length + structure.memoryPhis.length);
    guard.take('allocationUnits', region.nodes.length * 2 + erased.nodes.length);
    const removed = new Set(erased.nodes);
    if (!removed.size) return reject('empty-unreachable-arm');
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
      domainQueryHash:reachability.domainQueryHash, liveQueryHash:live[0].queryHash });
    const plan = freeze({ version:1, status:'complete', planId, beforeHash, afterHash, identity:guard.identity,
      scope:'canonical-unreachable-arm-erasure-candidate',
      transformAuthorization:false, renderValidation:'required',
      pendingValidation:freeze(['rendered-condition-equivalence','copied-region-carrier',
        'live-phi-render-correspondence','removed-entity-provenance']), region,
      removedRole:erased.role, liveRole:retained.role, removedNodes:erased.nodes,
      candidateNodes:freeze(candidateNodes), retainedHeader:region.header,
      retainedInstructions:structure.instructions, retainedPhis:structure.phis,
      retainedMemoryPhis:structure.memoryPhis, retainedEdges:structure.cfgEdges,
      queryHash:dead[0].queryHash, liveQueryHash:live[0].queryHash, domainQueryHash:reachability.domainQueryHash,
      proofRule:'canonical-entry-path-excludes-selected-arm-render-equivalence-unproved' });
    guard.check();
    if (readConditionalRegionReachabilityStructure(reachability, ir, guard.identity) !== structure
      || !readConditionalRegionStructure(structure, ir, guard.identity)) return reject('stale-region-erasure');
    issued.set(plan, { ir, guard, structure, reachability });
    return plan;
  } catch (error) { return reject(guard?.reason() ?? error.reason ?? 'region-erasure-unavailable'); }
}
