import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerAt, resolveModelTexts, resolvePointerBytes } from '../../../js/analyze.js';

const taggedPointer = new Uint8Array([0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x00, 0x7f]);

test('#4973: no target context grants no pointer-width authority', () => {
  assert.equal(resolvePointerBytes({}), null);
  assert.equal(resolvePointerBytes(null), null);
  assert.equal(pointerAt(taggedPointer, {}), null);
});

test('#4971/#4973: explicit width without architecture cannot authorize PAC/TBI stripping', () => {
  assert.equal(resolvePointerBytes({ pointerBytes: 8 }), 8);
  assert.equal(pointerAt(taggedPointer, { pointerBytes: 8 }), null);
  assert.equal(pointerAt(taggedPointer, { pointerBits: 64 }), null);
  assert.equal(pointerAt(taggedPointer, { architecture: 'arm64e' }), 0x123456789abcn);
});

test('#4973: resolveModelTexts with no ABI evidence performs no second read', async () => {
  const model = {
    addressRefs: [{ row: 0, addr: 0x2000n }],
    semantic: [],
    calls: [],
    facts: { stringRefs: [] },
  };
  const reads = [];
  const backend = {
    async readAt(addr) {
      reads.push(addr);
      if (addr === 0x2000n) {
        return { found: true, terminated: false, text: null, bytes: taggedPointer };
      }
      if (addr === 0x123456789abcn) {
        return {
          found: true,
          terminated: true,
          text: 'must not be reached without ABI evidence',
          bytes: new Uint8Array(),
        };
      }
      return { found: false };
    },
  };

  await resolveModelTexts(backend, model, 96, {});
  assert.deepEqual(reads, [0x2000n]);
});
