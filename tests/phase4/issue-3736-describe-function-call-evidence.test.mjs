import assert from 'node:assert/strict';
import test from 'node:test';

import { describeFunction } from '../../js/analyze.js';
import { lang, setLang } from '../../js/i18n.js';

function result(overrides = {}) {
  return {
    instructions: 3,
    savesLr: false,
    calls: [],
    indirectCalls: 0,
    loops: [],
    condBranches: 0,
    argRegs: [],
    setsReturnValue: false,
    frameBytes: 0,
    savesCallee: [],
    usesFloat: false,
    usesSimd: false,
    usesAtomic: false,
    hasTrap: false,
    dataRows: 0,
    truncated: false,
    ...overrides,
  };
}

function describe(language, input) {
  const previous = lang();
  setLang(language);
  try {
    return describeFunction(result(input), 'sample').join('\n');
  } finally {
    setLang(previous);
  }
}

test('#3736 direct calls are not misclassified as leaf functions', () => {
  const input = { savesLr: false, calls: [{ name: 'fatal_handler', target: 0x2000n }] };
  const english = describe('en', input);
  const japanese = describe('ja', input);

  assert.match(english, /It calls: fatal_handler/);
  assert.doesNotMatch(english, /leaf function that calls nothing/);
  assert.match(japanese, /「fatal_handler」 ?を呼んでいます/);
  assert.doesNotMatch(japanese, /末端の処理です/);
});

test('#3736 indirect calls are call evidence even without LR preservation', () => {
  const input = { savesLr: false, indirectCalls: 1 };
  const english = describe('en', input);
  const japanese = describe('ja', input);

  assert.match(english, /It makes 1 indirect call/);
  assert.doesNotMatch(english, /leaf function that calls nothing/);
  assert.match(japanese, /レジスタ経由の呼び出しが 1 か所/);
  assert.doesNotMatch(japanese, /末端の処理です/);
});

test('#3736 unknown direct targets still count as calls', () => {
  const english = describe('en', { savesLr: false, calls: [{}] });

  assert.match(english, /It calls: an unknown target/);
  assert.doesNotMatch(english, /leaf function that calls nothing/);
});

test('#3736 a true leaf keeps the leaf explanation in both languages', () => {
  const english = describe('en', result());
  const japanese = describe('ja', result());

  assert.match(english, /It never saves the return address — a leaf function that calls nothing\./);
  assert.match(japanese, /他の関数は呼んでいません。自分だけで完結する末端の処理です。/);
});

test('#3736 LR preservation does not imply a call', () => {
  const english = describe('en', { savesLr: true });

  assert.match(english, /It saves the return address\./);
  assert.doesNotMatch(english, /so it calls other functions/);
  assert.doesNotMatch(english, /leaf function that calls nothing/);
});
