import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFunctionSummary,
  functionSummaryDigest,
} from '../../../js/analysis/summary/contract.js';

const status = {
  snapshotId: 'snap-4654',
  analyzerId: 'summary',
  analyzerVersion: '1',
  completeness: 'complete',
};

const base = {
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
  noreturn: false,
  mayThrow: false,
  stackDelta: null,
  semanticFacts: [],
  status,
};

const digestOf = (override) => functionSummaryDigest(createFunctionSummary({ ...base, ...override }));

// #4654: the constructor accepts arbitrary `semanticFacts`/`escapes` elements,
// but `stableDigest` runs them through `jsonSafe`, which deterministically
// drops lossy values (undefined/function/symbol/non-finite/-0/bigint) as
// object properties. Two distinct canonical summaries could therefore share
// one semantic dependency identity. Digest identity must be injective over
// the consumer-visible values the constructor keeps.

test('#4654 {} and {confidence:NaN} semanticFacts never share a digest', () => {
  const empty = digestOf({ semanticFacts: [{}] });
  const nan = digestOf({ semanticFacts: [{ confidence: NaN }] });
  assert.notEqual(nan, empty, 'a NaN-valued fact must not digest as the empty fact');
});

test('#4654 nested undefined/function/symbol/±Infinity/-0 facts are distinguished', () => {
  const empty = digestOf({ semanticFacts: [{}] });
  const variants = [
    [{ x: undefined }],
    [{ x: () => 1 }],
    [{ x: Symbol('x') }],
    [{ x: Infinity }],
    [{ x: -Infinity }],
    [{ x: -0 }],
    [{ nested: { deep: { confidence: NaN } } }],
    [{ wide: 1n }],
  ];
  const digests = new Set([empty]);
  for (const semanticFacts of variants) {
    const digest = digestOf({ semanticFacts });
    assert.notEqual(digest, empty, 'a lossy-typed fact must not digest as the empty fact');
    digests.add(digest);
  }
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      assert.notEqual(
        digestOf({ semanticFacts: variants[i] }),
        digestOf({ semanticFacts: variants[j] }),
        `distinct lossy facts at [0]${JSON.stringify(Object.keys(variants[i])[0])}/[0]${JSON.stringify(Object.keys(variants[j])[0])} need distinct digests`,
      );
    }
  }
});

test('#4654 the same structured-value rule covers escapes', () => {
  const empty = digestOf({ escapes: [{}] });
  assert.notEqual(digestOf({ escapes: [{ detail: NaN }] }), empty);
  assert.notEqual(digestOf({ escapes: [{ detail: undefined }] }), empty);
  assert.notEqual(digestOf({ escapes: [{ detail: () => 1 }] }), empty);
  assert.notEqual(digestOf({ escapes: [{ detail: Symbol('s') }] }), empty);
  assert.notEqual(digestOf({ escapes: [{ detail: Infinity }] }), empty);
});

test('#4654 JSON-safe semanticFacts/escapes keep stable digest identity', () => {
  const facts = [{ kind: 'purity', confidence: 1, tags: ['a', 'b'], flag: true, missing: null }];
  const escapes = [{ kind: 'return-escape', target: 'ret', evidenceIds: ['ev-4654'] }];
  const first = digestOf({ semanticFacts: facts, escapes });
  const second = digestOf({ semanticFacts: [{ ...facts[0] }], escapes: [{ ...escapes[0] }] });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{32}$/);
});

test('#4654 a changed consumer-visible semantic field always changes the digest', () => {
  const pairs = [
    [[{}], [{ x: 1 }]],
    [[{ x: 1 }], [{ x: 2 }]],
    [[{ x: 1 }], [{ x: '1' }]],
    [[{ x: 0 }], [{ x: -0 }]],
    [[{ x: null }], [{ x: undefined }]],
    [[{ list: [1, 2] }], [{ list: [1, NaN] }]],
    [[{ a: { b: 1 } }], [{ a: { b: Infinity } }]],
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(
      digestOf({ semanticFacts: left }),
      digestOf({ semanticFacts: right }),
      'every consumer-visible semantic value change must advance dependency identity',
    );
  }
});
