import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerAt, resolveModelTexts, resolvePointerBytes } from '../js/analyze.js';

test('#4973: pointerAt decodes 4-byte pointer for arm64_32', () => {
  // 78 56 34 12 -> 0x12345678n
  const bytes = new Uint8Array([0x78, 0x56, 0x34, 0x12]);
  const ptr = pointerAt(bytes, { architecture: 'arm64_32' });
  assert.equal(ptr, 0x12345678n);
});

test('#4973: pointerAt ignores bytes[4..7] on arm64_32', () => {
  const bytesWithGarbage = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0xff]);
  const ptr = pointerAt(bytesWithGarbage, { architecture: 'arm64_32' });
  assert.equal(ptr, 0x12345678n, 'arm64_32 must ignore bytes past 4 bytes');
});

test('#4973: pointerAt does not incorporate adjacent table entry on arm64_32', () => {
  // First entry: 0x12345678, Second entry: 0xdeadbeef
  const table = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xef, 0xbe, 0xad, 0xde]);
  const ptr = pointerAt(table, { architecture: 'arm64_32' });
  assert.equal(ptr, 0x12345678n);
  assert.notEqual(ptr, 0xdeadbeef12345678n);
});

test('#4973: pointerAt preserves 64-bit decode on arm64/arm64e', () => {
  const bytes64 = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xef, 0xbe, 0x00, 0x00]);
  const ptr64 = pointerAt(bytes64, { architecture: 'arm64' });
  assert.equal(ptr64, 0xbeef12345678n);
});

test('#4973: pointerAt returns null for 32-bit null pointer', () => {
  const null32 = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78]);
  assert.equal(pointerAt(null32, { architecture: 'arm64_32' }), null);
});

test('#4973: pointerAt fails closed when target pointer width is unknown or unsupported', () => {
  const bytes = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xef, 0xbe, 0xad, 0x00]);
  assert.equal(pointerAt(bytes, { architecture: 'unknown' }), null);
  assert.equal(pointerAt(bytes, { architecture: 'custom-arch' }), null);
  assert.equal(pointerAt(bytes, { pointerBytes: 2 }), null);
  assert.equal(pointerAt(bytes, { pointerBits: 16 }), null);
});

test('#4973: resolvePointerBytes and pointerAt fail closed on structured/coercible architecture objects', () => {
  const bytes = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xef, 0xbe, 0xad, 0x00]);

  // Structured array containing architecture name
  assert.equal(resolvePointerBytes({ architecture: ['arm64_32'] }), null);
  assert.equal(resolvePointerBytes({ architecture: ['arm64'] }), null);
  assert.equal(pointerAt(bytes, { architecture: ['arm64_32'] }), null);

  // Objects with toString / valueOf coercible to architecture name
  const coercible32 = { toString: () => 'arm64_32' };
  assert.equal(resolvePointerBytes({ architecture: coercible32 }), null);
  assert.equal(pointerAt(bytes, { architecture: coercible32 }), null);

  const coerciblePAC = new Uint8Array([0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x00, 0x7f]);
  const coercibleArm64e = { toString: () => 'arm64e' };
  assert.equal(resolvePointerBytes({ architecture: coercibleArm64e }), null);
  assert.equal(pointerAt(coerciblePAC, { architecture: coercibleArm64e }), null, 'coercible architecture must not enable PAC/TBI stripping');

  // arch and cpu aliases with non-string values
  assert.equal(resolvePointerBytes({ arch: ['arm64'] }), null);
  assert.equal(resolvePointerBytes({ cpu: { toString: () => 'arm64_32' } }), null);
  assert.equal(pointerAt(bytes, { arch: ['arm64_32'] }), null);
  assert.equal(pointerAt(bytes, { cpu: { toString: () => 'arm64_32' } }), null);

  // Numbers and booleans as architecture
  assert.equal(resolvePointerBytes({ architecture: 64 }), null);
  assert.equal(resolvePointerBytes({ architecture: true }), null);
});

test('#4973: resolveModelTexts dereferences 4-byte pointer on arm64_32', async () => {
  const model = {
    addressRefs: [{ row: 0, addr: 0x4000n }],
    semantic: [],
    calls: [],
    facts: { stringRefs: [] },
  };

  const readAddrs = [];
  const backend = {
    readAt: async (addr) => {
      readAddrs.push(addr);
      if (addr === 0x4000n) {
        // Backend returns 8 bytes containing 4-byte pointer and adjacent field
        return {
          found: true,
          terminated: false,
          text: null,
          bytes: new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xef, 0xbe, 0xad, 0xde]),
        };
      }
      if (addr === 0x12345678n) {
        return {
          found: true,
          terminated: true,
          text: 'arm64_32 string target',
          bytes: new TextEncoder().encode('arm64_32 string target\0'),
        };
      }
      return { found: false };
    },
  };

  const resolved = await resolveModelTexts(backend, model, 96, { architecture: 'arm64_32' });
  assert.deepEqual(readAddrs, [0x4000n, 0x12345678n]);
  assert.equal(resolved.addressRefs[0].text, 'arm64_32 string target');
});
