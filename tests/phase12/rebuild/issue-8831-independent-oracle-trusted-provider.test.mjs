import assert from 'node:assert/strict';

import { stableDigest } from '../../../js/core/identity/index.js';
import {
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  evaluateF6RebuildDenominator,
  materializeRebuildTransaction,
  registerCanonicalIndependentOracleProvider,
  validateRebuildTransaction,
} from '../../../js/rebuild/transaction-v2.js';

// #8831 — the F6 `independent-differential-oracle` denominator unit is a release authority. A
// caller-supplied callback that only echoes the authoritative hashes/schema must NOT close it; only a
// registered canonical provider (which represents a genuinely independent implementation) may.

const source = Uint8Array.of(1, 2, 3, 4);
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

function buildTransaction() {
  return createRebuildTransaction({
    binaryId: 'bin:issue-8831-self-oracle',
    sourceHash: digest(source),
    format: 'macho',
    architecture: 'x86_64',
    loaderVersion: 'hex-loader:issue-8831:v1',
    operations: [{ id: 'patch', offset: 1, before: [2], after: [9], provenance: { source: 'test' } }],
    impact: {},
    requireIndependentOracle: true,
  });
}

function makeLoaderReparse() {
  return ({ transaction, materialized }) => ({
    ok: true,
    status: 'passed',
    format: transaction.format,
    architecture: transaction.architecture,
    loaderVersion: transaction.loaderVersion,
    sourceHash: transaction.sourceHash,
    outputHash: materialized.outputHash,
  });
}

// A self-referential oracle: it copies the schema and echoes the exact authoritative digests, so it
// clears the oracle contract while running no independent implementation whatsoever.
function makeEchoOracle() {
  return async ({ transaction, expectedOutputHash }) => ({
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok: true,
    status: 'passed',
    oracleIdentity: 'caller:self',
    oracleVersion: '0',
    oracleSource: 'inline-callback',
    sourceDigest: transaction.sourceHash,
    outputDigest: expectedOutputHash,
    format: transaction.format,
    architecture: transaction.architecture,
  });
}

async function evaluateWithOracle(independentOracle) {
  const transaction = buildTransaction();
  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
  assert.equal(materialized.status, 'materialized', 'materialization must succeed');
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: makeLoaderReparse(),
    independentOracle,
  });
  const independent = validation.validators.find((item) => item.validator === 'independent-differential');
  // The echo callback passes the oracle contract on its own; that is the point of #8831.
  assert.equal(independent?.status, 'passed', 'echo oracle must clear the contract, not be rejected by it');
  assert.equal(validation.independentDifferential, 'executed', 'echo oracle must actually execute');
  const denominator = evaluateF6RebuildDenominator({ transaction, validation, publication: null, proof: {} });
  return { validation, denominator };
}

const unitCell = (denominator) => denominator.cells['independent-differential-oracle'];

const untrusted = await evaluateWithOracle(makeEchoOracle());
assert.equal(untrusted.validation.independentOracleTrusted, false, 'unregistered echo callback is not a canonical provider');
assert.equal(unitCell(untrusted.denominator).status, 'blocking', 'echo callback must not close the F6 independent unit');
assert.equal(unitCell(untrusted.denominator).reason, 'f6-independent-oracle-provider-untrusted');
assert.equal(untrusted.denominator.blockingUnitIds.some((id) => id.endsWith(':independent-differential-oracle')), true);

const trustedOracle = registerCanonicalIndependentOracleProvider(makeEchoOracle());
const trusted = await evaluateWithOracle(trustedOracle);
assert.equal(trusted.validation.independentOracleTrusted, true, 'registered adapter is a canonical provider');
assert.equal(unitCell(trusted.denominator).status, 'closed', 'a registered independent provider may close the unit');
assert.equal(unitCell(trusted.denominator).reason, null);
assert.equal(trusted.denominator.closedUnitIds.some((id) => id.endsWith(':independent-differential-oracle')), true);

console.log('[phase12] issue #8831 independent-oracle trusted-provider denominator regression passed');
