import assert from 'node:assert/strict';
import test from 'node:test';

await import('../js/words.js');
await import('../js/address-provenance.js');
const W = globalThis.Words;
const K = W.KIND;

const BR_X9 = 0xd61f0120;
const BRAA_X0_X1 = 0xd71f0801;
const BRAB_X0_X1 = 0xd71f0c01;
const BRAAZ_X0 = 0xd61f081f;
const BRABZ_X0 = 0xd61f0c1f;
const RET_X30 = 0xd65f03c0;
const RETAA = 0xd65f0bff;
const RETAB = 0xd65f0fff;
const BLR_X0 = 0xd63f0000;
const BLRAA_X0_X1 = 0xd73f0801;
const BLRAB_X0_X1 = 0xd73f0c01;
const BLRAAZ_X0 = 0xd63f081f;
const BLRABZ_X0 = 0xd63f0c1f;
const ADRP_X8 = 0xb0000008;
const ADD_X8_X8_32 = 0x91008108;
const LDR_X2_X8 = 0xf9400102;
const ERET = 0xd69f03e0;
const ERETAA = 0xd69f0bff;
const ERETAB = 0xd69f0fff;
const BRK_1 = 0xd4200020;
const SVC_0 = 0xd4000001;

test('#4180 authenticated indirect branches classify as BRANCH, authenticated returns as RET', () => {
  assert.equal(W.classifyWord(BR_X9), K.BRANCH);
  assert.equal(W.classifyWord(BRAA_X0_X1), K.BRANCH);
  assert.equal(W.classifyWord(BRAB_X0_X1), K.BRANCH);
  assert.equal(W.classifyWord(BRAAZ_X0), K.BRANCH);
  assert.equal(W.classifyWord(BRABZ_X0), K.BRANCH);
  assert.equal(W.classifyWord(RET_X30), K.RET);
  assert.equal(W.classifyWord(RETAA), K.RET);
  assert.equal(W.classifyWord(RETAB), K.RET);
});

test('#4180 authenticated calls keep their existing INDCALL truth', () => {
  assert.equal(W.classifyWord(BLR_X0), K.INDCALL);
  assert.equal(W.classifyWord(BLRAA_X0_X1), K.INDCALL);
  assert.equal(W.classifyWord(BLRAB_X0_X1), K.INDCALL);
  assert.equal(W.classifyWord(BLRAAZ_X0), K.INDCALL);
  assert.equal(W.classifyWord(BLRABZ_X0), K.INDCALL);
});

test('#4180 adjacent system and trap encodings are not absorbed into the branch/return classes', () => {
  for (const word of [ERET, ERETAA, ERETAB]) {
    assert.notEqual(W.classifyWord(word), K.RET, `0x${word.toString(16)} must not classify as RET`);
    assert.notEqual(W.classifyWord(word), K.BRANCH, `0x${word.toString(16)} must not classify as BRANCH`);
  }
  assert.notEqual(W.classifyWord(SVC_0), K.RET);
  assert.notEqual(W.classifyWord(SVC_0), K.BRANCH);
  assert.notEqual(W.classifyWord(BLR_X0), K.BRANCH);
  assert.notEqual(W.classifyWord(BLRAAZ_X0), K.BRANCH);
  assert.equal(W.classifyWord(BRK_1), K.TRAP);
});

test('#4180 exported predicates and end-candidate truth agree with the classifier', () => {
  assert.equal(W.isBr(BRAA_X0_X1), true);
  assert.equal(W.isBr(BRAB_X0_X1), true);
  assert.equal(W.isBr(BRAAZ_X0), true);
  assert.equal(W.isBr(BRABZ_X0), true);
  assert.equal(W.isBr(BR_X9), true);
  assert.equal(W.isBr(RETAA), false);
  assert.equal(W.isRet(RETAA), true);
  assert.equal(W.isRet(RETAB), true);
  assert.equal(W.isRet(RET_X30), true);
  assert.equal(W.isRet(ERETAA), false);
  assert.equal(W.isRet(ERET), false);
  assert.equal(W.looksLikeEnd(RETAA), true);
  assert.equal(W.looksLikeEnd(RETAB), true);
  assert.equal(W.looksLikeEnd(ERETAA), false);
  const decoded = W.decodeWord(BRAA_X0_X1, 0x1000n);
  assert.equal(decoded.kindName, 'BRANCH');
  assert.equal(decoded.target, null);
});

test('#4180 provenance does not leak across an authenticated branch or return in a linear scan', () => {
  for (const terminator of [BRAA_X0_X1, BRAAZ_X0, RETAA, RETAB]) {
    const p = globalThis.AddressProvenance.create({ words: W });
    assert.equal(W.classifyWord(ADRP_X8), K.ADRP);
    p.note(8, 0x1120n, 1);
    const kind = W.classifyWord(terminator);
    assert.ok(kind === K.BRANCH || kind === K.RET,
      `0x${terminator.toString(16)} must classify as a terminator (got ${K[kind]})`);
    const result = p.control(terminator, 0x1008n, kind);
    assert.equal(result.barrier, true, `0x${terminator.toString(16)} must form a control barrier`);
    assert.equal(p.base(8, 2, { allowEntryFallback: true }), null);
    assert.equal(p.base(8, 3, { allowEntryFallback: true }), null,
      `x8 provenance must not survive across 0x${terminator.toString(16)} into the following ldr`);
  }
});

test('#4180 plain control-flow barrier behavior is unchanged', () => {
  const p = globalThis.AddressProvenance.create({ words: W });
  p.note(8, 0x1120n, 1);
  assert.equal(p.control(BR_X9, 0x1008n, K.BRANCH).barrier, true);
  assert.equal(p.base(8, 2), null);
  const q = globalThis.AddressProvenance.create({ words: W });
  q.note(8, 0x1120n, 1);
  assert.equal(q.control(ADD_X8_X8_32, 0x1008n, K.ARITH).barrier, false);
  assert.equal(q.base(8, 2), 0x1120n);
  assert.equal(q.control(LDR_X2_X8, 0x100cn, K.LOAD).barrier, false);
  assert.equal(q.base(8, 3), 0x1120n);
});
