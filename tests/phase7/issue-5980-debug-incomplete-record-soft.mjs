// Regression for #5980: `descriptor.complete:false` is the parser's explicit
// statement that a record has missing/uninterpreted content. Identity match
// proves the build, not the meaning — such records must stay soft evidence
// even under a matched-authoritative source identity.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDebugProviderResult,
  createDebugRecord,
  isDebugRecordAuthoritative,
} from '../../js/analysis/debug/provider.js';

function authoritativeResult() {
  return createDebugProviderResult({
    ecosystem: 'dwarf',
    identity: {
      verdict: 'matched-authoritative',
      providerId: 'phase7.debug.dwarf',
      providerVersion: '1',
      method: 'build-id',
      expected: 'build-A',
      observed: 'build-A',
    },
    status: {
      snapshotId: 'snap',
      analyzerId: 'phase7.debug.dwarf',
      analyzerVersion: '1',
      completeness: 'partial',
      stopReason: 'evidence-missing',
    },
  });
}

function record(complete) {
  return createDebugRecord({
    kind: 'type',
    entityId: 'type:x',
    descriptor: {
      layer: 'nominal',
      claim: { name: 'X' },
      complete,
    },
    providerId: 'phase7.debug.dwarf',
    providerVersion: '1',
    buildIdentity: 'build-A',
    evidenceIds: ['e:x'],
  });
}

test('#5980 an explicitly incomplete record never claims authority', () => {
  const result = authoritativeResult();
  assert.equal(isDebugRecordAuthoritative(result, record(false)), false);
});

test('#5980 a complete record under the same identity stays authoritative', () => {
  const result = authoritativeResult();
  assert.equal(isDebugRecordAuthoritative(result, record(true)), true);
});

test('#5980 a descriptor without a completeness field keeps the existing contract', () => {
  const result = authoritativeResult();
  const noCompleteField = createDebugRecord({
    kind: 'symbol',
    entityId: 'fn:x',
    descriptor: { isFunction: true },
    providerId: 'phase7.debug.dwarf',
    providerVersion: '1',
    buildIdentity: 'build-A',
    evidenceIds: ['e:fn'],
  });
  assert.equal(isDebugRecordAuthoritative(result, noCompleteField), true);
});
