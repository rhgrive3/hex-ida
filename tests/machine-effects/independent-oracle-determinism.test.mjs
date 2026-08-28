import assert from 'node:assert/strict';

import { createCorpus } from '../../tools/validation/machine-effects/oracle-corpus.mjs';
import {
  createOracleReport,
  validateOracleReport,
} from '../../tools/validation/machine-effects/oracle-report.mjs';
import { runIndependentComparison } from '../../tools/validation/machine-effects/oracle-runner.mjs';
import { canonicalStringify } from '../../tools/validation/machine-effects/oracle-schema.mjs';
import { INDEPENDENT_ORACLE_CASE_FIXTURES } from './fixtures/independent-oracle-cases.mjs';

const PRODUCT_SHA = '1'.repeat(40);
const BASE_SHA = '2'.repeat(40);
const A2_SNAPSHOT = Object.freeze({
  oracleRole: 'production-effect-registry-denominator-with-explicit-profile-gaps',
  rowIds: Object.freeze(['architecture:arm64']),
  rowCount: 1,
  architectureIds: Object.freeze(['arm64']),
  denominatorDigest: `sha256:${'3'.repeat(64)}`,
});

async function runOnce() {
  const corpus = createCorpus(INDEPENDENT_ORACLE_CASE_FIXTURES);
  const results = [];
  for (const corpusCase of corpus.cases) {
    results.push(await runIndependentComparison({
      corpusCase,
      subject: ({ caseValue }) => ({
        subjectIdentity: 'production-machine-effects-evaluator',
        subjectRole: 'production-machine-effects-subject',
        outcome: { kind: 'normal' },
        state: caseValue.expectedState,
      }),
    }));
  }
  const report = createOracleReport({
    productSha: PRODUCT_SHA,
    baseSha: BASE_SHA,
    verifierIdentity: 'hex-independent-machine-effects-verifier',
    verifierVersion: '1.0.0',
    corpus,
    results,
    toolchain: {
      identity: 'llvm-mc-18.1.3-independent-reference',
      version: '18.1.3',
      command: 'llvm-mc',
      target: 'arm64,x86_64,riscv64',
      status: 'available',
      diagnostics: ['bounded offline fixture execution'],
    },
    a2Before: A2_SNAPSHOT,
    a2After: A2_SNAPSHOT,
  });
  return { corpus, results, report };
}

const first = await runOnce();
const second = await runOnce();
assert.equal(canonicalStringify(first.corpus), canonicalStringify(second.corpus));
assert.equal(canonicalStringify(first.results), canonicalStringify(second.results));
assert.equal(first.corpus.corpusId, second.corpus.corpusId);
assert.deepEqual(first.results.map((result) => result.resultId), second.results.map((result) => result.resultId));
assert.equal(first.report.reportId, second.report.reportId);
assert.equal(canonicalStringify(first.report), canonicalStringify(second.report));
assert.equal(validateOracleReport(first.report).reportId, first.report.reportId);

const stale = JSON.parse(JSON.stringify(first.report));
stale.productSha = '4'.repeat(40);
assert.throws(() => validateOracleReport(stale), /stale-identity/);

console.log('machine-effects independent oracle determinism: PASS (2 byte-identical replays)');
