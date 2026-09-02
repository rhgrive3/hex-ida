import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FUNCTION_SUMMARY_CONTRACT_VERSION,
  FUNCTION_SUMMARY_SCHEMA_VERSION,
  summaryIdentityMatches,
} from '../../js/analysis/summary/contract.js';

function canonicalSummary() {
  return {
    schemaVersion: FUNCTION_SUMMARY_SCHEMA_VERSION,
    contractVersion: FUNCTION_SUMMARY_CONTRACT_VERSION,
    functionId: 'f',
    inputs: [],
    returnValues: [],
    returnProvenance: [],
    registerEffects: [],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    escapes: [],
    allocations: [],
    frees: [],
    directCalls: [],
    indirectCallSets: [],
    unknownCallEffects: [],
    semanticFacts: [],
    status: {
      snapshotId: 'snapshot-A',
      analyzerId: 'phase7.summary.local',
      analyzerVersion: '1.1.0',
    },
  };
}

const expected = {
  functionId: 'f',
  snapshotId: 'snapshot-A',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.1.0',
};

test('#3420 canonical primitive summary identities still match', () => {
  assert.equal(summaryIdentityMatches(canonicalSummary(), expected), true);
  assert.equal(summaryIdentityMatches(canonicalSummary(), {}), true, 'omitted dimensions stay optional');
});

test('#3420 structured expected identities cannot alias canonical protocol strings', () => {
  for (const field of Object.keys(expected)) {
    const value = expected[field];
    for (const malformed of [
      [value],
      { toString: () => value },
      value === 'f' ? 0 : 1,
      true,
    ]) {
      assert.equal(
        summaryIdentityMatches(canonicalSummary(), { ...expected, [field]: malformed }),
        false,
        `${field} must reject ${Object.prototype.toString.call(malformed)}`,
      );
    }
  }
});
