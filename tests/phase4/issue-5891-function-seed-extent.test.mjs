import assert from 'node:assert/strict';
import test from 'node:test';

import { BinaryImage, functionSeed, mergeFunctionSeeds } from '../../js/binary/model.js';

test('#5891 valid exact integer extents canonicalize at the merge boundary', () => {
  const merged = mergeFunctionSeeds([
    { address: '0x1000', source: 'heuristic', confidence: 0.6, size: 256 },
    { address: 0x2000n, source: 'symbol', confidence: 0.9, end: '0x2080' },
  ]);
  assert.equal(merged[0].size, 256n);
  assert.equal(merged[0].end, 0x1100n);
  assert.equal(merged[1].size, 0x80n);
  assert.equal(merged[1].end, 0x2080n);
});

test('#5891 duplicate-address seeds inherit a canonical extent without type mixing', () => {
  const merged = mergeFunctionSeeds([
    { address: 0x3000n, source: 'heuristic', confidence: 0.5, size: 4 },
    { address: '0x3000', source: 'symbol', confidence: 0.9 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].size, 4n);
  assert.equal(merged[0].end, 0x3004n);
  assert.equal(merged[0].extentInherited, true);
});

test('#5891 invalid extent carriers fail closed instead of reaching BigInt arithmetic', () => {
  const invalid = [
    true, false, [], [4], {}, { value: 4 }, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, 1.5, '4.5', 'not-an-integer',
  ];
  for (const value of invalid) {
    const bySize = mergeFunctionSeeds([{ address: 0x4000n, source: 'symbol', size: value }]);
    const byEnd = mergeFunctionSeeds([{ address: 0x4000n, source: 'symbol', end: value }]);
    assert.equal(bySize.length, 0, `invalid size ${String(value)} must be dropped`);
    assert.equal(byEnd.length, 0, `invalid end ${String(value)} must be dropped`);
  }
  assert.equal(mergeFunctionSeeds([{ address: ['0x4000'], size: 4 }]).length, 0);
});

test('#5891 a dropped invalid duplicate cannot suppress a valid extent', () => {
  const merged = mergeFunctionSeeds([
    { address: 0x5000n, source: 'symbol', confidence: 1, size: true },
    { address: 0x5000n, source: 'heuristic', confidence: 0.5, size: 8 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].size, 8n);
  assert.equal(merged[0].end, 0x5008n);
});

test('#5891 inferred next-function-start extents remain intact', () => {
  const merged = mergeFunctionSeeds([
    { address: 0x6000n, source: 'function_starts', confidence: 0.9 },
    { address: '0x6004', source: 'function_starts', confidence: 0.9 },
  ]);
  assert.equal(merged[0].size, 4n);
  assert.equal(merged[0].end, 0x6004n);
  assert.equal(merged[0].extentInferred, true);
});

test('#5891 BinaryImage.finalize canonicalizes producer extents end-to-end', () => {
  const image = new BinaryImage(new Uint8Array(0), { format: 'test' });
  image.functions.push(
    { address: 0x7000n, source: 'symbol', confidence: 0.9, size: 16 },
    { address: '0x7000', source: 'heuristic', confidence: 0.4 },
  );
  assert.doesNotThrow(() => image.finalize());
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].size, 16n);
  assert.equal(image.functions[0].end, 0x7010n);
});

test('#5891 functionSeed rejects non-exact-integer extent inputs with a typed error', () => {
  assert.equal(functionSeed('0x8000', { size: 4 }).size, 4n);
  assert.equal(functionSeed(0x8000n, { end: '0x8010' }).end, 0x8010n);
  assert.throws(
    () => functionSeed(0x8000n, { size: true }),
    (error) => error instanceof TypeError && error.message === 'function-seed-size-must-be-exact-integer',
  );
  assert.throws(
    () => functionSeed({ value: 0x8000 }, { size: 4 }),
    (error) => error instanceof TypeError && error.message === 'function-seed-address-must-be-exact-integer',
  );
});
