import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../js/viewer/variable-instruction-index.js';

test('issue 6224: rejects structured address coercion and fails closed', async () => {
  const badAddresses = [
    ['0'],
    [0n],
    { valueOf() { return 0n; } },
    true,
    false,
    null,
  ];

  for (const badAddr of badAddresses) {
    const index = new VariableInstructionIndex({
      disassembleAt: async () => ({
        supported: true,
        instructions: [{
          address: badAddr,
          length: 1,
          rawBytes: Uint8Array.of(0x90),
          mnemonic: 'nop',
          opStr: '',
        }],
      }),
      pageBytes: 32,
      overlapBytes: 0,
    });
    index.configureRegion({ id: 'text', vmAddr: 0n, size: 64n });

    await assert.rejects(
      () => index.ensurePage(0n),
      /variable-viewer-invalid-instruction-address/
    );
    assert.equal(index.knownEntry(0n), null, 'malformed address must not be published into known cache');
  }
});

test('issue 6224: rejects structured and numeric-string length coercion', async () => {
  const badLengths = [
    ['1'],
    '1',
    { valueOf() { return 1; } },
    true,
    1.5,
  ];

  for (const badLen of badLengths) {
    const index = new VariableInstructionIndex({
      disassembleAt: async () => ({
        supported: true,
        instructions: [{
          address: 0n,
          length: badLen,
          rawBytes: Uint8Array.of(0x90),
          mnemonic: 'nop',
          opStr: '',
        }],
      }),
      pageBytes: 32,
      overlapBytes: 0,
    });
    index.configureRegion({ id: 'text', vmAddr: 0n, size: 64n });

    await assert.rejects(
      () => index.ensurePage(0n),
      /variable-viewer-invalid-instruction-length/
    );
    assert.equal(index.knownEntry(0n), null);
  }
});

test('issue 6224: rejects nested Array, boolean, and string byte elements', async () => {
  const badByteArrays = [
    [['144']],
    ['144'],
    [true],
    [{ valueOf() { return 144; } }],
    [256],
    [-1],
    'not-an-array',
  ];

  for (const badRaw of badByteArrays) {
    const index = new VariableInstructionIndex({
      disassembleAt: async () => ({
        supported: true,
        instructions: [{
          address: 0n,
          length: 1,
          rawBytes: badRaw,
          mnemonic: 'nop',
          opStr: '',
        }],
      }),
      pageBytes: 32,
      overlapBytes: 0,
    });
    index.configureRegion({ id: 'text', vmAddr: 0n, size: 64n });

    await assert.rejects(
      () => index.ensurePage(0n),
      /variable-viewer-invalid-instruction-bytes/
    );
    assert.equal(index.knownEntry(0n), null);
  }
});

test('issue 6224: rejects structured mnemonic and operand strings', async () => {
  const badStrings = [
    ['nop'],
    { toString() { return 'nop'; } },
    123,
    true,
  ];

  for (const badMn of badStrings) {
    const index = new VariableInstructionIndex({
      disassembleAt: async () => ({
        supported: true,
        instructions: [{
          address: 0n,
          length: 1,
          rawBytes: Uint8Array.of(0x90),
          mnemonic: badMn,
          opStr: '',
        }],
      }),
      pageBytes: 32,
      overlapBytes: 0,
    });
    index.configureRegion({ id: 'text', vmAddr: 0n, size: 64n });

    await assert.rejects(
      () => index.ensurePage(0n),
      /variable-viewer-invalid-instruction-mnemonic/
    );
    assert.equal(index.knownEntry(0n), null);
  }

  for (const badOp of badStrings) {
    const index = new VariableInstructionIndex({
      disassembleAt: async () => ({
        supported: true,
        instructions: [{
          address: 0n,
          length: 1,
          rawBytes: Uint8Array.of(0x90),
          mnemonic: 'nop',
          opStr: badOp,
        }],
      }),
      pageBytes: 32,
      overlapBytes: 0,
    });
    index.configureRegion({ id: 'text', vmAddr: 0n, size: 64n });

    await assert.rejects(
      () => index.ensurePage(0n),
      /variable-viewer-invalid-instruction-operands/
    );
    assert.equal(index.knownEntry(0n), null);
  }
});

test('issue 6224: canonical instructions decode and cache normally', async () => {
  const index = new VariableInstructionIndex({
    disassembleAt: async () => ({
      supported: true,
      instructions: [{
        address: 0n,
        length: 1,
        rawBytes: Uint8Array.of(0x90),
        mnemonic: 'nop',
        opStr: '',
      }],
    }),
    pageBytes: 32,
    overlapBytes: 0,
  });
  index.configureRegion({ id: 'text', vmAddr: 0n, size: 64n });

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
