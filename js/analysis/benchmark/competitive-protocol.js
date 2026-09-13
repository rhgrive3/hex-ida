/** Competitive experiment contracts; NOT a benchmark runner or oracle.
 * Metadata declares an experiment. Only host-bound independent receipts admit
 * twins, capabilities and measurements. No absent measurement becomes zero.
 */
import { createEntityId, stableDigest, deepFreeze } from '../../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum,
  sha256Text, stringSet, compareIdentity, contractFail } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';

export const COMPETITIVE_PROTOCOL_SCHEMA = 'arm64-competitive-protocol/v1';
export const PARTICIPANTS = Object.freeze(['hex-astra', 'ida-astra', 'ghidra-astra']);
export const AVAILABILITY = Object.freeze(['AVAILABLE', 'BETA', 'ANNOUNCED', 'ROADMAP', 'UNVERIFIED']);
export const REQUIRED_METRICS = Object.freeze([
  'instruction-semantics', 'cfg', 'function-discovery', 'indirect-targets', 'points-to',
  'alias', 'memory-reaching-definition', 'value-recovery', 'type-layout-prototype',
  'decompiler-semantics', 'decompiler-readability', 'deobfuscation', 'semantic-queries',
  'symbolic-proof', 'static-runtime-reconciliation', 'similarity-recognition',
  'autonomous-investigation', 'explanation-provenance', 'cold-start', 'first-useful-result',
  'focused-query', 'peak-memory', 'large-binary-scaling', 'cancellation', 'incremental-cost',
]);
export const EXACT_ERROR_COUNTERS = Object.freeze([
  'wrong-exact-facts', 'false-must-alias', 'false-no-alias', 'false-exact-indirect-target', 'false-exact-type',
]);
const PROTOCOLS = new WeakSet(), ADMITTED = new WeakSet();
const TWIN_MANIFEST_SCHEMA = 'hex-competitive-twin-manifest/v1';
const datum = (value, code) => exactString(value, code, 4096);

function toolIdentity(input) {
  recordFields(input, ['name', 'version', 'distributionSha256', 'adapterSha256', 'settingsSha256', 'availability', 'capabilities', 'evidenceRefs'], 'competitive-tool-fields');
  return { name: datum(input.name, 'competitive-tool-name'), version: datum(input.version, 'competitive-tool-version'),
    distributionSha256: sha256Text(input.distributionSha256), adapterSha256: sha256Text(input.adapterSha256),
    settingsSha256: sha256Text(input.settingsSha256), availability: exactEnum(input.availability, AVAILABILITY, 'competitive-tool-availability'),
    capabilities: stringSet(input.capabilities, 'competitive-tool-capabilities', 256), evidenceRefs: stringSet(input.evidenceRefs, 'competitive-tool-evidence', 256) };
}
function astraIdentity(input) {
  recordFields(input, ['provider', 'modelId', 'modelRevision', 'inferenceParametersSha256', 'systemPromptSha256',
    'taskPromptSha256', 'harnessSha256', 'contextPolicySha256', 'knowledgePolicySha256', 'resourcePolicySha256'], 'competitive-astra-fields');
  const result = { provider: datum(input.provider, 'competitive-model-provider'), modelId: datum(input.modelId, 'competitive-model-id'),
    modelRevision: datum(input.modelRevision, 'competitive-model-revision') };
  for (const key of ['inferenceParametersSha256', 'systemPromptSha256', 'taskPromptSha256', 'harnessSha256',
    'contextPolicySha256', 'knowledgePolicySha256', 'resourcePolicySha256']) result[key] = sha256Text(input[key], `competitive-${key}`);
  return result;
}
function machineIdentity(input) {
  recordFields(input, ['machineId', 'osBuild', 'browserBuild', 'cpuProfile', 'memoryBytes', 'powerMode', 'isolationPolicySha256'], 'competitive-machine-fields');
  return { machineId: datum(input.machineId, 'competitive-machine'), osBuild: datum(input.osBuild, 'competitive-os'),
    browserBuild: input.browserBuild === null ? null : datum(input.browserBuild, 'competitive-browser'),
    cpuProfile: datum(input.cpuProfile, 'competitive-cpu'), memoryBytes: exactInteger(input.memoryBytes, 'competitive-memory', { min: 1 }),
    powerMode: datum(input.powerMode, 'competitive-power'), isolationPolicySha256: sha256Text(input.isolationPolicySha256) };
}
function twinReference(input) {
  recordFields(input, ['caseId', 'sourceSha256', 'binarySha256', 'debugBinarySha256', 'twinManifestSchema', 'twinManifestDigest',
    'executableBytesManifestSha256', 'oracleManifestSha256', 'toolchainManifestSha256', 'licenseEvidence', 'language', 'platform', 'isaProfile'], 'competitive-twin-fields');
  if (input.twinManifestSchema !== TWIN_MANIFEST_SCHEMA) contractFail('competitive-existing-twin-contract-required');
  return { caseId: datum(input.caseId, 'competitive-case'), sourceSha256: sha256Text(input.sourceSha256),
    binarySha256: sha256Text(input.binarySha256), debugBinarySha256: sha256Text(input.debugBinarySha256),
    twinManifestSchema: TWIN_MANIFEST_SCHEMA, twinManifestDigest: datum(input.twinManifestDigest, 'competitive-twin-digest'),
    executableBytesManifestSha256: sha256Text(input.executableBytesManifestSha256), oracleManifestSha256: sha256Text(input.oracleManifestSha256),
    toolchainManifestSha256: sha256Text(input.toolchainManifestSha256), licenseEvidence: datum(input.licenseEvidence, 'competitive-license-evidence'),
    language: exactEnum(input.language, ['c', 'cpp', 'objc', 'swift', 'rust', 'go'], 'competitive-language'),
    platform: exactEnum(input.platform, ['apple-macos', 'apple-ios', 'linux', 'android', 'windows-arm64'], 'competitive-platform'),
    isaProfile: datum(input.isaProfile, 'competitive-isa-profile') };
}

/** Declared protocol only. Does not download, execute or fabricate a corpus. */
export function createCompetitiveProtocol(value) {
  const input = snapshotContractData(value, { maxBytes: 4 * 1024 * 1024, maxNodes: 100000 });
  recordFields(input, ['schema', 'campaign', 'baselineCommit', 'denominatorSha256', 'track', 'participants', 'cases',
    'metrics', 'repetitions', 'orderPolicySha256', 'warmStatePolicySha256', 'adjudicationPolicySha256', 'victoryPolicySha256', 'holdoutManifestSha256'], 'competitive-protocol-fields');
  if (input.schema !== undefined && input.schema !== COMPETITIVE_PROTOCOL_SCHEMA) contractFail('competitive-protocol-schema');
  if (!/^[0-9a-f]{40}$/.test(input.baselineCommit)) contractFail('competitive-baseline-commit');
  if (!Array.isArray(input.participants) || input.participants.length !== PARTICIPANTS.length) contractFail('competitive-participant-count');
  const participants = input.participants.map((item) => {
    recordFields(item, ['id', 'tool', 'astra', 'machine', 'nativeCapabilitiesPolicySha256'], 'competitive-participant-fields');
    return { id: exactEnum(item.id, PARTICIPANTS, 'competitive-participant-id'), tool: toolIdentity(item.tool),
      astra: astraIdentity(item.astra), machine: machineIdentity(item.machine),
      nativeCapabilitiesPolicySha256: sha256Text(item.nativeCapabilitiesPolicySha256) };
  }).sort((a, b) => compareIdentity(a.id, b.id));
  if (new Set(participants.map((p) => p.id)).size !== PARTICIPANTS.length) contractFail('competitive-participant-duplicate');
  const commonAstra = stableDigest(participants[0].astra);
  if (participants.some((p) => stableDigest(p.astra) !== commonAstra)) contractFail('competitive-not-same-astra');
  // Native adapters may differ. The shared resource/context policy may not.
  if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 4096) contractFail('competitive-case-count');
  const cases = input.cases.map(twinReference).sort((a, b) => compareIdentity(a.caseId, b.caseId));
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) contractFail('competitive-case-duplicate');
  const metrics = stringSet(input.metrics ?? REQUIRED_METRICS, 'competitive-metrics', REQUIRED_METRICS.length);
  if (!metrics.length || metrics.some((metric) => !REQUIRED_METRICS.includes(metric))) contractFail('competitive-metric-unrecognized');
  const body = { schema: COMPETITIVE_PROTOCOL_SCHEMA, campaign: datum(input.campaign, 'competitive-campaign'),
    baselineCommit: input.baselineCommit, denominatorSha256: sha256Text(input.denominatorSha256),
    track: exactEnum(input.track, ['scripted-substrate', 'native-best', 'knowledge-equalized'], 'competitive-track'),
    participants, cases, metrics, repetitions: exactInteger(input.repetitions, 'competitive-repetitions', { min: 1, max: 1000 }),
    orderPolicySha256: sha256Text(input.orderPolicySha256), warmStatePolicySha256: sha256Text(input.warmStatePolicySha256),
    adjudicationPolicySha256: sha256Text(input.adjudicationPolicySha256), victoryPolicySha256: sha256Text(input.victoryPolicySha256),
    holdoutManifestSha256: sha256Text(input.holdoutManifestSha256), sameAstraIdentity: commonAstra };
  const id = createEntityId({ binaryId: `benchmark:${body.denominatorSha256}`, kind: COMPETITIVE_PROTOCOL_SCHEMA, identity: body });
  const result = deepFreeze({ ...body, id, status: 'DECLARED', qualified: false }); PROTOCOLS.add(result); return result;
}
export function assertCompetitiveProtocol(protocol) {
  if (!PROTOCOLS.has(protocol)) contractFail('competitive-protocol-not-normalized');
  return protocol;
}

/** Reuses a host adapter for the existing twin verifier, then independently
 * checks executable bytes and ground-truth scope. A matching manifest alone
 * cannot admit source/CFG/semantics. No verifier is shipped as a fake oracle.
 */
export async function admitCompetitiveProtocol(protocol, { work, verifyTwin, verifyParticipant, verifyPolicies } = {}) {
  assertCompetitiveProtocol(protocol); assertScopedAnalysisWork(work);
  const obligations = [], twinReceipts = [], participantReceipts = [];
  if (typeof verifyPolicies !== 'function') obligations.push('independent-policy-adjudicator-unavailable');
  else {
    const answer = await work.await((signal) => verifyPolicies(protocol, { signal }));
    if (answer?.protocolId !== protocol.id || answer.denominatorSha256 !== protocol.denominatorSha256
      || answer.victoryPolicySha256 !== protocol.victoryPolicySha256 || answer.preregistered !== true
      || answer.nativeAdaptersFair !== true || answer.counterbalanced !== true || answer.knowledgePolicyChecked !== true) {
      obligations.push('protocol-fairness-and-preregistration-not-admitted');
    }
  }
  for (const item of protocol.cases) {
    work.charge('workUnits');
    const receipt = typeof verifyTwin === 'function' ? await work.await((signal) => verifyTwin(item, { protocol, signal })) : null;
    if (receipt?.caseId !== item.caseId || receipt.binarySha256 !== item.binarySha256
      || receipt.debugBinarySha256 !== item.debugBinarySha256 || receipt.twinManifestDigest !== item.twinManifestDigest
      || receipt.oracleManifestSha256 !== item.oracleManifestSha256 || receipt.stripLineageVerified !== true
      || receipt.executableBytesEqual !== true || receipt.independentGroundTruth !== true
      || receipt.licensePermitted !== true || typeof receipt.checkerVersion !== 'string' || !receipt.checkerVersion) {
      obligations.push(`twin-not-admitted:${item.caseId}`);
    } else twinReceipts.push(snapshotContractData(receipt, { maxBytes: 65536, maxNodes: 4096 }));
    await work.yieldIfNeeded();
  }
  for (const participant of protocol.participants) {
    work.charge('workUnits');
    const receipt = typeof verifyParticipant === 'function'
      ? await work.await((signal) => verifyParticipant(participant, { protocol, signal })) : null;
    if (receipt?.participantId !== participant.id || receipt.toolDistributionSha256 !== participant.tool.distributionSha256
      || receipt.adapterSha256 !== participant.tool.adapterSha256 || receipt.sameAstraIdentity !== protocol.sameAstraIdentity
      || receipt.nativeCapabilitiesActuallyExercised !== true || receipt.availableForMeasurement !== true) {
      obligations.push(`participant-not-admitted:${participant.id}`);
    } else participantReceipts.push(snapshotContractData(receipt, { maxBytes: 65536, maxNodes: 4096 }));
  }
  const result = deepFreeze({ schema: 'competitive-protocol-admission/v1', protocolId: protocol.id,
    status: obligations.length ? 'NOT-ADMITTED' : 'ADMITTED-FOR-MEASUREMENT', obligations,
    twinReceipts, participantReceipts, victoryEstablished: false, cost: work.cost() });
  ADMITTED.add(result); return result;
}

export function assertCompetitiveProtocolAdmission(admission, protocol) {
  assertCompetitiveProtocol(protocol);
  if (!ADMITTED.has(admission) || admission.protocolId !== protocol.id) contractFail('competitive-admission-required');
  return admission;
}

/** Measurement data has independent observation/correctness/receipt fields.
 * No timing, failure count or recall is synthesized for an unavailable cell.
 */
export function normalizeCompetitiveMeasurement(protocol, value) {
  assertCompetitiveProtocol(protocol);
  const input = snapshotContractData(value, { maxBytes: 262144, maxNodes: 16384 });
  recordFields(input, ['protocolId', 'caseId', 'participantId', 'metric', 'repetition', 'state', 'cacheState',
    'binarySha256', 'value', 'unit', 'recall', 'unknownRate', 'exactErrors', 'oracleReceiptId',
    'executionReceiptId', 'correctnessReceiptId', 'sampleTraceSha256', 'reason'], 'competitive-measurement-fields');
  if (input.protocolId !== protocol.id) contractFail('competitive-measurement-protocol');
  const example = protocol.cases.find((item) => item.caseId === input.caseId);
  if (!example || input.binarySha256 !== example.binarySha256) contractFail('competitive-measurement-same-binary');
  exactEnum(input.participantId, PARTICIPANTS, 'competitive-measurement-participant');
  exactEnum(input.metric, protocol.metrics, 'competitive-measurement-metric');
  exactInteger(input.repetition, 'competitive-repetition', { max: protocol.repetitions - 1 });
  exactEnum(input.cacheState, ['cold', 'warm', 'not-applicable'], 'competitive-cache-state');
  const state = exactEnum(input.state, ['MEASURED', 'UNMEASURED', 'UNAVAILABLE', 'FAILED'], 'competitive-measurement-state');
  const body = { ...input, reason: input.reason == null ? null : datum(input.reason, 'competitive-measurement-reason') };
  if (state !== 'MEASURED') {
    for (const key of ['value', 'recall', 'unknownRate', 'exactErrors', 'oracleReceiptId', 'executionReceiptId', 'correctnessReceiptId', 'sampleTraceSha256']) {
      if (input[key] != null) contractFail('competitive-unmeasured-must-not-report-data');
      body[key] = null;
    }
    body.unit = input.unit == null ? null : datum(input.unit, 'competitive-unit');
  } else {
    if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0) contractFail('competitive-measurement-number');
    for (const key of ['recall', 'unknownRate']) {
      if (input[key] !== null && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1)) contractFail('competitive-ratio');
    }
    body.unit = datum(input.unit, 'competitive-unit');
    recordFields(input.exactErrors, EXACT_ERROR_COUNTERS, 'competitive-exact-counter-fields');
    body.exactErrors = Object.fromEntries(EXACT_ERROR_COUNTERS.map((key) => [key, exactInteger(input.exactErrors[key], 'competitive-exact-error-count')]));
    for (const key of ['oracleReceiptId', 'executionReceiptId', 'correctnessReceiptId']) body[key] = datum(input[key], `competitive-${key}`);
    body.sampleTraceSha256 = sha256Text(input.sampleTraceSha256);
  }
  return deepFreeze({ ...body, id: createEntityId({ binaryId: `benchmark:${protocol.denominatorSha256}`, kind: 'competitive-measurement/v1', identity: body }),
    receiptVerified: false });
}

/** Release veto/preflight only. Complete input data still does not select a
 * winner: paired statistics, recall noninferiority, human readability and all
 * platform gates require the separately pinned adjudicator.
 */
export function competitiveReleasePreflight(protocol, admission, measurements) {
  assertCompetitiveProtocol(protocol);
  if (!ADMITTED.has(admission) || admission.protocolId !== protocol.id) contractFail('competitive-admission-required');
  if (!Array.isArray(measurements) || measurements.length > 100000) contractFail('competitive-measurement-budget');
  const rows = measurements.map((value) => {
    const { id: _id, receiptVerified: _verified, ...data } = value;
    return normalizeCompetitiveMeasurement(protocol, data);
  });
  const keys = new Set(), vetoes = [...admission.obligations];
  let measured = 0;
  for (const row of rows) {
    const key = stableDigest([row.caseId, row.participantId, row.metric, row.repetition, row.cacheState]);
    if (keys.has(key)) contractFail('competitive-duplicate-measurement'); keys.add(key);
    if (row.state !== 'MEASURED') vetoes.push(`unmeasured:${row.id}`);
    else {
      measured++;
      for (const error of EXACT_ERROR_COUNTERS) if (row.exactErrors[error] !== 0) vetoes.push(`wrong-exact:${row.id}:${error}`);
    }
  }
  const expectedMinimum = protocol.cases.length * PARTICIPANTS.length * protocol.metrics.length * protocol.repetitions;
  // A quantity check cannot establish the exact case/cache-state Cartesian
  // product. The experiment's pinned adjudicator must close that matrix.
  if (measured < expectedMinimum) vetoes.push('required-measurement-matrix-incomplete');
  if (protocol.metrics.length !== REQUIRED_METRICS.length) vetoes.push('global-victory-metric-denominator-incomplete');
  vetoes.push('measurement-receipts-not-replayed', 'paired-statistical-and-human-adjudication-required');
  return deepFreeze({ schema: 'competitive-release-preflight/v1', protocolId: protocol.id, measured, expectedMinimum,
    distinctCells: keys.size, vetoes: stringSet(vetoes, 'competitive-vetoes', 600000), verdict: 'NOT-YET', victoryEstablished: false });
}
