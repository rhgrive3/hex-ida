import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../../js/blocks.js';
import { FACT } from '../../../js/semantic.js';
import { createAgentTools } from '../../../js/agent/tools.js';
import { createHexToolRegistry } from '../../../js/ai/tools/index.js';

let row = 0;
function inst(mn, ops = '') {
  const current = row++;
  return { row: current, address: 0x1000n + BigInt(current * 4), mn, ops };
}

const functionAddress = 0x1000n;
const model = buildSemanticModel([
  inst('ldr', 'w8, [x0, #0x140]'), // 0x140 = 320
  inst('add', 'w8, w8, #1'),
  inst('str', 'w8, [x0, #0x140]'),
  inst('ret', ''),
], [], []);

const tools = createAgentTools({ analyze: async () => model }, { maxFunctions: 4 });
const facts = await tools.get_semantic_facts(functionAddress);
const rmw = facts.results.find((fact) => fact.kind === FACT.RMW);
assert.ok(rmw?.location?.key, 'fixture must produce a canonical field key');
assert.equal(rmw.location.disp, 320n);

const exactKey = rmw.location.key;
assert.match(exactKey, /\+320$/);
const differentCanonicalKey = exactKey.replace(/\+320$/, '+32');
assert.notEqual(differentCanonicalKey, exactKey);
assert.equal(exactKey.includes(differentCanonicalKey), true, 'fixture must exercise the old substring-match bug');

const exact = await tools.verify_field_update(functionAddress, { key: exactKey });
assert.equal(exact.verified, true, 'exact canonical key must remain verifiable');
assert.equal(exact.total, 1);

const wrong = await tools.verify_field_update(functionAddress, { key: differentCanonicalKey });
assert.equal(wrong.verified, false, 'a different canonical key must not verify via substring matching');
assert.equal(wrong.total, 0);
assert.deepEqual(wrong.evidence, []);

const wrongWriters = await tools.find_field_writers(functionAddress, { key: differentCanonicalKey });
const wrongReaders = await tools.find_field_readers(functionAddress, { key: differentCanonicalKey });
assert.equal(wrongWriters.total, 0, 'writers must use exact canonical key identity');
assert.equal(wrongReaders.total, 0, 'readers must use exact canonical key identity');

const caseVariant = exactKey.toUpperCase();
if (caseVariant !== exactKey) {
  const wrongCase = await tools.verify_field_update(functionAddress, { key: caseVariant });
  assert.equal(wrongCase.verified, false, 'canonical key identity must remain case-sensitive');
}

const conflictingSelector = await tools.verify_field_update(functionAddress, { key: exactKey, offset: 32 });
assert.equal(conflictingSelector.verified, false, 'combined selectors must satisfy every supplied identity constraint');

const offset = await tools.verify_field_update(functionAddress, { offset: 320 });
assert.equal(offset.verified, true, 'offset selector semantics must not regress');
assert.equal(offset.total, 1);

const registry = createHexToolRegistry({
  addressExists: () => true,
  analyze: async () => model,
}, { maxFunctions: 4 });
const registryWrong = await registry.execute('verify_field_update', {
  functionAddress: '0x1000',
  field: { key: differentCanonicalKey },
}, { scope: 'function' });
assert.equal(registryWrong.result.verified, false, 'actual createHexToolRegistry must preserve exact field identity');
assert.equal(registryWrong.result.total, 0);

console.log('issue-4987 agent field key exact regression: ok');
