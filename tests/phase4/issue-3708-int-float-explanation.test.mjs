import assert from 'node:assert/strict';

import { explain } from '../../js/arm64.js';
import { lang, setLang } from '../../js/i18n.js';

/* Issue #3708: SCVTF and UCVTF consume the same register bit pattern with
 * different integer signedness.  The explainer receives register operands,
 * not their runtime values, so the source width and conversion signedness
 * must remain explicit in the pseudo-code and summary. */

const CASES = [
  // The high bit changes the architectural result for these 32-bit and
  // 64-bit source views, so neither conversion may collapse to the other.
  { dst:'d0', src:'w1', sourceType:'int32_t', unsignedType:'uint32_t', precision:'double', precisionLabel:'double-precision' },
  { dst:'d0', src:'x1', sourceType:'int64_t', unsignedType:'uint64_t', precision:'double', precisionLabel:'double-precision' },
  // Positive small values may compare equal at runtime, but the instruction
  // semantics still need to remain visible in the explanation.
  { dst:'s0', src:'w1', sourceType:'int32_t', unsignedType:'uint32_t', precision:'float', precisionLabel:'single-precision' },
  { dst:'s0', src:'x1', sourceType:'int64_t', unsignedType:'uint64_t', precision:'float', precisionLabel:'single-precision' },
];

function explainIn(language, mnemonic, operands) {
  const previous = lang();
  setLang(language);
  try {
    return explain(mnemonic, operands);
  } finally {
    setLang(previous);
  }
}

function assertExplanation(mnemonic, c, sourceType, signedness, langName) {
  const explanation = explain(mnemonic, `${c.dst}, ${c.src}`);
  const type = signedness === 'signed' ? sourceType : c.unsignedType;
  assert.equal(explanation.category, 'float', `${langName}: ${mnemonic} must stay a float conversion`);
  assert.equal(
    explanation.pseudo,
    `${c.dst} = (${c.precision})(${type})${c.src}`,
    `${langName}: ${mnemonic} must preserve source signedness/width and destination precision`,
  );
  assert.match(
    explanation.summary,
    signedness === 'signed' ? /signed integer|符号付き整数/ : /unsigned integer|符号なし整数/,
    `${langName}: ${mnemonic} summary must state ${signedness} input`,
  );
  assert.match(
    explanation.summary,
    new RegExp(`${c.precisionLabel}|${c.precision === 'double' ? '倍精度' : '単精度'}`),
    `${langName}: destination precision must remain visible`,
  );
}

const previousLanguage = lang();
try {
  for (const language of ['ja', 'en']) {
    setLang(language);
    for (const c of CASES) {
      assertExplanation('scvtf', c, c.sourceType, 'signed', language);
      assertExplanation('ucvtf', c, c.sourceType, 'unsigned', language);
    }
  }
} finally {
  setLang(previousLanguage);
}

for (const c of CASES) {
  const signed = explain('scvtf', `${c.dst}, ${c.src}`);
  const unsigned = explain('ucvtf', `${c.dst}, ${c.src}`);
  assert.notEqual(signed.pseudo, unsigned.pseudo, `SCVTF/UCVTF must differ for ${c.dst}, ${c.src}`);
  assert.notEqual(signed.summary, unsigned.summary, `SCVTF/UCVTF summary must differ for ${c.dst}, ${c.src}`);
}

// Fixed-point forms carry an fbits operand; dropping it changes the value.
const FIXED_POINT_CASES = [
  { mnemonic:'scvtf', operands:'d0, w1, #1', scale:1, pseudo:'d0 = ((double)(int32_t)w1) / 2^1' },
  { mnemonic:'scvtf', operands:'d0, w1, #32', scale:32, pseudo:'d0 = ((double)(int32_t)w1) / 2^32' },
  { mnemonic:'ucvtf', operands:'d0, x1, #64', scale:64, pseudo:'d0 = ((double)(uint64_t)x1) / 2^64' },
  { mnemonic:'scvtf', operands:'s0, s1, #1', scale:1, pseudo:'s0 = simd_signed_lane_to_float(s1, fbits=1)' },
  { mnemonic:'ucvtf', operands:'d0, d1, #64', scale:64, pseudo:'d0 = simd_unsigned_lane_to_double(d1, fbits=64)' },
];
for (const language of ['ja', 'en']) {
  for (const fixed of FIXED_POINT_CASES) {
    const result = explainIn(language, fixed.mnemonic, fixed.operands);
    assert.equal(result.pseudo, fixed.pseudo,
      `${language}: ${fixed.mnemonic} ${fixed.operands} must preserve the exact fixed-point operation and scale`);
    assert.ok(result.summary.includes(`2^${fixed.scale}`),
      `${language}: ${fixed.mnemonic} ${fixed.operands} summary must preserve the exact fixed-point scale`);
  }
}

for (const operands of ['d0, w1, #0', 'd0, w1, #33', 'd0, x1, #65', 's0, s1, #0', 's0, s1, #33', 'd0, d1, #65', 'v0.4s, v1.4s, #33']) {
  const result = explainIn('en', 'ucvtf', operands);
  assert.match(result.summary, /unknown|not interpreted|uninterpreted/i,
    `ucvtf ${operands}: unsupported fixed-point shape must be explicit`);
}

// SIMD scalar/vector forms are not ordinary W/X casts; retain lane shape and
// signedness without inventing an int32_t/uint32_t source type.
for (const [mnemonic, operands, pseudo, signedness] of [
  ['scvtf', 's0, s1', 's0 = simd_signed_lane_to_float(s1)', 'signed'],
  ['ucvtf', 's0, s1', 's0 = simd_unsigned_lane_to_float(s1)', 'unsigned'],
  ['scvtf', 'v0.4s, v1.4s', 'v0.4s = simd_signed_lanes_to_float(v1.4s)', 'signed'],
  ['ucvtf', 'v0.4s, v1.4s', 'v0.4s = simd_unsigned_lanes_to_float(v1.4s)', 'unsigned'],
]) {
  const result = explainIn('en', mnemonic, operands);
  assert.equal(result.pseudo, pseudo,
    `${mnemonic} ${operands}: SIMD operation must preserve exact ${signedness} semantics and lane shape`);
  assert.match(result.summary, new RegExp(`\\b${signedness}\\b`, 'i'),
    `${mnemonic} ${operands}: SIMD summary must state ${signedness} semantics`);
}

// Unsupported operand classes/modifiers must stay explicit instead of being
// silently forced into the scalar W/X -> S/D interpretation.
for (const mnemonic of ['scvtf', 'ucvtf']) {
  for (const operands of ['d0, v1', 'd0, #1', 'x0, w1', 'h0, w1', 'd0, w1, lsl #1']) {
    const result = explainIn('en', mnemonic, operands);
    assert.match(result.summary, /unknown|not interpreted|uninterpreted/i,
      `${mnemonic} ${operands}: unsupported operand shape must be explicit`);
    assert.doesNotMatch(result.pseudo, /int(?:32|64)_t|uint(?:32|64)_t/,
      `${mnemonic} ${operands}: unsupported operand shape must not receive a fabricated cast`);
  }
}

console.log('issue #3708 integer-to-float signedness/width/precision explanations: PASS');
