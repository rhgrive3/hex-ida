// A64 widening / bitfield instructions that the shared decompiler still renders
// as raw `__asm`.
//
// `js/decompiler/arm64-extra-semantics.js` is the fail-closed late-lowering
// boundary: a mnemonic is lowered only when its printed operand shape proves the
// exact architectural operation, and unknown shapes keep the raw assembly. This
// test pins both halves for the widening add/shift, bitwise insert, reduce and
// bitfield-insert families, and cross-checks the SBFIZ/UBFIZ contract against
// the already-proven MachineEffects bitfield evaluator instead of restating it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { lowerArm64RawAssembly } from '../../js/decompiler/arm64-extra-semantics.js';
import { evaluateArm64Bitfield } from '../../js/targets/architecture/arm64/effects/integer-core.js';

function lowerOne(payload) {
  const result = lowerArm64RawAssembly({ lines: [{ text: `__asm("${payload}");`, indent: 0 }] });
  assert.equal(result.lines.length, 1);
  return result.lines[0].text;
}
function staysRaw(payload) {
  return lowerOne(payload) === `__asm("${payload}");`;
}

test('USHLL/USHLL2 lower both halves and their exact arrangement pairs', () => {
  assert.equal(lowerOne('ushll v2.8h, v2.8b, #0'), 'v2 = __a64_ushll_8h(v2, 0);');
  assert.equal(lowerOne('ushll v1.4s, v1.4h, #7'), 'v1 = __a64_ushll_4s(v1, 7);');
  assert.equal(lowerOne('ushll v3.2d, v3.2s, #31'), 'v3 = __a64_ushll_2d(v3, 31);');
  assert.equal(lowerOne('ushll2 v1.8h, v1.16b, #0'), 'v1 = __a64_ushll2_8h(v1, 0);');
  assert.equal(lowerOne('ushll2 v0.4s, v0.8h, #3'), 'v0 = __a64_ushll2_4s(v0, 3);');

  // A mismatched half or an out-of-range shift is not this operation.
  assert.ok(staysRaw('ushll v2.8h, v2.16b, #0'));
  assert.ok(staysRaw('ushll2 v2.8h, v2.8b, #0'));
  assert.ok(staysRaw('ushll v2.8h, v2.8b, #16'));
  assert.ok(staysRaw('ushll v2.8h, v2.8b'));
  assert.ok(staysRaw('ushll v2.8h, x2, #0'));
});

test('UADDW/UADDW2 lower only their exact wide/narrow pairs', () => {
  assert.equal(lowerOne('uaddw v0.4s, v0.4s, v2.4h'), 'v0 = __a64_uaddw_4s(v0, v2);');
  assert.equal(lowerOne('uaddw v1.8h, v5.8h, v6.8b'), 'v1 = __a64_uaddw_8h(v5, v6);');
  assert.equal(lowerOne('uaddw2 v0.4s, v0.4s, v2.8h'), 'v0 = __a64_uaddw2_4s(v0, v2);');
  assert.equal(lowerOne('uaddw2 v2.2d, v2.2d, v4.4s'), 'v2 = __a64_uaddw2_2d(v2, v4);');

  // The wide source must share the destination arrangement, and the narrow
  // source must be the half the mnemonic names.
  assert.ok(staysRaw('uaddw v0.4s, v0.8h, v2.4h'));
  assert.ok(staysRaw('uaddw v0.4s, v0.4s, v2.8h'));
  assert.ok(staysRaw('uaddw2 v0.4s, v0.4s, v2.4h'));
  assert.ok(staysRaw('uaddw v0.4s, v0.4s, w2'));
});

test('BIT lowers only the 8B/16B byte arrangements', () => {
  assert.equal(lowerOne('bit v0.16b, v2.16b, v1.16b'), 'v0 = __a64_bit_16b(v0, v2, v1);');
  assert.equal(lowerOne('bit v31.8b, v30.8b, v29.8b'), 'v31 = __a64_bit_8b(v31, v30, v29);');

  // BIT has no lane-typed form and no distinct destination register.
  assert.ok(staysRaw('bit v0.4s, v2.4s, v1.4s'));
  assert.ok(staysRaw('bit v0.2d, v2.2d, v1.2d'));
  assert.ok(staysRaw('bit v0.16b, v2.8b, v1.16b'));
});

test('ADDV lowers each defined arrangement into the scalar SIMD register', () => {
  assert.equal(lowerOne('addv s0, v0.4s'), 'v0 = __a64_addv_4s(v0);');
  assert.equal(lowerOne('addv s4, v4.4s'), 'v4 = __a64_addv_4s(v4);');
  assert.equal(lowerOne('addv b1, v1.8b'), 'v1 = __a64_addv_8b(v1);');
  assert.equal(lowerOne('addv b1, v1.16b'), 'v1 = __a64_addv_16b(v1);');
  assert.equal(lowerOne('addv h2, v2.4h'), 'v2 = __a64_addv_4h(v2);');
  assert.equal(lowerOne('addv h3, v3.8h'), 'v3 = __a64_addv_8h(v3);');

  // ADDV has no 2D form, and the destination element width must match.
  assert.ok(staysRaw('addv d0, v0.2d'));
  assert.ok(staysRaw('addv s0, v0.4h'));
  assert.ok(staysRaw('addv s0, v0.16b'));
});

test('SBFIZ/UBFIZ lower the full-width destination and reject invalid fields', () => {
  assert.equal(lowerOne('sbfiz x1, x0, #2, #0x20'), 'x1 = __a64_sbfiz_64(x0, 2, 32);');
  assert.equal(lowerOne('sbfiz x0, x0, #3, #0x20'), 'x0 = __a64_sbfiz_64(x0, 3, 32);');
  assert.equal(lowerOne('ubfiz x6, x2, #2, #0x20'), 'x6 = __a64_ubfiz_64(x2, 2, 32);');
  assert.equal(lowerOne('ubfiz x19, x25, #3, #0x20'), 'x19 = __a64_ubfiz_64(x25, 3, 32);');

  // `#<width>` must be positive and fit inside the register together with
  // `#<lsb>`; a 32-bit view is not the variable the renderer names for the
  // register, so it stays raw instead of aliasing a second name.
  assert.ok(staysRaw('sbfiz x1, x0, #40, #0x20'));
  assert.ok(staysRaw('sbfiz x1, x0, #0, #0'));
  assert.ok(staysRaw('sbfiz w1, w0, #2, #0x20'));
  assert.ok(staysRaw('sbfiz x1, w0, #2, #0x20'));
  assert.ok(staysRaw('sbfiz x1, sp, #2, #0x20'));
});

test('SBFIZ/UBFIZ emitted lsb/width reproduce the proven bitfield semantics', () => {
  // Independent witness: the canonical MachineEffects SBFM/UBFM evaluator with
  // the SBFIZ/UBFIZ alias encoding (immr = -lsb mod 64, imms = width - 1).
  const MASK64 = (1n << 64n) - 1n;
  const sources = [
    0n, 1n, 2n, 0xfn, 0x80000000n, 0xdeadbeefn, 0x123456789abcdefn,
    0x7fffffffn, 0x80000000n, MASK64, 0xffffffff80000000n,
  ];
  let checked = 0;
  for (const mnemonic of ['sbfiz', 'ubfiz']) {
    for (const lsb of [0, 1, 2, 3, 7, 8, 16, 31, 32, 63]) {
      for (const width of [1, 2, 3, 8, 16, 32, 64 - lsb]) {
        if (width < 1 || lsb + width > 64) continue;
        const rendered = lowerOne(`${mnemonic} x1, x0, #${lsb}, #${width}`);
        const match = new RegExp(`^x1 = __a64_${mnemonic}_64\\(x0, (\\d+), (\\d+)\\);$`).exec(rendered);
        assert.ok(match, `unexpected lowering for ${mnemonic} #${lsb}, #${width}: ${rendered}`);
        const [, renderedLsb, renderedWidth] = match;
        assert.equal(Number(renderedLsb), lsb);
        assert.equal(Number(renderedWidth), width);
        const immr = (-lsb) & 63;
        const imms = width - 1;
        const kind = mnemonic === 'sbfiz' ? 'sbfm' : 'ubfm';
        for (const source of sources) {
          const expected = BigInt.asUintN(64, evaluateArm64Bitfield(kind, source, 0n, 64, immr, imms));
          const field = source & ((1n << BigInt(width)) - 1n);
          const value = mnemonic === 'sbfiz'
            ? BigInt.asUintN(64, BigInt.asIntN(width, field) << BigInt(lsb))
            : BigInt.asUintN(64, field << BigInt(lsb));
          assert.equal(value, expected, `${mnemonic} #${lsb}, #${width} of ${source.toString(16)}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1000, `expected a broad sweep, checked ${checked}`);
});
