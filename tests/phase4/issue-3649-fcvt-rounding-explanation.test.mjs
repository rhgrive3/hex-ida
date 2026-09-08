import assert from 'node:assert/strict';

import { explain } from '../../js/arm64.js';
import { lang, setLang } from '../../js/i18n.js';

/* Issue #3649: FCVT* scalar float-to-integer aliases differ by both
 * signedness and an encoded rounding direction.  A generic `(int)` cast is
 * wrong for ties-away/even and for either directed rounding mode. */

const SIBLINGS = [
  { mnemonic: 'fcvtzs', signed: true, functionName: 'round_toward_zero', mode: 'toward-zero', en: /toward zero/, ja: /0 方向/ },
  { mnemonic: 'fcvtzu', signed: false, functionName: 'round_toward_zero', mode: 'toward-zero', en: /toward zero/, ja: /0 方向/ },
  { mnemonic: 'fcvtas', signed: true, functionName: 'round_nearest_ties_away', mode: 'ties-away', en: /nearest, ties away from zero/, ja: /最近接.*中間.*遠い/ },
  { mnemonic: 'fcvtau', signed: false, functionName: 'round_nearest_ties_away', mode: 'ties-away', en: /nearest, ties away from zero/, ja: /最近接.*中間.*遠い/ },
  { mnemonic: 'fcvtms', signed: true, functionName: 'round_toward_minus_infinity', mode: 'toward-minus-infinity', en: /toward -infinity/, ja: /−∞ 方向/ },
  { mnemonic: 'fcvtmu', signed: false, functionName: 'round_toward_minus_infinity', mode: 'toward-minus-infinity', en: /toward -infinity/, ja: /−∞ 方向/ },
  { mnemonic: 'fcvtns', signed: true, functionName: 'round_nearest_ties_even', mode: 'ties-even', en: /nearest, ties to even/, ja: /最近接.*中間.*偶数/ },
  { mnemonic: 'fcvtnu', signed: false, functionName: 'round_nearest_ties_even', mode: 'ties-even', en: /nearest, ties to even/, ja: /最近接.*中間.*偶数/ },
  { mnemonic: 'fcvtps', signed: true, functionName: 'round_toward_plus_infinity', mode: 'toward-plus-infinity', en: /toward \+infinity/, ja: /\+∞ 方向/ },
  { mnemonic: 'fcvtpu', signed: false, functionName: 'round_toward_plus_infinity', mode: 'toward-plus-infinity', en: /toward \+infinity/, ja: /\+∞ 方向/ },
];

const ROUNDING_ORACLES = {
  'toward-zero': Math.trunc,
  'toward-minus-infinity': Math.floor,
  'toward-plus-infinity': Math.ceil,
  'ties-away': (value) => Math.sign(value) * Math.floor(Math.abs(value) + 0.5),
  'ties-even': (value) => {
    const lower = Math.floor(value);
    const fraction = value - lower;
    if (fraction < 0.5) return lower;
    if (fraction > 0.5) return lower + 1;
    return Math.abs(lower) % 2 === 0 ? lower : lower + 1;
  },
};

const ROUNDING_EXAMPLES = {
  'toward-zero': [[1.9, 1], [-1.9, -1]],
  'toward-minus-infinity': [[1.9, 1], [-1.1, -2]],
  'toward-plus-infinity': [[1.1, 2], [-1.9, -1]],
  'ties-away': [[1.5, 2], [-1.5, -2]],
  'ties-even': [[1.5, 2], [2.5, 2], [-1.5, -2], [-2.5, -2]],
};

function assertRoundingOracle(mode) {
  const oracle = ROUNDING_ORACLES[mode];
  assert.equal(typeof oracle, 'function', `${mode} must have a numeric oracle`);
  for (const [input, expected] of ROUNDING_EXAMPLES[mode]) {
    assert.equal(oracle(input), expected, `${mode}: ${input} must round to ${expected}`);
  }
}

const previousLanguage = lang();
try {
  for (const mode of Object.keys(ROUNDING_ORACLES)) assertRoundingOracle(mode);

  // W/X destination width and S/D source precision are all independently
  // visible in both language surfaces; the architectural pair need not have
  // matching widths (for example, W0 <- D1 is a valid scalar form).
  for (const language of ['en', 'ja']) {
    setLang(language);
    for (const sibling of SIBLINGS) {
      for (const [destination, destinationBits] of [['w0', 32], ['x0', 64]]) {
        for (const [source, sourceBits] of [['s1', 32], ['d1', 64]]) {
          const result = explain(sibling.mnemonic, `${destination}, ${source}`, 0n, {});
          const integerType = `${sibling.signed ? 'int' : 'uint'}${destinationBits}_t`;
          assert.equal(result.handlerError, undefined, `${language}: ${sibling.mnemonic} must not throw`);
          assert.equal(result.category, 'float');
          assert.equal(
            result.pseudo,
            `${destination} = (${integerType})${sibling.functionName}(${source})`,
            `${language}: ${sibling.mnemonic} must expose its rounding and signedness`,
          );
          assert.match(result.summary, language === 'en' ? (sibling.signed ? /signed integer/ : /unsigned integer/) : (sibling.signed ? /符号付き整数/ : /符号なし整数/));
          assert.match(result.summary, language === 'en' ? sibling.en : sibling.ja);
          assert.match(result.summary, language === 'en' ? new RegExp(`${sourceBits}-bit`) : new RegExp(`${sourceBits} ビット`));
          assert.match(result.summary, language === 'en' ? new RegExp(`${destinationBits}-bit`) : new RegExp(`${destinationBits} ビット`));
          assert.ok(result.terms.includes('float'));
        }
      }
    }
  }

  // The ten forms have five distinct rounding rules, while the S/U pair for
  // each rule still differs in its integer destination type.
  const byMnemonic = new Map(SIBLINGS.map((sibling) => [sibling.mnemonic, sibling]));
  for (const mode of Object.keys(ROUNDING_ORACLES)) {
    const names = SIBLINGS.filter((sibling) => sibling.mode === mode).map((sibling) => sibling.mnemonic);
    assert.equal(names.length, 2, `${mode} must have signed and unsigned siblings`);
    assert.notEqual(
      explain(names[0], 'w0, s0', 0n, {}).pseudo,
      explain(names[1], 'w0, s0', 0n, {}).pseudo,
      `${mode} signedness must remain visible`,
    );
    assert.equal(byMnemonic.get(names[0]).functionName, byMnemonic.get(names[1]).functionName);
  }

  // Do not turn malformed, fixed-point, or SIMD operands into a scalar cast.
  setLang('en');
  for (const sibling of SIBLINGS) {
    for (const operands of [
      '',
      'w0',
      'w0, s0, #8',
      'w0, s0, lsl #1',
      'v0.4s, v1.4s',
      'w0, v1.4s',
      'q0, s1',
      'w0, q1',
      'w0, h1',
      'w0, x1',
      'sp, s0',
      'w0, s0, s1',
    ]) {
      const result = explain(sibling.mnemonic, operands, 0n, {});
      assert.equal(result.handlerError, undefined, `${sibling.mnemonic} ${operands} must fail closed`);
      assert.equal(result.title, 'Unknown float-to-integer form');
      assert.equal(result.pseudo, operands ? `${sibling.mnemonic} ${operands}` : sibling.mnemonic);
      assert.match(result.summary, /unknown|unsupported|do not guess/i);
      assert.doesNotMatch(result.pseudo, /round_|\(int|\(uint/);
      assert.deepEqual(result.terms, []);
    }
  }

  setLang('ja');
  const invalidJapanese = explain('fcvtzs', 'w0, s0, #8', 0n, {});
  assert.equal(invalidJapanese.handlerError, undefined);
  assert.equal(invalidJapanese.title, '小数→整数（未解釈）');
  assert.match(invalidJapanese.summary, /推測しません/);
} finally {
  setLang(previousLanguage);
}

console.log('issue #3649 FCVT scalar rounding/signedness/width explanations: PASS');
