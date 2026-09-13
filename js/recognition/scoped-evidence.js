/** Evidence-preserving view of the EXISTING fingerprint comparator.
 * No additional recognizer, embedding store, or canonical identity database.
 * A hash/score/legacy `semantic-equivalent` label is never an equivalence proof.
 */
import { compareFingerprints, FUNCTION_FINGERPRINT_VERSION, FUNCTION_FINGERPRINT_COMPARISON_VERSION } from '../fingerprint/index.js';
import { createEntityId, deepFreeze, stableDigest, lossyTypeWitness } from '../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../core/identity/world.js';
import { assertScopedAnalysisWork, workStopStatus } from '../core/budgets/scoped-work.js';
import { snapshotContractData, recordFields, exactString, exactInteger, stringSet, compareIdentity, contractFail } from '../core/identity/structured.js';

export const SCOPED_RECOGNITION_VERSION = '1.3.0';
const HASH_FIELDS = Object.freeze(['exactBytesHash', 'normalizedBytesHash', 'instructionSequenceHash',
  'instructionBagHash', 'normalizedOperandsHash', 'normalizedOperandBagHash', 'cfgHash', 'semanticHash']);
const typedDigest = (value) => stableDigest({ value, typed: lossyTypeWitness(value) });

function normalizePublishedFunction(input, work) {
  // Only a bounded, already-published owner fingerprint is accepted here.
  // Passing source instructions would accidentally create a second eager
  // fingerprinting path with different budgets and metadata interpretation.
  const source = snapshotContractData(input, { allowBigInt: true, maxBytes: 262144, maxNodes: 8192 });
  recordFields(source, ['binaryId', 'functionId', 'artifactId', 'fingerprint', 'evidenceIds', 'label', 'provenance'], 'recognition-function-fields');
  exactString(source.binaryId, 'recognition-binary'); exactString(source.functionId, 'recognition-function');
  exactString(source.artifactId, 'recognition-artifact');
  const fp = source.fingerprint;
  if (fp?.schema !== 'hex.function-fingerprint' || fp.version !== FUNCTION_FINGERPRINT_VERSION) {
    contractFail('recognition-published-full-fingerprint-required');
  }
  if (!['arm64', 'arm64e'].includes(fp.architecture)) contractFail('recognition-arm64-only');
  exactInteger(fp.size, 'recognition-function-size', { max: 1048576 });
  for (const name of HASH_FIELDS) if (fp[name] != null) exactString(fp[name], 'recognition-feature-hash', 256);
  // Fields read by compareFingerprints are primitives, bounded arrays and
  // bounded profile records. No plugin callbacks are invoked by comparison.
  for (const name of ['basicBlockHashes', 'strings', 'imports', 'calls', 'constants', 'fieldAccessShape',
    'runtimeMetadata', 'callers', 'callees']) {
    if (!Array.isArray(fp[name]) || fp[name].length > 4096) contractFail(`recognition-feature-budget:${name}`);
  }
  if (!Array.isArray(fp.byteSample) || fp.byteSample.length > 4096
    || fp.byteSample.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) contractFail('recognition-byte-sample');
  for (const name of ['cfg', 'objc', 'swift']) {
    if (!fp[name] || typeof fp[name] !== 'object' || Array.isArray(fp[name])) contractFail('recognition-profile-record');
  }
  const evidenceIds = stringSet(source.evidenceIds ?? [], 'recognition-evidence', 256);
  const label = source.label == null ? null : exactString(source.label, 'recognition-label', 4096);
  work.charge('workUnits', 1 + Object.values(fp).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 1), 0));
  work.charge('residentBytes', 512 + JSON.stringify(fp, (_, value) => typeof value === 'bigint' ? value.toString() : value).length * 2);
  return deepFreeze({ ...source, label, evidenceIds, fingerprintDigest: typedDigest(fp),
    provenance: source.provenance ?? null });
}

function explainExistingSignals(comparison) {
  if (!Number.isFinite(comparison.confidence) || comparison.confidence < 0 || comparison.confidence > 1
    || !Array.isArray(comparison.evidence) || comparison.evidence.length > 128) contractFail('recognition-comparator-result');
  const groups = new Map();
  for (const signal of comparison.evidence) {
    if (!Number.isFinite(signal.value) || !Number.isFinite(signal.weight) || signal.weight < 0
      || signal.value < 0 || signal.value > 1) contractFail('recognition-feature-contribution');
    exactString(signal.group, 'recognition-feature-group'); exactString(signal.signal, 'recognition-feature-name');
    let group = groups.get(signal.group);
    if (!group) groups.set(signal.group, group = { totalSignalWeight: 0, groupWeight: 0 });
    group.totalSignalWeight += signal.weight; group.groupWeight = Math.max(group.groupWeight, signal.weight);
  }
  const totalGroupWeight = [...groups.values()].reduce((sum, group) => sum + group.groupWeight, 0);
  const features = comparison.evidence.map((signal) => {
    const group = groups.get(signal.group);
    return { feature: signal.signal, group: signal.group, value: signal.value, rawWeight: signal.weight,
      groupWeight: group.groupWeight,
      preCalibrationContribution: totalGroupWeight && group.totalSignalWeight
        ? signal.value * signal.weight / group.totalSignalWeight * group.groupWeight / totalGroupWeight : 0,
      legacyExactSignal: signal.exact === true,
      authority: 'matching-feature-not-identity-proof' };
  });
  return { features, contributionSemantics: 'linear-group-score-before-existing-comparator-floors-caps-and-boosts' };
}

/** Checks only observable constraints of the captured fingerprint records.
 * A mismatch can refute a particular byte/feature-equality proposition, never
 * refute all semantic equivalences. Source qualification stays separate.
 */
function matchConstraints(query, candidate, work) {
  const records = [], accepted = [], rejected = [], unknown = [];
  const add = (kind, status, observed, meaning) => {
    work.charge('workUnits');
    const body = { kind, status, observed, meaning, queryArtifact: query.artifactId,
      candidateArtifact: candidate.artifactId, authority: 'captured-owner-record-comparison; not-semantic-proof' };
    const id = createEntityId({ binaryId: query.binaryId, kind: 'recognition-constraint', identity: body });
    records.push({ ...body, id }); ({ accepted, rejected, unknown })[status].push(id);
  };
  const a = query.fingerprint, b = candidate.fingerprint;
  add('same-declared-architecture', a.architecture === b.architecture ? 'accepted' : 'rejected',
    [a.architecture, b.architecture], 'an architectural annotation, not ISA/profile qualification');
  add('equal-encoded-size', a.size === b.size ? 'accepted' : 'rejected', [a.size, b.size],
    'unequal extents reject byte identity, not optimized behavioral equivalence');
  const full = a.byteSample.length === a.size && b.byteSample.length === b.size;
  let equal = a.byteSample.length === b.byteSample.length;
  for (let index = 0; index < Math.max(a.byteSample.length, b.byteSample.length); index++) {
    work.charge('workUnits'); if (a.byteSample[index] !== b.byteSample[index]) equal = false;
  }
  add('captured-byte-sample-equality', !equal ? 'rejected' : full ? 'accepted' : 'unknown',
    { equal, completeSamples: full, queryLength: a.byteSample.length, candidateLength: b.byteSample.length },
    'sample equality is not a current-source, relocation or execution-environment identity proof');
  add('abi-type-placement-compatible', 'unknown', null, 'independent physical ABI/type bindings required');
  add('observable-effects-equivalent', 'unknown', null, 'summary/effect comparison across worlds not qualified');
  add('reference-source-current', 'unknown', null, 'reference bytes and reference world not reopened');
  const versions = stringSet(candidate.provenance?.versions ?? [], 'recognition-reference-versions', 32);
  versions.forEach(value => exactString(value, 'recognition-reference-version', 1024));
  add('sdk-version-family', 'unknown', versions,
    'stored version annotations are alternatives, not qualified SDK identity');
  return { accepted, rejected, unknown, records };
}

/** The host provides a current KnowledgeDB/index page, not an AI-supplied DB.
 * `isCurrent` MUST bind database revision, fingerprint producers and the page's
 * generation. A complete page is not a complete knowledge universe.
 */
export async function queryScopedRecognition(request, { world, assumptions, snapshotId, work, getContext = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  const input = snapshotContractData(request);
  recordFields(input, ['functionId', 'maxCandidates', 'resultLimit', 'cursor', 'versionFamily', 'retrieval', 'maximumIndexRecords', 'maximumBucketScan'], 'recognition-query-fields');
  exactString(input.functionId, 'recognition-function-locator'); exactString(snapshotId, 'recognition-snapshot');
  const maxCandidates = exactInteger(input.maxCandidates ?? 64, 'recognition-candidate-cap', { min: 1, max: 128 });
  const resultLimit = exactInteger(input.resultLimit ?? 16, 'recognition-result-cap', { min: 1, max: 32 });
  const cursor = input.cursor == null ? null : exactString(input.cursor, 'recognition-cursor', 128);
  const versionFamily = input.versionFamily == null ? null : exactString(input.versionFamily, 'recognition-version-family', 1024);
  const retrieval = input.retrieval ?? 'page';
  if (!['page', 'indexed'].includes(retrieval) || retrieval === 'indexed' && cursor !== null
    || retrieval === 'page' && (input.maximumIndexRecords != null || input.maximumBucketScan != null)) contractFail('recognition-retrieval-mode');
  const maximumIndexRecords = exactInteger(input.maximumIndexRecords ?? 8192, 'recognition-index-record-cap', { min: 128, max: 65536 });
  if (maximumIndexRecords % 128 !== 0) contractFail('recognition-index-page-multiple');
  const maximumBucketScan = exactInteger(input.maximumBucketScan ?? 1024, 'recognition-bucket-scan', { min: maxCandidates, max: 4096 });
  if (typeof getContext !== 'function') return { status: 'unsupported', reason: 'canonical-knowledge-context-unavailable', exact: false };
  const context = await work.await((signal) => getContext(input.functionId, { world, assumptions, snapshotId, maxCandidates, cursor, retrieval, maximumIndexRecords, maximumBucketScan, signal }));
  if (!context || context.functionLocator !== input.functionId || context.worldId !== world.id || context.snapshotId !== snapshotId
    || typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('recognition-context-binding');
  if (!Array.isArray(context.candidates) || context.candidates.length > maxCandidates) contractFail('recognition-host-candidate-cap');
  const revision = exactString(context.revision, 'recognition-knowledge-revision');
  // Detach the whole admitted page synchronously before yielding. This prevents
  // an update to a later record from manufacturing a mixed-generation page.
  const query = normalizePublishedFunction(context.query, work);
  if (!worldContains(world, query.binaryId)) contractFail('recognition-query-outside-world');
  const candidates = context.candidates.map((item) => normalizePublishedFunction(item, work));
  const page = snapshotContractData(context.page ?? { completeness: 'unknown', remaining: [] }, { maxBytes: 16384 });
  recordFields(page, ['completeness', 'remaining', 'continuation', 'visited', 'scopeId', 'retrieval'], 'recognition-page-fields');
  if (page.continuation != null) exactString(page.continuation, 'recognition-host-cursor', 128);
  if (page.visited != null) exactInteger(page.visited, 'recognition-page-visited');
  if (page.scopeId != null) exactString(page.scopeId, 'recognition-page-scope', 512);
  if (!['complete-page', 'partial', 'unknown'].includes(page.completeness)) contractFail('recognition-page-completeness');
  const remaining = new Set(['knowledge-universe-open', 'feature-hash-collisions-not-eliminated', 'semantic-equivalence-not-proved']);
  for (const reason of stringSet(page.remaining ?? [], 'recognition-page-remaining', 256)) remaining.add(reason);
  const inputIdentity = { worldId: world.id, assumptionsId: assumptions.id, snapshotId, revision,
    query: { artifactId: query.artifactId, digest: query.fingerprintDigest },
    candidates: candidates.map((item) => ({ binaryId: item.binaryId, functionId: item.functionId, artifactId: item.artifactId, digest: item.fingerprintDigest })),
    page: page.retrieval ? { ...page, retrieval: { ...page.retrieval, indexBuilt: null, candidateCutReused: null, sampledBucketUpperBound: null, buildPages: null } } : page, versionFamily, algorithm: { id: 'existing-compareFingerprints', version: FUNCTION_FINGERPRINT_COMPARISON_VERSION,
      fingerprintVersion: FUNCTION_FINGERPRINT_VERSION, projectionVersion: SCOPED_RECOGNITION_VERSION } };
  const id = createEntityId({ binaryId: query.binaryId, kind: 'scoped-recognition-result', identity: inputIdentity });
  const rows = [], seen = new Set(), hashBuckets = new Map();
  // Reserve the small output page before computation so a deadline can still
  // return already-produced partial evidence without a post-timeout charge.
  work.charge('results', Math.min(candidates.length, resultLimit));
  // Reserve bounded sorting/capsule output before the cancellable loop. A
  // stopped query must still export its completed rows without another debit.
  const capsuleBytes = 16384 + Math.min(candidates.length, resultLimit) * 131072;
  work.charge('workUnits', candidates.length * 16 + Math.min(candidates.length, resultLimit) * 128);
  work.charge('residentBytes', capsuleBytes);
  let executionStatus = 'completed', considered = 0;
  try {
    for (const candidate of candidates) {
      work.checkpoint();
      if (context.isCurrent() !== true) contractFail('recognition-context-stale');
      const key = typedDigest([candidate.binaryId, candidate.functionId, candidate.artifactId]);
      if (seen.has(key)) contractFail('recognition-duplicate-candidate');
      seen.add(key); considered++;
      work.charge('workUnits');
      const compared = compareFingerprints(query.fingerprint, candidate.fingerprint);
      const explained = explainExistingSignals(compared);
      const candidateId = createEntityId({ binaryId: query.binaryId, kind: 'recognition-candidate-reference', identity: { resultId: id, key } });
      rows.push({ id: candidateId, binaryId: candidate.binaryId, functionId: candidate.functionId, artifactId: candidate.artifactId,
        fingerprintDigest: candidate.fingerprintDigest, label: candidate.label, provenance: candidate.provenance,
        evidenceIds: candidate.evidenceIds, score: compared.confidence, reportedMatcherLabel: compared.identity,
        reasons: stringSet(compared.reasons ?? [], 'recognition-reasons', 128), ...explained,
        constraints: matchConstraints(query, candidate, work),
        exactIdentity: false, semanticEquivalence: 'unproved', metadataTransferAllowed: false });
      for (const feature of HASH_FIELDS) {
        const hash = candidate.fingerprint[feature];
        if (!hash) continue;
        const bucketId = typedDigest([feature, hash]);
        let bucket = hashBuckets.get(bucketId);
        if (!bucket) hashBuckets.set(bucketId, bucket = { feature, hash, candidateIds: [] });
        bucket.candidateIds.push(candidateId);
      }
      await work.yieldIfNeeded();
    }
    if (context.isCurrent() !== true) contractFail('recognition-context-stale');
  } catch (error) {
    const stopped = workStopStatus(error, work.signal);
    if (!stopped) throw error;
    executionStatus = stopped; remaining.add('candidate-comparison-incomplete');
  }
  rows.sort((a, b) => b.score - a.score || compareIdentity(a.id, b.id));
  if (rows.length > resultLimit) remaining.add('ranked-result-truncated');
  if (page.completeness !== 'complete-page') remaining.add('candidate-page-incomplete');
  const collisions = [...hashBuckets.values()].filter((bucket) => bucket.candidateIds.length > 1)
    .map((bucket) => ({ ...bucket, candidateIds: bucket.candidateIds.sort(compareIdentity),
      classification: 'shared-feature-bucket; not-proven-semantic-identity-or-hash-collision' }));
  // Preserve the same reference-universe cut and all collision candidates.
  // Hashes affect ranking only; no capsule authorizes metadata transfer.
  const capsuleBody = { schema: 'match-capsule/v1', queryBinary: query.binaryId, queryEntity: query.functionId,
    referenceUniverse: typedDigest({ revision, candidates: inputIdentity.candidates, page: inputIdentity.page }),
    universeCoverage: { page: page.completeness, universe: 'open', considered, candidates: candidates.length },
    algorithm: inputIdentity.algorithm,
    candidates: rows.slice(0, resultLimit).map(row => ({ reference: row.id, artifact: row.artifactId,
      features: row.features.map(feature => ({ kind: feature.feature, contribution: feature.preCalibrationContribution,
        artifact: row.artifactId })), similarityScore: row.score, constraints: row.constraints, relation: 'similar-only' })),
    collisionSet: [...new Set(collisions.flatMap(bucket => bucket.candidateIds))].sort(compareIdentity),
    transferableClaims: [], transferObligations: ['reference-source-current', 'abi-type-placement-compatible',
      'observable-effects-equivalent', 'sdk-version-family', 'license-and-annotation-authority'],
    exact: false, semanticAuthority: false };
  const capsule = { ...capsuleBody, id: createEntityId({ binaryId: query.binaryId, kind: 'match-capsule', identity: capsuleBody }) };
  snapshotContractData(capsule, { maxBytes: capsuleBytes, maxNodes: 65536, allowBigInt: true });
  if (context.isCurrent() !== true) contractFail('recognition-context-stale');
  return deepFreeze({ schema: 'scoped-recognition/v1', id, status: executionStatus, inputIdentity,
    queryFunctionId: query.functionId, requestedFunctionLocator: input.functionId,
    candidates: rows.slice(0, resultLimit), capsule, collisions, considered, candidateCount: candidates.length,
    retrieval: page.retrieval ?? null,
    versionFamily: describeVersionFamily(rows, versionFamily, page),
    upperBound: { kind: 'top', reason: 'knowledge-universe-open' }, provenMembers: [],
    existence: rows.length ? 'POSSIBLE' : 'UNKNOWN', exact: false,
    continuation: page.continuation ?? null, continuationAuthority: 'opaque-host-page-only; not-a-proof',
    remaining: [...remaining].sort(compareIdentity), cost: work.cost() });
}

/** Exact annotation membership, never SDK identity or version ordering. */
function describeVersionFamily(rows, requested, page) {
  const members = new Map();
  for (const row of rows) for (const version of row.provenance?.versions ?? []) {
    if (!members.has(version)) members.set(version, []);
    members.get(version).push(row.id);
  }
  return { requested, alternatives: [...members].sort(([a], [b]) => compareIdentity(a, b))
    .map(([version, candidates]) => ({ version, candidates: candidates.sort(compareIdentity) })),
    requestedCandidateIds: requested === null ? [] : (members.get(requested) ?? []).slice(),
    coverage: page.completeness, absence: 'UNKNOWN', exactVersionIdentity: false,
    authority: 'stored-version-annotations; all-candidates-preserved; no-semver-or-SDK-proof' };
}
