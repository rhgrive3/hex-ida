import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveMemoryRegion, isPreciseMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';

const baseInput = {
  functionId: 'f',
  origin: { instructionIds: ['i0'] },
  regionEvidence: { kind: 'stack-fixed', offset: 0 },
};

function derive(widthBits) {
  return deriveMemoryRegion({ ...baseInput, widthBits });
}

test('structured widthBits cannot mint precise region authority (#3488)', () => {
  for (const widthBits of [['64'], '64', true, { value: 64 }, 64n]) {
    const region = derive(widthBits);
    assert.equal(region.kind, 'unknown', `malformed width ${String(widthBits)} must fail closed`);
    assert.equal(isPreciseMemoryRegion(region), false);
    assert.equal('widthBits' in region, false, 'malformed width must not survive into unknown-region identity');
  }
});

test('width validation does not invoke user-controlled coercion (#3488)', () => {
  let coerced = 0;
  const widthBits = {
    valueOf() { coerced++; return 64; },
    toString() { coerced++; return '64'; },
  };
  const region = derive(widthBits);
  assert.equal(region.kind, 'unknown');
  assert.equal(coerced, 0);
});

test('primitive positive safe-integer width keeps precise region behavior (#3488)', () => {
  const region = derive(64);
  assert.equal(region.kind, 'stack-fixed');
  assert.equal(region.widthBits, 64);
  assert.equal(isPreciseMemoryRegion(region), true);
});

test('memory.widthBits uses the same strict boundary and keeps precedence (#3488)', () => {
  const malformed = deriveMemoryRegion({ ...baseInput, widthBits: 32, memory: { widthBits: ['64'] } });
  assert.equal(malformed.kind, 'unknown');

  const valid = deriveMemoryRegion({ ...baseInput, widthBits: ['32'], memory: { widthBits: 64 } });
  assert.equal(valid.kind, 'stack-fixed');
  assert.equal(valid.widthBits, 64);
});
