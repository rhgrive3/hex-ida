import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MiniArm64Emu,
  HEX_EMU_STOP_REASON,
} from '../js/targets/architecture/arm64/mini-arm64-emu.js';

function packWords(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return buf;
}

test('MiniArm64Emu decodes SIMD&FP LDR/STR (D/Q), LDUR/STUR, pre/post-index, literal, and NEON EOR', () => {
  // Code at 0x100000000:
  // 0x00: ldr  q0, #0x30            (0x9c000180) -> loads 16B from 0x100000030
  // 0x04: ldr  q1, #0x3c            (0x9c0001e1) -> loads 16B from 0x100000040
  // 0x08: eor  v0.16b, v0.16b, v1.16b (0x6e211c00)
  // 0x0c: str  q0, [sp, #0x10]      (0x3d8007e0)
  // 0x10: stur q0, [sp, #0x21]      (0x3c8213e0)
  // 0x14: ldur q2, [sp, #0x21]      (0x3cc213e2)
  // 0x18: str  d2, [sp, #0x40]      (0xfd0023e2)
  // 0x1c: ldr  d3, [sp, #0x40]      (0xfd4023e3)
  // 0x20: add  x0, sp, #0x50        (0x910143e0)
  // 0x24: str  d3, [x0, #8]!        (0xfc008c03) -> pre-index: x0 += 8, store d3
  // 0x28: ldr  d4, [x0], #8         (0xfc408404) -> post-index: load d4, x0 += 8
  // 0x2c: ret                       (0xd65f03c0)
  const code = packWords([
    0x9c000180,
    0x9c0001e1,
    0x6e211c00,
    0x3d8007e0,
    0x3c8213e0,
    0x3cc213e2,
    0xfd0023e2,
    0xfd4023e3,
    0x910143e0,
    0xfc008c03,
    0xfc408404,
    0xd65f03c0,
  ]);

  const enc = new TextEncoder();
  const key = new Uint8Array(16).fill(0x55);
  const plain = enc.encode('hello-fp-simd!!\0');
  const cipher = new Uint8Array(16);
  for (let i = 0; i < 16; i++) cipher[i] = plain[i] ^ key[i];

  const segBytes = new Uint8Array(0x50);
  segBytes.set(code, 0);
  segBytes.set(cipher, 0x30);
  segBytes.set(key, 0x40);

  const emu = new MiniArm64Emu([{ va: 0x100000000n, bytes: segBytes }], [], {
    entryVa: 0x100000000n,
    maxSteps: 64,
  });
  const res = emu.run();
  assert.equal(res.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(res.stepsUsed, 12);

  const sp = emu.gpr[31];
  const decoded = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    decoded[i] = emu.readByte(sp + 0x10n + BigInt(i));
  }
  assert.equal(new TextDecoder().decode(decoded), 'hello-fp-simd!!\0');

  // Verify pre-index + post-index updated x0 by +16 total and preserved d4 == d3
  assert.equal(res.x0, sp + 0x60n);
  assert.deepEqual(emu.getVec(4).subarray(0, 8), plain.subarray(0, 8));
});
