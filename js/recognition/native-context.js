/** First-party adapters to existing fingerprintFunction and KnowledgeDB.
 * They never resolve feature collisions into canonical identity or transfer
 * names/types. Candidate record IDs live in the knowledge namespace.
 */
import { fingerprintFunction, FUNCTION_FINGERPRINT_VERSION } from '../fingerprint/index.js';
import { KnowledgeDB } from '../knowledge/index.js';
import { createEntityId, stableDigest, lossyTypeWitness } from '../core/identity/index.js';
import { exactString, contractFail } from '../core/identity/structured.js';
export function captureNativeFingerprint(owner, input, summary, work) {
  const rows = owner.decodedInstructions;
  if (!Array.isArray(rows) || !rows.length || rows.length > 1024 || rows.some(row => !Number.isInteger(row.word) || row.word < 0 || row.word > 0xffffffff)) return {
    status: 'unsupported', reason: 'bounded-source-encoding-unavailable' };
  work.charge('workUnits', rows.length * 16); work.charge('residentBytes', rows.length * 512);
  const bytes = new Uint8Array(rows.length * 4), view = new DataView(bytes.buffer);
  rows.forEach((row, index) => view.setUint32(index * 4, row.word, true));
  const fingerprint = fingerprintFunction({ architecture: 'arm64', address: rows[0].address, bytes,
    instructions: rows, cfg: owner.pipeline.cfg, semantic: {
      operations: owner.pipeline.semanticIr.nodes.map(row => row.kind),
      reads: (summary?.memoryEffects ?? []).filter(row => row.kind === 'read').map(row => row.regionId),
      writes: (summary?.memoryEffects ?? []).filter(row => row.kind === 'write').map(row => row.regionId) } });
  return { schema: 'native-owner-fingerprint/v1', status: 'completed', binaryId: owner.pipeline.binaryId,
    functionId: owner.pipeline.functionId, worldId: input.worldId, snapshotId: input.snapshotId,
    artifactId: input.producerArtifactId, fingerprint, evidenceIds: [owner.pipeline.functionId],
    provenance: { owner: 'fingerprintFunction', version: FUNCTION_FINGERPRINT_VERSION,
      encodedBytesSource: 'same-reconciled-decoder-words', relocationView: 'unqualified', semanticEquivalence: 'unproved' } };
}
export async function nativeKnowledgeContext(locator, { database, world, snapshotId, maxCandidates, cursor = null, retrieval = 'page', maximumIndexRecords = 8192, maximumBucketScan = 1024, assumptions, work, isCurrent, loadOwner }) {
  if (!(database instanceof KnowledgeDB)) contractFail('native-knowledge-owner-required');
  const revision = database.revision, current = () => isCurrent() === true && database.revision === revision;
  if (!current()) contractFail('native-knowledge-context-stale');
  const loaded = await loadOwner(locator, { maximumValues: 1 });
  let issuedCursor = null;
  try {
    const query = loaded?.demand?.fingerprint;
    if (query?.status !== 'completed' || query.worldId !== world.id || query.snapshotId !== snapshotId
      || query.artifactId !== loaded.projection?.inputIdentity.producerArtifactId) contractFail('native-fingerprint-publication-binding');
    const scopeId = stableDigest({ worldId: world.id, assumptionsId: assumptions.id, snapshotId, locator,
      artifactId: query.artifactId, fingerprint: query.fingerprint, typed: lossyTypeWitness(query.fingerprint) });
    if (retrieval === 'indexed' && cursor !== null) contractFail('native-knowledge-index-does-not-consume-page-cursor');
    const page = retrieval === 'indexed'
      ? await database.scopedIndexedCandidates(query.fingerprint, { limit: maxCandidates, maximumRecords: maximumIndexRecords, maximumBucketScan, scopeId, work })
      : await database.scopedPage({ limit: maxCandidates, cursor, scopeId, work });
    issuedCursor = page.continuation;
    if (!current() || !page.isCurrent()) contractFail('native-knowledge-generation-changed');
    const candidates = [], remaining = ['knowledge-rejections-not-applied; candidates-only', 'cross-binary-contracts-not-verified'];
    for (const row of page.records) {
      work.charge('workUnits');
      if (row.fingerprint?.version !== FUNCTION_FINGERPRINT_VERSION || row.fingerprint?.schema !== 'hex.function-fingerprint'
        || !['arm64', 'arm64e'].includes(row.fingerprint.architecture)) { remaining.push('incompatible-record-preserved-as-unread'); continue; }
      exactString(row.id, 'knowledge-record-id');
      // This is an explicitly UNQUALIFIED knowledge-source identity. A saved
      // hash/name is not proof that the original binary is currently loaded.
      const binaryId = 'knowledge_source_' + stableDigest({ source: row.sourceBinaryHash ?? null });
      const identity = { recordId: row.id, revision, fingerprint: row.fingerprint, typed: lossyTypeWitness(row.fingerprint) };
      candidates.push({ binaryId, functionId: createEntityId({ binaryId, kind: 'knowledge-function-record', identity: { recordId: row.id } }),
        artifactId: createEntityId({ binaryId, kind: 'knowledge-record-revision', identity }), fingerprint: row.fingerprint,
        evidenceIds: [], label: (row.names ?? []).slice(0, 4).join(' / ').slice(0, 4096) || null,
        provenance: { owner: 'KnowledgeDB', recordId: row.id, revision, sourceBinaryHash: row.sourceBinaryHash,
          confirmation: row.confirmation, versions: (row.versions ?? []).slice(0, 32), license: 'not-established-by-local-record', authority: 'stored-annotation-not-semantic-proof' } });
    }
    const { status: _status, schema: _schema, worldId: _world, snapshotId: _snapshot, ...published } = query;
    return { functionLocator: locator, worldId: world.id, snapshotId, revision: String(revision), query: published, candidates,
      page: { completeness: page.truncated ? 'partial' : 'complete-page', remaining: [...new Set(remaining)], continuation: page.continuation, visited: page.visited, scopeId, ...(page.retrieval ? { retrieval: page.retrieval } : {}) }, isCurrent: current };
  } catch (error) { if (issuedCursor) database.cancelScopedPage(issuedCursor); throw error; }
  finally { loaded?.projection?.release(); }
}
