/**
 * Read-only ObjC Block capture view over a CURRENT canonical function. The
 * existing runtime recognizer supplies the layout candidate; Semantic IR and
 * MemorySSA supply source references. Neither the shape nor a capture field
 * establishes a lifetime, escape, retain policy, or happens-before relation.
 */
import { recognizeObjcBlockLiteral } from '../../apple/objc-runtime.js';
import { createEscapeRecord, ESCAPE_ANALYZER_VERSION } from '../summary/escape.js';
import { assertCanonicalQueryProjection } from '../query/semantic/projection.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { createEntityId, deepFreeze, stableStringify, stableDigest, lossyTypeWitness } from '../../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, exactInteger, stringSet, unsignedAddress, contractFail } from '../../core/identity/structured.js';

export const SCOPED_OBJC_BLOCK_VERSION = '1.0.0';
export const SCOPED_OBJC_BLOCK_SCHEMA = 'scoped-objc-block-capture-view/v1';
const sameData = (a, b) => stableStringify(a) === stableStringify(b)
  && stableStringify(lossyTypeWitness(a)) === stableStringify(lossyTypeWitness(b));
const digest = (value) => stableDigest({ value, typed: lossyTypeWitness(value) });
const PREFIX = new Map([[0, 8], [8, 4], [12, 4], [16, 8], [24, 8]]);

function sourceField(raw, projection) {
  recordFields(raw, ['offset', 'widthBytes', 'valueId', 'storeNodeId', 'memoryDefinitionId',
    'constant', 'evidenceIds', 'escapeRecordIds'], 'objc-block-field-fields');
  const offset = exactInteger(raw.offset, 'objc-block-field-offset', { max: 1048576 });
  const widthBytes = exactInteger(raw.widthBytes, 'objc-block-field-width', { min: 1, max: 65536 });
  const valueId = exactString(raw.valueId, 'objc-block-value-id');
  const storeNodeId = exactString(raw.storeNodeId, 'objc-block-store-id');
  const memoryDefinitionId = exactString(raw.memoryDefinitionId, 'objc-block-memory-def-id');
  const nodeRef = projection.entityReference('semantic-ir', storeNodeId);
  const defRef = projection.entityReference('memoryssa', memoryDefinitionId);
  const node = nodeRef === null ? null : projection.source(nodeRef);
  const memory = defRef === null ? null : projection.source(defRef);
  const references = projection.valueReferenceIds(valueId);
  const reasons = [];
  // Store inputs can contain both address and value. Membership is therefore a
  // source-link check ONLY. The field/value/offset proposition still needs the
  // owning layout/alias checker; do not infer it from register spelling.
  if (node?.kind !== 'store' || !node?.memory || node.memory.widthBits !== widthBytes * 8 || !node.inputs?.includes(valueId)) reasons.push('field-store-value-or-width-not-bound');
  if (!memory || memory.sourceEntityId !== storeNodeId || memory.kind !== 'memory-def') reasons.push('field-memory-definition-not-bound');
  if (!references.length || references.length > 32) reasons.push('field-canonical-ssa-value-unavailable');
  if (offset < 32 && PREFIX.get(offset) !== widthBytes) reasons.push('block-header-layout-width-mismatch');
  const constant = raw.constant === null ? null : unsignedAddress(raw.constant, { bits: Math.min(widthBytes * 8, 128) });
  const evidenceIds = stringSet(raw.evidenceIds, 'objc-block-field-evidence', 64);
  if (!evidenceIds.length) reasons.push('field-source-evidence-unavailable');
  return deepFreeze({ offset, widthBytes, valueId, storeNodeId, memoryDefinitionId, constant,
    nodeReference: nodeRef, memoryReference: defRef, valueReferences: references,
    evidenceIds, escapeRecordIds: stringSet(raw.escapeRecordIds ?? [], 'objc-block-field-escape-ids', 64),
    sourceLinks: reasons.length ? 'incomplete' : 'bound-owner-references', unknown: reasons,
    constantAuthority: 'unqualified-owner-candidate', exact: false });
}

export async function queryObjcBlockCaptures(request, { world, assumptions, snapshotId, projection, work, getContext = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  assertCanonicalQueryProjection(projection, { world, assumptions });
  recordFields(request, ['functionId', 'blockValueId'], 'objc-block-query-fields');
  const blockValueId = exactString(request.blockValueId, 'objc-block-query-value');
  if (request.functionId !== projection.functionId) contractFail('objc-block-query-function');
  const blockRefs = projection.valueReferenceIds(blockValueId);
  if (!blockRefs.length || blockRefs.length > 32) return { status: 'unsupported', reason: 'block-value-not-in-canonical-function', exact: false };
  if (!getContext) return { status: 'unsupported', reason: 'canonical-objc-block-fields-owner-unbound', exact: false };
  const context = await work.await((signal) => getContext({ functionId: projection.functionId, blockValueId }, {
    world, assumptions, snapshotId, projection, signal, work,
  }));
  if (!context) return { status: 'unsupported', reason: 'canonical-block-field-evidence-unavailable', exact: false };
  if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('objc-block-current-owner-required');
  const input = snapshotContractData(context.data, { allowBigInt: true, maxNodes: 32768, maxBytes: 1048576 });
  recordFields(input, ['schema', 'binding', 'fields', 'escapeRecords', 'escapeAnalyzerVersion', 'remaining'], 'objc-block-owner-fields');
  const binding = input.binding;
  recordFields(binding, ['worldId', 'assumptionsId', 'snapshotId', 'binaryId', 'functionId', 'projectionId',
    'producerArtifactId', 'ownerDigests', 'ownerRevision', 'blockValueId'], 'objc-block-binding-fields');
  if (input.schema !== 'canonical-objc-block-fields/v1' || binding.worldId !== world.id || binding.assumptionsId !== assumptions.id
    || binding.snapshotId !== snapshotId || binding.binaryId !== projection.inputIdentity.binaryId
    || binding.functionId !== projection.functionId || binding.projectionId !== projection.id || binding.blockValueId !== blockValueId
    || !projection.inputIdentity.producerArtifactId || binding.producerArtifactId !== projection.inputIdentity.producerArtifactId
    || !sameData(binding.ownerDigests, projection.inputIdentity.ownerDigests)) contractFail('objc-block-canonical-source-binding');
  exactString(binding.ownerRevision, 'objc-block-owner-revision');
  if (world.profile.addressBits !== 64 || !Array.isArray(input.fields) || input.fields.length > 128
    || !Array.isArray(input.escapeRecords) || input.escapeRecords.length > 256) contractFail('objc-block-supported-profile-or-budget');
  if (input.escapeRecords.length && input.escapeAnalyzerVersion !== ESCAPE_ANALYZER_VERSION) contractFail('objc-block-escape-owner-version');
  const fields = [], offsets = new Set(), escapeRecords = [], escapeIds = new Set(), unresolved = [];
  for (const raw of input.fields) {
    work.charge('workUnits'); work.charge('nodes');
    const field = sourceField(raw, projection);
    if (offsets.has(field.offset)) contractFail('objc-block-overlapping-owner-offset');
    offsets.add(field.offset); fields.push(field);
    if (field.unknown.length) unresolved.push({ offset: field.offset, reasons: field.unknown });
    await work.yieldIfNeeded();
  }
  fields.sort((a, b) => a.offset - b.offset);
  let previousEnd = 0;
  for (const field of fields) {
    if (field.offset < previousEnd) contractFail('objc-block-overlapping-owner-field');
    previousEnd = field.offset + field.widthBytes;
  }
  for (const raw of input.escapeRecords) {
    work.charge('workUnits'); work.charge('nodes');
    recordFields(raw, ['id', 'record'], 'objc-block-escape-reference-fields');
    const id = exactString(raw.id, 'objc-block-escape-record-id');
    if (escapeIds.has(id)) contractFail('objc-block-duplicate-escape-reference'); escapeIds.add(id);
    const record = createEscapeRecord(raw.record);
    if (!sameData(record, raw.record)) contractFail('objc-block-noncanonical-escape-record');
    const siteReference = record.siteId === null ? null : projection.entityReference('semantic-ir', record.siteId);
    escapeRecords.push({ id, record, siteReference, sourceBinding: siteReference ? 'canonical-site-reference' : 'site-unavailable',
      authority: 'existing-summary-declaration-not-new-escape-proof', lifetime: 'unknown', threadOrder: 'unknown' });
    await work.yieldIfNeeded();
  }
  for (const field of fields) for (const id of field.escapeRecordIds) {
    work.charge('workUnits'); if (!escapeIds.has(id)) unresolved.push({ offset: field.offset, reasons: ['referenced-escape-record-missing'], id });
    await work.yieldIfNeeded();
  }
  // Use the existing layout recognizer, but feed only source-linked values.
  // A symbolic invoke reference is a SHAPE candidate, not an exact target.
  const map = new Map(fields.filter((field) => field.sourceLinks === 'bound-owner-references')
    .map((field) => [field.offset, field.constant ?? { canonicalValueId: field.valueId }]));
  const recognized = recognizeObjcBlockLiteral(map, { pointerSize: 8 });
  const byOffset = new Map(fields.map((field) => [field.offset, field]));
  const remaining = stringSet([...stringSet(input.remaining ?? [], 'objc-block-owner-remaining', 128),
    'block-base-plus-field-offset-alias-proof-unreplayed', 'block-kind-and-invoke-target-unqualified',
    'capture-field-set-not-closed', 'capture-retain-copy-dispose-policy-unrecovered', 'byref-forwarding-not-resolved',
    'lifetime-generation-and-cardinality-unknown', 'cross-thread-happens-before-not-inferred']);
  work.checkpoint(); if (context.isCurrent() !== true) contractFail('objc-block-owner-stale-before-publication');
  const body = snapshotContractData({ schema: SCOPED_OBJC_BLOCK_SCHEMA, version: SCOPED_OBJC_BLOCK_VERSION,
    status: 'completed', binding, blockValueReferences: blockRefs,
    recognition: recognized ? 'unqualified-layout-candidate' : 'layout-candidate-unavailable',
    invoke: byOffset.get(16) ?? null, descriptor: byOffset.get(24) ?? null,
    fields, captures: fields.filter((field) => field.offset >= 32), escapeRecords, unresolved, remaining,
    exact: false, noCapturesProven: false, escapeTruthChanged: false, canonicalTruthChanged: false,
    functionTargetsCreated: 0, runtimeExecutionRequested: false }, { allowBigInt: true, maxBytes: 2097152, maxNodes: 65536 });
  work.charge('residentBytes', stableStringify(body).length * 2); work.checkpoint();
  return deepFreeze({ ...body, id: createEntityId({ binaryId: binding.binaryId, kind: SCOPED_OBJC_BLOCK_SCHEMA,
    identity: { digest: digest(body) } }), cost: work.cost() });
}

/** Native read-only bridge. Geometry is obtained from CURRENT points-to and
 * MemorySSA, not from a guessed register spelling, nominal type or SDK offset.
 * Competing stores to a field are retained as unknown rather than choosing an
 * arbitrary "last" write across branches or loops.
 */
export function nativeObjcBlockContext(projection, demand, blockValueId, { world, assumptions, snapshotId, work, isCurrent } = {}) {
  assertCanonicalQueryProjection(projection, { world, assumptions }); assertScopedAnalysisWork(work);
  if (demand?.worldId !== world.id || demand.assumptionsId !== assumptions.id || demand.snapshotId !== snapshotId
    || demand.functionId !== projection.functionId || demand.binaryId !== projection.inputIdentity.binaryId
    || isCurrent?.() !== true) contractFail('native-block-current-demand-binding');
  const base = demand.objects.find(row => row.valueId === blockValueId);
  if (!base || base.pointsTo.top || base.partitions.length !== 1 || base.partitions[0].subobject.offset == null) return null;
  const partition = base.partitions[0], rootKey = partition.root.rootKey, baseOffset = BigInt(partition.subobject.offset);
  const byOffset = new Map(), remaining = ['fields-are-static-store-candidates; execution-order-unproved'];
  const escapeRecords = (demand.escape?.records ?? []).map(record => ({
    id: createEntityId({ binaryId: projection.inputIdentity.binaryId, kind: 'scpa-escape-reference', identity: { functionId: projection.functionId, record } }), record }));
  const constant = (valueId, widthBits) => {
    const ids = new Set((demand.ranges?.bindings ?? []).filter(row => row.semanticValueId === valueId || row.semanticSsaValueId === valueId).map(row => row.localId));
    const facts = (demand.ranges?.values ?? []).filter(row => ids.has(row.localId) && row.completeness === 'complete'
      && !row.conditionalOn?.length && row.fact?.bits === widthBits && row.fact?.constant != null);
    if (!facts.length || facts.some(row => !sameData(row.fact, facts[0].fact))) return null;
    return String(facts[0].fact.constant.value);
  };
  for (const access of demand.memoryObjects?.accesses ?? []) {
    work.charge('workUnits');
    if (access.kind !== 'store' || access.memoryKind !== 'memory-def' || access.geometry !== 'canonical-region-description'
      || access.valueIds.length !== 1 || access.partitions.length !== 1 || access.partitions[0].root.rootKey !== rootKey) continue;
    const field = access.partitions[0];
    if (field.subobject.offset == null || !Number.isSafeInteger(access.widthBits) || access.widthBits % 8) continue;
    const relative = BigInt(field.subobject.offset) - baseOffset;
    if (relative < 0n || relative > 1048576n || access.widthBits < 8 || access.widthBits > 524288) continue;
    const offset = Number(relative), valueId = access.valueIds[0], objects = demand.objects.find(row => row.valueId === valueId);
    const roots = new Set((objects?.partitions ?? []).map(row => row.root.rootKey));
    const value = { offset, widthBytes: access.widthBits / 8, valueId, storeNodeId: access.nodeId,
      memoryDefinitionId: access.memoryEntityId, constant: constant(valueId, access.widthBits), evidenceIds: access.evidenceIds,
      escapeRecordIds: escapeRecords.filter(row => roots.has(row.record.rootKey)).map(row => row.id) };
    const entries = byOffset.get(offset) ?? new Map(); entries.set(access.nodeId, value); byOffset.set(offset, entries);
  }
  const candidates = [], ambiguous = new Set();
  for (const [offset, entries] of byOffset) {
    work.charge('workUnits', entries.size);
    if (entries.size !== 1) { ambiguous.add(offset); remaining.push(`ambiguous-stores-at-offset:${offset}`); }
    // Keep ambiguous intervals in the overlap sweep so a shorter neighboring
    // field cannot be laundered past an excluded wider store.
    candidates.push(...entries.values());
  }
  work.charge('workUnits', candidates.length * Math.max(1, Math.ceil(Math.log2(candidates.length + 1))));
  candidates.sort((a, b) => a.offset - b.offset || a.widthBytes - b.widthBytes);
  const overlap = new Set(); let group = [], groupEnd = -1;
  const settle = () => { if (group.length > 1) for (const row of group) overlap.add(row); };
  for (const row of candidates) {
    work.charge('workUnits');
    if (row.offset >= groupEnd) { settle(); group = []; groupEnd = -1; }
    group.push(row); groupEnd = Math.max(groupEnd, row.offset + row.widthBytes);
  }
  settle();
  const fields = [];
  for (const field of candidates) {
    work.charge('workUnits');
    if (ambiguous.has(field.offset) || overlap.has(field)) { remaining.push(`overlapping-store-at-offset:${field.offset}`); continue; }
    if (fields.length >= 128) { remaining.push('native-block-field-cut'); break; }
    fields.push(field);
  }
  if (demand.escape?.omittedRecords) remaining.push('native-escape-record-cut');
  const binding = { worldId: world.id, assumptionsId: assumptions.id, snapshotId,
    binaryId: projection.inputIdentity.binaryId, functionId: projection.functionId, projectionId: projection.id,
    producerArtifactId: projection.inputIdentity.producerArtifactId, ownerDigests: projection.inputIdentity.ownerDigests,
    ownerRevision: 'native-memoryssa-points-to-block-adapter/v1', blockValueId };
  return { isCurrent, data: { schema: 'canonical-objc-block-fields/v1', binding, fields, escapeRecords,
    escapeAnalyzerVersion: demand.escape?.version ?? ESCAPE_ANALYZER_VERSION, remaining: [...new Set(remaining)].slice(0, 128) } };
}

/** A small candidate lane for a demand answer, never a global block index. */
export async function projectNativeBlockCaptures(projection, demand, context) {
  const values = [], seen = new Set(), views = [], frontier = [], possible = [];
  const memoryRoots = new Set((demand.memoryObjects?.accesses ?? []).flatMap(access => access.partitions.map(partition => partition.root.rootKey)));
  for (const object of demand.objects) {
    context.work.charge('workUnits');
    if (object.pointsTo.top || object.partitions.length !== 1) continue;
    const partition = object.partitions[0], offset = partition.subobject.offset;
    // Canonical rooted objects often have unknown language/type. Actual store
    // geometry, not a name or a guessed "stack" tag, selects layout candidates.
    if (offset == null || !memoryRoots.has(partition.root.rootKey)) continue;
    const key = `${partition.root.rootKey}:${offset}`;
    if (seen.has(key)) continue; seen.add(key);
    possible.push({ valueId: object.valueId, offset: BigInt(offset), key });
  }
  context.work.charge('workUnits', possible.length * Math.max(1, Math.ceil(Math.log2(possible.length + 1))));
  possible.sort((a, b) => a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const candidate of possible) {
    if (values.length >= 4) { frontier.push({ reason: 'native-block-candidate-base-cut' }); break; }
    values.push(candidate.valueId);
  }
  for (const blockValueId of values) {
    const owner = nativeObjcBlockContext(projection, demand, blockValueId, context);
    // Demand answers include recognizable header candidates only. The direct
    // API can still explain incomplete fields for an explicitly selected base.
    if (!owner || ![0, 8, 16, 24].every(offset => owner.data.fields.some(field => field.offset === offset))) continue;
    const { cost: _cost, ...view } = await queryObjcBlockCaptures({ functionId: projection.functionId, blockValueId }, {
      ...context, projection, getContext: async () => owner });
    views.push(view);
    await context.work.yieldIfNeeded();
  }
  return { schema: 'native-block-candidate-view/v1', views, frontier, exact: false, noCapturesProven: false };
}
