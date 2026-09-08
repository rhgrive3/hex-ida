import assert from 'node:assert/strict';

const preFix = process.argv.includes('--pre-fix');

if (preFix) {
  const releaseProof = {
    status: 'not-integrated',
    reason: 'independent-oracle-not-implemented',
    passCount: 0,
  };
  assert.equal(
    releaseProof.status,
    'exact/equivalent',
    `pre-fix release-grade proof must fail: ${releaseProof.reason}`,
  );
}

const { createCorpusCase } = await import('../../tools/validation/machine-effects/oracle-schema.mjs');
const { runIndependentComparison } = await import('../../tools/validation/machine-effects/oracle-runner.mjs');
const {
  DETERMINISTIC_ADD_CASE,
  deterministicAddSubjectState,
} = await import('./fixtures/independent-oracle-cases.mjs');

const corpusCase = createCorpusCase(DETERMINISTIC_ADD_CASE);
const result = await runIndependentComparison({
  corpusCase,
  subject: () => deterministicAddSubjectState(corpusCase),
});

assert.equal(result.status, 'exact/equivalent');
assert.equal(result.oracleIdentity, 'hex-independent-machine-effects-oracle');
assert.equal(result.provenance.independentFromProduction, true);
assert.equal(result.comparisonCounts.registers > 0, true);
assert.equal(result.comparisonCounts.flags > 0, true);
assert.equal(result.comparisonCounts.vectors > 0, true);
assert.equal(result.passContribution, 1);

console.log(`machine-effects independent oracle counterexample: PASS (${result.status})`);
