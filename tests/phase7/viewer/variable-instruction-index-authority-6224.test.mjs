import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../../../js/viewer/variable-instruction-index.js';

function createIndex(instruction) {
  const index = new VariableInstructionIndex({
    disassembleAt: async () => ({ supported: true, instructions: [instruction] }),
    pageBytes: 32,
    overlapBytes: 0,
  });
  index.configureRegion({ id: 'text', vmAddr: 0n, size: 64n });
  return index;
}

async function rejectsWithoutPublishing(instruction, expected) {
  const index = createIndex(instruction);
  await assert.rejects(() => index.ensurePage(0n), expected);
  assert.equal(index.knownEntry(0n), null, 'malformed output must not be published');
}

test('issue 6224: rejects structured instruction-address authority', async () => {
  const badAddresses = [
    ['0'],
    [0n],
    { valueOf() { return 0n; } },
    true,
    false,
    null,
  ];

  for (const address of badAddresses) {
    await rejectsWithoutPublishing({
      address,
      length: 1,
      rawBytes: Uint8Array.of(0x90),
      mnemonic: 'nop',
      opStr: '',
    }, /variable-viewer-invalid-instruction-address/);
  }
});

test('issue 6224: rejects coerced instruction lengths', async () => {
  const badLengths = [['1'], '1', { valueOf() { return 1; } }, true, 1.5];

  for (const length of badLengths) {
    await rejectsWithoutPublishing({
      address: 0n,
      length,
      rawBytes: Uint8Array.of(0x90),
      mnemonic: 'nop',
      opStr: '',
    }, /variable-viewer-invalid-instruction-length/);
  }
});

test('issue 6224: rejects non-canonical raw bytes', async () => {
  const sparse = new Array(1);
  const badBytes = [
    [['144']],
    ['144'],
    [true],
    [{ valueOf() { return 144; } }],
    [256],
    [-1],
    [1.5],
    sparse,
    new Uint16Array([0x90]),
    'not-an-array',
  ];

  for (const rawBytes of badBytes) {
    await rejectsWithoutPublishing({
      address: 0n,
      length: 1,
      rawBytes,
      mnemonic: 'nop',
      opStr: '',
    }, /variable-viewer-invalid-instruction-bytes/);
  }
});

test('issue 6224: rejects structured mnemonic and operand strings', async () => {
  const badStrings = [['nop'], { toString() { return 'nop'; } }, 123, true];

  for (const mnemonic of badStrings) {
    await rejectsWithoutPublishing({
      address: 0n,
      length: 1,
      rawBytes: Uint8Array.of(0x90),
      mnemonic,
      opStr: '',
    }, /variable-viewer-invalid-instruction-mnemonic/);
  }

  for (const opStr of badStrings) {
    await rejectsWithoutPublishing({
      address: 0n,
      length: 1,
      rawBytes: Uint8Array.of(0x90),
      mnemonic: 'nop',
      opStr,
    }, /variable-viewer-invalid-instruction-operands/);
  }
});

test('issue 6224: canonical decoder output remains cacheable', async () => {
  const index = createIndex({
    address: 0n,
    length: 1,
    rawBytes: Uint8Array.of(0x90),
    mnemonic: 'nop',
    opStr: '',
  });

  const page = await index.ensurePage(0n);
  assert.equal(page.status, 'ok');
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].address, 0n);
  assert.equal(page.entries[0].length, 1);
  assert.deepEqual(page.entries[0].bytes, Uint8Array.of(0x90));
  assert.equal(page.entries[0].mnemonic, 'nop');
  assert.equal(page.entries[0].opStr, '');
  assert.ok(index.knownEntry(0n));
});
