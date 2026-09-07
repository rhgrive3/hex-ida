// Regression for #5758: mergeProgramScans same-vmAddr regionId tie-break must
// be locale-invariant (UTF-16 code-unit order). The tie-break decides which
// region's evidence survives the global caps, so collation-dependent order
// made the retained evidence environment-dependent.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeProgramScans } from '../js/program.js';

function scan(regionId, callFrom) {
  return {
    regionId,
    vmAddr: 0n,
    callFrom: new BigUint64Array([callFrom]),
    callTo: new BigUint64Array([0x1111n]),
    callCount: 1,
    refFrom: new BigUint64Array(0),
    refKind: new Uint8Array(0),
  };
}

test('#5758 tie-break keeps the code-unit-first region under the global cap', () => {
  const merged = mergeProgramScans([scan('ä', 0x10n), scan('z', 0x20n)], { limits: { calls: 1, refs: 0, kindWords: 0 } });
  assert.equal(merged.callFrom.length, 1);
  // Canonical code-unit order: 'z' (U+007A) < 'ä' (U+00E4). Collation-based
  // ordering (de/ja/en ICU rules) would keep the ä edge instead.
  assert.equal(merged.callFrom[0], 0x20n, 'the z-region edge must be retained under the cap');
});

test('#5758 tie-break is independent of the resolved default locale', () => {
  const expected = mergeProgramScans([scan('ä', 0x10n), scan('z', 0x20n)], { limits: { calls: 1, refs: 0, kindWords: 0 } }).callFrom[0];
  // Whatever the current host locale is, a different ICU collation (sv places
  // ä after z; most others before) must not change the retained evidence.
  const collationDisagrees = 'ä'.localeCompare('z') !== ('ä' < 'z' ? -1 : 1);
  if (collationDisagrees) {
    // The host locale disagrees with code-unit order; the merge must not.
    assert.equal(expected, 0x20n);
  }
  // And within this environment, repeated merges are deterministic.
  for (let i = 0; i < 3; i++) {
    const again = mergeProgramScans([scan('ä', 0x10n), scan('z', 0x20n)], { limits: { calls: 1, refs: 0, kindWords: 0 } });
    assert.equal(again.callFrom[0], expected);
  }
});

test('#5758 code-unit order is stable for ASCII and mixed-case region ids', () => {
  const merged = mergeProgramScans([scan('B', 0x1n), scan('a', 0x2n), scan('A', 0x3n)], { limits: { calls: 2, refs: 0, kindWords: 0 } });
  assert.equal(merged.callFrom.length, 2);
  assert.equal(merged.callFrom[0], 0x3n, "'A' < 'B' < 'a' in code-unit order");
  assert.equal(merged.callFrom[1], 0x1n);
});
