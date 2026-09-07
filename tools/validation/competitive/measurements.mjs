/**
 * Bind repository-owned competitive measurements to independent evidence.
 *
 * A twin capture proves which bytes were built and stripped.  It does not by
 * itself prove a semantic score, so this module accepts the independent P5/P6
 * LLVM/Capstone ledgers and the frozen P8 observation ledger separately.  A
 * value is emitted only when the ledger denominator and artifact/source
 * identities agree with the capture.  A failed identity check is represented
 * as UNMEASURED rather than being repaired with a guessed number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import {
  capturePhase5TwinWorkload,
  capturePhase6TwinWorkload,
  capturePhase8TwinWorkload,
  validateCompetitiveTwinCapture,
} from './workload-twins.mjs';
import { loadCorpus } from '../phase8/build-corpus.mjs';
import { observeCorpus } from '../phase8/decompile-corpus.mjs';
import { loadFrozenBaseline, qualityVector } from '../phase8/metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const COMPETITIVE_MEASUREMENT_SCHEMA = 'hex-competitive-measurement/v1';
export const MEASURED_STATUS = 'MEASURED';
export const UNMEASURED_STATUS = 'UNMEASURED';
const AUTHORITY = 'same-binary-twin';
const COMPARISONS = new Set(['WIN', 'TIE', 'LOSS', UNMEASURED_STATUS]);
const BINARY_METRICS = Object.freeze([
  'machine-effects-x86_64-coverage',
  'machine-effects-riscv64-coverage',
  'decompiler-quality-gotos',
  'decompiler-quality-assembly-fallbacks',
]);

function runtimeIdentity() {
  return {
    node: process.version,
    architecture: process.arch,
    platform: process.platform,
  };
}

function measurementError(code, detail = '') {
  throw new TypeError(`competitive-measurement-${code}${detail ? `:${detail}` : ''}`);
}

/** Validate the value-bearing evidence envelope before it reaches a scorecard. */
export function validateCompetitiveMeasurement(value, { expectedMetricId = null } = {}) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) measurementError('object-required');
  if (value.schemaVersion !== COMPETITIVE_MEASUREMENT_SCHEMA) measurementError('schema-version');
  if (expectedMetricId != null && value.metricId !== expectedMetricId) measurementError('metric-mismatch', value.metricId);
  if (typeof value.metricId !== 'string' || !value.metricId.trim()) measurementError('metric-id');
  if (![MEASURED_STATUS, UNMEASURED_STATUS].includes(value.status)) measurementError('status', String(value.status));
  if (value.authority !== AUTHORITY) measurementError('authority', String(value.authority));
  if (!COMPARISONS.has(value.comparison)) measurementError('comparison', String(value.comparison));
  for (const key of ['candidateValue', 'referenceValue']) {
    if (value[key] != null && !finiteNumber(value[key])) measurementError('value', `${value.metricId}:${key}`);
  }
  if (value.status === MEASURED_STATUS) {
    if (!finiteNumber(value.candidateValue) || !finiteNumber(value.referenceValue)) measurementError('measured-values', value.metricId);
    if (value.comparison === UNMEASURED_STATUS) measurementError('measured-comparison', value.metricId);
    for (const key of ['corpusId', 'inputIdentity', 'referenceTool', 'referenceVersion', 'configuration', 'runPolicy', 'captureDigest', 'artifactIdsDigest']) {
      if (typeof value[key] !== 'string' || !value[key].trim()) measurementError('identity', `${value.metricId}:${key}`);
    }
    if (value.denominator == null || typeof value.denominator !== 'object' || Array.isArray(value.denominator)) measurementError('denominator', value.metricId);
    if (value.semanticOracle == null || typeof value.semanticOracle !== 'object' || Array.isArray(value.semanticOracle)) measurementError('oracle', value.metricId);
  } else {
    if (value.candidateValue !== null || value.referenceValue !== null || value.comparison !== UNMEASURED_STATUS) {
      measurementError('unmeasured-values', value.metricId);
    }
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    measurementError('evidence-refs', value.metricId);
  }
  return Object.freeze(value);
}

const P56_METRIC = Object.freeze({
  'machine-effects-x86_64-coverage': Object.freeze({
    testPath: 'tests/phase5/verification/compiler-corpus-pipeline.test.mjs',
    marker: 'P5_6_PIPELINE_LEDGER=',
    producer: 'independent-llvm-boundaries-capstone-5.0.1',
  }),
  'machine-effects-riscv64-coverage': Object.freeze({
    testPath: 'tests/phase6/verification/compiler-corpus-pipeline.test.mjs',
    marker: 'P6_PIPELINE_LEDGER=',
    producer: 'independent-llvm-boundaries-capstone-5.0.1',
  }),
});

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function comparison(direction, candidateValue, referenceValue) {
  if (!finiteNumber(candidateValue) || !finiteNumber(referenceValue)) return UNMEASURED_STATUS;
  if (direction === 'higher') return candidateValue > referenceValue ? 'WIN' : candidateValue === referenceValue ? 'TIE' : 'LOSS';
  if (direction === 'lower') return candidateValue < referenceValue ? 'WIN' : candidateValue === referenceValue ? 'TIE' : 'LOSS';
  if (direction === 'exact-zero') return candidateValue === 0 && referenceValue === 0 ? 'TIE' : candidateValue === 0 ? 'WIN' : 'LOSS';
  return UNMEASURED_STATUS;
}

function captureIdentity(capture) {
  if (capture == null) return { ok: false, reason: 'twin-capture-missing' };
  try {
    validateCompetitiveTwinCapture(capture, { replayArtifacts: false });
  } catch (error) {
    return { ok: false, reason: `twin-capture-invalid:${error.message}` };
  }
  if (capture.status !== 'READY') return { ok: false, reason: `twin-capture-${String(capture.status).toLowerCase()}` };
  const artifacts = new Map((capture.artifacts || []).map((artifact) => [artifact.id, artifact]));
  return {
    ok: true,
    capture,
    artifacts,
    captureDigest: capture.captureDigest,
    artifactIdsDigest: capture.denominator.artifactIdsDigest,
    inputIdentity: `capture_${capture.captureDigest}`,
    evidenceRefs: [
      `capture:${capture.captureDigest}`,
      `capture-denominator:${capture.denominator.artifactIdsDigest}`,
    ],
  };
}

function unmeasured(metricId, capture, reason, details = {}) {
  const identity = captureIdentity(capture);
  return Object.freeze({
    schemaVersion: COMPETITIVE_MEASUREMENT_SCHEMA,
    metricId,
    status: UNMEASURED_STATUS,
    authority: AUTHORITY,
    candidateValue: null,
    referenceValue: null,
    comparison: UNMEASURED_STATUS,
    corpusId: identity.ok ? identity.capture.corpusId : null,
    inputIdentity: identity.ok ? identity.inputIdentity : `unmeasured:${metricId}`,
    referenceTool: 'unmeasured',
    referenceVersion: 'unmeasured',
    configuration: 'independent-oracle',
    runPolicy: 'exact',
    captureDigest: identity.ok ? identity.captureDigest : null,
    artifactIdsDigest: identity.ok ? identity.artifactIdsDigest : null,
    denominator: null,
    semanticOracle: null,
    evidenceRefs: identity.ok ? identity.evidenceRefs : [],
    reason,
    ...clone(details),
  });
}

function measured({
  metricId,
  capture,
  candidateValue,
  referenceValue,
  direction,
  corpusId,
  denominator,
  referenceTool,
  referenceVersion,
  semanticOracle,
  evidenceRefs = [],
  details = {},
}) {
  const identity = captureIdentity(capture);
  if (!identity.ok) return unmeasured(metricId, capture, identity.reason);
  if (!finiteNumber(candidateValue) || !finiteNumber(referenceValue)) {
    return unmeasured(metricId, capture, 'measurement-value-not-finite');
  }
  if (typeof corpusId !== 'string' || corpusId !== identity.capture.corpusId) {
    return unmeasured(metricId, capture, 'measurement-corpus-identity-mismatch', { observedCorpusId: corpusId ?? null });
  }
  if (semanticOracle == null || typeof semanticOracle !== 'object' || Array.isArray(semanticOracle)) {
    return unmeasured(metricId, capture, 'semantic-oracle-identity-missing');
  }
  const result = {
    schemaVersion: COMPETITIVE_MEASUREMENT_SCHEMA,
    metricId,
    status: MEASURED_STATUS,
    authority: AUTHORITY,
    candidateValue,
    referenceValue,
    comparison: comparison(direction, candidateValue, referenceValue),
    corpusId,
    inputIdentity: identity.inputIdentity,
    referenceTool,
    referenceVersion,
    configuration: 'independent-oracle',
    runPolicy: 'exact',
    captureDigest: identity.captureDigest,
    artifactIdsDigest: identity.artifactIdsDigest,
    denominator,
    semanticOracle,
    evidenceRefs: sortedUnique([...identity.evidenceRefs, ...evidenceRefs]),
    reason: 'independent-oracle-and-same-binary-twin-identity-bound',
    ...clone(details),
  };
  return Object.freeze(result);
}

function sameSourceHash(capture, ledger) {
  const sourceHash = ledger?.source?.sha256;
  if (typeof sourceHash !== 'string' || !sourceHash) return { ok: false, reason: 'ledger-source-identity-missing' };
  const hashes = sortedUnique((capture.artifacts || []).map((artifact) => artifact.manifest?.sourceIdentity?.sha256).filter(Boolean));
  if (hashes.length !== 1 || hashes[0] !== sourceHash) {
    return { ok: false, reason: 'ledger-source-identity-mismatch', observed: hashes, expected: sourceHash };
  }
  const supportHash = ledger.supportSource?.sha256;
  if (typeof supportHash === 'string') {
    const supportHashes = sortedUnique((capture.artifacts || [])
      .map((artifact) => artifact.manifest?.compileOptions?.supportSource?.sha256)
      .filter(Boolean));
    if (supportHashes.length !== 1 || supportHashes[0] !== supportHash) {
      return { ok: false, reason: 'ledger-support-source-identity-mismatch', observed: supportHashes, expected: supportHash };
    }
  }
  return { ok: true };
}

function sameFixtureHashes(capture, ledger) {
  const fixtureRows = new Map();
  const artifactHashKinds = new Map();
  for (const row of ledger?.fixtures || []) {
    if (typeof row?.id === 'string') {
      if (fixtureRows.has(row.id)) return { ok: false, reason: 'ledger-duplicate-fixture', fixture: row.id };
      fixtureRows.set(row.id, row);
    }
  }
  const captureIds = [...(capture.artifacts || [])].map((artifact) => artifact.id).sort();
  const ledgerIds = [...fixtureRows.keys()].sort();
  if (stableDigest(captureIds) !== stableDigest(ledgerIds)) {
    return { ok: false, reason: 'ledger-artifact-denominator-mismatch', captureIds, ledgerIds };
  }
  for (const id of captureIds) {
    const expected = fixtureRows.get(id)?.sha256;
    const manifest = capture.artifacts.find((artifact) => artifact.id === id)?.manifest || {};
    const debug = manifest.debugArtifactSha256;
    const stripped = manifest.strippedArtifactSha256;
    const artifactHashKind = expected === debug ? 'debug' : expected === stripped ? 'stripped' : null;
    if (typeof expected !== 'string' || artifactHashKind == null) {
      return { ok: false, reason: 'ledger-artifact-hash-mismatch', artifactId: id, ledgerHash: expected ?? null, debugHash: debug ?? null, strippedHash: stripped ?? null };
    }
    if (!fixtureRows.get(id)) return { ok: false, reason: 'ledger-row-fixture-missing', fixture: id };
    artifactHashKinds.set(id, artifactHashKind);
  }
  return { ok: true, fixtureRows, artifactHashKinds };
}

function validatePipelineLedger(metricId, ledger, capture) {
  const identity = captureIdentity(capture);
  if (!identity.ok) return { ok: false, reason: identity.reason };
  if (ledger == null || typeof ledger !== 'object' || Array.isArray(ledger)) return { ok: false, reason: 'ledger-object-missing' };
  if (!Array.isArray(ledger.ledger) || ledger.ledger.length === 0) return { ok: false, reason: 'ledger-rows-missing' };
  const source = sameSourceHash(capture, ledger);
  if (!source.ok) return source;
  const hashes = sameFixtureHashes(capture, ledger);
  if (!hashes.ok) return hashes;
  const mandatory = ledger.totals?.mandatory;
  if (!Number.isSafeInteger(mandatory) || mandatory !== ledger.ledger.length) return { ok: false, reason: 'ledger-denominator-invalid' };
  const categories = sortedUnique(ledger.ledger.map((row) => row.category).filter((value) => typeof value === 'string'));
  if (categories.length === 0 || mandatory !== capture.artifacts.length * categories.length) {
    return { ok: false, reason: 'ledger-category-denominator-mismatch', artifactCount: capture.artifacts.length, categoryCount: categories.length, mandatory };
  }
  const tupleIds = new Set();
  for (const row of ledger.ledger) {
    const tuple = `${row.fixture}\u0000${row.category}`;
    if (tupleIds.has(tuple)) return { ok: false, reason: 'ledger-duplicate-tuple', tuple };
    tupleIds.add(tuple);
    if (!hashes.fixtureRows.has(row.fixture)) return { ok: false, reason: 'ledger-row-fixture-missing', fixture: row.fixture };
  }
  return {
    ok: true,
    identity,
    categories,
    fixtureRows: hashes.fixtureRows,
    artifactHashKinds: sortedUnique([...hashes.artifactHashKinds.values()]),
  };
}

function referenceOraclePass(row, metricId) {
  if (!Number.isSafeInteger(row?.instructionCount) || row.instructionCount <= 0) return false;
  if (row.decodeMismatchCount !== 0) return false;
  if (metricId === 'machine-effects-riscv64-coverage' && row.capstoneDifferentialMismatchCount !== 0) return false;
  return true;
}

/**
 * Convert one P5/P6 independent ledger into a value-bearing evidence record.
 * Candidate coverage counts complete product tuples; reference coverage counts
 * tuples whose LLVM boundary and shipped Capstone differential were valid.
 */
export function measurePhase56Coverage({ metricId, ledger, capture, direction = 'higher' } = {}) {
  if (!P56_METRIC[metricId]) throw new TypeError(`competitive-p56-metric-unsupported:${metricId}`);
  const valid = validatePipelineLedger(metricId, ledger, capture);
  if (!valid.ok) return unmeasured(metricId, capture, valid.reason, { identityFailure: valid });
  const rows = ledger.ledger;
  const mandatory = rows.length;
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const oraclePassed = rows.filter((row) => referenceOraclePass(row, metricId)).length;
  const compilerVersions = sortedUnique([
    ...rows.map((row) => row.compilerIdentity).filter(Boolean),
    ...(ledger.toolchain?.compiler ? [ledger.toolchain.compiler] : []),
  ]);
  const toolchain = ledger.toolchain || {};
  const referenceVersion = compilerVersions.join(',') || String(toolchain.compiler || 'unknown');
  return measured({
    metricId,
    capture,
    direction,
    corpusId: capture.corpusId,
    candidateValue: passed / mandatory,
    referenceValue: oraclePassed / mandatory,
    denominator: {
      kind: 'pipeline-tuples',
      artifactCount: capture.artifacts.length,
      categoryCount: valid.categories.length,
      tupleCount: mandatory,
      artifactIdsDigest: capture.denominator.artifactIdsDigest,
      artifactHashKinds: valid.artifactHashKinds,
      tupleIdsDigest: stableDigest(rows.map((row) => `${row.fixture}\u0000${row.category}`).sort()),
      candidatePasses: passed,
      referenceOraclePasses: oraclePassed,
    },
    referenceTool: P56_METRIC[metricId].producer,
    referenceVersion,
    semanticOracle: {
      schemaVersion: 'hex-competitive-semantic-oracle/v1',
      kind: 'llvm-boundary-and-capstone-differential',
      testPath: P56_METRIC[metricId].testPath,
      sourceSha256: ledger.source.sha256,
      compilerIdentity: compilerVersions,
      linkerIdentity: sortedUnique(capture.artifacts.map((artifact) => artifact.manifest?.linker?.version).filter(Boolean)),
      runtime: runtimeIdentity(),
      corpusDigest: stableDigest({ source: ledger.source, fixtures: ledger.fixtures }),
      ledgerDigest: stableDigest({ totals: ledger.totals, ledger: rows }),
    },
    evidenceRefs: [P56_METRIC[metricId].testPath, P56_METRIC[metricId].producer],
  });
}

function qualityMetric(metricId) {
  if (metricId === 'decompiler-quality-gotos') return 'gotos';
  if (metricId === 'decompiler-quality-assembly-fallbacks') return 'rawAssemblyFallbacks';
  throw new TypeError(`competitive-phase8-metric-unsupported:${metricId}`);
}

function observationIdentity(observations) {
  return {
    count: Array.isArray(observations) ? observations.length : 0,
    ids: (Array.isArray(observations) ? observations : []).map((row) => row?.id),
    digest: stableDigest(observations),
  };
}

function compilerVersionToken(value) {
  return String(value || '').match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
}

/** Bind P8 candidate observations to the frozen source/corpus baseline. */
export function measurePhase8Quality({ metricId, observations, baseline = loadFrozenBaseline(), corpus = loadCorpus(), capture, direction = 'lower' } = {}) {
  const field = qualityMetric(metricId);
  const identity = captureIdentity(capture);
  if (!identity.ok) return unmeasured(metricId, capture, identity.reason);
  if (identity.capture.corpusId !== corpus.corpusId || identity.capture.corpusVersion !== corpus.corpusVersion) {
    return unmeasured(metricId, capture, 'phase8-corpus-identity-mismatch', { captureCorpusId: identity.capture.corpusId, corpusId: corpus.corpusId });
  }
  if (baseline?.corpusId !== corpus.corpusId || baseline?.corpusVersion !== corpus.corpusVersion || baseline?.corpusDigest !== corpus.corpusDigest) {
    return unmeasured(metricId, capture, 'phase8-frozen-baseline-identity-mismatch');
  }
  const frozenCompiler = compilerVersionToken(corpus.toolchain?.compiler);
  const capturedCompilers = sortedUnique((capture.artifacts || [])
    .map((artifact) => compilerVersionToken(artifact.manifest?.compiler?.version))
    .filter(Boolean));
  if (frozenCompiler != null && (capturedCompilers.length !== 1 || capturedCompilers[0] !== frozenCompiler)) {
    return unmeasured(metricId, capture, 'phase8-corpus-toolchain-mismatch', {
      frozenCompiler,
      capturedCompilers,
    });
  }
  if (!Array.isArray(observations) || !Array.isArray(baseline.observations) || observations.length !== corpus.functions.length
      || baseline.observations.length !== corpus.functions.length
      || stableDigest(observations.map((row) => row?.id)) !== stableDigest(corpus.functions.map((row) => row?.id))
      || stableDigest(baseline.observations.map((row) => row?.id)) !== stableDigest(corpus.functions.map((row) => row?.id))) {
    return unmeasured(metricId, capture, 'phase8-observation-denominator-mismatch');
  }
  const candidate = qualityVector(observations);
  const reference = qualityVector(baseline.observations);
  const candidateValue = candidate[field];
  const referenceValue = reference[field];
  if (!finiteNumber(candidateValue) || !finiteNumber(referenceValue)) return unmeasured(metricId, capture, 'phase8-quality-value-missing');
  const candidateIdentity = observationIdentity(observations);
  const baselineIdentity = observationIdentity(baseline.observations);
  return measured({
    metricId,
    capture,
    direction,
    corpusId: corpus.corpusId,
    candidateValue,
    referenceValue,
    denominator: {
      kind: 'phase8-frozen-function-corpus',
      functionCount: corpus.functions.length,
      corpusDigest: corpus.corpusDigest,
      candidateObservationsDigest: candidateIdentity.digest,
      baselineObservationsDigest: baseline.observationsDigest,
    },
    referenceTool: 'phase8-frozen-source-baseline',
    referenceVersion: String(baseline.baseCommit || 'unknown'),
    semanticOracle: {
      schemaVersion: 'hex-competitive-semantic-oracle/v1',
      kind: 'frozen-source-corpus-observation',
      metricField: field,
      runtime: runtimeIdentity(),
      frozenCompiler,
      capturedCompilers,
      corpusId: corpus.corpusId,
      corpusVersion: corpus.corpusVersion,
      corpusDigest: corpus.corpusDigest,
      candidateObservationDigest: candidateIdentity.digest,
      baselineObservationDigest: baselineIdentity.digest,
      baselineLedgerDigest: baseline.observationsDigest,
    },
    evidenceRefs: [
      'tests/phase8/corpus/**',
      'tools/validation/phase8/decompile-corpus.mjs',
      'tools/validation/phase8/metrics.mjs',
    ],
    details: { candidateQuality: candidate, referenceQuality: reference },
  });
}

/** Collect all four binary records from already captured evidence. */
export function collectCompetitiveMeasurements({ capturesByMetric = {}, phase5Ledger = null, phase6Ledger = null, phase8Observations = null, phase8Baseline = null, phase8Corpus = null } = {}) {
  const records = {};
  records['machine-effects-x86_64-coverage'] = measurePhase56Coverage({
    metricId: 'machine-effects-x86_64-coverage',
    ledger: phase5Ledger,
    capture: capturesByMetric['machine-effects-x86_64-coverage'],
  });
  records['machine-effects-riscv64-coverage'] = measurePhase56Coverage({
    metricId: 'machine-effects-riscv64-coverage',
    ledger: phase6Ledger,
    capture: capturesByMetric['machine-effects-riscv64-coverage'],
  });
  for (const metricId of ['decompiler-quality-gotos', 'decompiler-quality-assembly-fallbacks']) {
    records[metricId] = measurePhase8Quality({
      metricId,
      observations: phase8Observations,
      baseline: phase8Baseline || undefined,
      corpus: phase8Corpus || undefined,
      capture: capturesByMetric[metricId] || capturesByMetric['decompiler-quality-gotos'],
    });
  }
  return Object.freeze(records);
}

/** Parse one machine-readable ledger emitted by the focused P5/P6 test. */
export function parsePipelineLedgerOutput(output, marker) {
  const text = String(output || '');
  const start = text.lastIndexOf(marker);
  if (start < 0) throw new Error(`competitive-ledger-marker-missing:${marker}`);
  const payload = text.slice(start + marker.length).split(/\r?\n/, 1)[0].trim();
  try { return JSON.parse(payload); } catch (error) { throw new Error(`competitive-ledger-json-invalid:${error.message}`); }
}

/** Execute only the focused P5/P6 producer and return its ledger. */
export function runPipelineLedger(metricId, { env = {}, node = process.execPath } = {}) {
  const spec = P56_METRIC[metricId];
  if (!spec) throw new TypeError(`competitive-pipeline-metric-unsupported:${metricId}`);
  const result = spawnSync(node, ['--test', spec.testPath], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const ledger = parsePipelineLedgerOutput(output, spec.marker);
  if (result.status !== 0) {
    const error = new Error(`competitive-pipeline-failed:${metricId}:${result.status}`);
    error.ledger = ledger;
    throw error;
  }
  return ledger;
}

export function phase8CurrentObservations({ corpus = loadCorpus(), decompilerTimeBudgetMs = 20000 } = {}) {
  return observeCorpus({ corpus, decompilerTimeBudgetMs });
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

/**
 * Run the bounded repository-owned collection path.  P5/P6 are built once as
 * debug twins and the focused oracle tests reuse those exact files.  P8 uses
 * the frozen function corpus; if its compiler identity differs, its records
 * remain UNMEASURED as required by the profile.
 */
export function collectCompetitiveMeasurementsFromRepository({
  outputRoot,
  p56ToolchainBin = process.env.HEX_P56_TOOLCHAIN_BIN || null,
  p8Clang = process.env.CLANG || 'clang',
  p8ExpectedCompilerVersion,
  p8NativeArm64 = true,
  decompilerTimeBudgetMs = 20000,
} = {}) {
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) throw new TypeError('competitive-measurement-output-root-required');
  const root = path.resolve(outputRoot);
  const captures = {};
  const captureSpecs = [
    ['machine-effects-x86_64-coverage', capturePhase5TwinWorkload, 'p5'],
    ['machine-effects-riscv64-coverage', capturePhase6TwinWorkload, 'p6'],
  ];
  for (const [metricId, builder, name] of captureSpecs) {
    const artifactRoot = path.join(root, name);
    captures[metricId] = builder({ artifactRoot, outDir: path.join(artifactRoot, 'debug'), toolchainBin: p56ToolchainBin });
    writeJson(path.join(root, `${name}-capture.json`), captures[metricId]);
  }
  const ledgers = {};
  const ledgerMetrics = [
    ['machine-effects-x86_64-coverage', 'p5'],
    ['machine-effects-riscv64-coverage', 'p6'],
  ];
  for (const [metricId, name] of ledgerMetrics) {
    if (captures[metricId].status !== 'READY') continue;
    try {
      ledgers[metricId] = runPipelineLedger(metricId, {
        env: {
          HEX_P56_TOOLCHAIN_BIN: p56ToolchainBin || '',
          HEX_P56_CORPUS_DIR: path.join(root, name, 'debug'),
          HEX_P56_CORPUS_DEBUG: '1',
          HEX_P56_REUSE_CORPUS: '1',
        },
      });
      writeJson(path.join(root, `${name}-ledger.json`), ledgers[metricId]);
    } catch (error) {
      ledgers[metricId] = error.ledger || null;
    }
  }
  for (const [metricId, name] of [
    ['decompiler-quality-gotos', 'p8-gotos'],
    ['decompiler-quality-assembly-fallbacks', 'p8-fallbacks'],
  ]) {
    captures[metricId] = capturePhase8TwinWorkload({
      metricId,
      artifactRoot: path.join(root, name),
      artifactDirectory: path.join(root, name, 'debug'),
      clang: p8Clang,
      ...(p8ExpectedCompilerVersion == null ? {} : { expectedCompilerVersion: p8ExpectedCompilerVersion }),
      nativeArm64: p8NativeArm64,
    });
    writeJson(path.join(root, `${name}-capture.json`), captures[metricId]);
  }
  const corpus = loadCorpus();
  const p8Ready = captures['decompiler-quality-gotos'].status === 'READY'
    || captures['decompiler-quality-assembly-fallbacks'].status === 'READY';
  const observations = p8Ready ? phase8CurrentObservations({ corpus, decompilerTimeBudgetMs }) : null;
  const measurements = collectCompetitiveMeasurements({
    capturesByMetric: captures,
    phase5Ledger: ledgers['machine-effects-x86_64-coverage'] || null,
    phase6Ledger: ledgers['machine-effects-riscv64-coverage'] || null,
    phase8Observations: observations,
    phase8Corpus: corpus,
  });
  writeJson(path.join(root, 'measurements.json'), measurements);
  return Object.freeze({ captures, measurements, outputRoot: root });
}

export { BINARY_METRICS };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!process.argv.includes('--collect')) {
    console.error('competitive measurements: import collectCompetitiveMeasurements or pass --collect --output <directory>');
    process.exitCode = 2;
  } else {
    const outputIndex = process.argv.indexOf('--output');
    const outputRoot = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
    try {
      const result = collectCompetitiveMeasurementsFromRepository({ outputRoot });
      console.log(JSON.stringify({ outputRoot: result.outputRoot, measurements: Object.fromEntries(Object.entries(result.measurements).map(([metricId, measurement]) => [metricId, { status: measurement.status, candidateValue: measurement.candidateValue, referenceValue: measurement.referenceValue, comparison: measurement.comparison, reason: measurement.reason }])) }, null, 2));
    } catch (error) {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    }
  }
}
