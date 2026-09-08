import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createKnowledgePack,
  validateKnowledgePack,
  SIGNATURE_PACK_FORMAT,
  SIGNATURE_PACK_VERSION,
} from '../js/signature/index.js';

test('#6100 signatures:[null] does not leak a raw TypeError', () => {
  let pack = null;
  let threw = null;
  try {
    pack = createKnowledgePack({ signatures: [null] });
  } catch (error) {
    threw = error;
  }
  assert.equal(threw, null);
  assert.ok(pack);
  assert.equal(pack.signatures.length, 1);
  assert.equal(pack.signatures[0].architecture, 'any');
  assert.deepEqual(pack.signatures[0].symbols, []);
});

test('#6100 mappings:[null] does not leak a raw TypeError', () => {
  let pack = null;
  let threw = null;
  try {
    pack = createKnowledgePack({ mappings: [null] });
  } catch (error) {
    threw = error;
  }
  assert.equal(threw, null);
  assert.ok(pack);
  assert.equal(pack.mappings.length, 1);
  assert.equal(pack.mappings[0].identity, null);
  assert.equal(pack.mappings[0].confirmation, 'weak-inferred');
});

test('#6100 primitive and array entries normalize to default entries, not crashes', () => {
  const pack = createKnowledgePack({ signatures: [42, ['x'], 'str', null], mappings: [7, false, null] });
  for (const entry of pack.signatures) {
    assert.equal(typeof entry, 'object');
    assert.equal(entry.architecture, 'any');
    assert.equal(entry.confidence, 1);
  }
  for (const entry of pack.mappings) {
    assert.equal(typeof entry, 'object');
    assert.equal(entry.negative, false);
  }
});

test('#6100 well-formed signature/mapping entries keep existing normalization', () => {
  const pack = createKnowledgePack({
    architecture: 'arm64',
    confidence: 0.5,
    signatures: [
      { architecture: 'x86_64', name: 'mylib', symbols: ['a', 'a', 'b'], confidence: 1.5 },
    ],
    mappings: [
      { identity: 'ident-1', name: 'func', roles: ['role'], negative: true, confidence: 0.25 },
    ],
  });
  const sig = pack.signatures[0];
  assert.equal(sig.architecture, 'x86_64');
  assert.equal(sig.name, 'mylib');
  assert.deepEqual(sig.symbols, ['a', 'b']);
  assert.equal(sig.confidence, 1);
  const map = pack.mappings[0];
  assert.equal(map.identity, 'ident-1');
  assert.equal(map.negative, true);
  assert.equal(map.confidence, 0.25);
});

test('#6100 validateKnowledgePack fail-closed shape gate is not weakened', () => {
  const bad = { format: SIGNATURE_PACK_FORMAT, version: SIGNATURE_PACK_VERSION, signatures: [null], mappings: [] };
  const result = validateKnowledgePack(bad);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'knowledge pack entry must be an object');

  const good = validateKnowledgePack(createKnowledgePack({}));
  assert.equal(good.ok, true);
});
