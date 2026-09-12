/** One call-target envelope, with candidate discovery separated from admission. */
import { createEntityId, deepFreeze, stableStringify, lossyTypeWitness } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../../core/identity/world.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, stringSet, compareIdentity, contractFail } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork, workStopStatus } from '../../core/budgets/scoped-work.js';
import { createSetEnvelope, qualifySetEnvelope, setExistenceVerdict } from '../../core/evidence/set-envelope.js';
import { assertCanonicalQueryProjection } from '../query/semantic/projection.js';
import { classifyCallTargetProof } from '../summary/contract.js';

export const DISPATCH_QUERY_SCHEMA = 'unified-dispatch-query/v1';
export const DISPATCH_RESULT_SCHEMA = 'unified-dispatch-result/v1';
export const DISPATCH_FAMILIES = Object.freeze([
  'direct', 'register', 'jump-table', 'tail-call', 'cpp-vtable', 'objc-msgsend', 'swift-witness',
  'swift-metadata', 'closure', 'objc-block', 'callback', 'dispatch-handler', 'import-stub',
  'chained-fixup', 'authenticated-pointer', 'thunk-chain',
]);
const sameValue = (a, b) => stableStringify(a) === stableStringify(b) && stableStringify(lossyTypeWitness(a)) === stableStringify(lossyTypeWitness(b));
const REGISTRIES = new WeakSet();

export function normalizeDispatchQuery(value) {
  const input = snapshotContractData(value, { maxBytes: 262144 });
  recordFields(input, ['schema', 'functionId', 'callSiteId', 'families', 'maxTargets', 'maxHops'], 'dispatch-query-fields');
  if (input.schema !== undefined && input.schema !== DISPATCH_QUERY_SCHEMA) contractFail('dispatch-query-schema');
  const families = stringSet(input.families ?? DISPATCH_FAMILIES, 'dispatch-query-families', DISPATCH_FAMILIES.length);
  if (!families.length || families.some((family) => !DISPATCH_FAMILIES.includes(family))) contractFail('dispatch-query-family');
  return deepFreeze({ schema: DISPATCH_QUERY_SCHEMA,
    functionId: exactString(input.functionId, 'dispatch-query-function'), callSiteId: exactString(input.callSiteId, 'dispatch-query-call-site'), families,
    maxTargets: exactInteger(input.maxTargets ?? 128, 'dispatch-query-target-budget', { min: 1, max: 4096 }),
    maxHops: exactInteger(input.maxHops ?? 8, 'dispatch-query-hop-budget', { min: 1, max: 64 }) });
}

/** Host-only resolvers; registering one is NOT evidence that it can prove targets. */
export class DispatchResolverRegistry {
  #entries = new Map(); #revision = 0; #notify;
  constructor({ onMembershipChange = null } = {}) {
    if (onMembershipChange !== null && typeof onMembershipChange !== 'function') contractFail('dispatch-registry-notifier');
    this.#notify = onMembershipChange; REGISTRIES.add(this);
  }
  get revision() { return this.#revision; }
  register({ id, version, families, resolve }) {
    exactString(id, 'dispatch-resolver-id'); exactString(version, 'dispatch-resolver-version');
    const kinds = stringSet(families, 'dispatch-resolver-families', DISPATCH_FAMILIES.length);
    if (!kinds.length || kinds.some((kind) => !DISPATCH_FAMILIES.includes(kind)) || typeof resolve !== 'function') contractFail('dispatch-resolver-contract');
    if (this.#entries.has(id) || this.#entries.size >= 32) contractFail('dispatch-resolver-capacity');
    // Invalidation happens BEFORE the membership update. A failing invalidator
    // vetoes registration instead of publishing stale negative cache entries.
    this.#notify?.({ kind: 'add', id, families: kinds });
    const entry = Object.freeze({ id, version, families: kinds, resolve });
    this.#entries.set(id, entry); this.#revision++;
    return () => {
      if (this.#entries.get(id) !== entry) return;
      this.#notify?.({ kind: 'remove', id, families: kinds });
      this.#entries.delete(id); this.#revision++;
    };
  }
  descriptors(families = DISPATCH_FAMILIES) {
    return deepFreeze([...this.#entries.values()].filter((entry) => entry.families.some((family) => families.includes(family)))
      .sort((a, b) => compareIdentity(a.id, b.id)).map(({ id, version, families }) => ({ id, version, families })));
  }
  async resolve(descriptor, request, context, work) {
    assertScopedAnalysisWork(work);
    const entry = this.#entries.get(descriptor.id);
    if (!entry || entry.version !== descriptor.version) return { status: 'stale', reason: 'dispatch-resolver-changed' };
    const revision = this.#revision;
    const response = await work.await((signal) => entry.resolve(request, { ...context, signal, work }));
    if (this.#entries.get(entry.id) !== entry || revision !== this.#revision) return { status: 'stale', reason: 'dispatch-registry-changed' };
    const data = snapshotContractData(response, { allowBigInt: true, maxBytes: 1048576, maxNodes: 16384 });
    recordFields(data, ['status', 'reason', 'worldId', 'assumptionsId', 'projectionId', 'callSiteId', 'candidates', 'requirements', 'chains'], 'dispatch-resolver-response');
    if (data.worldId !== context.world.id || data.assumptionsId !== context.assumptions.id
      || data.projectionId !== context.projection.id || data.callSiteId !== request.callSiteId) contractFail('dispatch-resolver-response-unbound');
    exactEnum(data.status, ['completed', 'partial', 'unsupported'], 'dispatch-resolver-status');
    if (!Array.isArray(data.candidates) || data.candidates.length > request.maxTargets) contractFail('dispatch-resolver-candidate-cap');
    if (!Array.isArray(data.chains ?? []) || (data.chains?.length ?? 0) > request.maxTargets) contractFail('dispatch-resolver-chain-cap');
    for (const chain of data.chains ?? []) {
      if (!Array.isArray(chain) || chain.length > request.maxHops) contractFail('dispatch-resolver-hop-cap');
      for (const hop of chain) {
        recordFields(hop, ['from', 'to', 'family', 'evidenceIds', 'requirements'], 'dispatch-hop-fields');
        exactString(hop.from, 'dispatch-hop-source'); exactString(hop.to, 'dispatch-hop-target');
        exactEnum(hop.family, DISPATCH_FAMILIES, 'dispatch-hop-family');
        stringSet(hop.evidenceIds ?? []); stringSet(hop.requirements ?? []);
      }
    }
    return data;
  }
}

function candidate(input, source, world) {
  recordFields(input, ['targetEntityId', 'binaryId', 'address', 'family', 'evidenceIds', 'requirements', 'score', 'provenance'], 'dispatch-candidate-fields');
  const targetEntityId = exactString(input.targetEntityId, 'dispatch-target-id');
  const binaryId = input.binaryId == null ? null : exactString(input.binaryId, 'dispatch-target-binary');
  const requirements = stringSet(input.requirements ?? []);
  if (binaryId !== null && !worldContains(world, binaryId)) requirements.push('target-image-not-in-world');
  const address = input.address == null ? null : exactString(input.address, 'dispatch-target-address');
  if (address !== null && !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(address)) contractFail('dispatch-target-canonical-address');
  if (address !== null && BigInt(address) >= (1n << 64n)) contractFail('dispatch-target-address-width');
  const family = exactEnum(input.family, DISPATCH_FAMILIES, 'dispatch-target-family');
  const evidenceIds = stringSet(input.evidenceIds ?? []);
  if (input.score !== undefined && (typeof input.score !== 'number' || !Number.isFinite(input.score) || input.score < 0 || input.score > 1)) contractFail('dispatch-candidate-score');
  let provenance = null;
  if (input.provenance !== undefined) {
    const value = snapshotContractData(input.provenance, { allowBigInt: true, maxBytes: 65536, maxNodes: 4096 });
    recordFields(value, ['schema', 'id', 'worldId', 'binaryId', 'artifactId', 'ownerRevision', 'declaration'], 'dispatch-provenance-fields');
    if (value.schema !== 'dispatch-owner-reference/v1' || value.worldId !== world.id
      || value.binaryId !== binaryId) contractFail('dispatch-provenance-world-binding');
    exactString(value.id, 'dispatch-provenance-id'); exactString(value.artifactId, 'dispatch-provenance-artifact');
    exactString(value.ownerRevision, 'dispatch-provenance-revision');
    provenance = { ...value, authority: 'unqualified-owner-reference-not-proof' };
  }
  return { item: { id: targetEntityId, value: { targetEntityId, binaryId, address }, evidenceIds },
    ...(provenance === null ? {} : { provenance }), source, ...(input.score === undefined ? {} : { score: input.score }), family, requirements: stringSet(requirements) };
}

/**
 * Resolve a single canonical call. The default only projects the existing
 * target classifier; language/PAC/thunk providers contribute CANDIDATES.
 * `admit` is a trusted in-process proof adapter and cannot be sent by Astra.
 */
export async function resolveUnifiedDispatch(projection, input, { world, assumptions, work, registry = null, admit = null, nativeContext = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  assertCanonicalQueryProjection(projection, { world, assumptions });
  const query = normalizeDispatchQuery(input);
  if (query.functionId !== projection.functionId) contractFail('dispatch-function-projection-mismatch');
  if (registry !== null && !REGISTRIES.has(registry)) contractFail('dispatch-resolver-registry-untrusted');
  if (admit !== null && typeof admit !== 'function') contractFail('dispatch-admission-hook');
  let node = null, nodeReference = null;
  for (let i = 0; i < projection.size; i++) {
    work.charge('workUnits');
    const record = projection.recordAt(i);
    if (record.owner === 'semantic-ir' && record.entityId === query.callSiteId) {
      node = projection.source(record.id); nodeReference = record.reference; break;
    }
    await work.yieldIfNeeded();
  }
  if (!node?.call) return deepFreeze({ schema: DISPATCH_RESULT_SCHEMA, status: 'unsupported', reason: 'canonical-call-site-not-found', candidates: [], exact: false, cost: work.cost() });
  const proof = classifyCallTargetProof(node.call), candidates = [], requirements = [], chains = [], conflicts = [];
  const revision = registry?.revision ?? 0;
  let status = 'completed';
  try {
    const source = `semantic-call:${projection.inputIdentity.ownerDigests.ir}`;
    for (const target of proof.candidateEntityIds) {
      work.charge('results'); work.charge('workUnits');
      if (candidates.length >= query.maxTargets) { requirements.push('target-result-budget'); break; }
      candidates.push(candidate({ targetEntityId: target, family: proof.kind === 'direct' ? 'direct' : 'register',
        evidenceIds: [node.id], requirements: ['call-target-scope-qualification-required'] }, source, world));
    }
    for (const descriptor of registry?.descriptors(query.families) ?? []) {
      const result = await registry.resolve(descriptor, query, { world, assumptions, projection, nodeReference, nativeContext }, work);
      if (result.status === 'stale') { status = 'stale'; requirements.push(result.reason); break; }
      requirements.push(...stringSet(result.requirements ?? []));
      if (result.status !== 'completed') requirements.push(`resolver-${result.status}:${descriptor.id}`);
      for (const value of result.candidates) {
        work.charge('workUnits'); work.charge('results');
        if (candidates.length >= query.maxTargets) { requirements.push('target-result-budget'); break; }
        candidates.push(candidate(value, `${descriptor.id}@${descriptor.version}`, world));
      }
      for (const chain of result.chains ?? []) {
        if (chains.length >= query.maxTargets) { requirements.push('dispatch-chain-result-budget'); break; }
        work.charge('workUnits', chain.length); work.charge('residentBytes', chain.length * 256);
        chains.push(chain);
      }
      await work.yieldIfNeeded();
    }
  } catch (error) {
    const stopped = workStopStatus(error, work.signal);
    if (!stopped) throw error;
    status = stopped; requirements.push(stopped);
  }
  if (registry && revision !== registry.revision) { status = 'stale'; requirements.push('dispatch-resolver-membership-changed'); }
  const identities = new Map();
  for (const entry of candidates) {
    const previous = identities.get(entry.item.id);
    if (previous && !sameValue(previous.value, entry.item.value)) conflicts.push(entry.item.id);
    else identities.set(entry.item.id, entry.item);
    requirements.push(...entry.requirements);
  }
  if (!proof.exhaustive) requirements.push('indirect-target-world-open');
  if (world.environment.dynamicLoading === 'open') requirements.push('dynamic-image-membership-open');
  if (world.environment.interposition !== 'excluded-with-evidence') requirements.push('interposition-not-excluded');
  requirements.push('normal-target-vs-trap-domain-not-qualified');
  if (conflicts.length) requirements.push('target-identity-conflict');
  const proposedUpper = proof.exhaustive && status === 'completed' && !conflicts.length
    ? { kind: 'finite', members: proof.candidateEntityIds.map((id) => identities.get(id)).filter(Boolean), evidenceIds: [node.id] }
    : { kind: 'top', domain: 'normal-call-targets' };
  // A bounded candidate list that dropped a canonical target cannot serve even
  // as the proposed upper. The admitted upper remains unknown until replay.
  if (proposedUpper.kind === 'finite' && proposedUpper.members.length !== proof.candidateEntityIds.length) {
    proposedUpper.kind = 'top'; delete proposedUpper.members; delete proposedUpper.evidenceIds; proposedUpper.domain = 'normal-call-targets';
  }
  const envelope = createSetEnvelope({ domain: 'normal-call-targets', provenMembers: [], upper: proposedUpper,
    rankedCandidates: candidates.map(({ item, source, score }) => ({ item, source, ...(score === undefined ? {} : { score }) })),
    closure: { status: 'open', certificate: null, frontier: stringSet(requirements) } }, { world, maxMembers: query.maxTargets });
  let admitted = qualifySetEnvelope(envelope, { world, assumptions });
  if (admit && status === 'completed' && !conflicts.length) {
    try {
      const judgments = await work.await((signal) => admit(envelope, { world, assumptions, projection, nodeReference, signal }));
      // Raw / deserialized judgments fail the process-local qualification gate.
      admitted = qualifySetEnvelope(envelope, { ...judgments, world, assumptions });
    } catch (error) {
      const stopped = workStopStatus(error, work.signal);
      if (!stopped) throw error;
      status = stopped;
    }
  }
  const body = { schema: DISPATCH_RESULT_SCHEMA, status, worldId: world.id, assumptionsId: assumptions.id,
    projectionId: projection.id, callSite: nodeReference, query, candidates, chains, conflicts: stringSet(conflicts),
    envelope: admitted, existence: setExistenceVerdict(admitted), exact: admitted.exact,
    producerClassification: { ...proof, authority: 'existing-owner-classification; not-world-closure-proof' },
    unsupportedFamilies: query.families.filter((kind) => !['direct', 'register'].includes(kind)
      && !(registry?.descriptors([kind]).length)), remaining: stringSet(requirements), cost: work.cost() };
  const { cost: _cost, ...identity } = body;
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: DISPATCH_RESULT_SCHEMA, identity });
  return deepFreeze({ ...body, id });
}
