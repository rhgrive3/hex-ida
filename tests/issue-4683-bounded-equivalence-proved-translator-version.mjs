import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_BINARY_OP } from '../js/symbolic/expr/kinds.js';
import { createBv, createFreshSymbol, createBinary } from '../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { isProvedEvidence } from '../js/symbolic/evidence/symbolic-evidence.js';
import { VERDICT, TRANSLATOR_VERSION } from '../js/symbolic/verify/query.js';
import { verifyBoundedEquivalence } from '../js/symbolic/verify/equivalence.js';

const CUSTOM_TRANSLATOR_VERSION = 'custom-translator-v2';

function equivalentPair() {
  const x = createFreshSymbol(bvSort(4), 'x');
  return {
    beforeTarget: createBinary(BV_BINARY_OP.ADD, x, x),
    afterTarget: createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1)),
  };
}

function differingPair() {
  const x = createFreshSymbol(bvSort(4), 'x');
  return {
    beforeTarget: createBinary(BV_BINARY_OP.ADD, x, createBv(4, 1)),
    afterTarget: createBinary(BV_BINARY_OP.ADD, x, createBv(4, 2)),
  };
}

test('#4683 PROVED evidence records the query default translator version', async () => {
  const result = await verifyBoundedEquivalence({
    ...equivalentPair(),
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(result.verdict, VERDICT.PROVED);
  assert.equal(result.query.translatorVersion, TRANSLATOR_VERSION);
  assert.equal(
    result.evidence.translatorVersion,
    result.query.translatorVersion,
    'PROVED evidence must report the translator version the query was actually built and solved with',
  );
});

test('#4683 custom options.translatorVersion propagates into PROVED evidence', async () => {
  const result = await verifyBoundedEquivalence({
    ...equivalentPair(),
    backend: new ExhaustiveBvBackend(),
    options: { translatorVersion: CUSTOM_TRANSLATOR_VERSION },
  });
  assert.equal(result.verdict, VERDICT.PROVED);
  assert.equal(result.query.translatorVersion, CUSTOM_TRANSLATOR_VERSION);
  assert.equal(result.evidence.translatorVersion, CUSTOM_TRANSLATOR_VERSION);
});

test('#4683 REFUTED evidence version propagation is preserved', async () => {
  const result = await verifyBoundedEquivalence({
    ...differingPair(),
    backend: new ExhaustiveBvBackend(),
    options: { translatorVersion: CUSTOM_TRANSLATOR_VERSION },
  });
  assert.equal(result.verdict, VERDICT.REFUTED);
  assert.equal(result.evidence.translatorVersion, result.query.translatorVersion);
});

test('#4683 query binding and proof authority survive the version fix', async () => {
  const defaultRun = await verifyBoundedEquivalence({ ...equivalentPair(), backend: new ExhaustiveBvBackend() });
  const customRun = await verifyBoundedEquivalence({
    ...equivalentPair(),
    backend: new ExhaustiveBvBackend(),
    options: { translatorVersion: CUSTOM_TRANSLATOR_VERSION },
  });
  assert.equal(defaultRun.evidence.queryHash, defaultRun.query.queryHash);
  assert.equal(customRun.evidence.queryHash, customRun.query.queryHash);
  assert.notEqual(defaultRun.query.queryHash, customRun.query.queryHash);
  assert.equal(customRun.evidence.proofAuthority, defaultRun.evidence.proofAuthority);
  assert.ok(isProvedEvidence(defaultRun.evidence));
  assert.ok(isProvedEvidence(customRun.evidence));
});
