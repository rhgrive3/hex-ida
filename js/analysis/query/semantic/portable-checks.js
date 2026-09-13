/** Project CURRENT owner proposals and freshly read source bytes into the small
 * detached replay format. Owner proposal generation is reused, never duplicated.
 */
import { collectDemandIntegerCandidates } from './demand-integer.js';
import { PORTABLE_CHECK_SCHEMA, normalizePortableChecks, replayPortableChecks } from '../../../core/evidence/portable-replay.js';
import { recordFields, exactString, contractFail } from '../../../core/identity/structured.js';
import { stableStringify } from '../../../core/identity/index.js';

export async function queryPortableChecks(input, { world, assumptions, snapshotId, work, isCurrent, loadOwner, readRange } = {}) {
  recordFields(input, ['functionId', 'capsule'], 'portable-query-fields'); exactString(input.functionId, 'portable-function');
  const supplied = input.capsule === undefined ? null : normalizePortableChecks(input.capsule);
  if (typeof readRange !== 'function') return { status: 'unsupported', reason: 'portable-current-source-reader-required', exact: false };
  const loaded = await loadOwner(input.functionId, work, { maximumValues: 64 });
  try {
    work.checkpoint(); if (isCurrent?.() !== true) contractFail('portable-owner-stale');
    const projection = loaded?.projection, demand = loaded?.demand;
    if (!projection || demand?.status !== 'completed') return { status: 'unsupported', reason: 'portable-current-native-owner-required', exact: false };
    const factReferences = [];
    for (let i = 0; i < projection.size; i++) {
      work.charge('workUnits'); const row = projection.recordAt(i);
      if (row.owner === 'semantic-ir') factReferences.push({ record: projection.present(row.id, { includeOrigins: true }), source: projection.source(row.id) });
      await work.yieldIfNeeded();
    }
    const candidates = collectDemandIntegerCandidates({ functionId: projection.functionId, demand, inputIdentity: projection.inputIdentity,
      factReferences }, { world, assumptions, work });
    const checks = [];
    for (const candidate of candidates) {
      const fragment = candidate.fragment, offset = fragment.source.start, length = Number(BigInt(fragment.source.boundary) - BigInt(offset));
      work.charge('bytesRead', length);
      const got = await work.await(signal => readRange({ worldId: world.id, binaryId: projection.inputIdentity.binaryId, offset, length, signal }));
      work.checkpoint(); if (isCurrent?.() !== true) contractFail('portable-source-stale');
      if (got?.worldId !== world.id || got.binaryId !== projection.inputIdentity.binaryId || String(got.offset) !== offset
        || !(got.bytes instanceof Uint8Array) || got.bytes.length !== length) contractFail('portable-source-read-binding');
      checks.push({ id: candidate.readReferenceId, fragment, bytesHex: [...got.bytes].map(v => v.toString(16).padStart(2, '0')).join('') });
    }
    const capsule = normalizePortableChecks({ schema: PORTABLE_CHECK_SCHEMA,
      binding: { worldId: world.id, assumptionsId: assumptions.id, snapshotId, binaryId: projection.inputIdentity.binaryId,
        functionId: projection.functionId, functionLocator: input.functionId, producerArtifactId: projection.inputIdentity.producerArtifactId }, checks,
      remaining: ['bounded-owner-proposal-subset; unlisted-values-not-checked', 'source-owner-and-profile-not-release-qualified'] });
    if (supplied && stableStringify(capsule) !== stableStringify(supplied)) return { status: 'rejected', reason: 'portable-current-owner-or-source-mismatch',
      exact: false, semanticProof: false, sourceBinding: 'mismatch', capsuleRebound: false };
    const replay = await replayPortableChecks(capsule, { work });
    work.checkpoint(); if (isCurrent?.() !== true) contractFail('portable-stale-before-publication');
    return { schema: 'scpa-current-portable-checks/v1', status: 'completed', capsule, replay,
      sourceBinding: 'current-native-owner-and-source-bytes', capsuleRebound: supplied !== null,
      exact: false, semanticProof: false, canonicalTruthChanged: false, releaseQualified: false };
  } finally { loaded?.projection?.release(); }
}
