/** Bounded T0--T3 orchestration over existing native-best adapters.
 * No model client, emulator, secondary analysis owner, oracle or scoring engine.
 * A completed adapter call is an UNADJUDICATED execution, never a measured win.
 */
import { assertCompetitiveProtocol, normalizeCompetitiveMeasurement } from './competitive-protocol.js';
import { snapshotContractData, recordFields, exactInteger, exactString, sha256Text, contractFail } from '../../core/identity/structured.js';
import { stableDigest, stableStringify, lossyTypeWitness, deepFreeze } from '../../core/identity/index.js';
import { assertScopedAnalysisWork, ScopedAnalysisWork, workStopStatus } from '../../core/budgets/scoped-work.js';

export const ASTRA_TRIAL_MODES = Object.freeze(['T0', 'T1', 'T2', 'T3']);
const TRACKS = { T0: 'scripted-substrate', T1: 'native-best', T2: 'knowledge-equalized', T3: 'native-best' };
const PLANS = new WeakSet(), RESULTS = new WeakSet(), MAX_TRIALS = 4096;
const digest = value => stableDigest({ value, typed: lossyTypeWitness(value) });
const bytes = value => new TextEncoder().encode(stableStringify(value)).length;
function resources(raw) {
  const defaults = { deadlineMs: 10000, maximumSteps: 64, toolCalls: 128, modelTokens: 131072,
    contextBytes: 1048576, networkBytes: 8388608, cleanupMs: 1000 };
  recordFields(raw, Object.keys(defaults), 'astra-trial-resource-fields');
  const caps = { deadlineMs: 120000, maximumSteps: 256, toolCalls: 1024, modelTokens: 1048576,
    contextBytes: 8388608, networkBytes: 67108864, cleanupMs: 5000 };
  return Object.fromEntries(Object.keys(defaults).map(key => [key, exactInteger(raw[key] ?? defaults[key], 'astra-trial-resource-' + key,
    { min: ['deadlineMs', 'maximumSteps', 'cleanupMs'].includes(key) ? 1 : 0, max: caps[key] })]));
}
/** Every track keeps all cases, participants, cache states and repetitions.
 * Order is seeded/counterbalanced, not an assertion of statistical sufficiency.
 */
export function createAstraTrialPlan(protocols, raw = {}) {
  recordFields(protocols, ASTRA_TRIAL_MODES, 'astra-trial-protocol-fields');
  for (const mode of ASTRA_TRIAL_MODES) {
    assertCompetitiveProtocol(protocols[mode]);
    if (protocols[mode].track !== TRACKS[mode]) contractFail('astra-trial-track-mismatch');
  }
  const input = snapshotContractData(raw, { maxBytes: 2097152 });
  recordFields(input, ['tasks', 'resources', 'seed', 'cacheStates'], 'astra-trial-plan-fields');
  const seed = exactInteger(input.seed, 'astra-trial-seed', { min: 1, max: 0xffffffff });
  const cacheStates = input.cacheStates ?? ['cold', 'warm'];
  if (!Array.isArray(cacheStates) || !cacheStates.length || cacheStates.length > 2 || new Set(cacheStates).size !== cacheStates.length
    || cacheStates.some(value => !['cold', 'warm'].includes(value))) contractFail('astra-trial-cache-states');
  const base = protocols.T0, caseDigest = digest(base.cases), common = protocols.T1.participants[0].astra;
  for (const mode of ASTRA_TRIAL_MODES) {
    const protocol = protocols[mode];
    if (digest(protocol.cases) !== caseDigest || protocol.baselineCommit !== base.baselineCommit
      || protocol.repetitions !== base.repetitions || stableStringify(protocol.metrics) !== stableStringify(base.metrics)) contractFail('astra-trial-denominator-mismatch');
    if (mode !== 'T0') for (const participant of protocol.participants) {
      for (const key of ['provider', 'modelId', 'modelRevision', 'inferenceParametersSha256', 'systemPromptSha256', 'taskPromptSha256', 'harnessSha256']) {
        if (participant.astra[key] !== common[key]) contractFail('astra-trial-cross-track-model-mismatch');
      }
    }
  }
  if (!Array.isArray(input.tasks) || input.tasks.length !== base.cases.length) contractFail('astra-trial-full-task-denominator');
  const tasks = new Map();
  for (const task of input.tasks) {
    recordFields(task, ['caseId', 'request'], 'astra-trial-task-fields');
    if (!base.cases.some(row => row.caseId === task.caseId) || tasks.has(task.caseId)) contractFail('astra-trial-task-case');
    if (bytes(task.request) > 65536) contractFail('astra-trial-request-budget');
    tasks.set(task.caseId, task);
  }
  if (base.cases.length * base.repetitions * 3 * ASTRA_TRIAL_MODES.length * cacheStates.length > MAX_TRIALS) contractFail('astra-trial-plan-cap');
  const limits = resources(input.resources ?? {}), trials = []; let state = seed;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
  for (let repetition = 0; repetition < base.repetitions; repetition++) for (let c = 0; c < base.cases.length; c++) {
    const sample = base.cases[c];
    for (let m = 0; m < ASTRA_TRIAL_MODES.length; m++) {
      const mode = ASTRA_TRIAL_MODES[m], protocol = protocols[mode], participants = protocol.participants.map(row => row.id);
      for (let i = participants.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [participants[i], participants[j]] = [participants[j], participants[i]]; }
      const cacheOrder = (repetition + c + m) % 2 ? [...cacheStates].reverse() : cacheStates;
      for (const cacheState of cacheOrder) for (const participantId of participants) {
        const descriptor = { mode, protocolId: protocol.id, caseId: sample.caseId, binarySha256: sample.binarySha256,
          participantId, repetition, cacheState, requestDigest: digest(tasks.get(sample.caseId).request) };
        trials.push({ ...descriptor, id: digest(descriptor), ordinal: trials.length });
      }
    }
  }
  const body = { schema: 'same-astra-trial-plan/v1', seed, orderAlgorithm: 'xorshift32-fisher-yates-participants/cache-alternation-v1',
    protocols: Object.fromEntries(ASTRA_TRIAL_MODES.map(mode => [mode, protocols[mode].id])), tasks: [...tasks.values()],
    resources: limits, cacheStates: [...cacheStates], trials, minimumFiveRepetitions: base.repetitions >= 5,
    denominator: trials.length, defaultRolloutEligible: false, preregistrationVerified: false };
  const plan = deepFreeze({ ...body, id: digest(body) }); PLANS.add(plan); return plan;
}
function bindingFor(protocol, trial) {
  const participant = protocol.participants.find(row => row.id === trial.participantId);
  return { protocolId: protocol.id, participantId: participant.id, mode: trial.mode, caseId: trial.caseId,
    binarySha256: trial.binarySha256, toolDistributionSha256: participant.tool.distributionSha256,
    adapterSha256: participant.tool.adapterSha256, settingsSha256: participant.tool.settingsSha256,
    machineId: participant.machine.machineId, sameAstraIdentity: trial.mode === 'T0' ? null : protocol.sameAstraIdentity };
}
function validatePreparation(raw, expected, trial, limits, protocol) {
  const data = snapshotContractData(raw, { maxBytes: 65536 });
  recordFields(data, ['schema', 'binding', 'cacheState', 'cachePolicySha256', 'cacheGeneration', 'namespaceId', 'evidenceId',
    'knowledge', 'limits', 'boundedExecution', 'cancellationSupported', 'modelCallsDisabled'], 'astra-trial-preparation-fields');
  if (data.schema !== 'same-astra-trial-preparation/v1' || stableStringify(data.binding) !== stableStringify(expected)
    || data.cacheState !== trial.cacheState || data.cachePolicySha256 !== protocol.warmStatePolicySha256
    || stableStringify(data.limits) !== stableStringify(limits) || data.boundedExecution !== true
    || data.cancellationSupported !== true || (trial.mode === 'T0' && data.modelCallsDisabled !== true)) contractFail('astra-trial-preparation-binding');
  for (const key of ['cacheGeneration', 'namespaceId', 'evidenceId']) exactString(data[key], 'astra-trial-preparation-' + key);
  const knowledge = data.knowledge;
  recordFields(knowledge, ['manifestSha256', 'availability', 'licenseEvidenceId', 'networkPolicy', 'costPolicySha256', 'runtimeObservationBudget'], 'astra-trial-knowledge-fields');
  sha256Text(knowledge.manifestSha256); sha256Text(knowledge.costPolicySha256);
  exactString(knowledge.licenseEvidenceId, 'astra-trial-license');
  if (!['AVAILABLE', 'UNAVAILABLE', 'UNVERIFIED'].includes(knowledge.availability)
    || !['deny', 'explicit-allowlist'].includes(knowledge.networkPolicy)) contractFail('astra-trial-knowledge-policy');
  exactInteger(knowledge.runtimeObservationBudget, 'astra-trial-observation-budget', { max: 1000000 });
  return data;
}
function assertBorrowed(context) {
  if (!context || typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('astra-trial-owner-stale');
}
function trialFailureReason(error) {
  // Keep bounded diagnostic codes, never serialize arbitrary host error text.
  // A failed trial must itself survive the continuation's exact-string grammar.
  const reason = error?.code ?? error?.message;
  return typeof reason === 'string' && reason.length > 0 && reason.length <= 512 && !/[^a-z0-9_.:-]/i.test(reason)
    ? reason : 'astra-trial-host-failed';
}

const RESULT_FIELDS = ['schema', 'planId', 'denominator', 'attempted', 'trials', 'measurements', 'stopped', 'cost',
  'victoryEstablished', 'defaultRolloutEligible', 'releaseQualified', 'measurementAdmission', 'minimumRepetitionsExecuted', 'progress'];
const ADMISSION = 'requires-existing-competitive-matrix-independent-verifiers';
const pairedKey = row => stableStringify([row.caseId, row.repetition, row.cacheState]);
function continuationDigest(result) {
  const { integrityDigest, ...progress } = result.progress;
  return digest({ ...result, progress });
}
const COMPACT_RESULT_SCHEMA = 'same-astra-trial-results-compact/v1';
/** Lossless plan-relative transport, not a new receipt or admission authority.
 * The fixed trial descriptor and prepared host binding already live in the
 * exact plan. Do not store thousands of copies in a bounded journal. */
export function packAstraTrialContinuation(plan, result) {
  if (!PLANS.has(plan) || !RESULTS.has(result) || result.planId !== plan.id) contractFail('astra-trial-pack-owned-result');
  const trials = result.trials.map((row, index) => {
    const compact = Object.fromEntries(Object.entries(row).filter(([key]) => !Object.hasOwn(plan.trials[index], key)));
    if (compact.preparation) {
      const { binding, ...preparation } = compact.preparation;
      compact.preparation = preparation;
    }
    return compact;
  });
  return deepFreeze({ ...result, schema: COMPACT_RESULT_SCHEMA, trials });
}
function expandContinuation(plan, protocols, packed) {
  if (packed.planId !== plan.id || packed.denominator !== plan.denominator || !Array.isArray(packed.trials)
    || packed.trials.length !== plan.denominator) contractFail('astra-trial-continuation-pack-binding');
  // Charge the expanded wire before retaining each row. Expansion only restores
  // a bounded fixed descriptor, never recursively follows attacker references.
  let expandedBytes = bytes({ ...packed, trials: [] });
  const trials = packed.trials.map((row, index) => {
    const trial = plan.trials[index];
    if (Object.keys(trial).some(key => Object.hasOwn(row, key)) || row.preparation && Object.hasOwn(row.preparation, 'binding')) contractFail('astra-trial-continuation-pack-duplicate');
    const full = { ...trial, ...row, ...(row.preparation ? {
      preparation: { ...row.preparation, binding: bindingFor(protocols[trial.mode], trial) },
    } : {}) };
    expandedBytes += bytes(full) + 1;
    if (expandedBytes > 8388608) contractFail('astra-trial-continuation-expanded-budget');
    return full;
  });
  return deepFreeze({ ...packed, schema: 'same-astra-trial-results/v1', trials });
}

/** Validate an owned copy of a serialized execution journal before any host call.
 * The digest is transport integrity, NOT authenticity. Imported observations and
 * candidate receipts remain unadmitted; only the existing matrix can admit them.
 * A consumed failure is not retried: an interrupted external side effect cannot
 * safely be inferred to have never happened. This is not a crash-atomic journal.
 */
export function validateAstraTrialContinuation(plan, protocols, raw) {
  if (!PLANS.has(plan)) contractFail('astra-trial-owned-plan-required');
  for (const mode of ASTRA_TRIAL_MODES) {
    assertCompetitiveProtocol(protocols[mode]);
    if (protocols[mode].id !== plan.protocols[mode]) contractFail('astra-trial-continuation-protocol');
  }
  const input = snapshotContractData(raw, { maxBytes: 8388608, maxNodes: 200000 });
  recordFields(input, RESULT_FIELDS, 'astra-trial-continuation-fields');
  const data = input.schema === COMPACT_RESULT_SCHEMA ? expandContinuation(plan, protocols, input) : input;
  recordFields(data, RESULT_FIELDS, 'astra-trial-continuation-fields');
  if (data.schema !== 'same-astra-trial-results/v1' || data.planId !== plan.id || data.denominator !== plan.denominator
    || data.measurementAdmission !== ADMISSION || ['victoryEstablished', 'defaultRolloutEligible', 'releaseQualified'].some(key => data[key] !== false)) contractFail('astra-trial-continuation-binding');
  const progress = data.progress;
  recordFields(progress, ['schema', 'nextOrdinal', 'attemptedTotal', 'invocation', 'historyProvenance', 'integrityDigest'], 'astra-trial-continuation-progress');
  if (progress.schema !== 'same-astra-trial-continuation/v1' || !['local-unadmitted', 'imported-unadmitted'].includes(progress.historyProvenance)) contractFail('astra-trial-continuation-schema');
  exactInteger(progress.nextOrdinal, 'astra-trial-continuation-frontier', { max: plan.denominator });
  exactInteger(progress.attemptedTotal, 'astra-trial-continuation-total', { max: progress.nextOrdinal });
  exactInteger(progress.invocation, 'astra-trial-continuation-invocation', { min: 1, max: 1000000 });
  exactInteger(data.attempted, 'astra-trial-continuation-attempted', { max: Math.min(256, progress.attemptedTotal) });
  if (progress.integrityDigest !== continuationDigest(data)) contractFail('astra-trial-continuation-integrity');
  if (!Array.isArray(data.trials) || data.trials.length !== plan.denominator || !Array.isArray(data.measurements)
    || data.measurements.length > plan.denominator * protocols.T0.metrics.length) contractFail('astra-trial-continuation-denominator');
  const byId = new Map(), candidates = new Map();
  for (let index = 0; index < data.trials.length; index++) {
    const row = data.trials[index], trial = plan.trials[index];
    recordFields(row, [...Object.keys(trial), 'state', 'executionState', 'reason', 'evidenceIds', 'measurements', 'oracleAuthority',
      'correctness', 'defaultRolloutEligible', 'preparation', 'capabilityDigest', 'responseDigest', 'observed', 'cleanup'], 'astra-trial-continuation-row-fields');
    if (Object.keys(trial).some(key => row[key] !== trial[key]) || row.oracleAuthority !== false || row.defaultRolloutEligible !== false
      || row.correctness !== 'UNMEASURED' || !['UNMEASURED', 'FAILED', 'UNAVAILABLE'].includes(row.state)
      || !['not-run', 'preparation-failed', 'failed-during-execution', 'executed-unadjudicated', 'invalidated-cleanup', 'invalidated-control-pair'].includes(row.executionState)) contractFail('astra-trial-continuation-row-binding');
    exactString(row.reason, 'astra-trial-continuation-reason', 512);
    for (const key of ['evidenceIds', 'measurements']) {
      if (!Array.isArray(row[key]) || row[key].length > (key === 'evidenceIds' ? 1 : protocols[trial.mode].metrics.length)
        || new Set(row[key]).size !== row[key].length) contractFail('astra-trial-continuation-row-references');
      for (const id of row[key]) exactString(id, 'astra-trial-continuation-reference');
    }
    if (index >= progress.nextOrdinal) {
      // Invalid T2 controls can conservatively mark a still-unrun partner FAILED.
      if (row.executionState !== 'not-run' || row.preparation != null || row.observed != null || row.evidenceIds.length
        || row.measurements.length || !(['UNMEASURED'].includes(row.state) || row.state === 'FAILED' && row.reason === 'paired-common-information-control-mismatch')) contractFail('astra-trial-continuation-tail');
    } else if (row.executionState === 'not-run' && !['native-adapter-unavailable', 'knowledge-unavailable-or-unverified', 'paired-common-information-control-mismatch'].includes(row.reason)) {
      contractFail('astra-trial-continuation-unprocessed-prefix');
    }
    if (row.preparation != null) validatePreparation(row.preparation, bindingFor(protocols[trial.mode], trial), trial,
      { ...plan.resources, ...(trial.mode === 'T0' ? { modelTokens: 0 } : {}) }, protocols[trial.mode]);
    if (row.executionState === 'executed-unadjudicated') {
      if (row.state !== 'UNMEASURED' || row.reason !== 'independent-measurement-admission-required' || !row.preparation
        || row.preparation.knowledge.availability !== 'AVAILABLE' || row.evidenceIds[0] !== row.preparation.evidenceId || row.cleanup != null) contractFail('astra-trial-continuation-execution');
      exactString(row.capabilityDigest, 'astra-trial-continuation-capability'); exactString(row.responseDigest, 'astra-trial-continuation-response');
      recordFields(row.observed, ['runnerElapsedMs', 'runnerCalls', 'modelTokens', 'correctness', 'memoryPeak'], 'astra-trial-continuation-observation');
      if (!Number.isFinite(row.observed.runnerElapsedMs) || row.observed.runnerElapsedMs < 0
        || row.observed.modelTokens !== (trial.mode === 'T0' ? 0 : null) || row.observed.correctness !== 'UNMEASURED'
        || row.observed.memoryPeak !== 'UNMEASURED') contractFail('astra-trial-continuation-observed-claim');
      exactInteger(row.observed.runnerCalls, 'astra-trial-continuation-calls', { max: 2048 });
    } else if (row.measurements.length) contractFail('astra-trial-continuation-nonexecuted-measurements');
    byId.set(row.id, row); candidates.set(row.id, new Set());
  }
  for (const entry of data.measurements) {
    recordFields(entry, ['trialId', 'mode', 'measurement'], 'astra-trial-continuation-measurement-entry');
    const row = byId.get(entry.trialId);
    if (!row || entry.mode !== row.mode || row.executionState !== 'executed-unadjudicated') contractFail('astra-trial-continuation-measurement-row');
    const { id, receiptVerified, ...input } = entry.measurement;
    const measurement = normalizeCompetitiveMeasurement(protocols[row.mode], input), metrics = candidates.get(row.id);
    if (receiptVerified !== false || id !== measurement.id || stableStringify(entry.measurement) !== stableStringify(measurement)
      || input.caseId !== row.caseId || input.participantId !== row.participantId || input.cacheState !== row.cacheState
      || input.repetition !== row.repetition || metrics.has(input.metric) || !row.measurements.includes(id)) contractFail('astra-trial-continuation-measurement-binding');
    metrics.add(input.metric);
  }
  for (const row of data.trials) if (row.measurements.length !== candidates.get(row.id).size) contractFail('astra-trial-continuation-missing-measurement');
  if (data.minimumRepetitionsExecuted !== (plan.minimumFiveRepetitions && data.trials.every(row => row.executionState === 'executed-unadjudicated'))) contractFail('astra-trial-continuation-repetitions');
  return data;
}

/** Host supplies adapters/preparation and optional offline adjudication. Their
 * claims remain unverified until competitive-matrix's independent admission.
 * Host adapters MUST enforce forwarded limits; the runner independently bounds
 * waits and cancels, but cannot forcibly kill a remote process from JavaScript.
 */
export async function runAstraTrials(plan, protocols, { work, getAdapter = null, adjudicate = null, maximumTrials = 64, resumeFrom = null } = {}) {
  if (!PLANS.has(plan)) contractFail('astra-trial-owned-plan-required'); assertScopedAnalysisWork(work);
  exactInteger(maximumTrials, 'astra-trial-run-cap', { min: 1, max: 256 });
  for (const mode of ASTRA_TRIAL_MODES) {
    assertCompetitiveProtocol(protocols[mode]); if (protocols[mode].id !== plan.protocols[mode]) contractFail('astra-trial-plan-protocol-changed');
  }
  if (getAdapter !== null && typeof getAdapter !== 'function' || adjudicate !== null && typeof adjudicate !== 'function') contractFail('astra-trial-host-capabilities');
  const prior = resumeFrom === null ? null : validateAstraTrialContinuation(plan, protocols, resumeFrom);
  const startOrdinal = prior?.progress.nextOrdinal ?? 0;
  // snapshotContractData returned owned data; changing a paired control below
  // must never mutate the caller's saved report (or a previous frozen result).
  const rows = prior ? prior.trials.slice(0, startOrdinal).map(row => ({ ...row, measurements: [...row.measurements] })) : [];
  const measurements = prior ? [...prior.measurements] : [];
  const namespaces = new Set(), t2Knowledge = new Map(), invalidControls = new Set();
  for (const row of rows) {
    if (row.preparation) {
      namespaces.add(row.preparation.namespaceId);
      if (row.mode === 'T2') {
        const key = pairedKey(row), policy = digest(row.preparation.knowledge), before = t2Knowledge.get(key);
        if (before && before !== policy) invalidControls.add(key);
        else t2Knowledge.set(key, policy);
      }
    }
    if (row.mode === 'T2' && row.reason === 'paired-common-information-control-mismatch') invalidControls.add(pairedKey(row));
  }
  let attempted = 0, stopped = null, nextOrdinal = startOrdinal;
  for (const trial of plan.trials.slice(startOrdinal)) {
    const base = { ...trial, state: 'UNMEASURED', executionState: 'not-run', reason: 'not-executed',
      evidenceIds: [], measurements: [], oracleAuthority: false, correctness: 'UNMEASURED', defaultRolloutEligible: false };
    if (stopped || attempted >= maximumTrials) { rows.push({ ...base, reason: stopped ?? 'per-invocation-trial-cap' }); continue; }
    nextOrdinal = trial.ordinal + 1;
    if (!getAdapter) { rows.push({ ...base, state: 'UNAVAILABLE', reason: 'native-adapter-unavailable' }); continue; }
    let context = null, child = null, controller = null, abort = null, preparation = null, attemptedQuery = false;
    const pendingMeasurements = [];
    const protocol = protocols[trial.mode], expected = bindingFor(protocol, trial), limits = { ...plan.resources,
      ...(trial.mode === 'T0' ? { modelTokens: 0 } : {}) };
    try {
      work.checkpoint(); work.charge('workUnits'); attempted++;
      context = await work.await(signal => getAdapter(expected, { trial, limits, signal }));
      if (!context) { rows.push({ ...base, state: 'UNAVAILABLE', reason: 'native-adapter-unavailable' }); continue; }
      assertBorrowed(context);
      if (typeof context.prepare !== 'function' || !context.adapter || ['capabilities', 'query', 'explain', 'cancel'].some(key => typeof context.adapter[key] !== 'function')) contractFail('astra-trial-adapter-contract');
      if (stableStringify(context.binding) !== stableStringify(expected)) contractFail('astra-trial-adapter-binding');
      controller = new AbortController(); abort = () => controller.abort(work.signal.reason);
      work.signal.addEventListener('abort', abort, { once: true }); if (work.signal.aborted) abort();
      child = new ScopedAnalysisWork({ limits: { deadlineMs: limits.deadlineMs, calls: Math.min(limits.toolCalls + 8, 2048), workUnits: 100000 }, signal: controller.signal, name: 'astra-single-trial' });
      const call = fn => work.await(() => child.await(fn));
      preparation = validatePreparation(await call(signal => context.prepare({ ...trial, planId: plan.id }, { signal, limits })), expected, trial, limits, protocol);
      assertBorrowed(context);
      if (namespaces.has(preparation.namespaceId)) contractFail('astra-trial-cross-run-namespace-reuse');
      namespaces.add(preparation.namespaceId);
      if (trial.mode === 'T2') {
        const key = stableStringify([trial.caseId, trial.repetition, trial.cacheState]);
        const policy = digest(preparation.knowledge), prior = t2Knowledge.get(key);
        if (prior && prior !== policy) { invalidControls.add(key); contractFail('astra-trial-common-information-mismatch'); }
        t2Knowledge.set(key, policy);
      }
      if (preparation.knowledge.availability !== 'AVAILABLE') {
        rows.push({ ...base, reason: 'knowledge-unavailable-or-unverified', preparation }); continue;
      }
      const capabilities = snapshotContractData(await call(signal => context.adapter.capabilities({ signal })), { maxBytes: 131072 });
      assertBorrowed(context);
      const task = plan.tasks.find(row => row.caseId === trial.caseId);
      attemptedQuery = true;
      const response = snapshotContractData(await call(signal => context.adapter.query(task.request, {
        signal, deadlineMs: limits.deadlineMs, maximumSteps: limits.maximumSteps, limits: { calls: limits.toolCalls }, trialBudget: limits,
      })), { allowBigInt: true, maxBytes: 4194304, maxNodes: 100000 });
      work.charge('residentBytes', bytes(response)); assertBorrowed(context);
      if (trial.mode === 'T0' && response.mode !== 'T0-model-free') contractFail('astra-trial-model-free-response-required');
      const observation = { ...base, state: 'UNMEASURED', executionState: 'executed-unadjudicated', reason: 'independent-measurement-admission-required',
        preparation, capabilityDigest: digest(capabilities), responseDigest: digest(response),
        observed: { runnerElapsedMs: child.cost().elapsedMs, runnerCalls: child.cost().used.calls ?? 0,
          modelTokens: trial.mode === 'T0' ? 0 : null, correctness: 'UNMEASURED', memoryPeak: 'UNMEASURED' },
        evidenceIds: [preparation.evidenceId] };
      if (adjudicate) {
        const candidates = snapshotContractData(await call(signal => adjudicate({ trial, binding: expected, preparation, response }, { protocol, signal })), { maxBytes: 262144 });
        assertBorrowed(context);
        if (!Array.isArray(candidates) || candidates.length > protocol.metrics.length) contractFail('astra-trial-adjudication-cap');
        const metrics = new Set();
        for (const candidate of candidates) {
          if (candidate.caseId !== trial.caseId || candidate.participantId !== trial.participantId
            || candidate.repetition !== trial.repetition || candidate.cacheState !== trial.cacheState || metrics.has(candidate.metric)) contractFail('astra-trial-measurement-cell-binding');
          metrics.add(candidate.metric); const measurement = normalizeCompetitiveMeasurement(protocol, candidate);
          // Still requires branded admission and independent receipt replay.
          observation.measurements.push(measurement.id); pendingMeasurements.push({ trialId: trial.id, mode: trial.mode, measurement });
        }
      }
      child.checkpoint(); work.checkpoint(); assertBorrowed(context); rows.push(observation); measurements.push(...pendingMeasurements);
    } catch (error) {
      const parentStopped = workStopStatus(error, work.signal), localStopped = child && workStopStatus(error, child.signal);
      // A per-trial timeout does not silently remove the remaining denominator.
      if (work.signal.aborted || parentStopped === 'budget-exhausted') stopped = parentStopped ?? 'parent-stopped';
      rows.push({ ...base, state: 'FAILED', executionState: attemptedQuery ? 'failed-during-execution' : 'preparation-failed',
        reason: localStopped ?? parentStopped ?? trialFailureReason(error), preparation });
    } finally {
      controller?.abort(new Error('astra-trial-retired')); child?.dispose();
      if (abort) work.signal.removeEventListener('abort', abort);
      // Cancellation/close are also finite, even if a provider ignores abort.
      if (context) {
        const cleanup = new ScopedAnalysisWork({ limits: { deadlineMs: limits.cleanupMs }, name: 'astra-trial-cleanup' });
        let cleanupFailed = false, cleanupError = null;
        try {
          // A prompt cancel rejection must not skip a still-feasible close.
          // Both attempts share the same finite cleanup deadline; an expired
          // deadline prevents a fresh host call rather than granting more time.
          try { if (attemptedQuery) await cleanup.await(() => context.adapter.cancel()); }
          catch (error) { cleanupFailed = true; cleanupError = error; }
          try { if (typeof context.close === 'function') await cleanup.await(signal => context.close({ signal })); }
          catch (error) { if (!cleanupFailed) cleanupError = error; cleanupFailed = true; }
          if (cleanupFailed) {
            const last = rows[rows.length - 1];
            if (last?.id === trial.id) {
              last.cleanup = { status: 'unconfirmed', reason: workStopStatus(cleanupError, cleanup.signal) ?? 'cleanup-failed' };
              if (last.executionState === 'executed-unadjudicated') {
                last.state = 'FAILED'; last.executionState = 'invalidated-cleanup'; last.reason = 'trial-cleanup-unconfirmed'; last.measurements = [];
              }
            }
          }
        } finally { cleanup.dispose(); }
      }
    }
  }
  for (const row of rows) if (row.mode === 'T2' && invalidControls.has(stableStringify([row.caseId, row.repetition, row.cacheState]))) {
    row.state = 'FAILED'; row.executionState = row.executionState === 'executed-unadjudicated' ? 'invalidated-control-pair' : row.executionState;
    row.reason = 'paired-common-information-control-mismatch'; row.measurements = [];
  }
  const validRows = new Set(rows.filter(row => row.executionState === 'executed-unadjudicated').map(row => row.id));
  const result = { schema: 'same-astra-trial-results/v1', planId: plan.id, denominator: plan.denominator,
    attempted, trials: rows, measurements: measurements.filter(row => validRows.has(row.trialId)), stopped, cost: work.cost(), victoryEstablished: false, defaultRolloutEligible: false,
    releaseQualified: false, measurementAdmission: ADMISSION,
    minimumRepetitionsExecuted: plan.minimumFiveRepetitions && rows.every(row => row.executionState === 'executed-unadjudicated') };
  result.progress = { schema: 'same-astra-trial-continuation/v1', nextOrdinal,
    attemptedTotal: (prior?.progress.attemptedTotal ?? 0) + attempted, invocation: (prior?.progress.invocation ?? 0) + 1,
    historyProvenance: prior ? 'imported-unadmitted' : 'local-unadmitted' };
  result.progress.integrityDigest = continuationDigest(result);
  const frozen = deepFreeze(result); RESULTS.add(frozen); return frozen;
}

/** Read-only rollout veto inventory, not a release approval mechanism. */
export function reviewAstraTrialReadiness(plan, result) {
  if (!PLANS.has(plan) || !RESULTS.has(result) || result.planId !== plan.id || result.denominator !== plan.denominator) contractFail('astra-trial-review-owned-results-required');
  const vetoes = new Set(['independent-measurement-and-oracle-admission-required',
    'physical-iPad-latency-memory-and-cancellation-not-admitted', 'paired-statistical-and-human-task-adjudication-required']);
  if (!plan.minimumFiveRepetitions) vetoes.add('minimum-five-repetitions-not-planned');
  if (!plan.cacheStates.includes('cold') || !plan.cacheStates.includes('warm')) vetoes.add('cold-and-warm-strata-incomplete');
  const modes = Object.fromEntries(ASTRA_TRIAL_MODES.map(mode => {
    const rows = result.trials.filter(row => row.mode === mode);
    const executed = rows.filter(row => row.executionState === 'executed-unadjudicated').length;
    const failed = rows.filter(row => row.state === 'FAILED').length, unavailable = rows.filter(row => row.state === 'UNAVAILABLE').length;
    if (executed !== rows.length) vetoes.add(mode + ':execution-denominator-incomplete');
    return [mode, { expected: rows.length, executedUnadjudicated: executed, failed, unavailable, unmeasured: rows.length, independentlyMeasured: 0 }];
  }));
  return deepFreeze({ schema: 'same-astra-rollout-review/v1', planId: plan.id, denominator: result.denominator, modes,
    candidateMeasurementCount: result.measurements.length, vetoes: [...vetoes].sort(), verdict: 'NOT-YET',
    defaultRolloutEligible: false, releaseQualified: false, victoryEstablished: false });
}
