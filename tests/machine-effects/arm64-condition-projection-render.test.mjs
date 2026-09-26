// AArch64 conditional-branch projection, end to end.
//
// The canonical route is machine-effects -> semantic IR v2 -> compatibility v1
// -> shared decompiler, so the rendered predicate depends on both the lifted
// condition value (`js/targets/architecture/arm64/effects/control.js`) and the
// v2->v1 conditional-branch projection
// (`js/semantics/compat/semantic-ir-v2-to-v1-nodes.js`). These cases pin the
// rendered C for the three real lifted shapes:
//
//   * a flag-testing branch `b.<cond>` whose dominating flag setter proves the
//     predicate (exact comparison / named NZCV helper), and
//   * a bit-testing branch `tbnz`/`tbz`, whose lifted condition IS the tested
//     bit value and never a producer-less NZCV predicate.
//
// Rendering an NZCV predicate with no proven flag source is what produced
// `__arm64_condition_unknown(/* NZCV */)`; no case here may render it, and a
// branch without any proven condition must stay explicitly symbolic instead.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';

const BASE = 0x100000000n;
const testAbiAdapter = semanticAbiAdapter(AAPCS64_ABI);

function decompileLines(lines) {
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return { row, address: BASE + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(raw, {
    startRow: 0, endRow: raw.length - 1, rowOfAddress, symbolFor: () => null, name: null,
  });
  const result = decompile(model, {
    abiAdapter: testAbiAdapter, addr: BASE, name: 'condProjection', rowOfAddress,
    beginner: false, deterministicTransforms: true,
  });
  assert.equal(result.semantic, true, 'the canonical semantic route must serve these fixtures');
  return result.pseudocode;
}

test('TBNZ renders the tested bit value, never a producer-less NZCV predicate', () => {
  const pseudocode = decompileLines(['tbnz w8, #31, #0x100000008', 'ret']);
  assert.match(pseudocode, /bit_extract\([^,]+, 31, 1\)\s*!=\s*0/);
  assert.doesNotMatch(pseudocode, /__arm64_condition_unknown/);
});

test('TBZ renders the same tested bit value under an equality test', () => {
  const pseudocode = decompileLines(['tbz w8, #31, #0x100000008', 'ret']);
  assert.match(pseudocode, /bit_extract\([^,]+, 31, 1\)\s*==\s*0/);
  assert.doesNotMatch(pseudocode, /__arm64_condition_unknown/);
});

test('a flag-testing branch renders the predicate proven by its dominating CMP', () => {
  const signed = decompileLines(['cmp w8, #0', 'b.lt #0x100000008', 'ret']);
  assert.match(signed, /\(int32_t\)x8\s*<\s*0/);
  assert.doesNotMatch(signed, /__arm64_condition_unknown/);

  const equality = decompileLines(['subs w8, w0, w1', 'b.eq #0x100000008', 'ret']);
  assert.match(equality, /\(uint32_t\)a1\s*==\s*\(uint32_t\)a2/);
  assert.doesNotMatch(equality, /__arm64_condition_unknown/);

  const logical = decompileLines(['tst w8, #1', 'b.ne #0x100000008', 'ret']);
  assert.match(logical, /\(\(uint32_t\)x8\s*&\s*\(uint32_t\)1\)\s*!=\s*0/);
  assert.doesNotMatch(logical, /__arm64_condition_unknown/);
});

test('an ADD-derived unsigned predicate keeps its named NZCV helper', () => {
  const pseudocode = decompileLines(['adds w8, w0, w1', 'b.hi #0x100000008', 'ret']);
  assert.match(pseudocode, /__arm64_nzcv_add_hi_32\(\(uint32_t\)a1, \(uint32_t\)a2\)/);
  assert.doesNotMatch(pseudocode, /__arm64_condition_unknown/);
});

test('a branch with no proven flag source stays explicit instead of being fabricated', () => {
  const pseudocode = decompileLines(['b.ne #0x100000008', 'ret']);
  assert.match(pseudocode, /condition_ne/);
  assert.doesNotMatch(pseudocode, /__arm64_condition_unknown/);
  assert.doesNotMatch(pseudocode, /==\s*0\s*\)\s*goto/, 'no predicate may be invented for an unseen condition');
});
