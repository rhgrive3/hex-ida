import assert from 'node:assert/strict';

import { createAnalysisStatus } from '../js/analysis/status.js';
import { createFunctionSummary, functionSummaryDigest } from '../js/analysis/summary/contract.js';

const status = createAnalysisStatus({
  snapshotId: 'snapshot_4654',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

const digestOf = (overrides) => functionSummaryDigest(createFunctionSummary({ functionId: 'fn_4654', status, ...overrides }));

assert.equal(
  digestOf({ semanticFacts: [{ a: 1, b: 'x', c: [1, 2], d: { e: null } }], escapes: [{ kind: 'return-escape', target: 't', evidenceIds: ['e1'] }] }),
  '4947849943d282013ee774461661aaf4',
  'canonical JSON-safe semantic fields must keep their established digest',
);

assert.equal(
  digestOf({ semanticFacts: [{ b: 'x', c: [1, 2], a: 1, d: { e: null } }] }),
  digestOf({ semanticFacts: [{ a: 1, d: { e: null }, b: 'x', c: [1, 2] }] }),
  'key order alone must not move a canonical digest',
);

assert.notEqual(
  digestOf({ semanticFacts: [{ a: 1 }] }),
  digestOf({ semanticFacts: [{ a: 2 }] }),
  'a JSON-safe fact change must move the digest',
);

const minimalCounterexample = digestOf({ semanticFacts: [{}] }) !== digestOf({ semanticFacts: [{ confidence: NaN }] });
assert.ok(minimalCounterexample, 'the issue-4654 minimal counterexample must not alias: [{confidence:NaN}] vs [{}]');

const lossyVariants = [
  { tag: 'nan', value: [{ confidence: NaN }] },
  { tag: 'undefined', value: [{ x: undefined }] },
  { tag: 'function', value: [{ x: () => 1 }] },
  { tag: 'symbol', value: [{ x: Symbol('x') }] },
  { tag: 'infinity', value: [{ x: Infinity }] },
  { tag: 'negative-infinity', value: [{ x: -Infinity }] },
  { tag: 'nested-nan', value: [{ x: { y: [{ z: NaN }] } }] },
  { tag: 'nested-undefined', value: [{ x: { y: [{ z: undefined }] } }] },
  { tag: 'neg-zero', value: [{ x: -0 }] },
  { tag: 'bigint', value: [{ x: 1n }] },
  { tag: 'function-element', value: [() => 1] },
  { tag: 'symbol-element', value: [Symbol('y')] },
];

for (const { tag, value } of lossyVariants) {
  assert.notEqual(
    digestOf({ semanticFacts: value }),
    digestOf({ semanticFacts: [{ x: 0 }] }),
    `lossy semanticFacts variant "${tag}" must not alias the plain zero fact`,
  );
  assert.notEqual(
    digestOf({ semanticFacts: value }),
    digestOf({ semanticFacts: [{}] }),
    `lossy semanticFacts variant "${tag}" must not alias the empty fact`,
  );
  assert.notEqual(
    digestOf({ semanticFacts: value }),
    digestOf({ semanticFacts: [{ x: '0' }] }),
    `lossy semanticFacts variant "${tag}" must not alias the string-zero fact`,
  );
}

const lossyDigests = lossyVariants.map(({ value }) => digestOf({ semanticFacts: value }));
for (let i = 0; i < lossyDigests.length; i++) {
  for (let j = i + 1; j < lossyDigests.length; j++) {
    assert.notEqual(lossyDigests[i], lossyDigests[j], `distinct lossy variants ${lossyVariants[i].tag}/${lossyVariants[j].tag} must keep distinct digests`);
  }
}

assert.ok(
  ['nan', 'undefined', 'function', 'symbol', 'neg-zero', 'bigint'].every((tag) => {
    const value = lossyVariants.find((variant) => variant.tag === tag).value;
    return digestOf({ semanticFacts: value }) === digestOf({ semanticFacts: structuredCloneSafe(value) });
  }),
  'equal lossy content must remain digest-stable across separate constructor calls',
);

assert.notEqual(
  digestOf({ escapes: [{}] }),
  digestOf({ escapes: [{ depth: NaN }] }),
  'lossy escapes entries must not alias the empty escape',
);
assert.notEqual(
  digestOf({ escapes: [{}] }),
  digestOf({ escapes: [{ depth: undefined }] }),
  'undefined-valued escape properties must not alias the empty escape',
);
assert.notEqual(
  digestOf({ escapes: [{ depth: 0 }] }),
  digestOf({ escapes: [{ depth: -0 }] }),
  'negative-zero escape depth must not alias the plain zero escape',
);
assert.notEqual(
  digestOf({ escapes: [{ depth: 2n }] }),
  digestOf({ escapes: [{ depth: '2' }] }),
  'bigint escape depth must not alias the numeric-string escape',
);

const cyclic = {};
cyclic.self = cyclic;
assert.ok(
  digestOf({ semanticFacts: [{ x: 1 }] }).length === 32,
  'digest shape remains a stable 128-bit hex identity',
);
assert.throws(
  () => digestOf({ semanticFacts: [cyclic] }),
  /identity-cyclic-value/,
  'cyclic semanticFacts must keep the fail-closed digest behavior',
);

function structuredCloneSafe(value) {
  return value.map((entry) => cloneEntry(entry));
  function cloneEntry(entry) {
    const out = {};
    for (const key of Object.keys(entry)) out[key] = cloneValue(entry[key]);
    return out;
  }
  function cloneValue(item) {
    if (Array.isArray(item)) return item.map((child) => cloneValue(child));
    if (item && typeof item === 'object') return cloneEntry(item);
    return item;
  }
}

console.log('issue-4654 semanticFacts/escapes digest injectivity: ok');
