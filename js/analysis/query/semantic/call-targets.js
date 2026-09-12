/** Selected canonical target references, not discovery or target-set closure. */
import { deepFreeze, stableStringify } from '../../../core/identity/index.js';
import { unsignedAddress, contractFail } from '../../../core/identity/structured.js';
import { assertCanonicalQueryProjection } from './projection.js';

const keyFor = (binaryId, sliceId, address) => JSON.stringify([binaryId, sliceId, address]);
export function indexScopedFunctionEntries(projections) {
  if (!Array.isArray(projections) || projections.length > 32) contractFail('scoped-call-entry-budget');
  const functions = new Map(), addresses = new Map();
  for (const projection of projections) {
    assertCanonicalQueryProjection(projection);
    if (functions.has(projection.functionId)) contractFail('scoped-call-function-duplicate');
    functions.set(projection.functionId, projection);
    const location = projection.inputIdentity.sourceLocation;
    if (!location) continue;
    const key = keyFor(location.binaryId, location.sliceId, location.start);
    const entries = addresses.get(key) ?? []; entries.push(projection); addresses.set(key, entries);
  }
  return { functions, addresses };
}
function literalTarget(projection, valueId) {
  const value = projection.canonicalValue(valueId);
  if (!value || !['bitvector', 'address'].includes(value.machineType?.kind) || value.machineType.widthBits !== 64) return null;
  const reference = projection.entityReference('semantic-ir', value.definitionNodeId);
  const definition = reference ? projection.source(reference) : null, constant = value.metadata?.constant;
  if (definition?.kind !== 'const' || !definition.outputs?.includes(valueId)
    || constant?.kind !== 'bitvector' || constant.widthBits !== 64 || constant.value == null
    || stableStringify(constant) !== stableStringify(definition.attributes?.constant)) return null;
  let address;
  try { address = unsignedAddress(constant.value, { bits: 64 }); } catch { return null; }
  return { address, valueId, definitionId: definition.id, reference };
}
/** A range view must be captured from the same native invocation. It cannot
 * resolve discovery, execution feasibility, authentication or image closure.
 * This adapter reuses Phase8 facts rather than evaluating expression trees.
 */
export function assertNativeTargetDemand(demand, projection) {
  if (demand == null) return null;
  const input = projection.inputIdentity;
  if (demand.schema !== 'scoped-local-owner-projection/v1' || demand.kind !== 'demand'
    || demand.status !== 'completed' || demand.worldId !== input.worldId
    || demand.assumptionsId !== input.assumptionsId || demand.snapshotId !== input.snapshotId
    || demand.functionId !== projection.functionId || demand.binaryId !== input.binaryId
    || !Array.isArray(demand.ranges?.bindings) || demand.ranges.bindings.length > 128
    || !Array.isArray(demand.ranges?.values) || demand.ranges.values.length > 128) contractFail('native-target-demand-binding');
  return demand;
}
function rangedTarget(projection, valueId, demand) {
  if (!demand || demand.ranges.status !== 'completed') return null;
  const value = projection.canonicalValue(valueId);
  if (!value || !['bitvector', 'address'].includes(value.machineType?.kind) || value.machineType.widthBits !== 64) return null;
  const bindings = demand.ranges.bindings.filter(row => row.semanticValueId === valueId || row.semanticSsaValueId === valueId);
  const localIds = new Set(bindings.map(binding => binding.localId));
  const rows = demand.ranges.values.filter(row => localIds.has(row.localId));
  if (!rows.length || rows.some(row => row.completeness !== 'complete' || row.conditionalOn?.length
    || row.fact?.bits !== 64 || row.fact.constant?.value == null)) return null;
  const constants = new Set(rows.map(row => String(row.fact.constant.value)));
  if (constants.size !== 1) return null;
  let address;
  try { address = unsignedAddress([...constants][0], { bits: 64 }); } catch { return null; }
  return { address, valueId, definitionId: value.definitionNodeId,
    reference: projection.entityReference('semantic-ir', value.definitionNodeId),
    rangeFactIds: rows.map(row => row.entityId).sort(), source: 'existing-phase8-unconditional-constant',
    exact: false, callFeasibility: 'unknown' };
}
/** A caller debits each row before committing its cursor. Bounded range lookup
 * inspects at most 128 bindings/facts per target; native callers precharge that
 * deterministic work before entering this synchronous iterator.
 */
export function* scopedCallTargetRows(projection, node, index, nativeDemand = null) {
  assertCanonicalQueryProjection(projection);
  if (!(index?.functions instanceof Map) || !(index.addresses instanceof Map)) contractFail('scoped-call-index');
  if (!node?.call) return;
  const demand = assertNativeTargetDemand(nativeDemand, projection);
  const recordId = projection.entityReference('semantic-ir', node.id);
  if (!recordId || projection.source(recordId) !== node) contractFail('scoped-call-node-not-owned');
  const declared = node.call.targetEntityIds ?? [], values = node.call.targetValueIds ?? [];
  if (declared.length > 64 || values.length > 64) {
    yield { reason: 'call-target-fanout-cut', targetFunctionId: null, address: null, exact: false, closed: false, inSelectedScope: false }; return;
  }
  const caller = projection.inputIdentity, seen = new Set();
  const common = { callerFunctionId: projection.functionId, callSiteId: node.id, callSiteReference: recordId,
    exact: false, closed: false, authority: 'selected-canonical-target-reference; not-executable-target-proof' };
  for (const id of declared) {
    const target = index.functions.get(id), location = target?.inputIdentity.sourceLocation;
    if (seen.has(id)) continue; seen.add(id);
    yield deepFreeze({ ...common, targetFunctionId: id, address: location?.start ?? null,
      inSelectedScope: Boolean(target), reason: target ? null : 'callee-outside-explicit-scope',
      source: 'canonical-call-target-entity', sourceBinding: { callerInput: caller, calleeInput: target?.inputIdentity ?? null } });
  }
  for (const id of values) {
    const literal = literalTarget(projection, id) ?? rangedTarget(projection, id, demand);
    const ranged = Boolean(literal?.rangeFactIds);
    if (!literal) {
      yield deepFreeze({ ...common, targetFunctionId: null, address: null, inSelectedScope: false,
        source: 'unresolved-canonical-target-value', valueId: id, reason: 'target-value-is-not-a-bound-64-bit-literal' });
      continue;
    }
    const location = caller.sourceLocation;
    const targets = location ? index.addresses.get(keyFor(caller.binaryId, location.sliceId, literal.address)) ?? [] : [];
    if (!targets.length) yield deepFreeze({ ...common, targetFunctionId: null, address: literal.address, inSelectedScope: false,
      source: ranged ? 'native-range-target' : 'canonical-literal-target', reason: location ? 'literal-target-outside-selected-entries' : 'caller-source-location-unbound',
      sourceBinding: { callerInput: caller, literal } });
    for (const target of targets) {
      if (seen.has(target.functionId)) continue; seen.add(target.functionId);
      yield deepFreeze({ ...common, targetFunctionId: target.functionId, address: literal.address, inSelectedScope: true,
        source: ranged ? 'native-range-to-selected-entry' : 'canonical-literal-to-selected-entry', reason: targets.length > 1 ? 'multiple-selected-functions-share-entry' : null,
        sourceBinding: { callerInput: caller, calleeInput: target.inputIdentity, literal } });
    }
  }
  if (!declared.length && !values.length) yield deepFreeze({ ...common, targetFunctionId: null,
    address: null, inSelectedScope: false, source: 'unresolved', reason: 'canonical-call-target-unavailable' });
}
