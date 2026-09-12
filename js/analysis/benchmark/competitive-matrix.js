/**
 * Bounded audit of RECORDED competitive measurements. No compiler, benchmark,
 * model or product is executed. Missing/failed cells remain in the denominator.
 * This builds descriptive statistics, NOT statistical or overall victory claims.
 */
import { assertCompetitiveProtocol, assertCompetitiveProtocolAdmission, normalizeCompetitiveMeasurement,
  PARTICIPANTS, REQUIRED_METRICS, EXACT_ERROR_COUNTERS } from './competitive-protocol.js';
import { createEntityId, deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, exactEnum, sha256Text, stringSet, compareIdentity, contractFail } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';

export const COMPETITIVE_MATRIX_VERSION = '1.0.0';
export const COMPETITIVE_MATRIX_SCHEMA = 'arm64-competitive-metric-matrix/v1';
const PLANS = new WeakSet();
const MAX_CELLS = 100000, MAX_GROUPS = 1024, MAX_EXAMPLES = 128;
const STATES = ['cold', 'warm', 'not-applicable'];
const digest = (value) => stableDigest({ value, typed: lossyTypeWitness(value) });
const key = (...values) => stableStringify(values);
const finiteRatio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;

/** Manifest normalizer only. A hash/name is not proof of preregistration. */
export function createCompetitiveMetricMatrix(protocol, value) {
  assertCompetitiveProtocol(protocol);
  const input = snapshotContractData(value, { maxNodes: 65536, maxBytes: 2097152 });
  recordFields(input, ['schema', 'protocolId', 'definitionSha256', 'caseStrata', 'metrics'], 'competitive-matrix-fields');
  if (input.schema !== undefined && input.schema !== COMPETITIVE_MATRIX_SCHEMA || input.protocolId !== protocol.id) contractFail('competitive-matrix-protocol');
  if (!Array.isArray(input.metrics) || input.metrics.length !== protocol.metrics.length
    || !Array.isArray(input.caseStrata) || input.caseStrata.length !== protocol.cases.length) contractFail('competitive-matrix-complete-definition-required');
  const metrics = input.metrics.map((metric) => {
    recordFields(metric, ['id', 'unit', 'direction', 'cacheStates', 'definitionSha256'], 'competitive-metric-definition-fields');
    const id = exactEnum(metric.id, protocol.metrics, 'competitive-matrix-metric');
    const cacheStates = stringSet(metric.cacheStates, 'competitive-matrix-cache-states', 3);
    if (!cacheStates.length || cacheStates.some((state) => !STATES.includes(state))
      || cacheStates.includes('not-applicable') && cacheStates.length !== 1) contractFail('competitive-matrix-cache-state-mix');
    return { id, unit: exactString(metric.unit, 'competitive-matrix-unit'),
      direction: exactEnum(metric.direction, ['higher-better', 'lower-better', 'descriptive-only'], 'competitive-matrix-direction'),
      cacheStates, definitionSha256: sha256Text(metric.definitionSha256) };
  }).sort((a, b) => compareIdentity(a.id, b.id));
  if (new Set(metrics.map((metric) => metric.id)).size !== metrics.length) contractFail('competitive-matrix-duplicate-metric');
  const knownCases = new Set(protocol.cases.map((sample) => sample.caseId));
  const caseStrata = input.caseStrata.map((entry) => {
    recordFields(entry, ['caseId', 'stratumId'], 'competitive-matrix-stratum-fields');
    if (!knownCases.has(entry.caseId)) contractFail('competitive-matrix-case');
    return { caseId: entry.caseId, stratumId: exactString(entry.stratumId, 'competitive-matrix-stratum') };
  }).sort((a, b) => compareIdentity(a.caseId, b.caseId));
  if (new Set(caseStrata.map((entry) => entry.caseId)).size !== caseStrata.length) contractFail('competitive-matrix-duplicate-case');
  const strata = new Set(caseStrata.map((entry) => entry.stratumId));
  const variants = metrics.reduce((sum, metric) => sum + metric.cacheStates.length, 0);
  const expectedCells = caseStrata.length * variants * protocol.repetitions * PARTICIPANTS.length;
  if (expectedCells > MAX_CELLS || strata.size * variants > MAX_GROUPS) contractFail('competitive-matrix-structural-budget');
  const body = { schema: COMPETITIVE_MATRIX_SCHEMA, version: COMPETITIVE_MATRIX_VERSION,
    protocolId: protocol.id, definitionSha256: sha256Text(input.definitionSha256),
    denominatorSha256: protocol.denominatorSha256, caseStrata, metrics, expectedCells,
    expectedPairsPerCompetitor: expectedCells / PARTICIPANTS.length };
  const id = createEntityId({ binaryId: `benchmark:${protocol.denominatorSha256}`, kind: COMPETITIVE_MATRIX_SCHEMA, identity: body });
  const plan = deepFreeze({ ...body, id, status: 'DECLARED', preregistrationVerified: false });
  PLANS.add(plan); return plan;
}

function summary(samples) {
  if (!samples.length) return { count: 0, median: null, p95: null, mean: null };
  const ordered = [...samples].sort((left, right) => left - right), middle = Math.floor(ordered.length / 2);
  // Scaled accumulation avoids overflow when many finite large measurements are
  // supplied. Infinity/NaN must never appear as a silently successful statistic.
  let mean = 0;
  for (const sample of samples) mean += sample / samples.length;
  const median = ordered.length % 2 ? ordered[middle] : ordered[middle - 1] / 2 + ordered[middle] / 2;
  return { count: ordered.length, median, p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
    mean: Number.isFinite(mean) ? mean : null };
}
function unitRatio(a, b) {
  const ratio = finiteRatio(a, b);
  return ratio !== null && Number.isFinite(ratio) ? ratio : null;
}
function newCounters() {
  return { expected: 0, missing: 0, failed: 0, unavailable: 0, unmeasured: 0,
    measuredUnverified: 0, receiptChecked: 0, exactErrors: Object.fromEntries(EXACT_ERROR_COUNTERS.map((name) => [name, 0])) };
}
function addCounter(counter, row, checked) {
  counter.expected++;
  if (!row) { counter.missing++; return; }
  if (row.state !== 'MEASURED') {
    counter[{ FAILED: 'failed', UNAVAILABLE: 'unavailable', UNMEASURED: 'unmeasured' }[row.state]]++;
    return;
  }
  counter[checked ? 'receiptChecked' : 'measuredUnverified']++;
  for (const name of EXACT_ERROR_COUNTERS) {
    const count = counter.exactErrors[name] + row.exactErrors[name];
    if (!Number.isSafeInteger(count)) contractFail('competitive-error-counter-overflow');
    counter.exactErrors[name] = count;
  }
}

/**
 * verifyDefinition / verifyMeasurement are first-party offline verifier
 * capabilities, never tool-request data. They must actually replay their input
 * manifests/receipts. Absent verifiers keep rows unqualified. The method never
 * grants a winner, even after every receipt has passed.
 */
export async function auditCompetitiveMeasurements(protocol, admission, plan, measurements,
  { work, verifyDefinition = null, verifyMeasurement = null } = {}) {
  assertCompetitiveProtocol(protocol); assertCompetitiveProtocolAdmission(admission, protocol); assertScopedAnalysisWork(work);
  if (!PLANS.has(plan) || plan.protocolId !== protocol.id) contractFail('competitive-matrix-branded-plan-required');
  if (!Array.isArray(measurements) || measurements.length > MAX_CELLS
    || verifyDefinition !== null && typeof verifyDefinition !== 'function'
    || verifyMeasurement !== null && typeof verifyMeasurement !== 'function') contractFail('competitive-matrix-input');
  if (Object.getPrototypeOf(measurements) !== Array.prototype || Reflect.ownKeys(measurements).length !== measurements.length + 1) contractFail('competitive-matrix-plain-array-required');
  const definitions = new Map(plan.metrics.map((definition) => [definition.id, definition]));
  const rows = new Map(), checked = new Set(), leases = [], examples = [], rowsDigest = [], verificationRecords = [];
  let omittedExamples = 0, definitionChecked = false, definitionReceipt = null;
  const recordIssue = (issue) => {
    if (examples.length < MAX_EXAMPLES) { work.charge('residentBytes', 1024); examples.push(issue); } else omittedExamples++;
  };
  const captureLease = (context, code) => {
    if (!context || typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail(code);
    work.charge('residentBytes', 128); leases.push(context.isCurrent);
    return snapshotContractData(context.data, { maxBytes: 32768, maxNodes: 2048 });
  };
  if (verifyDefinition) {
    const context = await work.await((signal) => verifyDefinition(plan, { protocol, admission, signal, work }));
    if (context) {
      const receipt = captureLease(context, 'competitive-matrix-definition-owner-current');
      recordFields(receipt, ['protocolId', 'matrixId', 'definitionSha256', 'denominatorSha256', 'victoryPolicySha256',
        'checkerId', 'checkerVersion', 'receiptId', 'preregistrationVerified', 'fullDenominatorVerified', 'cacheAndStrataPolicyVerified'], 'competitive-matrix-definition-receipt-fields');
      if (receipt.protocolId !== protocol.id || receipt.matrixId !== plan.id || receipt.definitionSha256 !== plan.definitionSha256
        || receipt.denominatorSha256 !== protocol.denominatorSha256 || receipt.victoryPolicySha256 !== protocol.victoryPolicySha256) contractFail('competitive-matrix-definition-receipt-binding');
      for (const name of ['checkerId', 'checkerVersion', 'receiptId']) exactString(receipt[name], 'competitive-matrix-definition-checker');
      definitionChecked = receipt.preregistrationVerified === true && receipt.fullDenominatorVerified === true && receipt.cacheAndStrataPolicyVerified === true;
      definitionReceipt = receipt;
    }
  }
  for (let position = 0; position < measurements.length; position++) {
    const descriptor = Object.getOwnPropertyDescriptor(measurements, String(position));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) contractFail('competitive-matrix-non-data-row');
    const input = descriptor.value;
    work.charge('workUnits'); work.charge('nodes');
    // Strip presentation fields only after a strict detached read. Never accept
    // the input's receiptVerified flag as authority or reinterpret a source row.
    const snapshot = snapshotContractData(input, { maxNodes: 16384, maxBytes: 262144 });
    const { id: suppliedId, receiptVerified: _flag, ...data } = snapshot;
    const row = normalizeCompetitiveMeasurement(protocol, data);
    if (suppliedId !== undefined && suppliedId !== row.id) contractFail('competitive-matrix-measurement-id-mismatch');
    const definition = definitions.get(row.metric);
    if (!definition.cacheStates.includes(row.cacheState)) contractFail('competitive-matrix-unregistered-cache-state');
    if (row.unit !== null && row.unit !== definition.unit) contractFail('competitive-matrix-unit-mismatch');
    const cell = key(row.caseId, row.metric, row.repetition, row.cacheState, row.participantId);
    if (rows.has(cell)) contractFail('competitive-matrix-duplicate-cell');
    work.charge('residentBytes', stableStringify(row).length * 2 + cell.length * 2 + 256);
    rows.set(cell, row); rowsDigest.push(row.id);
    if (row.state === 'MEASURED' && verifyMeasurement) {
      const context = await work.await((signal) => verifyMeasurement(row, { protocol, plan, definition, signal, work }));
      if (context) {
        const receipt = captureLease(context, 'competitive-matrix-measurement-owner-current');
        recordFields(receipt, ['protocolId', 'matrixId', 'measurementId', 'sampleTraceSha256', 'definitionSha256',
          'oracleReceiptId', 'executionReceiptId', 'correctnessReceiptId', 'sameAstraIdentity',
          'checkerId', 'checkerVersion', 'receiptId', 'traceAndToolIdentityVerified', 'independentOracleVerified',
          'reportedNumbersVerified', 'scopeAndResourceAccountingVerified'], 'competitive-matrix-measurement-receipt-fields');
        if (receipt.protocolId !== protocol.id || receipt.matrixId !== plan.id || receipt.measurementId !== row.id
          || receipt.sampleTraceSha256 !== row.sampleTraceSha256 || receipt.definitionSha256 !== definition.definitionSha256
          || receipt.oracleReceiptId !== row.oracleReceiptId || receipt.executionReceiptId !== row.executionReceiptId
          || receipt.correctnessReceiptId !== row.correctnessReceiptId || receipt.sameAstraIdentity !== protocol.sameAstraIdentity) contractFail('competitive-matrix-measurement-receipt-binding');
        for (const name of ['checkerId', 'checkerVersion', 'receiptId']) exactString(receipt[name], 'competitive-matrix-measurement-checker');
        const admitted = receipt.traceAndToolIdentityVerified === true && receipt.independentOracleVerified === true
          && receipt.reportedNumbersVerified === true && receipt.scopeAndResourceAccountingVerified === true;
        if (admitted) checked.add(cell);
        const record = { measurementId: row.id, receiptId: receipt.receiptId, checkerId: receipt.checkerId,
          checkerVersion: receipt.checkerVersion, inputBindingDigest: digest(receipt), admitted };
        work.charge('residentBytes', stableStringify(record).length * 2); verificationRecords.push(record);
      }
    }
    await work.yieldIfNeeded();
  }
  const counters = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, newCounters()]));
  const groups = new Map();
  for (const entry of plan.caseStrata) for (const metric of plan.metrics) for (const cacheState of metric.cacheStates) {
    const groupKey = key(entry.stratumId, metric.id, cacheState);
    let group = groups.get(groupKey);
    if (!group) {
      group = { stratumId: entry.stratumId, metric: metric.id, cacheState, unit: metric.unit, direction: metric.direction,
        expectedPerParticipant: 0, participants: Object.fromEntries(PARTICIPANTS.map((participant) => [participant, newCounters()])),
        pairs: Object.fromEntries(PARTICIPANTS.filter((id) => id !== 'hex-astra').map((id) => [id, []])) };
      work.charge('residentBytes', 2048 + groupKey.length * 2); groups.set(groupKey, group);
    }
    for (let repetition = 0; repetition < protocol.repetitions; repetition++) {
      work.charge('workUnits'); group.expectedPerParticipant++;
      const paired = new Map();
      for (const participant of PARTICIPANTS) {
        work.charge('workUnits');
        const cell = key(entry.caseId, metric.id, repetition, cacheState, participant), row = rows.get(cell), qualified = checked.has(cell);
        addCounter(counters[participant], row, qualified); addCounter(group.participants[participant], row, qualified);
        if (!row || row.state !== 'MEASURED' || !qualified) recordIssue({ caseId: entry.caseId, metric: metric.id, repetition, cacheState,
          participantId: participant, state: !row ? 'MISSING' : row.state !== 'MEASURED' ? row.state : 'RECEIPT-UNVERIFIED' });
        if (row?.state === 'MEASURED' && qualified) paired.set(participant, row);
      }
      const own = paired.get('hex-astra');
      for (const [participant, pairs] of Object.entries(group.pairs)) {
        const other = paired.get(participant);
        if (own && other) {
          work.charge('residentBytes', 192);
          pairs.push({ own: own.value, other: other.value, ownRecall: own.recall, otherRecall: other.recall,
            ownUnknown: own.unknownRate, otherUnknown: other.unknownRate });
        }
      }
      await work.yieldIfNeeded();
    }
  }
  const resultGroups = [];
  for (const group of groups.values()) {
    work.charge('workUnits');
    const comparisons = {};
    for (const [participant, pairs] of Object.entries(group.pairs)) {
      work.charge('workUnits', pairs.length);
      const complete = pairs.length === group.expectedPerParticipant;
      // Partial-pair summaries are deliberately withheld: dropping hard failed
      // cases before taking a median could turn an incomplete run into a win.
      const own = complete ? summary(pairs.map((row) => row.own)) : summary([]);
      const other = complete ? summary(pairs.map((row) => row.other)) : summary([]);
      const recallComplete = complete && pairs.every((row) => row.ownRecall !== null && row.otherRecall !== null);
      const unknownComplete = complete && pairs.every((row) => row.ownUnknown !== null && row.otherUnknown !== null);
      comparisons[participant] = { observedPairedCells: pairs.length, expectedPairedCells: group.expectedPerParticipant,
        matrixComplete: complete, own, competitor: other,
        medianRatioCompetitorOverHex: complete ? unitRatio(other.median, own.median) : null,
        p95RatioCompetitorOverHex: complete ? unitRatio(other.p95, own.p95) : null,
        recall: recallComplete ? { hex: summary(pairs.map((row) => row.ownRecall)), competitor: summary(pairs.map((row) => row.otherRecall)) } : null,
        unknownRate: unknownComplete ? { hex: summary(pairs.map((row) => row.ownUnknown)), competitor: summary(pairs.map((row) => row.otherUnknown)) } : null,
        ratioUndefinedOnZeroOrOverflow: true, statisticalVerdict: 'UNMEASURED', winner: null,
        uncertainty: ['paired-confidence-intervals-not-computed', 'stratum-and-family-correlation-not-adjudicated',
          'raw-ratios-not-victory-tests', 'micro-precision-and-recall-require-independent-eligible-counts'] };
    }
    const { pairs: _pairs, ...header } = group;
    resultGroups.push({ ...header, comparisons }); await work.yieldIfNeeded();
  }
  const releaseVetoes = [...admission.obligations];
  if (!definitionChecked) releaseVetoes.push('metric-matrix-preregistration-not-replayed');
  if (protocol.metrics.length !== REQUIRED_METRICS.length) releaseVetoes.push('required-global-metric-denominator-incomplete');
  for (const participant of PARTICIPANTS) {
    const counter = counters[participant];
    if (counter.receiptChecked !== counter.expected) releaseVetoes.push(`required-cells-missing-or-unqualified:${participant}`);
  }
  for (const name of EXACT_ERROR_COUNTERS) if (counters['hex-astra'].exactErrors[name] > 0) releaseVetoes.push(`hex-exact-error-veto:${name}`);
  releaseVetoes.push('paired-noninferiority-and-primary-win-adjudication-required', 'device-and-human-task-evidence-required',
    'proof-rewrite-evidence-error-denominators-require-further-metric-definition');
  // Yield while checking retained leases, but recheck every lease once more
  // after the last yield: an earlier verifier could have changed meanwhile.
  for (const isCurrent of leases) {
    work.charge('workUnits'); if (isCurrent() !== true) contractFail('competitive-matrix-verifier-evidence-stale');
    await work.yieldIfNeeded();
  }
  for (const isCurrent of leases) { work.charge('workUnits'); if (isCurrent() !== true) contractFail('competitive-matrix-verifier-evidence-stale'); }
  rowsDigest.sort(compareIdentity);
  const body = snapshotContractData({ schema: 'competitive-measurement-audit/v1', version: COMPETITIVE_MATRIX_VERSION,
    protocolId: protocol.id, matrixId: plan.id, definitionChecked, definitionReceipt,
    measurementSetDigest: digest(rowsDigest), suppliedCells: rows.size, expectedCells: plan.expectedCells,
    counters, groups: resultGroups, verificationRecords, examples, omittedExamples, releaseVetoes: stringSet(releaseVetoes),
    statistics: 'descriptive; nearest-rank p95; no distributional confidence claims',
    uncertainty: 'Zero observed errors is not universal soundness. Unavailable competitor capability is not a loss.',
    verdict: 'NOT-YET', victoryEstablished: false, experimentsExecuted: 0 }, { maxBytes: 8388608, maxNodes: 262144 });
  work.charge('residentBytes', stableStringify(body).length * 2); work.checkpoint();
  return deepFreeze({ ...body, id: createEntityId({ binaryId: `benchmark:${protocol.denominatorSha256}`, kind: 'competitive-measurement-audit/v1', identity: { digest: digest(body) } }), cost: work.cost() });
}
