#!/usr/bin/env node
// Pure aggregation of already recorded real-binary and live-API observations.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CHECKPOINT = process.argv[2] || '/mnt/workspace/.dev-state/agent-work/evidence/jev-full-opportunity-audit/live-checkpoint';
const REPEAT = process.argv[3] || '/mnt/workspace/.dev-state/agent-work/evidence/jev-full-opportunity-audit/repeat-checkpoint';
const MEASUREMENT = process.argv[4] || '/mnt/workspace/.dev-state/agent-work/evidence/jev-full-opportunity-audit/current-main/measurement.json';
const BROADER = process.argv[5] || process.env.HEX_JEV_BROADER_COMPARISON
  || path.join(HERE, 'broader-scheduler-summary.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = fs.readFileSync(path.join(HERE, 'rows.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const det = read(path.join(HERE, 'deterministic-screen.json'));
const role = read(path.join(HERE, 'field-role-results.json'));
const measurement = read(MEASUREMENT);
const broaderRaw = read(BROADER);
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const toolVersion = (name) => {
  try { return execFileSync(name, ['--version'], { encoding: 'utf8' }).split('\n')[0]; }
  catch { return 'unavailable'; }
};
const atomic = (name, object) => {
  const file = path.join(HERE, name); const pending = `${file}.${process.pid}.pending`;
  fs.writeFileSync(pending, JSON.stringify(object, null, 2) + '\n'); fs.renameSync(pending, file);
};
const pct = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.ceil(p * a.length) - 1] : null;
const strong = (v) => v === 'confirmed' || v === 'likely';
const d = new Map(det.perRow.map((r) => [r.id, r]));
const broader = broaderRaw.schema === 'hex-jev-broader-scheduler-summary/v1'
  ? broaderRaw
  : {
    schema: 'hex-jev-broader-scheduler-summary/v1',
    source: {
      comparisonSha256: sha(BROADER), schedulerPr: 9464,
      schedulerHead: 'f035af71dd183c25d36af7d1eebe413ecfd4bb04',
      ...(fs.existsSync(path.join(path.dirname(BROADER), 'focused-eligible-corpus.jsonl'))
        ? { corpusSha256: sha(path.join(path.dirname(BROADER), 'focused-eligible-corpus.jsonl')) } : {}),
      ...(fs.existsSync(path.join(path.dirname(BROADER), 'probe-transitions.jsonl'))
        ? { transitionsSha256: sha(path.join(path.dirname(BROADER), 'probe-transitions.jsonl')) } : {}),
    },
    denominator: broaderRaw.denominator,
    focusedCount: broaderRaw.focusedCount,
    eligibleWrongBaseline: broaderRaw.eligibleWrongBaseline,
    budget: broaderRaw.budget,
    selectedHeuristic: broaderRaw.selectedHeuristic,
    baseline: broaderRaw.baseline,
    heuristic: broaderRaw.heuristic,
    budgetOracle: broaderRaw.oracleB,
    unboundedOracle: broaderRaw.oracleA,
    gap: broaderRaw.gap,
    probeStatistics: broaderRaw.probeStatistics,
    classificationCounts: broaderRaw.classificationCounts,
  };
const partial = rows.filter((r) => r.mode === 'partial');
const exact = rows.filter((r) => r.mode === 'exact');
const wrong = rows.filter((r) => !r.baselineCorrect);
const one = (set, correct) => ({ totalN: set.length, baselineCorrect: set.filter((r) => r.baselineCorrect).length,
  correct: set.filter(correct).length,
  wrongToCorrect: set.filter((r) => !r.baselineCorrect && correct(r)).length,
  correctToWrong: set.filter((r) => r.baselineCorrect && !correct(r)).length });
if (rows.length !== 426 || exact.length !== 230 || partial.length !== 196 || wrong.length !== 144)
  throw new Error('baseline denominators changed');
if (!measurement.complete || measurement.fieldRows !== 426 || measurement.productCommit !== '09dfcb283f721b6598f34675a8a42480147d5752')
  throw new Error('current-main measurement incomplete or from unexpected head');
const failures = rows.filter((r) => !r.candidatePresent);
if (failures.length) throw new Error(`candidate recall changed: ${failures.length}`);

const byBinary = Object.fromEntries(['battlecats', 'TsumTsum', 'YWP'].map((binary) => {
  const set = rows.filter((r) => r.binary === binary);
  return [binary, { N: set.length, correctTop1: set.filter((r) => r.baselineCorrect).length,
    wrongTop1: set.filter((r) => !r.baselineCorrect).length }];
}));
const rowTags = rows.map((r) => {
  const top = r.candidates[0]; const truth = r.candidates.find((c) => c.truth);
  const norm = (v) => String(v || '').replace(/^_/, '').toLowerCase();
  const tags = [r.mode === 'exact' ? 'exact-query' : 'partial-remembered-query'];
  if (!r.candidatePresent) tags.push('candidate-recall-failure');
  if (r.candidatePresent && !r.baselineCorrect) {
    tags.push('ranking-failure');
    if (top?.className === truth?.className) tags.push('same-class-ambiguity');
    if (norm(top?.fieldName) === norm(truth?.fieldName)) tags.push('same-field-name-across-classes');
    if (norm(top?.fieldName) === norm(r.query).replace(/\s/g, '')) tags.push('literal-alternative');
    if (truth?.recallLane) tags.push('truth-on-lexical-recall-lane');
    if ((truth?.score || 0) > (top?.score || 0)) tags.push('truth-higher-fusion-but-lower-rank');
    if ((top?.evidenceCodes || []).join('|') === (truth?.evidenceCodes || []).join('|')) tags.push('same-evidence-code-sequence');
    if (!truth?.groups?.includes('dataflow')) tags.push('truth-without-dataflow-group');
  }
  if (strong(r.verdict) && !r.baselineCorrect) tags.push('false-strong');
  if (!strong(r.verdict) && r.baselineCorrect) tags.push('correct-but-ambiguous');
  return { id: r.id, primary: !r.candidatePresent ? 'candidate-recall' : !r.baselineCorrect
    ? (strong(r.verdict) ? 'ranking-wrong-strong' : 'ranking-wrong-ambiguous')
    : (strong(r.verdict) ? 'correct-strong' : 'confidence-too-weak'), tags };
});
const countTags = (tags) => Object.fromEntries(tags.map((t) => [t, rowTags.filter((r) => r.tags.includes(t)).length]));
const taxonomy = {
  schema: 'hex-jev-failure-taxonomy/v1', denominator: 426, byBinary,
  queryModes: { exact: 230, partialRemembered: 196, freeFormIntentMeasured: 0, locationHeldOut: 1 },
  primaryCounts: Object.fromEntries([...new Set(rowTags.map((r) => r.primary))].map((p) => [p, rowTags.filter((r) => r.primary === p).length])),
  overlappingObservedTags: countTags(['ranking-failure', 'false-strong', 'correct-but-ambiguous',
    'same-class-ambiguity', 'same-field-name-across-classes', 'literal-alternative',
    'truth-on-lexical-recall-lane', 'truth-higher-fusion-but-lower-rank',
    'same-evidence-code-sequence', 'truth-without-dataflow-group']),
  unmeasuredCauses: ['query interpretation as user intent', 'cross-function semantics', 'unnamed-field role',
    'type/class recovery as causal ranking blocker', 'unsupported/parser/lifter/extent among these field queries'],
  externalFailureStudies: {
    location: 'DSDA mobj_t.health, one holdout row, wrong top1/ambiguous under P4',
    unsupportedExtent: 'reports/investigations/unsupported-semantics: 320/320 DT_INIT/DT_FINI extent gaps; binary-grounded deterministic follow-up',
    functionDiscovery: 'reports/investigations/function-discovery: 172 IDA-only rows, 170 confirmed structural and 2 probable structural',
  }, rows: rowTags,
};
atomic('failure-taxonomy.json', taxonomy);

const ranking = Object.fromEntries(['label', 'class', 'evidence'].map((arm) => [arm, {
  allPartial: one(partial, (r) => r.jev[arm]?.correct),
  ambiguousOnly: one(partial.filter((r) => r.verdict === 'ambiguous'), (r) => r.jev[arm]?.correct),
  exactUnchanged: 229,
  additionalAnalyzeCalls: 0,
  apiCalls: partial.filter((r) => r.jev[arm]).length,
  failures: partial.filter((r) => r.jev[arm]?.error).length,
}]));
const detComparison = one(partial, (r) => d.get(r.id)?.correct);
const jevVsDet = Object.fromEntries(['label', 'class', 'evidence'].map((arm) => [arm, {
  jevRescuesDetMisses: partial.filter((r) => !r.baselineCorrect && r.jev[arm]?.correct && !d.get(r.id)?.correct).length,
  detRescuesJevMisses: partial.filter((r) => !r.baselineCorrect && !r.jev[arm]?.correct && d.get(r.id)?.correct).length,
}]));
const safeGate = (r, arm) => r.verdict === 'ambiguous' && !r.jev[arm]?.error
  && r.jev[arm]?.unique >= .9 && r.jev[arm]?.confidence >= .9;
const safety = Object.fromEntries(['label', 'class', 'evidence'].map((arm) => [arm, {
  predicate: 'partial + ambiguous + unique>=0.9 + confidence>=0.9; preference never promotes strong',
  triggered: partial.filter((r) => safeGate(r, arm)).length,
  wrongToCorrect: partial.filter((r) => safeGate(r, arm) && !r.baselineCorrect && r.jev[arm].correct).length,
  correctToWrong: partial.filter((r) => safeGate(r, arm) && r.baselineCorrect && !r.jev[arm].correct).length,
}]));
const roleMetrics = Object.fromEntries(['local', 'crossFunction'].map((arm) => {
  const set = role.results.filter((r) => r.arm === arm && r.supported);
  return [arm, { supportedN: set.length, deterministicCorrect: set.filter((r) => r.deterministic === r.expected).length,
    jevCorrect: set.filter((r) => r.choice === r.expected).length,
    jevWrongToCorrect: set.filter((r) => r.deterministic !== r.expected && r.choice === r.expected).length,
    jevCorrectToWrong: set.filter((r) => r.deterministic === r.expected && r.choice !== r.expected).length }];
}));
const evaluation = {
  schema: 'hex-jev-full-opportunity-evaluation/v1', sourceProductCommit: measurement.productCommit,
  denominator: 426, candidatePresent: 426, baselineCorrect: 282, wrongRanking: 144,
  exact: { N: 230, baselineCorrect: 229, interventionCalls: 0 },
  partial: { N: 196, baselineCorrect: 53, wrong: 143 },
  deterministic: { method: 'BattleCats-selected 168-point lexical grid; same benchmark generator on both sides',
    partial: detComparison, all426ProjectedCorrect: 229 + detComparison.correct,
    development: det.development, holdout: det.holdout },
  jevForcedPreference: ranking,
  jevVsDet,
  failClosedGate: safety,
  modelPreferenceConfidence: Object.fromEntries(['label', 'class', 'evidence'].map((arm) => {
    const high = partial.filter((r) => r.jev[arm]?.confidence >= .9);
    return [arm, { atLeastPoint9N: high.length, correctAmongHigh: high.filter((r) => r.jev[arm].correct).length,
      wrongAmongHigh: high.filter((r) => !r.jev[arm].correct).length,
      maxSelfRatedUniqueness: Math.max(...partial.map((r) => r.jev[arm].unique)) }];
  })),
  fieldRoleCompilerFixture: { N: role.cases, supportedN: role.supportedCases, results: roleMetrics },
  evidencePlanning: broader,
  confidence: { currentCorrectStrong: 211, currentFalseStrong: 67,
    policyChanged: false, modelPreferenceIsNotConfidenceProof: true },
  caveats: ['Forced preference is an offline top1 counterfactual, not a safe confirmed/likely decision.',
    'Partial labels omit context that distinguishes many literal alternatives; binary split shares query construction and SDK families.',
    'The lexical grid was selected on BattleCats and may exploit the remembered-name fixture generator.'],
};
atomic('evaluation-summary.json', evaluation);

const allCalls = partial.flatMap((r) => ['label', 'class', 'evidence'].map((arm) => r.jev[arm]).filter(Boolean));
const repeatFiles = fs.existsSync(REPEAT) ? fs.readdirSync(REPEAT).filter((x) => x.endsWith('.json')) : [];
const repeated = repeatFiles.map((name) => ({ first: read(path.join(CHECKPOINT, name)), second: read(path.join(REPEAT, name)) }));
const latency = {
  schema: 'hex-jev-latency-summary/v1', endpoint: 'https://api.openjev.sh/v1/systemone', model: 'openjev',
  observedCalls: allCalls.length, concurrency: 3, requestTimeoutMs: 15000,
  byArm: Object.fromEntries(['label', 'class', 'evidence'].map((arm) => {
    const calls = partial.map((r) => r.jev[arm]); const values = calls.map((r) => r.latencyMs);
    return [arm, { N: calls.length, p50Ms: pct(values, .5), p95Ms: pct(values, .95), p99Ms: pct(values, .99),
      maxMs: Math.max(...values), failures: calls.filter((r) => r.error).length,
      uniqueP50: pct(calls.map((r) => r.unique), .5), uniqueP95: pct(calls.map((r) => r.unique), .95) }];
  })),
  overall: { p50Ms: pct(allCalls.map((r) => r.latencyMs), .5),
    p95Ms: pct(allCalls.map((r) => r.latencyMs), .95), p99Ms: pct(allCalls.map((r) => r.latencyMs), .99),
    timeoutCount: allCalls.filter((r) => r.error === 'timeout').length,
    malformedCount: allCalls.filter((r) => r.error?.includes('malformed')).length,
    apiUnavailableCount: allCalls.filter((r) => r.error?.startsWith('http-5')).length,
    rateLimitCount: allCalls.filter((r) => r.status === 429).length },
  repeatedQuery: { N: repeated.length, sameChoice: repeated.filter((r) => r.first.choice === r.second.choice).length,
    changedIds: repeated.filter((r) => r.first.choice !== r.second.choice).map((r) => `${r.first.rowId}|${r.first.arm}`) },
  fieldRole: role.latencyMs,
  failurePolicy: 'Timeout, non-200, malformed response, model mismatch, invalid candidate, or missing probability returns baseline index 0; no score or verdict promotion.',
  risk: { privacy: 'class, field and evidence summaries leave device in every live call',
    cache: 'Exact state+model+binary/evidence version could be reused; no production cache measured',
    retry: 'No retry was needed in this run; retry benefit and 429 recovery remain unmeasured' },
};
atomic('latency-summary.json', latency);

const oracle = {
  schema: 'hex-jev-oracle-ceilings/v1', denominator: 426,
  candidateOracle: { present: 426, upperBoundCorrect: 426, candidateGenerationGainCeilingOnThisCorpus: 0 },
  currentRecordedEvidence: { observedCorrect: 282, noCapturedDifferentialWrong: 22,
    metadataOrWeakDifferentialWrong: 122, robustTruthDifferentialWrong: 0,
    note: 'A diagnostic of recorded evidence, not a mathematical ceiling on future semantic evidence.' },
  rememberedNameOracle: { arbitraryTruthChoiceCorrect: 426, note: 'Requires oracle knowledge of hidden unique-name label; not deployable.' },
  confidenceOracle: { correctStrongUpperBoundIfTopCorrectnessKnown: 282,
    currentCorrectStrong: 211, abstentionGap: 71, currentFalseStrong: 67 },
  currentProbeCatalog: { focusedN: 61, baselineCorrect: 19, eligibleWrong: 42,
    deterministicH6Correct: 21, budgetOracleCorrect: 21, unboundedOracleCorrect: 21,
    deterministicVsBudgetOracleResolvedGap: 0, budget: { probes: 6, analyzeCalls: 6, elapsedMs: 1000 },
    caveat: 'H6 was post-hoc; same catalog and budget, not an independent holdout.' },
  broaderEvidencePlanning: broader,
  sourceRefs: { calibration: 'reports/investigations/pinpoint-confidence-plan-a/current-main-p4/oracle-ceiling.json',
    probeAuditPr: 9464, probeAuditResultCommit: '64096f5cb04c300a6bc7f412d7030896bc48d067',
    schedulerReverifiedAt: git('rev-parse', 'origin/pr-9464') },
};
atomic('oracle-ceilings.json', oracle);

const manifest = {
  schema: 'hex-jev-full-opportunity-manifest/v1', producedAt: new Date().toISOString(),
  productCommit: measurement.productCommit, productTree: measurement.productTree,
  reportBaseCommitAtGeneration: git('rev-parse', 'HEAD'),
  queryFixture: measurement.queryFixture, binaryFixtures: measurement.fixtures,
  currentMainMeasurement: { source: 'persistent evidence/current-main/measurement.json', sha256: sha(MEASUREMENT),
    sourceRows: 'persistent evidence/current-main/rows.jsonl',
    sourceRowsSha256: sha(path.join(path.dirname(MEASUREMENT), 'rows.jsonl')) },
  cxxFixture: { binarySha256: '65c65e1cdf061201229894b1eca341d76db9554f192bd20328cb896bc8c52d06',
    sourceSha256: role.fixtureSourceSha256,
    target: 'aarch64-unknown-linux-gnu', optimization: '-O0',
    toolchain: { clang: toolVersion('clang++'), linker: toolVersion('ld.lld'), disassembler: toolVersion('llvm-objdump') } },
  liveContract: { endpoint: 'https://api.openjev.sh/v1/systemone', model: 'openjev',
    probeStatus: 200, modelsStatus: 200, secretStored: false },
  relatedPrHeadsAtReview: { probeAudit9464: git('rev-parse', 'origin/pr-9464'),
    cxxMember9469: git('rev-parse', 'origin/pr-9469') },
  artifactHashes: Object.fromEntries(['failure-taxonomy.json', 'use-case-matrix.json',
    'evaluation-summary.json', 'oracle-ceilings.json', 'latency-summary.json', 'broader-scheduler-summary.json',
    'rows.jsonl', 'deterministic-screen.json', 'field-role-results.json',
    'field-role-cases.json', 'evaluate.mjs', 'deterministic-screen.mjs',
    'field-role-screen.mjs', 'build-report.mjs', 'validate.mjs', 'broader-probe.patch'].filter((f) => fs.existsSync(path.join(HERE, f)))
    .map((f) => [f, sha(path.join(HERE, f))])),
  limitations: ['No independent free-form intent or unnamed-field real-game ground truth',
    'No production Jev integration or safe strong-verdict gain',
    'Evidence-planning oracle is complete only for the 105-row ambiguous-partial catalog; 39 wrong-but-strong rows are outside the fail-closed scheduler predicate'],
};
atomic('manifest.json', manifest);
console.log(JSON.stringify({ taxonomy: taxonomy.primaryCounts, ranking: evaluation.jevForcedPreference.label,
  deterministic: detComparison, latency: latency.overall, role: roleMetrics }));
