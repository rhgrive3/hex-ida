import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FUNCTION_FINGERPRINT_COMPARISON_VERSION,
  FUNCTION_FINGERPRINT_VERSION,
  FingerprintVersionError,
  assertFingerprintCompatible,
  compareFingerprints,
  fingerprintFunction,
} from '../../js/fingerprint/index.js';
import { DEFAULT_MATCH_BUDGET, createMatchBudget } from '../../js/recognition/match-budget.js';
import {
  calibrationReport,
  matchFunctions,
  maximumWeightCandidateMatching,
  recognitionMetrics,
} from '../../js/recognition/matcher.js';
import { solveCandidateMatching } from '../../js/recognition/bounded-matching.js';
import {
  SIGNATURE_PACK_VERSION,
  createKnowledgePack,
  importKnowledgePack,
  validateKnowledgePack,
} from '../../js/signature/index.js';

// HEX-S2-02 acceptance denominator.  Recognition may order candidates but it
// must never convert an unresolved collision into an exact name/type, and a
// truncated search must retain what it could not decide.
const COLLISION_CLASSES = Object.freeze([
  'identical-thunk',
  'icf-clone',
  'relocation-stripped',
  'tiny-function-without-bytes',
]);

const TRUNCATION_AUTHORITIES = Object.freeze([
  'component-budget',
  'solver-budget',
  'wall-clock',
  'candidate-edge-cap',
  'preprocessing',
]);

const ALTERNATIVE_CAP = 4;
const DEFAULT_AMBIGUITY_WINDOW = 0.035;
const DEFAULT_CALIBRATION_BINS = 10;
const CALIBRATION_SCORE_KIND = 'similarity-confidence-v1';

const BUDGET_LIMITS = Object.freeze([
  'maxPreprocessFunctions', 'maxPreprocessInputBytes', 'maxPreprocessEstimatedBytes', 'maxPreprocessWork',
  'maxIndexEntries', 'maxCandidateEvaluations', 'maxCandidateEdges', 'maxComponentNodes', 'maxComponentEdges',
  'maxSolverRelaxations', 'maxSolverAugmentations', 'maxPostprocessWork', 'maxWallMs',
]);

const BASE_CFG = Object.freeze({ blocks: 2, edges: 1, exits: 1, loops: 0, calls: 1 });

function rawFunction(overrides = {}) {
  return {
    address: 0x1000n,
    architecture: 'arm64',
    bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    instructions: ['stp x29, x30, [sp,#-0x20]!', 'add x3, x1, x2', 'str x3, [x0,#0x20]', 'ret'],
    cfg: BASE_CFG,
    strings: ['alpha-unique'],
    imports: ['memcpy'],
    calls: ['helper'],
    constants: [100],
    semantic: { reads: ['field:0x20'], writes: ['field:0x20'], rmw: ['field:0x20'], operations: ['add'], returnOrigin: 'void' },
    ...overrides,
  };
}

function thunk(overrides = {}) {
  return rawFunction({
    cfg: { blocks: 1, edges: 0, exits: 1, loops: 0, calls: 0 },
    instructions: ['ret'],
    strings: [],
    imports: [],
    calls: [],
    constants: [],
    semantic: { reads: [], writes: [], rmw: [], operations: [], returnOrigin: 'void' },
    ...overrides,
  });
}

function distinctPair() {
  const before = [
    rawFunction({ address: 0x1000n, bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), strings: ['alpha-unique'], constants: [100] }),
    rawFunction({
      address: 0x1100n,
      bytes: Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]),
      instructions: ['mov x0, x1', 'sub x2, x2, #4', 'ret'],
      cfg: { blocks: 1, edges: 0, exits: 1, loops: 0, calls: 0 },
      strings: ['beta-unique'],
      imports: ['free'],
      calls: ['other'],
      constants: [7],
      semantic: { reads: ['field:0x8'], writes: ['field:0x8'], rmw: [], operations: ['sub'], returnOrigin: 'void' },
    }),
  ];
  return {
    before,
    after: [{ ...before[0], address: 0x2000n }, { ...before[1], address: 0x2100n }],
  };
}

test('S2-02 collision, alternative, truncation and calibration denominators are frozen', () => {
  assert.deepEqual(COLLISION_CLASSES, ['identical-thunk', 'icf-clone', 'relocation-stripped', 'tiny-function-without-bytes']);
  assert.deepEqual(TRUNCATION_AUTHORITIES, ['component-budget', 'solver-budget', 'wall-clock', 'candidate-edge-cap', 'preprocessing']);
  assert.equal(ALTERNATIVE_CAP, 4);
  assert.equal(DEFAULT_AMBIGUITY_WINDOW, 0.035);
  assert.equal(FUNCTION_FINGERPRINT_VERSION, 4);
  assert.equal(FUNCTION_FINGERPRINT_COMPARISON_VERSION, '1.0.0');
  assert.equal(CALIBRATION_SCORE_KIND, 'similarity-confidence-v1');
  assert.equal(DEFAULT_CALIBRATION_BINS, 10);
  for (const limit of BUDGET_LIMITS) {
    assert.ok(Number.isSafeInteger(DEFAULT_MATCH_BUDGET[limit]) && DEFAULT_MATCH_BUDGET[limit] > 0, `${limit} must be a positive bounded limit`);
  }
});

test('S2-02 identical thunk collisions keep every candidate and never publish an exact match', () => {
  const before = [thunk({ address: 0x1000n, bytes: Uint8Array.from([0xc0, 0x03, 0x5f, 0xd6, 0, 0, 0, 0]) })];
  const after = [
    thunk({ address: 0x2000n, bytes: Uint8Array.from([0xc0, 0x03, 0x5f, 0xd6, 0, 0, 0, 0]) }),
    thunk({ address: 0x3000n, bytes: Uint8Array.from([0xc0, 0x03, 0x5f, 0xd6, 0, 0, 0, 0]) }),
  ];
  const result = matchFunctions(before, after);

  assert.equal(result.truncated, false);
  assert.equal(result.matches.length, 1);
  const [match] = result.matches;
  assert.equal(match.ambiguous, true, 'two identical clones must not be published as one exact identity');
  assert.ok(match.candidates.length >= 1 && match.candidates.length <= ALTERNATIVE_CAP, 'the discarded collision stays available as an alternative');
  assert.equal(match.candidates[0].side, 'after');
  assert.equal(result.ambiguous, true);

  const metrics = recognitionMetrics([[before[0].address, after[0].address]], result);
  assert.equal(metrics.truePositive, 0, 'an ambiguous match is not an exact prediction');
  assert.equal(metrics.falsePositive, 0, 'an ambiguous match must not be published as an exact false positive either');
});

test('S2-02 maximum-weight matching keeps one assignment per side and prefers the global optimum', () => {
  const selected = maximumWeightCandidateMatching([
    { i: 0, j: 0, confidence: 0.6 },
    { i: 0, j: 1, confidence: 0.9 },
    { i: 1, j: 1, confidence: 0.7 },
  ]);
  assert.equal(selected.length, 2);
  const pairs = selected.map((candidate) => `${candidate.i}>${candidate.j}`).sort();
  assert.deepEqual(pairs, ['0>0', '1>1'], 'the two-edge 1.3 assignment must beat the single 0.9 edge');

  const ties = maximumWeightCandidateMatching([
    { i: 0, j: 0, confidence: 0.8 },
    { i: 0, j: 1, confidence: 0.8 },
  ]);
  assert.equal(ties.length, 1, 'a collision on one before-function still yields a single assignment');

  const invalid = solveCandidateMatching([{ i: 0, j: 0, confidence: Number.NaN }, { i: 1, j: 1, confidence: 1.5 }]);
  assert.deepEqual(invalid.selected, [], 'candidates without a valid confidence are not matches');
  assert.equal(invalid.ambiguousLeft.size, 0);
});

test('S2-02 component, solver and wall-clock exhaustion mark the collision set ambiguous', () => {
  const componentBudget = createMatchBudget({ maxComponentNodes: 1 });
  const component = solveCandidateMatching([
    { i: 0, j: 0, confidence: 0.9 },
    { i: 1, j: 1, confidence: 0.9 },
  ], componentBudget);
  assert.deepEqual(component.selected, []);
  assert.equal(component.ambiguousLeft.size, 2);
  assert.equal(component.ambiguousRight.size, 2);
  assert.equal(component.truncatedComponents.length, 2);
  for (const entry of component.truncatedComponents) assert.equal(entry.reason, 'component-budget');

  const solverBudget = createMatchBudget({ maxSolverRelaxations: 1 });
  const solver = solveCandidateMatching([{ i: 0, j: 0, confidence: 0.9 }], solverBudget);
  assert.deepEqual(solver.selected, []);
  assert.match(solver.truncatedComponents[0].reason, /solver relaxations exceeded 1/);
  assert.equal(solver.budget.truncated, true);

  let clock = 0;
  const wallBudget = createMatchBudget({ maxWallMs: 1, now: () => (clock += 1000) });
  const wall = solveCandidateMatching([{ i: 0, j: 0, confidence: 0.9 }], wallBudget);
  assert.deepEqual(wall.selected, []);
  assert.match(wall.truncatedComponents[0].reason, /wall-clock budget/);
});

test('S2-02 truncated candidate graphs keep unresolved inputs instead of reporting deletions', () => {
  const { before, after } = distinctPair();

  const edgeCapped = matchFunctions(before, after, { matchBudget: { maxCandidateEdges: 1 } });
  assert.equal(edgeCapped.truncated, true);
  assert.equal(edgeCapped.ambiguous, true);
  assert.equal(edgeCapped.matches.length, 0);
  assert.equal(edgeCapped.unresolvedBefore.length, 2, 'unresolved before-functions are retained');
  assert.equal(edgeCapped.unresolvedAfter.length, 2, 'unresolved after-functions are retained');
  assert.equal(edgeCapped.matching.candidateGraphIncomplete, true);
  assert.match(edgeCapped.matching.budget.reason, /candidate edges exceeded 1/);

  const preprocessingCapped = matchFunctions(before, after, { matchBudget: { maxPreprocessFunctions: 1 } });
  assert.equal(preprocessingCapped.truncated, true);
  assert.equal(preprocessingCapped.matches.length, 0);
  assert.equal(preprocessingCapped.matching.preprocessingIncomplete, true);
  assert.equal(preprocessingCapped.unresolvedBefore.length, 2);

  const aborted = matchFunctions(before, after, { signal: AbortSignal.abort() });
  assert.equal(aborted.truncated, true);
  assert.equal(aborted.matches.length, 0);
  assert.equal(aborted.matching.candidateGraphIncomplete, true);
});

test('S2-02 unambiguous matches keep exact authority and calibrated reporting', () => {
  const { before, after } = distinctPair();
  const result = matchFunctions(before, after);

  assert.equal(result.truncated, false);
  assert.equal(result.ambiguous, false);
  assert.equal(result.matches.length, 2);
  for (const match of result.matches) {
    assert.equal(match.ambiguous, false);
    assert.deepEqual(match.candidates, []);
    assert.ok(match.confidence > 0 && match.confidence <= 1);
  }
  assert.equal(result.matching.ambiguousBefore, 0);
  assert.equal(result.matching.ambiguousAfter, 0);

  const expected = [[before[0].address, after[0].address], [before[1].address, after[1].address]];
  const metrics = recognitionMetrics(expected, result);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.falseMatchRate, 0);
  assert.equal(metrics.ambiguousRate, 0);

  const report = calibrationReport(expected, result, { bins: 5 });
  assert.equal(report.calibrated, false, 'confidence is not a calibration guarantee');
  assert.equal(report.scoreKind, CALIBRATION_SCORE_KIND);
  assert.equal(report.bins.length, 5);
  assert.equal(report.bins.reduce((sum, bin) => sum + bin.samples, 0), 2);
  for (const bin of report.bins) {
    assert.ok(bin.samples > 0 ? bin.observedPrecision >= 0 && bin.observedPrecision <= 1 : bin.observedPrecision === null);
  }

  const wrongExpected = [[before[0].address, after[1].address]];
  assert.ok(recognitionMetrics(wrongExpected, result).precision < 1, 'false exactness must be measurable');
});

test('S2-02 relocation-stripped bytes normalize but stay candidates, and byte-less tiny functions never match', () => {
  const relocation = [{ offset: 0, width: 8 }];
  const relocA = fingerprintFunction(rawFunction({ bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), relocationOffsets: relocation, instructions: [] }));
  const relocB = fingerprintFunction(rawFunction({ bytes: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]), relocationOffsets: relocation, instructions: [] }));
  assert.equal(relocA.normalizedBytesHash, relocB.normalizedBytesHash);
  const relocationComparison = compareFingerprints(relocA, relocB);
  assert.equal(relocationComparison.identity, 'normalized-identical', 'relocation-only differences are reported as normalized, not exact bytes');
  assert.equal(
    relocationComparison.evidence.some((entry) => entry.signal === 'exact-bytes'),
    false,
    'a normalized match must not carry byte-exact evidence',
  );

  // A partially relocation-covered comparison keeps its uncertainty instead of
  // inheriting the fully normalized confidence.
  const partiallyMasked = fingerprintFunction(rawFunction({
    bytes: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]), relocationOffsets: [{ offset: 0, width: 4 }], instructions: [],
  }));
  assert.notEqual(
    partiallyMasked.normalizedBytesHash,
    relocA.normalizedBytesHash,
    'unmasked bytes keep the normalized hash unresolved',
  );
  const partialComparison = compareFingerprints(relocA, partiallyMasked);
  assert.notEqual(partialComparison.identity, 'normalized-identical', 'a partially normalized comparison is not a normalized match');
  assert.notEqual(partialComparison.identity, 'exact');
  assert.ok(partialComparison.confidence < 1, 'partial relocation coverage must not reach exact authority');

  const byteLessA = fingerprintFunction(thunk({ address: 0x1000n, bytes: null }));
  const byteLessB = fingerprintFunction(thunk({ address: 0x2000n, bytes: new Uint8Array(0) }));
  assert.equal(byteLessA.normalizedBytesHash, null);
  assert.equal(byteLessB.normalizedBytesHash, null);
  const byteLessComparison = compareFingerprints(byteLessA, byteLessB);
  assert.notEqual(byteLessComparison.identity, 'exact', 'byte-less tiny functions must not become a byte-exact identity');
  assert.equal(
    byteLessComparison.evidence.some((entry) => entry.signal === 'exact-bytes'),
    false,
    'a byte-less comparison carries no byte-exact evidence',
  );
  const byteLessCollision = matchFunctions(
    [thunk({ address: 0x1000n, bytes: null })],
    [thunk({ address: 0x2000n, bytes: null }), thunk({ address: 0x3000n, bytes: null })],
  );
  for (const match of byteLessCollision.matches) {
    assert.notEqual(match.identity, 'exact', 'a byte-less collision cannot publish an exact identity');
    assert.equal(match.ambiguous, true, 'a byte-less collision must stay ambiguous');
  }

  const empty = fingerprintFunction({ address: 1n, bytes: new Uint8Array(0) });
  assert.equal(empty.normalizedBytesHash, null);
  assert.equal(compareFingerprints(empty, empty).identity, 'unrelated');
});

test('S2-02 fingerprint and knowledge-pack data versions fail closed on unknown versions', () => {
  const fingerprint = fingerprintFunction(rawFunction());
  assert.equal(fingerprint.version, FUNCTION_FINGERPRINT_VERSION);
  assert.equal(assertFingerprintCompatible(fingerprint), fingerprint, 'a current-version fingerprint passes through unchanged');
  const futureFingerprint = { ...fingerprint, version: FUNCTION_FINGERPRINT_VERSION + 1 };
  assert.throws(() => assertFingerprintCompatible(futureFingerprint), FingerprintVersionError);
  assert.throws(() => compareFingerprints(futureFingerprint, fingerprint), (error) => {
    assert.equal(error?.name, 'FingerprintVersionError');
    assert.equal(error?.code, 'unsupported-fingerprint-version');
    return true;
  });
  assert.throws(() => assertFingerprintCompatible({ ...fingerprint, version: 0 }), FingerprintVersionError);
  assert.deepEqual(assertFingerprintCompatible({ schema: 'other-fingerprint', version: 99 }), { schema: 'other-fingerprint', version: 99 });

  const pack = createKnowledgePack({
    architecture: 'arm64',
    signatures: [{ architecture: 'arm64', symbols: ['_malloc'], confidence: 0.9 }],
    mappings: [{ identity: 'fn:1', name: 'helper', confirmation: 'weak-inferred' }],
  });
  assert.equal(validateKnowledgePack(pack).ok, true);
  const futurePack = { ...pack, version: SIGNATURE_PACK_VERSION + 1 };
  assert.equal(validateKnowledgePack(futurePack).ok, false);
  assert.match(validateKnowledgePack(futurePack).error, /unsupported knowledge pack version/);
  assert.equal(validateKnowledgePack({ ...pack, format: 'other-knowledge-pack' }).ok, false);
  const { provenance, ...signatureWithoutProvenance } = pack.signatures[0];
  assert.match(validateKnowledgePack({ ...pack, signatures: [signatureWithoutProvenance] }).error, /signature provenance is required/);
  const { license, ...signatureWithoutLicense } = pack.signatures[0];
  assert.match(validateKnowledgePack({ ...pack, signatures: [signatureWithoutLicense] }).error, /signature license is required/);
  assert.equal(importKnowledgePack('{not json').ok, false);
  assert.match(importKnowledgePack('{not json').error, /malformed knowledge pack JSON/);
  assert.equal(importKnowledgePack(JSON.stringify(pack)).ok, true);
});
