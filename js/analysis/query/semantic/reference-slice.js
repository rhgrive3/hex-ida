/** Portable current-owner explanations, NOT EvidenceGraph proof receipts. */
import { createEntityId, deepFreeze, jsonSafe, lossyTypeWitness, stableStringify } from '../../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';
import { snapshotContractData, recordFields, stringSet, exactString, exactInteger, exactEnum, unsignedAddress, compareIdentity, contractFail } from '../../../core/identity/structured.js';
import { assertCanonicalQueryProjection } from './projection.js';

export const REFERENCE_SLICE_SCHEMA = 'scoped-reference-slice/v1';
export function normalizeReferenceSliceRequest(value) {
  const input = snapshotContractData(value, { maxBytes: 65536, maxNodes: 1024 });
  recordFields(input, ['projectionId', 'referenceIds', 'direction', 'maxDepth', 'maxNodes', 'includeBytes'], 'reference-slice-request-fields');
  const referenceIds = stringSet(input.referenceIds, 'reference-slice-roots', 32);
  if (!referenceIds.length) contractFail('reference-slice-empty-roots');
  if (input.includeBytes !== undefined && typeof input.includeBytes !== 'boolean') contractFail('reference-slice-include-bytes');
  return deepFreeze({ projectionId: exactString(input.projectionId, 'reference-slice-projection'), referenceIds,
    direction: exactEnum(input.direction ?? 'backward', ['backward', 'forward'], 'reference-slice-direction'),
    maxDepth: exactInteger(input.maxDepth ?? 2, 'reference-slice-depth', { max: 16 }),
    maxNodes: exactInteger(input.maxNodes ?? 64, 'reference-slice-node-limit', { min: 1, max: 256 }),
    includeBytes: input.includeBytes === true });
}
export async function explainCanonicalReferenceSlice(projection, value, { world, assumptions, work, readRange = null, isCurrent } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  assertCanonicalQueryProjection(projection, { world, assumptions });
  const request = normalizeReferenceSliceRequest(value), snapshotId = projection.inputIdentity.snapshotId;
  const check = () => { work.checkpoint(); if (typeof isCurrent !== 'function' || isCurrent() !== true) contractFail('reference-slice-stale'); };
  check();
  if (request.projectionId !== projection.id) return { status: 'stale', reason: 'reference-slice-projection-changed', exact: false };
  const queue = [], visited = new Set(), records = [], edgeCandidates = new Map(), frontier = [], ranges = new Map();
  let omittedFrontier = 0;
  const gap = (entry) => { if (frontier.length < 256) frontier.push(entry); else omittedFrontier++; };
  for (const id of request.referenceIds) {
    if (!projection.record(id)) { gap({ referenceId: id, reason: 'reference-not-in-current-projection' }); continue; }
    if (visited.size >= request.maxNodes) { gap({ referenceId: id, reason: 'reference-node-limit' }); continue; }
    visited.add(id); queue.push({ id, depth: 0 });
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    check(); work.charge('workUnits'); work.charge('nodes');
    const { id, depth } = queue[cursor], record = projection.present(id, { includeOrigins: true });
    const owned = snapshotContractData({ record, source: projection.source(id) }, { allowBigInt: true, maxBytes: 262144, maxNodes: 8192 });
    work.charge('residentBytes', stableStringify(owned).length * 2 + 128); records.push(owned);
    for (const range of record.origin?.byteRanges ?? []) {
      work.charge('workUnits');
      if (range.binaryId !== projection.inputIdentity.binaryId) { gap({ referenceId: id, reason: 'origin-source-outside-current-binary' }); continue; }
      const start = unsignedAddress(range.start, { bits: 64 }), end = unsignedAddress(range.end, { bits: 64, allowEnd: true });
      const length = BigInt(end) - BigInt(start);
      if (length <= 0n || length > 4096n) { gap({ referenceId: id, reason: 'origin-range-size-limit' }); continue; }
      const key = JSON.stringify([range.binaryId, start, end]);
      if (!ranges.has(key)) {
        if (ranges.size >= 32) { gap({ referenceId: id, reason: 'origin-range-count-limit' }); continue; }
        ranges.set(key, { binaryId: range.binaryId, offset: start, length: Number(length), referenceIds: new Set() });
      }
      ranges.get(key).referenceIds.add(id);
    }
    for (const edgeId of projection.adjacent(id, request.direction)) {
      work.charge('workUnits'); work.charge('edges');
      const edge = projection.edge(edgeId), target = request.direction === 'backward' ? edge.from : edge.to;
      if (depth >= request.maxDepth) { gap({ referenceId: id, reason: 'reference-depth-limit' }); break; }
      if (edgeCandidates.size >= 512 && !edgeCandidates.has(edge.id)) { gap({ referenceId: id, reason: 'reference-edge-limit' }); break; }
      if (!visited.has(target)) {
        if (visited.size >= request.maxNodes) { gap({ referenceId: target, reason: 'reference-node-limit' }); continue; }
        work.charge('queueOperations'); visited.add(target); queue.push({ id: target, depth: depth + 1 });
      }
      edgeCandidates.set(edge.id, edge);
    }
    await work.yieldIfNeeded();
  }
  const sources = [];
  for (const source of ranges.values()) {
    check();
    const description = { binaryId: source.binaryId, offset: source.offset, length: source.length,
      referenceIds: [...source.referenceIds].sort(compareIdentity), bytes: null, status: 'origin-reference-only' };
    if (request.includeBytes) {
      if (typeof readRange !== 'function') { description.status = 'source-reader-unavailable'; gap({ reason: description.status }); }
      else {
        work.charge('bytesRead', source.length);
        const reply = await work.await((signal) => readRange({ worldId: world.id, binaryId: source.binaryId,
          offset: source.offset, length: source.length }, { signal }));
        check();
        if (reply?.worldId !== world.id || reply.binaryId !== source.binaryId
          || unsignedAddress(reply.offset, { bits: 64 }) !== source.offset || !(reply.bytes instanceof Uint8Array)
          || reply.bytes.byteLength !== source.length) contractFail('reference-slice-byte-source-binding');
        description.bytes = [...reply.bytes]; description.status = 'current-source-bytes';
      }
    }
    sources.push(description); await work.yieldIfNeeded();
  }
  check();
  const raw = { schema: REFERENCE_SLICE_SCHEMA, version: '1.0.0', worldId: world.id, assumptionsId: assumptions.id,
    snapshotId, inputIdentity: projection.inputIdentity, request, records,
    edges: [...edgeCandidates.values()].sort((a, b) => compareIdentity(a.id, b.id)), sources,
    frontier: { entries: frontier, omittedEntries: omittedFrontier, closed: false },
    semanticProof: false, exact: false, authority: 'canonical-reference-and-byte-explanation; not-a-proof-certificate' };
  const body = snapshotContractData({ ...jsonSafe(raw), originalTypes: lossyTypeWitness(raw) }, { maxBytes: 2 * 1024 * 1024, maxNodes: 65536 });
  work.charge('residentBytes', stableStringify(body).length * 2);
  const id = createEntityId({ binaryId: projection.inputIdentity.binaryId, kind: REFERENCE_SLICE_SCHEMA, identity: body });
  check();
  return { status: 'completed', bundle: deepFreeze({ ...body, id }), exact: false, cost: work.cost() };
}
export async function replayCanonicalReferenceSlice(projection, value, options) {
  const bundle = snapshotContractData(value, { maxBytes: 2 * 1024 * 1024, maxNodes: 65536 });
  if (bundle.schema !== REFERENCE_SLICE_SCHEMA) contractFail('reference-slice-schema');
  exactString(bundle.id, 'reference-slice-id');
  const expected = await explainCanonicalReferenceSlice(projection, bundle.request, options);
  if (expected.status !== 'completed') return { ...expected, semanticProof: false };
  // Full content, including the original-type witness and optional bytes.
  // A non-cryptographic entity ID alone is never sufficient for admission.
  const matches = stableStringify(bundle) === stableStringify(expected.bundle);
  options.work.checkpoint();
  if (options.isCurrent() !== true) contractFail('reference-slice-stale');
  return deepFreeze({ schema: 'scoped-reference-slice-replay/v1', status: matches ? 'matched-current-source' : 'rejected',
    sourceId: bundle.id, expectedId: expected.bundle.id, contentMatches: matches, semanticProof: false, exact: false,
    reason: matches ? 'full-current-reference-content-matched; semantic-qualification-not-performed' : 'reference-or-byte-content-mismatch',
    cost: options.work.cost() });
}
