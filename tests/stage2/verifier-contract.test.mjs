import assert from 'node:assert/strict';
import { minimumVerdictCounts, stage2KnownDenominatorGaps } from '../../tools/validation/stage2/verify.mjs';

const knownGaps = stage2KnownDenominatorGaps();
assert.ok(knownGaps.includes('arm64:a64:all-decoder-encodings-and-aliases'));
assert.ok(knownGaps.includes('x86_64:long-64:effect-family:atomic'));

const passed = (command) => ({ command, status: 'passed' });
const complete = minimumVerdictCounts({
  structural: { errors: [] }, sourceAudit: { ok: true },
  commands: [passed('node tests/stage2/run.mjs'), passed('npm run check'), passed('npm run benchmark:baseline')],
  profiles: { status: 'passed', failures: [] }, physical: { status: 'passed' },
  ledger: { unmappedCount: 0, unresolved: [] }, generatedOutput: { status: 'passed' },
  candidateMerge: { status: 'passed' }, releaseBlockingIssueCount: 0,
});
const requiredFields = [
  'unmappedCount', 'unprovenCount', 'scopeReductionCount', 'promotedFallbackCount',
  'coverageDenominatorMisses', 'requiredValidatorMisses', 'fuzzOrPropertyFailures',
  'mutationSelfTestFailures', 'realFixtureFailures', 'performanceBudgetFailures',
  'requiredTargetPlatformFailures', 'supportProjectionMismatches',
  'releaseBlockingIssueCount', 'staleEvidenceCount',
];
assert.deepEqual(Object.keys(complete), requiredFields);
assert.equal(Object.values(complete).every((value) => Number.isSafeInteger(value) && value === 0), true, 'COMPLETE inputs produce only numeric zero counts');

const missing = minimumVerdictCounts({
  structural: { errors: ['scope-baseline-not-ancestor'] }, sourceAudit: { ok: false }, commands: [],
  profiles: { status: 'failed', failures: ['S1-A2-NATIVE:denominator-not-complete'] },
  physical: { status: 'failed' }, ledger: { unmappedCount: 1, unresolved: [{}] },
  generatedOutput: { status: 'blocked-by-preflight' }, candidateMerge: { status: 'failed' },
  releaseBlockingIssueCount: null,
});
for (const field of requiredFields) assert.ok(missing[field] > 0, `${field} must fail closed when its proof is absent`);

console.log('[stage2] H16 machine verdict fields fail closed');
