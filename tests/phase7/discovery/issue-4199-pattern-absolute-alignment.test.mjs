import assert from 'node:assert/strict';
import test from 'node:test';

import { createPatternProducer } from '../../../js/analysis/discovery/producers.js';

function producer(alignment = 4) {
  return createPatternProducer({
    id: 'issue-4199-pattern',
    architectureId: 'arm64',
    alignment,
    patterns: [{ id: 'prologue', bytes: [0xaa, 0xbb] }],
  });
}

function starts(base, code, alignment = 4) {
  return producer(alignment)
    .produce({ image: { codeBaseAddress: base, code: Uint8Array.from(code) } })
    .map((item) => item.start);
}

test('pattern alignment is evaluated in absolute address space', () => {
  assert.deepEqual(
    starts(0x1000n, [0xaa,0xbb,0,0, 0xaa,0xbb,0,0, 0xaa,0xbb]),
    ['4096', '4100', '4104'],
  );

  assert.deepEqual(
    starts(0x1002n, [0,0, 0xaa,0xbb,0,0, 0xaa,0xbb,0,0, 0xaa,0xbb]),
    ['4100', '4104', '4108'],
  );

  assert.deepEqual(
    starts(0x1002n, [0xaa,0xbb, 0,0,0,0]),
    [],
    'a buffer-relative aligned offset must not mint a misaligned virtual address candidate',
  );
});

test('pattern alignment is invariant under chunking at the same absolute address', () => {
  const whole = starts(
    0x1000n,
    [0,0,0,0, 0xaa,0xbb,0,0, 0xaa,0xbb,0,0],
  );
  const chunk = starts(
    0x1002n,
    [0,0, 0xaa,0xbb,0,0, 0xaa,0xbb,0,0],
  );

  assert.deepEqual(whole, ['4100', '4104']);
  assert.deepEqual(chunk, whole);
});

test('alignment=1 preserves byte-by-byte scanning', () => {
  assert.deepEqual(
    starts(0x1002n, [0xaa,0xbb, 0xaa,0xbb], 1),
    ['4098', '4100'],
  );
});

console.log('issue #4199 pattern absolute alignment: PASS');
