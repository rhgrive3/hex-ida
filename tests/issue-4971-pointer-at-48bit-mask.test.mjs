import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerAt, resolveModelTexts } from '../js/analyze.js';

test('#4971: pointerAt preserves bits 36..47 for arm64/arm64e pointers with PAC/tags', () => {
  // VA with bit 36..47 set: 0x123456789abcn
  // Bit 36..47 is 0x123
  // Top 16 bits set for PAC: 0x7f00000000000000n
  // Combined raw: 0x7f00123456789abcn
  const rawBytes = new Uint8Array([0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x00, 0x7f]);
  const ptr = pointerAt(rawBytes, { architecture: 'arm64e' });
  assert.equal(ptr, 0x123456789abcn, 'PAC-tagged pointer must retain bits 36..47');
});

test('#4971: pointerAt preserves canonical < 2^48 pointers as-is', () => {
  const canonicalBytes = new Uint8Array([0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x00, 0x00]);
  const ptr = pointerAt(canonicalBytes, { architecture: 'arm64' });
  assert.equal(ptr, 0x123456789abcn, 'canonical pointer below 2^48 must match exactly');

  const pageBytes = new Uint8Array([0x00, 0x40, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(pointerAt(pageBytes, { architecture: 'arm64' }), 0x10004000n);
});

test('#4971: pointerAt returns null for all-zero null pointers', () => {
  const zeros = new Uint8Array(8);
  assert.equal(pointerAt(zeros, { architecture: 'arm64' }), null);
  assert.equal(pointerAt(zeros, { architecture: 'arm64e' }), null);
});

test('#4971: pointerAt fails closed on non-canonical high-bit patterns for architectures without PAC/TBI', () => {
  const rawBytes = new Uint8Array([0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x00, 0x7f]);
  // Non-ARM64 / architectures without PAC/TBI support cannot canonicalize arbitrary high bits
  assert.equal(pointerAt(rawBytes, { architecture: 'x86_64' }), null);

  // All-zero address portion with non-zero tag must return null
  const nullWithTag = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xaa]);
  assert.equal(pointerAt(nullWithTag, { architecture: 'arm64' }), null);
});

test('#4971: pointerAt handles arm64 TBI tagged pointer', () => {
  // TBI tag in top byte: 0xaa00000010004000n
  const taggedBytes = new Uint8Array([0x00, 0x40, 0x00, 0x10, 0x00, 0x00, 0x00, 0xaa]);
  const ptr = pointerAt(taggedBytes, { architecture: 'arm64' });
  assert.equal(ptr, 0x10004000n, 'TBI tag must be stripped to reveal canonical VA');
});

test('#4971: resolveModelTexts dereferences PAC pointer to correct address without bit truncation', async () => {
  const model = {
    addressRefs: [{ row: 0, addr: 0x2000n }],
    semantic: [],
    calls: [],
    facts: { stringRefs: [] },
  };

  const readAddrs = [];
  const backend = {
    readAt: async (addr) => {
      readAddrs.push(addr);
      if (addr === 0x2000n) {
        // First read: pointer cell containing PAC pointer to 0x123456789abcn
        return {
          found: true,
          terminated: false,
          text: null,
          bytes: new Uint8Array([0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x00, 0x7f]),
        };
      }
      if (addr === 0x123456789abcn) {
        return {
          found: true,
          terminated: true,
          text: 'hello from pac indirect text',
          bytes: new TextEncoder().encode('hello from pac indirect text\0'),
        };
      }
      return { found: false };
    },
  };

  const resolved = await resolveModelTexts(backend, model, 96, { architecture: 'arm64e' });
  assert.deepEqual(readAddrs, [0x2000n, 0x123456789abcn]);
  assert.equal(resolved.addressRefs[0].text, 'hello from pac indirect text');
});
