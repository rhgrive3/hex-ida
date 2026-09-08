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
for (const language of ['ja', 'en']) {
  for (const [mnemonic, operands, scale] of [
    ['scvtf', 'd0, w1, #1', '2\\^1'],
    ['scvtf', 'd0, w1, #32', '2\\^32'],
    ['ucvtf', 'd0, x1, #64', '2\\^64'],
    ['scvtf', 's0, s1, #1', '2\\^1'],
    ['ucvtf', 'd0, d1, #64', '2\\^64'],
  ]) {
    const result = explainIn(language, mnemonic, operands);
    assert.match(result.pseudo + result.summary, new RegExp(scale + '|fixed|固定小数点|小数部'),
      `${language}: ${mnemonic} fixed-point scale must remain explicit`);
  }
}

for (const operands of ['d0, w1, #0', 'd0, w1, #33', 'd0, x1, #65', 's0, s1, #0', 's0, s1, #33', 'd0, d1, #65', 'v0.4s, v1.4s, #33']) {
  const result = explainIn('en', 'ucvtf', operands);
  assert.match(result.summary, /unknown|not interpreted|uninterpreted/i,
    `ucvtf ${operands}: unsupported fixed-point shape must be explicit`);
}

// SIMD scalar/vector forms are not ordinary W/X casts; retain lane shape and
// signedness without inventing an int32_t/uint32_t source type.
for (const [mnemonic, signedness] of [['scvtf', 'signed'], ['ucvtf', 'unsigned']]) {
  for (const operands of ['s0, s1', 'v0.4s, v1.4s']) {
    const result = explainIn('en', mnemonic, operands);
    assert.match(result.pseudo, /simd|lane/i, `${mnemonic} ${operands}: SIMD lane shape must be explicit`);
    assert.match(result.summary, new RegExp(`${signedness}|lane|SIMD`, 'i'),
      `${mnemonic} ${operands}: SIMD ${signedness} semantics must be explicit`);
    assert.doesNotMatch(result.pseudo, /int(?:32|64)_t|uint(?:32|64)_t/,
      `${mnemonic} ${operands}: SIMD must not fabricate a GP integer cast`);
  }
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
