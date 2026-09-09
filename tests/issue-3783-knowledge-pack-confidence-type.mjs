import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNATURE_PACK_FORMAT,
  SIGNATURE_PACK_VERSION,
  createKnowledgePack,
  importKnowledgePack,
  validateKnowledgePack,
} from '../js/signature/index.js';

function rawPack(kind, confidence) {
  const base = {
    format: SIGNATURE_PACK_FORMAT,
    version: SIGNATURE_PACK_VERSION,
    signatures: [],
    mappings: [],
  };
  if (kind === 'signature') {
    base.signatures.push({ architecture:'arm64', confidence, symbols:[], provenance:{ source:'test' }, license:'test' });
  } else {
    base.mappings.push({ identity:'fn-1', confidence, provenance:{ source:'test' }, license:'test' });
  }
  return base;
}

for (const kind of ['signature', 'mapping']) {
  test(`#3783 ${kind} validation rejects non-number confidence`, () => {
    for (const confidence of ['0.9', ['1'], [0.5], true, false, {}, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const pack = rawPack(kind, confidence);
      assert.equal(validateKnowledgePack(pack).ok, false, `${kind} ${String(confidence)} must fail validation`);
      assert.equal(importKnowledgePack(JSON.stringify(pack)).ok, false, `${kind} ${String(confidence)} must fail JSON import`);
    }
  });

  test(`#3783 ${kind} validation preserves finite [0,1] numbers`, () => {
    for (const confidence of [0, 0.5, 1]) {
      const pack = rawPack(kind, confidence);
      assert.equal(validateKnowledgePack(pack).ok, true);
      assert.equal(importKnowledgePack(JSON.stringify(pack)).ok, true);
    }
  });
}

test('#3783 create path fails closed on explicit malformed confidence', () => {
  for (const confidence of ['0.9', ['1'], true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createKnowledgePack({ confidence }), /confidence must be a finite number/);
    assert.throws(() => createKnowledgePack({ signatures:[{ confidence }] }), /confidence must be a finite number/);
    assert.throws(() => createKnowledgePack({ mappings:[{ confidence }] }), /confidence must be a finite number/);
  }
});

test('#3783 create path preserves defaults and numeric clamping', () => {
  const defaults = createKnowledgePack({ signatures:[{}], mappings:[{}] });
  assert.equal(defaults.confidence, 1);
  assert.equal(defaults.signatures[0].confidence, 1);
  assert.equal(defaults.mappings[0].confidence, 1);
  assert.equal(createKnowledgePack({ confidence:1.5 }).confidence, 1);
  assert.equal(createKnowledgePack({ confidence:-0.5 }).confidence, 0);
});
