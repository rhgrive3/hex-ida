// Regression for #5758: mergeProgramScans same-vmAddr regionId tie-break must
// be locale-invariant (UTF-16 code-unit order). The tie-break decides which
// region's evidence survives the global caps, so collation-dependent order
// made the retained evidence environment-dependent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mergeProgramScans } from '../../js/program.js';

function scan(regionId, callFrom, { vmAddr = 0n, callTo = 0x1111n, refFrom = [], refTo = [], refKind = [] } = {}) {
  return {
    regionId,
    vmAddr,
    callFrom: new BigUint64Array([callFrom]),
    callTo: new BigUint64Array([callTo]),
    callCount: 1,
    refFrom: new BigUint64Array(refFrom),
    refTo: new BigUint64Array(refTo),
    refKind: new Uint8Array(refKind),
    refCount: refFrom.length,
  };
}

function snapshot(result) {
  const values = (array) => Array.from(array, (value) => typeof value === 'bigint' ? value.toString() : value);
  return JSON.stringify({
    callFrom: values(result.callFrom), callTo: values(result.callTo),
    refFrom: values(result.refFrom), refTo: values(result.refTo), refKind: values(result.refKind),
    kindRegions: result.kindRegions.map((region) => ({
      regionId: region.regionId, vmAddr: region.vmAddr.toString(), words: region.words,
      kinds: values(region.kinds), kindsCovered: region.kindsCovered,
    })),
    callsCapped: result.callsCapped, refsCapped: result.refsCapped,
    complete: result.complete, truncated: result.truncated,
  });
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

test('#5758 refs cap keeps the same code-unit-first region', () => {
  const merged = mergeProgramScans([
    scan('ä', 0x10n, { refFrom: [0x30n], refTo: [0x3111n], refKind: [1] }),
    scan('z', 0x20n, { refFrom: [0x40n], refTo: [0x4222n], refKind: [2] }),
  ], { limits: { calls: 0, refs: 1, kindWords: 0 } });
  assert.equal(merged.refCount, 1);
  assert.equal(merged.refFrom[0], 0x40n, 'the z-region reference must be retained under the cap');
  assert.equal(merged.refTo[0], 0x4222n);
  assert.equal(merged.refKind[0], 2);
  assert.equal(merged.refsCapped, true);
});

test('#5758 locale changes keep every merged typed array byte-identical', () => {
  const scans = [
    scan('ä', 0x10n, { refFrom: [0x30n], refTo: [0x3111n], refKind: [1] }),
    scan('z', 0x20n, { refFrom: [0x40n], refTo: [0x4222n], refKind: [2] }),
    scan('A', 0x30n, { vmAddr: 1n, refFrom: [0x50n], refTo: [0x5333n], refKind: [3] }),
  ];
  const options = { limits: { calls: 2, refs: 2, kindWords: 0 } };
  const expected = snapshot(mergeProgramScans(scans, options));
  const programUrl = new URL('../../js/program.js', import.meta.url).href;
  const childScript = `
import { mergeProgramScans } from ${JSON.stringify(programUrl)};
const scan = (regionId, callFrom, { vmAddr = 0n, callTo = 0x1111n, refFrom = [], refTo = [], refKind = [] } = {}) => ({
  regionId, vmAddr, callFrom: new BigUint64Array([callFrom]), callTo: new BigUint64Array([callTo]), callCount: 1,
  refFrom: new BigUint64Array(refFrom), refTo: new BigUint64Array(refTo), refKind: new Uint8Array(refKind), refCount: refFrom.length,
});
const result = mergeProgramScans([
  scan('ä', 0x10n, { refFrom: [0x30n], refTo: [0x3111n], refKind: [1] }),
  scan('z', 0x20n, { refFrom: [0x40n], refTo: [0x4222n], refKind: [2] }),
  scan('A', 0x30n, { vmAddr: 1n, refFrom: [0x50n], refTo: [0x5333n], refKind: [3] }),
], { limits: { calls: 2, refs: 2, kindWords: 0 } });
const values = (array) => Array.from(array, (value) => typeof value === 'bigint' ? value.toString() : value);
console.log(JSON.stringify({
  callFrom: values(result.callFrom), callTo: values(result.callTo), refFrom: values(result.refFrom),
  refTo: values(result.refTo), refKind: values(result.refKind),
  kindRegions: result.kindRegions.map((region) => ({ regionId: region.regionId, vmAddr: region.vmAddr.toString(), words: region.words, kinds: values(region.kinds), kindsCovered: region.kindsCovered })),
  callsCapped: result.callsCapped, refsCapped: result.refsCapped, complete: result.complete, truncated: result.truncated,
}));
`;
  for (const locale of ['en_US.UTF-8', 'sv_SE.UTF-8', 'de_DE.UTF-8']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, LANG: locale, LANGUAGE: locale, LC_ALL: locale },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr || `locale child failed for ${locale}`);
    assert.equal(child.stdout.trim(), expected, `merged arrays changed under ${locale}`);
  }
});

test('#5758 no-cap merge preserves all edges and vmAddr remains the primary key', () => {
  const merged = mergeProgramScans([
    scan('z', 0x20n, { vmAddr: 0x200n, callTo: 0x2222n }),
    scan('ä', 0x10n, { vmAddr: 0x100n, callTo: 0x1111n }),
  ], { limits: { calls: 2, refs: 0, kindWords: 0 } });
  assert.equal(merged.callCount, 2);
  assert.deepEqual([...merged.callFrom], [0x10n, 0x20n]);
  assert.deepEqual([...merged.callTo], [0x1111n, 0x2222n]);
  assert.equal(merged.callsCapped, false);
});
