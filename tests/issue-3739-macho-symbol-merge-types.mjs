import assert from 'node:assert/strict';
import { mergeMachOAnalysisResults } from '../js/macho-analysis-merge.js';

const legacy = {
  addrs:new BigUint64Array([0x1000n]), kinds:new Uint8Array([1]), flags:new Uint8Array([0]),
  names:['legacy_name'], funcs:new BigUint64Array(0),
};
const truth = { source:'BinaryImage', normalized:true, complete:true, reasons:[] };

for (const normalized of [
  { addrs:[['4096']], kinds:[2], flags:[1], names:['forged'], symbolTruth:truth },
  { addrs:[4096n], kinds:[['2']], flags:[1], names:['forged'], symbolTruth:truth },
  { addrs:[4096n], kinds:[2], flags:[['1']], names:['forged'], symbolTruth:truth },
  { addrs:[4096n], kinds:[2], flags:[1], names:[['forged']], symbolTruth:truth },
]) {
  const merged = mergeMachOAnalysisResults(legacy, normalized);
  assert.deepEqual(merged.names, ['legacy_name']);
  assert.equal(merged.kinds[0], 1);
  assert.equal(merged.symbolTruth.complete, false);
  assert.ok(merged.symbolTruth.reasons.includes('normalized-macho-symbol-record-invalid'));
}

{
  const normalized = {
    addrs:new BigUint64Array([0x1000n]), kinds:new Uint8Array([2]), flags:new Uint8Array([1]),
    names:['canonical'], nameProvenance:[{source:'test',confidence:1,confirmed:true}], symbolTruth:truth,
  };
  const merged = mergeMachOAnalysisResults(legacy, normalized);
  assert.deepEqual(merged.names, ['canonical']);
  assert.equal(merged.kinds[0], 2);
  assert.equal(merged.flags[0], 1);
  assert.equal(merged.symbolTruth.complete, true);
}

for (const address of [4096n, 4096, '4096', '0x1000']) {
  const normalized = { addrs:[address], kinds:[2], flags:[0], names:['ok'], symbolTruth:truth };
  assert.equal(mergeMachOAnalysisResults(legacy, normalized).names[0], 'ok');
}
for (const address of [-1n, 2n ** 64n, 1.5, '01', ' 4096 ']) {
  const normalized = { addrs:[address], kinds:[2], flags:[0], names:['bad'], symbolTruth:truth };
  const merged = mergeMachOAnalysisResults(legacy, normalized);
  assert.deepEqual(merged.names, ['legacy_name']);
  assert.equal(merged.symbolTruth.complete, false);
}

console.log('issue-3739 Mach-O symbol merge type boundary: PASS');
