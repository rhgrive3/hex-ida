import assert from 'node:assert/strict';
import test from 'node:test';
import { VariableInstructionIndex } from '../../../js/viewer/variable-instruction-index.js';

const decodeNothing = async () => ({ supported: true, instructions: [] });
const validValues = {
  pageBytes: 64,
  overlapBytes: 1,
  maxPages: 2,
  maxInstructions: 32,
  maxPrefetchPages: 1,
  resyncBytes: 64,
};
const errorCodes = {
  pageBytes: 'variable-viewer-invalid-page-bytes',
  overlapBytes: 'variable-viewer-invalid-overlap',
  maxPages: 'variable-viewer-invalid-cache-pages',
  maxInstructions: 'variable-viewer-invalid-instruction-limit',
  maxPrefetchPages: 'variable-viewer-invalid-prefetch-pages',
  resyncBytes: 'variable-viewer-invalid-resync-bytes',
};

test('issue #4416 rejects structured constructor scalars before coercion', () => {
  for (const [field, value] of Object.entries(validValues)) {
    const malformed = [
      [value],
      { valueOf: () => value },
      new Number(value),
      true,
    ];
    for (const input of malformed) {
      assert.throws(
        () => new VariableInstructionIndex({ disassembleAt: decodeNothing, [field]: input }),
        new RegExp(errorCodes[field]),
        `${field} must reject ${Object.prototype.toString.call(input)}`,
      );
    }
  }
});

test('issue #4416 preserves canonical scalar compatibility at each boundary', () => {
  const index = new VariableInstructionIndex({ disassembleAt: decodeNothing, ...validValues });
  assert.equal(index.pageBytes, 64);
  assert.equal(index.overlapBytes, 1);
  assert.equal(index.maxPages, 2);
  assert.equal(index.maxInstructions, 32);
  assert.equal(index.maxPrefetchPages, 1);
  assert.equal(index.resyncBytes, 64);

  index.configureRegion({ id: 'canonical', vmAddr: '0x1000', size: '256' });
  assert.equal(index.region.start, 0x1000n);
  assert.equal(index.region.size, 256n);

  const bigintIndex = new VariableInstructionIndex({ disassembleAt: decodeNothing, pageBytes: 64, overlapBytes: 1 });
  bigintIndex.configureRegion({ id: 'primitive', vmAddr: 0x2000n, size: 0x100n });
  assert.equal(bigintIndex.region.start, 0x2000n);
  assert.equal(bigintIndex.region.size, 0x100n);
});

test('issue #4416 rejects structured region scalars and decoder instruction scalars', async () => {
  const index = new VariableInstructionIndex({ disassembleAt: decodeNothing, pageBytes: 64, maxPrefetchPages: 0 });
  for (const [field, value, code] of [
    ['vmAddr', 0x1000, 'variable-viewer-region-start-required'],
    ['size', 0x100, 'variable-viewer-region-size-required'],
  ]) {
    for (const malformed of [[value], { valueOf: () => BigInt(value) }, true]) {
      const region = { id: 'malformed', vmAddr: 0x1000n, size: 0x100n, [field]: malformed };
      assert.throws(() => index.configureRegion(region), new RegExp(code));
    }
  }

  const badInstructions = [
    { address: [0], length: 1, rawBytes: Uint8Array.of(0x90) },
    { address: 0n, length: [1], rawBytes: Uint8Array.of(0x90) },
    { address: 0n, length: { valueOf: () => 1 }, rawBytes: Uint8Array.of(0x90) },
    { address: 0n, length: true, rawBytes: Uint8Array.of(0x90) },
  ];
  for (const instruction of badInstructions) {
    const decoderIndex = new VariableInstructionIndex({
      disassembleAt: async () => ({ supported: true, instructions: [instruction] }),
      pageBytes: 32,
      overlapBytes: 0,
      maxPrefetchPages: 0,
    });
    decoderIndex.configureRegion({ id: 'decoder', vmAddr: 0n, size: 64n });
    await assert.rejects(() => decoderIndex.ensurePage(0n), /variable-viewer-invalid-(instruction-address|instruction-length)/);
    assert.equal(decoderIndex.knownEntry(0n), null);
  }
});
