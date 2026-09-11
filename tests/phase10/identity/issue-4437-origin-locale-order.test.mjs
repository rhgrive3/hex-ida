import assert from 'node:assert/strict';

import { createEvidenceNode, EvidenceGraph } from '../../../js/core/evidence/index.js';
import { stableStringify } from '../../../js/core/identity/index.js';
import { createOriginSet } from '../../../js/core/identity/origin.js';

const IDs = ['ä', 'z'];

function originInput(reverse = false) {
  const ids = reverse ? [...IDs].reverse() : [...IDs];
  return {
    byteRanges: ids.map((binaryId) => ({ binaryId, offset: 1n, length: 1n })).concat({ binaryId: ids[0], offset: 1n, length: 1n }),
    virtualRanges: ids.map((imageId) => ({ imageId, address: 0x100n, length: 1n })).concat({ imageId: ids[0], address: 0x100n, length: 1n }),
    instructionIds: [...ids, ids[0]],
    operationIds: [...ids, ids[0]],
    sourceLocations: ids.map((file) => ({ file: `${file}.c`, line: 1 })).concat({ file: `${ids[0]}.c`, line: 1 }),
    parentEntityIds: [...ids, ids[0]],
    transforms: ids.map((passId) => ({
      passId,
      passVersion: '1',
      ruleId: 'rule',
      consumedEntityIds: [...ids].reverse(),
      producedEntityIds: [...ids],
      preconditions: [],
      proofKind: 'proof',
    })).concat({
      passId: ids[0],
      passVersion: '1',
      ruleId: 'rule',
      consumedEntityIds: [...ids].reverse(),
      producedEntityIds: [...ids],
      preconditions: [],
      proofKind: 'proof',
    }),
  };
}

function withLocale(locale, callback) {
  const previous = String.prototype.localeCompare;
  const collator = new Intl.Collator(locale);
  String.prototype.localeCompare = function localeCompare(other) {
    return collator.compare(String(this), String(other));
  };
  try {
    return callback();
  } finally {
    String.prototype.localeCompare = previous;
  }
}

function legacyOrder(locale, values) {
  const collator = new Intl.Collator(locale);
  return values
    .map((value) => [stableStringify(value), value])
    .sort(([left], [right]) => collator.compare(left, right))
    .map(([, value]) => value);
}

// Prove that the fixture distinguishes the old locale-sensitive comparator.
assert.notDeepEqual(legacyOrder('en-US', IDs), legacyOrder('sv-SE', IDs));

const en = withLocale('en-US', () => createOriginSet(originInput()));
const sv = withLocale('sv-SE', () => createOriginSet(originInput()));
const ja = withLocale('ja-JP', () => createOriginSet(originInput()));
const reversed = withLocale('sv-SE', () => createOriginSet(originInput(true)));

for (const [name, origin] of [['en-US', en], ['sv-SE', sv], ['ja-JP', ja]]) {
  assert.deepEqual(origin.instructionIds, ['z', 'ä'], `${name}: instruction IDs use code-unit order`);
  assert.deepEqual(origin.operationIds, ['z', 'ä'], `${name}: operation IDs use code-unit order`);
  assert.deepEqual(origin.parentEntityIds, ['z', 'ä'], `${name}: parent IDs use code-unit order`);
  assert.equal(origin.byteRanges.length, 2, `${name}: byte ranges dedupe`);
  assert.equal(origin.virtualRanges.length, 2, `${name}: virtual ranges dedupe`);
  assert.equal(origin.sourceLocations.length, 2, `${name}: source locations dedupe`);
  assert.equal(origin.transforms.length, 2, `${name}: transforms dedupe`);
  assert.deepEqual(origin.transforms[0].consumedEntityIds, ['z', 'ä'], `${name}: transform inputs use code-unit order`);
  assert.deepEqual(origin.transforms[0].producedEntityIds, ['z', 'ä'], `${name}: transform outputs use code-unit order`);
}

assert.deepEqual(en, sv, 'OriginSet must not vary with locale');
assert.deepEqual(en, ja, 'OriginSet must not vary with locale');
assert.deepEqual(en, reversed, 'OriginSet must not vary with insertion order');
assert.equal(stableStringify(en), stableStringify(sv), 'canonical OriginSet serialization must be locale-invariant');

function evidenceNode(locale) {
  return withLocale(locale, () => createEvidenceNode({
    id: 'evidence-4437',
    family: 'SemanticEvidence',
    semanticKind: 'locale-invariant-provenance',
    origin: originInput(),
    payload: { source: 'issue-4437' },
  }));
}

// A logical duplicate created under another locale must remain equal to the
// existing node instead of being rejected as an evidence-id conflict.
const graph = new EvidenceGraph();
graph.addNode(evidenceNode('en-US'));
assert.doesNotThrow(() => graph.addNode(evidenceNode('sv-SE')));
assert.doesNotThrow(() => graph.addNode(evidenceNode('ja-JP')));
assert.equal(graph.allNodes().length, 1);

console.log('issue-4437 OriginSet locale-independent ordering tests passed');
