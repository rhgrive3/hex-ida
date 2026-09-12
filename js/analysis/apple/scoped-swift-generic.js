/** Read-only projection of source-bound Swift generic declarations. This is not
 * a metadata parser or a second type engine. Substitution only follows explicit
 * host-owned parameter bindings and the existing nominal/conformance index.
 * Even a consistent declaration does not prove a runtime instantiation.
 */
import { createEntityId, deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../../core/identity/index.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, unsignedAddress, contractFail } from '../../core/identity/structured.js';
export const SWIFT_GENERIC_ENVIRONMENT_SCHEMA = 'swift-generic-environment-declarations/v1';
const typedDigest = value => stableDigest({ value, typed: lossyTypeWitness(value) });
const parameterKey = value => `${value.depth}:${value.index}`;
function parameter(value) {
  recordFields(value, ['depth', 'index'], 'swift-generic-parameter-fields');
  return { depth: exactInteger(value.depth, 'swift-generic-depth', { max: 63 }), index: exactInteger(value.index, 'swift-generic-index', { max: 4095 }) };
}
/** Only explicit nominal and dependent-member terms are supported. An address
 * of a generic nominal descriptor is NOT the identity of an instantiation.
 */
export function projectSwiftGenericEnvironment(value, { expectedId, binding, index, work }) {
  assertScopedAnalysisWork(work); work.checkpoint();
  if (expectedId === null) { if (value != null) contractFail('swift-generic-unbound-environment'); return null; }
  exactString(expectedId, 'swift-generic-environment-id');
  const missing = reason => deepFreeze({ schema: 'swift-generic-environment-view/v1', id: expectedId,
    status: 'partial', constraints: [], substitutions: [], conflicts: [], remaining: [reason], semantic: 'unknown', exact: false });
  if (value == null) return missing('swift-generic-environment-owner-unavailable');
  const data = snapshotContractData(value, { allowBigInt: true, maxBytes: 16384, maxNodes: 2048 });
  work.charge('residentBytes', stableStringify(data).length * 2 + 16384);
  recordFields(data, ['schema', 'id', 'binding', 'parameters', 'substitutions', 'requirements', 'complete'], 'swift-generic-environment-fields');
  if (data.schema !== SWIFT_GENERIC_ENVIRONMENT_SCHEMA || data.id !== expectedId) contractFail('swift-generic-environment-identity');
  if (stableStringify([data.binding, lossyTypeWitness(data.binding)]) !== stableStringify([binding, lossyTypeWitness(binding)])) contractFail('swift-generic-environment-source-binding');
  if (typeof data.complete !== 'boolean') contractFail('swift-generic-environment-completeness');
  if (!Array.isArray(data.parameters) || data.parameters.length > 32 || !Array.isArray(data.substitutions) || data.substitutions.length > 64
    || !Array.isArray(data.requirements) || data.requirements.length > 64) contractFail('swift-generic-environment-count-bound');
  const parameters = new Map(), substitutions = new Map(), requirements = [], requirementIds = new Set();
  const remaining = new Set(['swift-generic-source-binding-not-independently-checked', 'swift-runtime-generic-instantiation-not-proved']);
  if (!data.complete) remaining.add('swift-generic-environment-incomplete');
  for (const raw of data.parameters) {
    work.charge('workUnits'); const p = parameter(raw), key = parameterKey(p);
    if (parameters.has(key)) contractFail('swift-generic-duplicate-parameter'); parameters.set(key, p);
  }
  function term(raw, depth = 0) {
    work.charge('workUnits'); if (depth > 8) contractFail('swift-generic-term-depth');
    const kind = exactEnum(raw?.kind, ['parameter', 'nominal', 'dependent-member'], 'swift-generic-term-kind');
    if (kind === 'parameter') {
      recordFields(raw, ['kind', 'parameter'], 'swift-generic-parameter-term-fields'); const p = parameter(raw.parameter);
      if (!parameters.has(parameterKey(p))) contractFail('swift-generic-undeclared-parameter'); return { kind, parameter: p };
    }
    if (kind === 'nominal') {
      recordFields(raw, ['kind', 'binaryId', 'sliceId', 'address'], 'swift-generic-nominal-fields');
      return { kind, binaryId: exactString(raw.binaryId, 'swift-generic-type-binary'), sliceId: exactString(raw.sliceId, 'swift-generic-type-slice'), address: unsignedAddress(raw.address) };
    }
    recordFields(raw, ['kind', 'base', 'protocolAddress', 'name'], 'swift-generic-dependent-member-fields');
    return { kind, base: term(raw.base, depth + 1), protocolAddress: unsignedAddress(raw.protocolAddress), name: exactString(raw.name, 'swift-generic-member-name', 256) };
  }
  for (const raw of data.substitutions) {
    work.charge('workUnits'); recordFields(raw, ['parameter', 'value'], 'swift-generic-substitution-fields');
    const p = parameter(raw.parameter), key = parameterKey(p);
    if (!parameters.has(key)) contractFail('swift-generic-undeclared-parameter');
    if (!substitutions.has(key)) substitutions.set(key, new Map()); const v = term(raw.value);
    substitutions.get(key).set(stableStringify(v), v); // identical declarations coalesce; alternatives never do
  }
  for (const raw of data.requirements) {
    work.charge('workUnits'); const id = exactString(raw.id, 'swift-generic-requirement-id', 256);
    if (requirementIds.has(id)) contractFail('swift-generic-duplicate-requirement'); requirementIds.add(id);
    const kind = exactEnum(raw.kind, ['same-type', 'conformance', 'superclass', 'layout'], 'swift-generic-requirement-kind');
    const fields = ['id', 'kind', 'left', ...(kind === 'conformance' ? ['protocolAddress'] : kind === 'layout' ? ['layout'] : ['right'])];
    recordFields(raw, fields, 'swift-generic-requirement-fields');
    requirements.push({ id, kind, left: term(raw.left), ...(kind === 'conformance' ? { protocolAddress: unsignedAddress(raw.protocolAddress) }
      : kind === 'layout' ? { layout: exactString(raw.layout, 'swift-generic-layout-description', 256) } : { right: term(raw.right) }) });
  }
  const conflicts = [];
  for (const [key, alternatives] of substitutions) if (alternatives.size > 1) conflicts.push({ kind: 'ambiguous-substitution', parameter: parameters.get(key), alternatives: [...alternatives.values()] });
  function normalize(value, path = new Set()) {
    work.charge('workUnits');
    if (value.kind === 'nominal') {
      const type = value.binaryId === binding.binaryId && value.sliceId === binding.sliceId && index?.typesByAddress?.get(BigInt(value.address).toString());
      if (!type || type.address == null || unsignedAddress(type.address) !== value.address) return { term: value, resolved: false, reason: 'swift-generic-nominal-not-in-bound-owner' };
      if (type.generic !== false) return { term: value, resolved: false, reason: 'swift-generic-nominal-instantiation-unavailable' };
      return { term: value, resolved: true, reason: 'existing-owner-nominal-address' };
    }
    if (value.kind === 'dependent-member') {
      const base = normalize(value.base, path);
      return { term: { ...value, base: base.term }, resolved: false, reason: 'swift-associated-type-witness-substitution-unavailable' };
    }
    const key = parameterKey(value.parameter), alternatives = substitutions.get(key);
    if (path.has(key)) return { term: value, resolved: false, reason: 'swift-generic-substitution-cycle' };
    if (!alternatives?.size) return { term: value, resolved: false, reason: 'swift-generic-parameter-unbound' };
    if (alternatives.size !== 1) return { term: value, resolved: false, reason: 'swift-generic-substitution-ambiguous' };
    return normalize(alternatives.values().next().value, new Set([...path, key]));
  }
  const substitutionsView = [...parameters].map(([key, p]) => {
    const normalized = normalize({ kind: 'parameter', parameter: p }); if (!normalized.resolved) remaining.add(normalized.reason);
    return { parameter: p, declaredAlternatives: [...(substitutions.get(key)?.values() ?? [])], ...normalized };
  });
  const constraints = [];
  for (const requirement of requirements) {
    const left = normalize(requirement.left), right = requirement.right ? normalize(requirement.right) : null;
    let status = 'UNKNOWN', reason;
    if (!left.resolved || right && !right.resolved) reason = !left.resolved ? left.reason : right.reason;
    else if (requirement.kind === 'same-type') {
      status = stableStringify(left.term) === stableStringify(right.term) ? 'declaration-consistent' : 'declaration-conflict';
      reason = 'bound-owner-nominal-address-comparison-only';
    } else if (requirement.kind === 'conformance') {
      const protocol = index?.protocolsByAddress?.get(BigInt(requirement.protocolAddress).toString());
      const declarations = index?.conformancesByType?.get(`type@${BigInt(left.term.address)}`) ?? [];
      if (!Array.isArray(declarations) || declarations.length > 4096) contractFail('swift-generic-conformance-budget');
      work.charge('workUnits', declarations.length + 1);
      const matching = declarations.filter(row => row.protocol != null && unsignedAddress(row.protocol) === requirement.protocolAddress);
      if (protocol && unsignedAddress(protocol.address) === requirement.protocolAddress && matching.length === 1
        && matching[0].conditionalRequirements === 0 && matching[0].resilientWitnesses === false) {
        status = 'declaration-consistent'; reason = 'existing-unconditional-conformance-declaration-only';
      } else reason = matching.length > 1 ? 'swift-generic-conformance-collision' : 'swift-generic-conformance-layout-unqualified';
    } else reason = requirement.kind === 'superclass' ? 'swift-generic-superclass-owner-not-connected' : 'swift-generic-layout-owner-not-connected';
    if (status === 'UNKNOWN') remaining.add(reason);
    if (status === 'declaration-conflict') conflicts.push({ kind: 'same-type', requirementId: requirement.id, left: left.term, right: right.term });
    constraints.push({ id: requirement.id, kind: requirement.kind, declaration: requirement, left, right, status, reason, semantic: 'unknown' });
  }
  if (conflicts.length) remaining.add('swift-generic-declaration-conflicts-unresolved');
  const view = { schema: 'swift-generic-environment-view/v1', environmentId: data.id, sourceBinding: data.binding,
    completeDeclaredInventory: data.complete, substitutions: substitutionsView, constraints, conflicts,
    status: conflicts.length ? 'declaration-conflict' : !data.complete || constraints.some(row => row.status === 'UNKNOWN') || substitutionsView.some(row => !row.resolved) ? 'partial' : 'declaration-consistent',
    remaining: [...remaining].sort(), semantic: 'unknown', exact: false, authority: 'host-declared-generic-constraints-not-runtime-proof' };
  snapshotContractData(view, { maxBytes: 32768, maxNodes: 4096 });
  work.checkpoint();
  return deepFreeze({ ...view, id: createEntityId({ binaryId: binding.binaryId, kind: 'swift-generic-environment-view', identity: typedDigest(view) }) });
}
