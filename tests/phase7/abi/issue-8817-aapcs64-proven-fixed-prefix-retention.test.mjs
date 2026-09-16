import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../../js/targets/abi/index.js';

// #8817: semanticAbiAdapter().argumentLocations() collapsed the whole result to
// [] as soon as ANY argument beyond a proven fixed prefix had an unproven
// scalar layout, destroying placements the classifier itself had already proved
// (mustUse:true / possible:false / exact pointer in x0). That is an
// under-approximation, not fail-closed behaviour. The fix keeps the maximal
// proof-bearing prefix and fails closed only at the uncertainty frontier, while
// never promoting function/call completeness.

const aapcs = () => semanticAbiAdapter(AAPCS64_ABI, { architecture: 'arm64', platform: 'linux' });

test('a proven fixed prefix survives a later unproven scalar-layout argument', () => {
  const functionPrototype = { parameters: [{ type: 'Player *' }, { type: 'int32' }] };
  const locations = aapcs().argumentLocations({ functionPrototype });
  assert.ok(locations.length >= 1, 'the classifier-proven x0 must not be erased by a later unknown argument');
  const x0 = locations.find((entry) => entry.index === 0);
  assert.ok(x0, 'index 0 location is retained');
  assert.equal(x0.reg, 'x0');
  assert.equal(x0.exact, true, 'a proven pointer prefix stays exact');
  assert.equal(x0.mustUse, true);
  assert.equal(x0.possible, false);
});

test('an unproven leading argument does not let a later argument be speculated exact', () => {
  const functionPrototype = { parameters: [{ type: 'int32' }, { type: 'Player *' }] };
  const locations = aapcs().argumentLocations({ functionPrototype });
  assert.equal(locations.length, 0, 'nothing may be promoted to exact across the uncertainty frontier');
  assert.ok(locations.every((entry) => entry.exact !== true));
});

test('retaining the prefix never promotes function/call completeness', () => {
  const functionPrototype = { parameters: [{ type: 'Player *' }, { type: 'int32' }] };
  const call = aapcs().classifyCall({ call: { callPrototype: functionPrototype } });
  assert.notEqual(call.completeness, 'complete', 'a partial ABI evidence result stays non-complete');
  assert.equal(call.partial, true);
});

test('a malformed aggregate argument descriptor still publishes no locations', () => {
  const members = [
    { type: 'uint64', bits: 64, bytes: 8, byteOffset: 0 },
    { type: 'uint64', bits: 64, bytes: 8, byteOffset: 8 },
  ];
  const functionPrototype = {
    parameters: [{ type: 'struct D', aggregate: true, bits: 128, bytes: 16, members, padding: 'bad' }],
  };
  assert.deepEqual(aapcs().argumentLocations({ functionPrototype }), [],
    'malformed evidence must never gain an unknown candidate list from this relaxation');
});

test('an unknown prototype still yields an explicitly conservative candidate set', () => {
  const locations = aapcs().argumentLocations({});
  assert.ok(locations.length > 0, 'the unknown-prototype path is unchanged');
  assert.equal(locations.every((entry) => entry.possible === true && entry.mustUse === false
    && entry.exact === false && entry.certainty === 'unknown'), true);
});

test('a fully-proven (non-partial) prototype is unaffected', () => {
  const functionPrototype = { parameters: [{ type: 'int64', bits: 64 }, { type: 'int64', bits: 64 }] };
  const locations = aapcs().argumentLocations({ functionPrototype });
  assert.ok(locations.length >= 2);
  assert.equal(locations[0].exact, true);
  assert.equal(locations[0].reg, 'x0');
  assert.equal(locations[1].exact, true);
  assert.equal(locations[1].reg, 'x1');
});
