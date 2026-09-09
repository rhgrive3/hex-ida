import assert from 'node:assert/strict';
import { SIGNATURE_PACK_FORMAT, createKnowledgePack, importKnowledgePack, validateKnowledgePack } from '../js/signature/index.js';

const provenance = { source:'imported' };
function packWith(kind, confidence) {
  const signature = { architecture:'arm64', confidence:1, symbols:[], provenance, license:'test' };
  const mapping = { identity:'id', confidence:1, provenance, license:'test' };
  if (kind === 'signature') signature.confidence = confidence;
  else mapping.confidence = confidence;
  return { format:SIGNATURE_PACK_FORMAT, version:2, signatures:[signature], mappings:[mapping] };
}

for (const kind of ['signature','mapping']) {
  for (const confidence of ['0.9', ['1'], [0.5], true, false, {}, NaN, Infinity, -Infinity]) {
    assert.equal(validateKnowledgePack(packWith(kind, confidence)).ok, false, `${kind} malformed confidence must fail typed validation`);
    assert.equal(importKnowledgePack(JSON.stringify(packWith(kind, confidence))).ok, false);
  }
  for (const confidence of [0, 0.5, 1]) assert.equal(validateKnowledgePack(packWith(kind, confidence)).ok, true);
}

for (const input of [
  { confidence:'0.9' },
  { confidence:true },
  { confidence:[0.5] },
  { signatures:[{ architecture:'arm64', confidence:'1' }] },
  { mappings:[{ identity:'id', confidence:['1'] }] },
]) assert.throws(() => createKnowledgePack(input), TypeError);

assert.equal(createKnowledgePack({}).confidence, 1);
assert.equal(createKnowledgePack({ confidence:null }).confidence, 1);
assert.equal(createKnowledgePack({ confidence:0.4 }).confidence, 0.4);
assert.equal(createKnowledgePack({ confidence:2 }).confidence, 1, 'finite numeric create values retain clamp semantics');

console.log('issue-3783 knowledge pack confidence typed boundary: PASS');
