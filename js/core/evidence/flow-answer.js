/** Atomic flow answer assembly over the canonical EvidenceGraph/ArtifactStore.
 * This is an explanation export, not another analysis owner or a proof oracle.
 */
import { EvidenceGraph } from './index.js';
import { createScopedJudgmentCandidate, qualifyScopedJudgment, scopedJudgmentClaim } from './scoped.js';
import { INTEGER_FRAGMENT_KIND } from './arm64-integer-fragment.js';
import { exportEvidenceCertificate } from './certificate.js';
import { createArtifactDescriptor } from '../artifacts/contracts.js';
import { assertWorldScope, assertAssumptionSet } from '../identity/world.js';
import { createEntityId, deepFreeze, jsonSafe, stableStringify, stableDigest, lossyTypeWitness } from '../identity/index.js';
import { snapshotContractData, contractFail } from '../identity/structured.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';

export const FLOW_ANSWER_SCHEMA = 'flow-answer/v1';
export const FLOW_ANSWER_BUNDLE_SCHEMA = 'scpa-flow-answer-publication/v1';
const family = owner => owner === 'semantic-ir' ? 'SemanticEvidence' : 'DataflowEvidence';

export async function assembleFlowAnswer({ plan, result, members, specializations, dispatchBounds, slices,
  frontier = [], investigation = null, world, assumptions, snapshotId, dependencies, work, readRange = null, isCurrent } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  const check = () => { work.checkpoint(); if (isCurrent?.() !== true) contractFail('flow-answer-stale'); };
  check();
  if (!Array.isArray(members) || members.length > 8 || !Array.isArray(specializations) || specializations.length > 32
    || !Array.isArray(dispatchBounds) || dispatchBounds.length > 128 || !Array.isArray(slices) || slices.length > 64) contractFail('flow-answer-input-cap');
  const binaryId = world.binarySet[0].binaryId, graph = new EvidenceGraph({}, { maxNodes: 8192, maxEdges: 16384 });
  const referenceNodes = new Map(), entityNodes = new Map(), summaryNodes = new Map(), pendingEdges = [];
  const gaps = frontier.slice(0, 1024); let omittedGaps = Math.max(0, frontier.length - gaps.length);
  const gap = row => { if (gaps.length < 1024) gaps.push(row); else omittedGaps++; };
  const scope = { world: world.id, assumptions: assumptions.id, quantifier: 'candidate-only' };
  function addNode(kind, identity, payload, targetIds = [], origin = {}) {
    work.charge('workUnits'); work.charge('nodes');
    const id = createEntityId({ binaryId, kind: `scpa-evidence:${kind}`, identity: { worldId: world.id, snapshotId, ...identity } });
    graph.addNode({ id, family: kind, binaryId, targetEntityIds: targetIds, semanticKind: payload.reference ? 'scpa-canonical-owner-reference'
        : payload.owner === 'decompiler/phase8/sccp' ? 'scpa-demand-range-fact'
          : payload.owner === 'analysis/pointsto' ? 'scpa-demand-object-view'
            : payload.owner === INTEGER_FRAGMENT_KIND ? INTEGER_FRAGMENT_KIND : 'scoped-owner-reference',
      completeness: 'partial', deterministic: false, origin, payload: { scope, ...payload } });
    return id;
  }
  function edge(from, to, kind = 'derived-from', reason = 'canonical-owner-reference') {
    if (!from || !to || from === to) return;
    work.charge('edges'); work.charge('workUnits');
    graph.addEdge({ from, to, type: kind, metadata: { reason, worldId: world.id, semanticProof: false } });
  }
  function reference(row) {
    const record = row.record, ref = record?.reference;
    if (!ref || ref.snapshotId !== snapshotId || ref.binaryId !== binaryId) { gap({ reason: 'evidence-reference-binding-unavailable' }); return; }
    // Reference IDs are navigation identities. The node carries the whole owner
    // row and its type witness, so a digest alone cannot impersonate a premise.
    const payload = { reference: ref, ownerRow: jsonSafe(row.source), originalTypes: lossyTypeWitness(row.source),
      checkerLevel: 'integrity-only', authority: 'canonical-owner-reference-not-semantic-proof' };
    const id = addNode(family(record.owner), { referenceId: record.id }, payload, [record.entityId], record.origin ?? {});
    const old = referenceNodes.get(record.id);
    if (old && old !== id) contractFail('flow-answer-reference-collision');
    referenceNodes.set(record.id, id);
    const key = `${ref.functionId}\u0000${record.entityId}`;
    const list = entityNodes.get(key) ?? new Set(); list.add(id); entityNodes.set(key, list);
    for (const sourceId of record.origin?.instructionIds ?? []) {
      const sourceKey = `${ref.functionId}\u0000${sourceId}`;
      const sources = entityNodes.get(sourceKey) ?? new Set(); sources.add(id); entityNodes.set(sourceKey, sources);
    }
    return id;
  }
  for (const member of members) {
    check();
    for (const row of member.factReferences ?? []) reference(row);
    await work.yieldIfNeeded();
  }
  for (const slice of slices) {
    check();
    if (slice.worldId !== world.id || slice.assumptionsId !== assumptions.id || slice.snapshotId !== snapshotId) contractFail('flow-answer-slice-binding');
    for (const row of slice.records) reference(row);
    for (const link of slice.edges) pendingEdges.push(link);
    for (const source of slice.sources) {
      const id = addNode('BinaryEvidence', { binaryId: source.binaryId, offset: source.offset, length: source.length },
        { binaryId: source.binaryId, offset: source.offset, length: source.length, bytes: source.bytes, status: source.status, authority: 'current-source-bytes; instruction-meaning-not-proved' }, [],
        { byteRanges: [{ binaryId: source.binaryId, start: source.offset, end: (BigInt(source.offset) + BigInt(source.length)).toString() }] });
      for (const ref of source.referenceIds) edge(referenceNodes.get(ref), id, 'originates-from');
    }
    for (const row of slice.frontier?.entries ?? []) gap(row);
    omittedGaps += slice.frontier?.omittedEntries ?? 0;
    await work.yieldIfNeeded();
  }
  for (const link of pendingEdges) {
    if (!referenceNodes.has(link.to) || !referenceNodes.has(link.from)) { gap({ reason: 'result-edge-outside-explanation-cut', edgeId: link.id }); continue; }
    edge(referenceNodes.get(link.to), referenceNodes.get(link.from), 'derived-from', link.kind);
  }
  const ownerRoots = [], integerDerivations = [];
  for (const member of members) {
    check();
    const demand = member.demand;
    const id = addNode('DataflowEvidence', { functionId: member.functionId, summary: member.summary },
      { owner: 'analysis/summary/interprocedural', producerArtifactId: member.artifactId,
        summary: jsonSafe(member.summary), originalTypes: lossyTypeWitness(member.summary),
        summaryStatus: member.summary?.status ?? null, memorySsaOwner: member.inputIdentity.ownerDigests.memoryssa,
        closure: 'unknown' }, [member.functionId]);
    summaryNodes.set(member.functionId, id); ownerRoots.push(id);
    const effects = [...(member.summary?.memoryReadRegions ?? []), ...(member.summary?.memoryWriteRegions ?? [])];
    let linked = 0;
    for (const effect of effects) for (const entityId of effect.evidenceIds ?? []) {
      for (const target of entityNodes.get(`${member.functionId}\u0000${entityId}`) ?? []) { edge(id, target); linked++; }
    }
    if (effects.length && !linked) gap({ functionId: member.functionId, reason: 'summary-memory-premises-outside-evidence-cut' });
    for (const block of demand.blockCaptures?.views ?? []) {
      const blockId = addNode('DataflowEvidence', { functionId: member.functionId, block },
        { owner: 'apple/objc-runtime', functionId: member.functionId, blockCapture: jsonSafe(block),
          originalTypes: lossyTypeWitness(block), lifetimeAuthority: false }, [member.functionId]);
      edge(id, blockId, 'derived-from', 'native-block-capture-fields');
      for (const field of block.fields) for (const sourceId of [field.storeNodeId, field.memoryDefinitionId, field.valueId]) {
        for (const target of entityNodes.get(`${member.functionId}\u0000${sourceId}`) ?? []) edge(blockId, target);
      }
    }
    for (const view of demand.abiPlacements?.views ?? []) {
      const abiId = addNode('DataflowEvidence', { functionId: member.functionId, abiView: view },
        { owner: 'targets/abi', functionId: member.functionId, abiPlacement: jsonSafe(view),
          originalTypes: lossyTypeWitness(view), prototypeAuthority: false }, [member.functionId]);
      edge(id, abiId, 'derived-from', 'canonical-abi-physical-placement-input');
    }
    for (const access of demand.memoryObjects?.accesses ?? []) {
      const accessId = addNode('DataflowEvidence', { functionId: member.functionId, memoryAccess: access },
        { owner: 'semantics/memoryssa', functionId: member.functionId, memoryAccess: jsonSafe(access),
          originalTypes: lossyTypeWitness(access), aliasAuthority: false }, [access.nodeId, access.memoryEntityId]);
      edge(id, accessId, 'derived-from', 'canonical-memory-effect-input');
      for (const sourceId of [access.nodeId, access.memoryEntityId, access.addressValueId, ...access.valueIds]) {
        for (const target of entityNodes.get(`${member.functionId}\u0000${sourceId}`) ?? []) edge(accessId, target);
      }
    }
    for (const object of demand.objects ?? []) {
      const objectId = addNode('DataflowEvidence', { functionId: member.functionId, object },
        { owner: 'analysis/pointsto', functionId: member.functionId, projection: jsonSafe(object), originalTypes: lossyTypeWitness(object),
          aliasAuthority: false, lifetime: 'unknown' }, [object.valueId]);
      edge(id, objectId, 'derived-from', 'object-context-input');
      for (const target of entityNodes.get(`${member.functionId}\u0000${object.valueId}`) ?? []) edge(objectId, target);
    }
    const rangeNodes = new Map();
    for (const range of demand.ranges?.values ?? []) {
      const rangeId = addNode('DataflowEvidence', { functionId: member.functionId, range },
        { owner: 'decompiler/phase8/sccp', value: jsonSafe(range), originalTypes: lossyTypeWitness(range),
          ownerIdentity: demand.ranges.ownerIdentity, bindings: demand.ranges.bindings }, [range.entityId ?? member.functionId]);
      rangeNodes.set(range.localId, rangeId);
      edge(id, rangeId, 'derived-from', 'query-demand-value-input');
      for (const binding of demand.ranges.bindings.filter(row => row.localId === range.localId)) {
        for (const valueId of [binding.semanticValueId, binding.semanticSsaValueId]) {
          for (const target of entityNodes.get(`${member.functionId}\u0000${valueId}`) ?? []) edge(rangeId, target);
        }
      }
    }
    for (const candidate of member.integerProofCandidates ?? []) {
      const read = referenceNodes.get(candidate.readReferenceId), range = rangeNodes.get(candidate.fragment.rangeLocalId);
      if (!read || !range) { gap({ reason: 'integer-fragment-premise-outside-evidence-cut' }); continue; }
      const source = candidate.fragment.source;
      const bytes = addNode('BinaryEvidence', { integerFragmentSource: source },
        { owner: 'scpa-integer-fragment-bytes', source, authority: 'source-range-only; requires-current-byte-replay' }, [],
        { byteRanges: [{ binaryId: source.binaryId, start: source.start, end: source.end }] });
      const fragment = { ...candidate.fragment, premises: { source: bytes, read, range } };
      const proof = addNode('DataflowEvidence', { integerFragment: fragment },
        { owner: INTEGER_FRAGMENT_KIND, fragment, proofStatus: 'not-checked', scopeLimited: true }, [fragment.semanticValueId]);
      edge(id, proof, 'derived-from', 'scoped-integer-derivation-candidate');
      for (const premise of Object.values(fragment.premises)) edge(proof, premise, 'derived-from', 'integer-fragment-premise');
      integerDerivations.push({ nodeId: proof, ruleId: fragment.ruleId, ruleVersion: fragment.ruleVersion,
        functionId: member.functionId, localId: fragment.rangeLocalId, domain: fragment.domain, status: 'not-checked' });
    }
    await work.yieldIfNeeded();
  }
  for (const specialized of specializations) {
    const id = addNode('DataflowEvidence', { specializationId: specialized.id }, { owner: 'analysis/summary/specialization',
      specialization: jsonSafe(specialized), originalTypes: lossyTypeWitness(specialized) }, [specialized.functionId]);
    edge(id, summaryNodes.get(specialized.functionId)); edge(id, summaryNodes.get(specialized.callerFunctionId)); ownerRoots.push(id);
  }
  for (const dispatch of dispatchBounds) {
    const id = addNode('ControlFlowEvidence', { dispatch }, { owner: 'analysis/dispatch', dispatch: jsonSafe(dispatch) },
      [dispatch.query?.callSiteId ?? dispatch.callSiteId ?? plan.id]);
    ownerRoots.push(id);
    for (const candidate of dispatch.candidates ?? []) {
      const pointer = candidate.provenance?.declaration.pointerView, access = candidate.provenance?.declaration.access;
      for (const ref of [dispatch.query?.callSiteId, access?.nodeId, access?.memoryEntityId].filter(Boolean)) {
        for (const target of entityNodes.get(`${dispatch.query.functionId}\u0000${ref}`) ?? []) edge(id, target);
      }
      const source = pointer?.byteSource;
      if (!source) { if (pointer) gap({ reason: 'loader-pointer-source-bytes-unavailable', pointerId: pointer.id }); continue; }
      if (source.worldId !== world.id || source.snapshotId !== snapshotId || source.binaryId !== binaryId
        || source.length !== 8 || !Array.isArray(source.bytes) || source.bytes.length !== 8) contractFail('flow-pointer-byte-binding');
      const bytes = addNode('BinaryEvidence', { binaryId: source.binaryId, offset: source.offset, length: 8, loaderPointer: pointer.id },
        { pointerViewId: pointer.id, loaderRevision: source.loaderRevision, bytes: source.bytes,
          authority: 'current-source-pointer-bytes; authentication-and-load-occurrence-not-proven' }, [],
        { byteRanges: [{ binaryId, start: String(source.offset), end: (BigInt(source.offset) + 8n).toString() }] });
      edge(id, bytes, 'originates-from');
    }
  }
  const rawAnswer = { schema: FLOW_ANSWER_SCHEMA, version: '1.0.0', queryId: plan.id,
    worldId: world.id, assumptionsId: assumptions.id, snapshotId, scope: plan.query.scope, investigation,
    existence: result?.totalResults ? 'POSSIBLE' : 'UNKNOWN', lower: { members: [], reason: 'no-executable-path-witness' },
    upper: { kind: 'TOP', reason: 'scope-or-semantics-not-closed' }, candidates: result?.results ?? [],
    enumerationComplete: result?.enumerationComplete === true, semanticClosure: 'unknown', exact: false,
    frontier: { entries: gaps, omittedEntries: omittedGaps, closed: false }, dependencies,
    precision: { blockCaptures: members.map(m => ({ functionId: m.functionId, ...m.demand.blockCaptures })), abiPlacements: members.map(m => ({ functionId: m.functionId, ...m.demand.abiPlacements })), objects: members.flatMap(m => m.demand.objects), memoryObjects: members.map(m => ({ functionId: m.functionId, ...m.demand.memoryObjects })), valueFacts: members.flatMap(m => m.demand.ranges?.values ?? []),
      summarySpecializations: specializations, dispatchBounds },
    authority: 'possible-canonical-dependence; no-negative-or-executable-proof' };
  // Neither elapsed time nor service cursors qualify a semantic proposition.
  const { cost: _queryCost, continuation: _cursor, ...semanticResult } = result ?? {};
  const resultDigest = stableDigest({ semanticResult: jsonSafe(semanticResult), ownerRoots: [...ownerRoots].sort() });
  const supportId = `scpa-query:${plan.id}:${resultDigest}`;
  graph.addNode({ id: `machine-derived:${supportId}`, family: 'DataflowEvidence', binaryId, targetEntityIds: [plan.id],
    semanticKind: 'bounded-query-enumeration', completeness: 'partial', deterministic: false,
    payload: { scope, result: jsonSafe(semanticResult), semanticProof: false } });
  for (const root of [...new Set([...ownerRoots, ...referenceNodes.values()])]) edge(`machine-derived:${supportId}`, root);
  const candidate = createScopedJudgmentCandidate({ subject: plan.id, quantifier: 'candidate-only',
    value: { schema: FLOW_ANSWER_SCHEMA, existence: rawAnswer.existence, candidateCount: rawAnswer.candidates.length, resultDigest },
    support: [{ kind: 'machine-derived', producer: supportId }], precision: 'unknown',
    obligations: ['world-closure', 'semantic-profile-qualification', 'path-feasibility',
      ...(gaps.length || omittedGaps ? ['unresolved-query-frontier'] : [])],
    derivation: 'scpa-demand-query-owner-reference-chain/v1', executionStatus: 'completed' }, { world, assumptions });
  const judgment = await qualifyScopedJudgment(candidate, { world, assumptions, work,
    resolveSupport: (_support, checked) => ({ world: world.id, assumptions: assumptions.id, subject: plan.id,
      propositionMatches: stableStringify(checked.value) === stableStringify(candidate.value), accepted: true,
      quantifier: 'candidate-only', precision: 'unknown' }) });
  const claim = scopedJudgmentClaim(judgment, { binaryId }); graph.addNode(claim); edge(claim.id, `machine-derived:${supportId}`);
  const { cost: _certificateCost, ...certificate } = await exportEvidenceCertificate({ graph, roots: [claim.id], world, assumptions, work,
    readRange, includeBytes: true });
  check();
  const answer = deepFreeze({ ...rawAnswer, judgment, evidence: { rootId: claim.id, checkerLevel: 'integrity-only',
    certificateStatus: certificate.status, semanticProof: false, integerDerivations } });
  const raw = { schema: FLOW_ANSWER_BUNDLE_SCHEMA, version: '1.1.0', worldId: world.id, assumptionsId: assumptions.id,
    snapshotId, answer, graph: graph.toJSON(), certificate, dependencies,
    ownerInputs: members.map(({ locator, inputIdentity, artifactId, demand }) => ({ locator, inputIdentity, artifactId, precision: demand.precision })),
    exact: false, releaseQualified: false };
  const payload = snapshotContractData({ ...jsonSafe(raw), originalTypes: lossyTypeWitness(raw) }, { maxBytes: 16 * 1024 * 1024, maxNodes: 262144 });
  work.charge('residentBytes', stableStringify(payload).length * 2); check();
  return { payload: deepFreeze(payload), graph, rootId: claim.id };
}

export async function publishFlowAnswer(bundle, { store, world, snapshotId, work, isCurrent } = {}) {
  assertWorldScope(world); assertScopedAnalysisWork(work);
  if (!store || typeof store.publish !== 'function') return { status: 'unsupported', reason: 'canonical-artifact-store-unavailable', exact: false };
  if (bundle?.schema !== FLOW_ANSWER_BUNDLE_SCHEMA || bundle.worldId !== world.id || bundle.snapshotId !== snapshotId
    || bundle.answer?.exact !== false || bundle.answer?.upper?.kind !== 'TOP') contractFail('flow-answer-publication-contract');
  work.checkpoint();
  if (isCurrent?.() !== true) contractFail('flow-answer-publication-stale');
  const descriptor = createArtifactDescriptor({ artifactKind: 'scpa-flow-answer', binaryId: world.binarySet[0].binaryId,
    sliceId: world.binarySet[0].sliceId, entityId: bundle.answer.queryId, producerId: 'scpa-demand-query', producerVersion: '1.0.0',
    relevance: { loader: false, architectureSemantic: false, abiSemantic: false, semanticSchema: false },
    config: { worldId: world.id, assumptionsId: bundle.assumptionsId, snapshotId, payload: bundle },
    dependencyScope: bundle.dependencies, upstreamArtifactIds: bundle.dependencies.positiveArtifactIds });
  const expected = stableStringify(bundle);
  work.charge('artifactsMaterialized');
  const published = await work.await(signal => store.publish(descriptor, bundle, { signal, completeness: 'partial', allowIncomplete: true, isCurrent,
    validate: value => isCurrent() === true && stableStringify(value) === expected }));
  work.checkpoint(); if (isCurrent() !== true) contractFail('flow-answer-publication-stale');
  return { status: published.status, artifactId: published.artifactId, rootId: bundle.answer.evidence.rootId,
    atomic: true, exact: false, checkerLevel: 'integrity-only' };
}
