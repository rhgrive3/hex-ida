import test from 'node:test';
import assert from 'node:assert/strict';

import {
  placeName,
  plainPlaceName,
  plainRegName,
  plainOpName,
  comprehensionHeadline,
  roleProofText,
  factText,
  evidenceText,
  useText,
  proofText,
  sinkText,
  patchImpactPreview,
  functionStory,
} from '../js/narrate.js';
import { findAccumulators, shapeOfStep, findSink, STEP } from '../js/comprehend.js';
import { regNode, floatNode } from '../js/expr.js';
import { GLOSSARY, GLOSSARY_ORDER, glossaryEntry, searchGlossary } from '../js/glossary.js';
import { describeOperandPlain, explainOperandsForBeginner } from '../js/ui/explain/arm64-operands.js';
import { setLang } from '../js/i18n.js';
import { buildBeginnerFunctionCard, decorateFunctionAnalysisForUi } from '../js/ui/function-analysis-presentation.js';

test('narrate: placeName preserves 3-arg compat while beginner mode & plainPlaceName use plain Japanese', () => {
  assert.equal(placeName(null, 'x0', 0x20n), 'x0 + 0x20');
  assert.equal(placeName({ plain: 'hp', className: 'BattleManager' }, 'x0', 0x20n), 'BattleManager の hp');

  const objAttr = placeName(null, 'x0', 0x20n, { beginner: true });
  assert.equal(objAttr, 'このオブジェクトの属性');
  assert.doesNotMatch(objAttr, /x0|0x20/);

  const localVar = plainPlaceName(null, 'x29', -0x60n);
  assert.equal(localVar, '一時変数');
  assert.doesNotMatch(localVar, /x29|0x60/);

  const argData = plainPlaceName(null, 'x1', 0n);
  assert.match(argData, /2番目の入力データ/);
  assert.doesNotMatch(argData, /x1/);

  const invalidDisp = plainPlaceName(null, 'x1', 'not-a-number');
  assert.match(invalidDisp, /2番目の入力データ/);
  assert.doesNotMatch(invalidDisp, /属性/);
});

test('narrate: comprehensionHeadline and roleProofText do not leak raw register tags', () => {
  const pipe = comprehensionHeadline({
    headline: { code: 'cm-pipeline', reg: 'x25', steps: 4, scales: 2 },
  });
  assert.ok(pipe);
  assert.doesNotMatch(pipe, /x25/);

  const carry = comprehensionHeadline({
    headline: { code: 'cm-carry', reg: 'd8', steps: 3 },
  });
  assert.ok(carry);
  assert.doesNotMatch(carry, /d8/);

  const proof = roleProofText({
    code: 'role-chain-verified',
    detail: { steps: 5, reg: 'x25' },
  });
  assert.ok(proof);
  assert.doesNotMatch(proof, /x25/);
});

test('narrate: factText, evidenceText, and useText translate register and opcode jargon', () => {
  const retFact = factText({ code: 'returns-value', detail: {} });
  assert.doesNotMatch(retFact, /\bx0\b/);
  assert.match(retFact, /返り値/);

  const argFact = factText({ code: 'arguments', detail: { regs: [0, 1] } });
  assert.doesNotMatch(argFact, /\bx[01]\b/);
  assert.match(argFact, /1番目の入力/);
  assert.match(argFact, /2番目の入力/);

  const cmpFact = factText({ code: 'compare-const', detail: { register: 'x0', value: 100 } });
  assert.doesNotMatch(cmpFact, /\bx0\b/);
  assert.match(cmpFact, /1番目の入力/);

  const updFact = factText({ code: 'value-update', detail: { kind: 'read-modify-write', base: 'x0', disp: 0x20n, ops: [{ op: 'sdiv' }] } });
  assert.doesNotMatch(updFact, /x0 \+ 0x20/);
  assert.match(updFact, /このオブジェクトの属性/);

  const copyEv = evidenceText({ code: 'copy', detail: { from: 'x0', to: 'x1' } });
  assert.doesNotMatch(copyEv, /\bx[01]\b/);
  assert.match(copyEv, /1番目の入力/);
  assert.match(copyEv, /2番目の入力/);

  const storeUse = useText({ use: 'store', detail: { base: 'x29', disp: -0x10n } });
  assert.doesNotMatch(storeUse, /x29|0x10/);
  assert.match(storeUse, /一時変数/);

  const divUse = useText({ use: 'compute', detail: { op: 'sdiv' } });
  assert.doesNotMatch(divUse, /\bsdiv\b/);
  assert.match(divUse, /割り算/);

  assert.equal(plainRegName('x0'), '1番目の入力');
  assert.equal(plainOpName('sdiv'), '割り算');
});

test('narrate: proofText emits zero literal Markdown asterisks', () => {
  const samples = [
    proofText({ code: 'loc-damage-source', detail: { usedAsAmount: 3, scaled: true } }),
    proofText({ code: 'loc-drain-verified', detail: { address: 0x1000n, from: { disp: 0x10n }, n: 2 } }),
    proofText({ code: 'loc-capped-by-field', detail: { cap: 0x24n } }),
  ];
  for (const s of samples) {
    assert.ok(s.length > 0);
    assert.equal(s.includes('**'), false, `unexpected raw markdown asterisks in: ${s}`);
  }
  assert.doesNotMatch(samples[1], /0x10|0x1000/i);
  assert.match(samples[1], /16 バイト目/);
  assert.doesNotMatch(samples[2], /0x24/i);
  assert.match(samples[2], /36 バイト目/);
});

test('narrate: shortName shortens mangled C++ symbol names in beginner prose', () => {
  const mangled = '__ZN13BattleManager11applyDamageEi';
  const f = factText({ code: 'call-named', detail: { name: mangled } });
  assert.doesNotMatch(f, /__ZN13/);
  assert.match(f, /BattleManager|applyDamage/);

  const ev = evidenceText({ code: 'call-named', detail: { name: mangled } });
  assert.doesNotMatch(ev, /__ZN13/);

  const story = functionStory({
    semantic: [],
    calls: [],
    facts: {
      features: [],
      apis: [],
      strings: [],
      calledNames: [{ name: mangled }],
      loops: 0,
      indirectCalls: 0,
      calls: 1,
      evidence: [],
      confidence: 0.7,
      mainRole: { kind: 'calls' },
    },
  }, mangled);
  assert.doesNotMatch(story.purpose.join('\n'), /__ZN13/);
});

test('narrate: sinkText handles ambiguous sinks cleanly', () => {
  const named = sinkText({
    kind: 'ambiguous',
    certain: false,
    candidates: [{ name: '__ZN13BattleManager5applyEi' }, { name: 'sub_1000' }],
  });
  assert.ok(named);
  assert.match(named, /複数に分かれ/);
  assert.doesNotMatch(named, /__ZN13/);

  const multiUnnamed = sinkText({
    kind: 'ambiguous',
    certain: false,
    candidates: [{ kind: 'store' }, { kind: 'return' }],
  });
  assert.ok(multiUnnamed);
  assert.match(multiUnnamed, /2 通り/);

  const partial = sinkText({ kind: 'ambiguous', certain: false, candidates: [{ kind: 'return' }] });
  assert.ok(partial);
  assert.match(partial, /特定できません/);
});

test('narrate: patchImpactPreview explains impact in 1 plain-Japanese sentence', () => {
  const branch = patchImpactPreview({ isConditional: true, mnemonic: 'b.eq' });
  assert.match(branch, /スキップ/);

  const ret = patchImpactPreview({ isReturn: true, mnemonic: 'ret' });
  assert.match(ret, /返り値/);

  const arith = patchImpactPreview({ mnemonic: 'add' });
  assert.match(arith, /増減/);

  const write = patchImpactPreview({ mnemonic: 'str' });
  assert.match(write, /保存|記録/);

  const call = patchImpactPreview('call');
  assert.match(call, /呼び出し/);
});

test('comprehend: supports FP callee-saved accumulators (s8..s15, d8..d15, v8..v15) and FP steps/sinks', () => {
  const seed = regNode('d8', 0);
  const step1 = { k: 'bin', op: 'fmul', a: seed, b: floatNode(1.5, 64) };
  const mid = regNode('d8', 1);
  const step2 = { k: 'bin', op: 'fadd', a: mid, b: floatNode(10, 64) };

  const model = {
    instructions: [
      { row: 1, address: 0x1004n, mnemonic: 'fmul', reads: ['d8'], isReturn: false, isBranch: false, isCall: false, isConditional: false },
      { row: 2, address: 0x1008n, mnemonic: 'fadd', reads: ['d8'], isReturn: false, isBranch: false, isCall: false, isConditional: false },
      { row: 3, address: 0x100cn, mnemonic: 'ret', reads: ['d0'], isReturn: true, isBranch: false, isCall: false, isConditional: false },
    ],
    calls: [],
  };
  const vg = {
    defs: new Map([
      [1, { d8: step1 }],
      [2, { d8: step2 }],
    ]),
    memWrites: [],
    at(row, reg) {
      if (row === 1 && reg === 'd8') return seed;
      if (row === 2 && reg === 'd8') return mid;
      if (row === 3 && reg === 'd0') return step2;
      return null;
    },
  };

  const accs = findAccumulators(model, vg);
  assert.equal(accs.length, 1);
  assert.equal(accs[0].reg, 'd8');
  assert.equal(accs[0].count, 2);
  assert.ok(accs[0].ops.includes('fmul'));
  assert.ok(accs[0].ops.includes('fadd'));

  assert.equal(shapeOfStep(accs[0].steps[0].expr).kind, STEP.SCALE);
  assert.equal(shapeOfStep(accs[0].steps[1].expr).kind, STEP.OFFSET);

  const sink = findSink(model, vg, accs[0]);
  assert.equal(sink?.kind, 'return');

  // Verify s8 and v15 are also recognized as carried accumulators
  for (const reg of ['s8', 's15', 'd15', 'v8', 'v15']) {
    const rSeed = regNode(reg, 0);
    const rNext = { k: 'bin', op: 'fsub', a: rSeed, b: floatNode(2, 32) };
    const rVg = {
      defs: new Map([[1, { [reg]: rNext }]]),
      at: (row, r) => (row === 1 && r === reg ? rSeed : null),
    };
    const found = findAccumulators({ instructions: [{ row: 1, address: 0x1000n }] }, rVg);
    assert.equal(found.length, 1, `expected ${reg} to be detected as FP accumulator`);
    assert.equal(found[0].reg, reg);
  }
});

test('glossary: includes beginner concepts and alias-aware search', () => {
  const requiredIds = [
    'function', 'argument', 'returnvalue', 'caller', 'callee',
    'patch', 'emulator', 'offset', 'field', 'pseudocode',
    'branch', 'assembly', 'immediate', 'register',
  ];
  for (const id of requiredIds) {
    assert.ok(glossaryEntry(id), `missing glossary entry: ${id}`);
    assert.ok(GLOSSARY_ORDER.includes(id), `missing from GLOSSARY_ORDER: ${id}`);
    assert.ok(GLOSSARY[id].short.length > 0);
    assert.ok(GLOSSARY[id].body.length > 0);
  }

  assert.equal(searchGlossary('条件分岐')[0], 'branch');
  assert.equal(searchGlossary('定数')[0], 'immediate');
  assert.equal(searchGlossary('返り値')[0], 'returnvalue');
  assert.equal(searchGlossary('書き換え')[0], 'patch');
  assert.equal(searchGlossary('emulate')[0], 'emulator');
  assert.equal(searchGlossary('pseudocode')[0], 'pseudocode');
  assert.equal(searchGlossary('呼び出し元')[0], 'caller');
  assert.equal(searchGlossary('呼び出し先')[0], 'callee');
});

test('arm64-operands: describeOperandPlain & explainOperandsForBeginner hide raw hex/regs in technical', () => {
  const items = explainOperandsForBeginner('x0, [x29, #-0x20], #0x10');
  assert.equal(items.length, 3);

  assert.match(items[0].summary, /1番目の入力/);
  assert.doesNotMatch(items[0].summary, /\bx0\b/);
  assert.equal(items[0].technical, 'x0');

  assert.match(items[1].summary, /一時変数/);
  assert.doesNotMatch(items[1].summary, /x29|0x20/);
  assert.match(items[1].technical, /x29/);

  assert.match(items[2].summary, /16/);
  assert.doesNotMatch(items[2].summary, /0x10/);
  assert.equal(items[2].technical, '#0x10');

  const cond = describeOperandPlain({ k: 'cond', text: 'eq' });
  assert.match(cond.summary, /等しい/);
  assert.equal(cond.technical, 'eq');
});

test('function-analysis-presentation: builds beginner-first summary card and separates technical details', () => {
  const canonical = Object.freeze({
    architectureId: 'arm64',
    abiId: 'aapcs64',
    pipeline: Object.freeze({
      legacyV1: {
        startAddress: 0x1000n,
        instructions: [
          { id: 0, row: 1, op: 'cmp', isConditional: true },
          { id: 1, row: 2, op: 'ret', isReturn: true },
        ],
        blocks: [
          { index: 0, startRow: 1, endRow: 2, insts: [{ row: 1 }, { row: 2 }] },
        ],
        backEdges: [],
      },
      cfg: Object.freeze({
        blocks: Object.freeze([
          Object.freeze({
            id: 'b0',
            successors: Object.freeze([
              Object.freeze({ to: 'b1', kind: 'conditional-true' }),
              Object.freeze({ to: 'b2', kind: 'conditional-false' }),
            ]),
          }),
        ]),
      }),
    }),
    decompiler: Object.freeze({ signature: 'int check_vip(void *self)' }),
  });

  const decorated = decorateFunctionAnalysisForUi(canonical);
  assert.ok(decorated.beginnerSummary);
  assert.match(decorated.beginnerSummary.headline, /条件|枝分かれ/);
  assert.match(decorated.beginnerSummary.patchImpact, /スキップ|条件/);
  assert.doesNotMatch(decorated.beginnerSummary.headline, /arm64|0x1000|aapcs64/i);
  assert.equal(decorated.beginnerSummary.technicalDetails.architectureId, 'arm64');
  assert.equal(decorated.beginnerSummary.technicalDetails.startAddress, '0x1000');

  const directCard = buildBeginnerFunctionCard(decorated);
  assert.equal(directCard.headline, decorated.beginnerSummary.headline);

  setLang('en');
  try {
    assert.match(decorated.beginnerSummary.headline, /branch/i);
  } finally {
    setLang('ja');
  }
});
