import assert from 'node:assert/strict';
import test from 'node:test';

import { factFromRange, rangeOf } from '../../../js/decompiler/phase8/range.js';

const j = (value) => JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item)));

const range = () => rangeOf(0n, 3n, 8);

test('#5222 boolean known-bit evidence degrades exactness to malformed', () => {
  const fact = factFromRange(range(), { status: 'exact', knownOne: true });
  assert.equal(fact.status, 'malformed', `BigInt(true)===1n must not become an exact known-one mask: ${j(fact)}`);
  assert.equal(j(fact.knownOne), '0n');
  const zero = factFromRange(range(), { status: 'exact', knownZero: false });
  assert.equal(zero.status, 'malformed');
});

test('#5222 array known-bit evidence degrades exactness to malformed', () => {
  const fact = factFromRange(range(), { status: 'exact', knownOne: ['8'] });
  assert.equal(fact.status, 'malformed', `BigInt(['8'])===8n must not become an exact known-bit mask: ${j(fact)}`);
});

test('#5222 boolean/array congruence fields degrade exactness to malformed', () => {
  const fact = factFromRange(range(), {
    status: 'exact',
    congruence: { modulus: true, remainder: ['0x10'] },
  });
  assert.equal(fact.status, 'malformed', `BigInt(true)/BigInt(['0x10']) must not pose as a residue class: ${j(fact)}`);
  assert.deepEqual(j(fact.congruence), { remainder: '0n', modulus: '1n' });
});

test('#5222 canonical bigint/number/string evidence keeps its exact authority', () => {
  const one = factFromRange(range(), { status: 'exact', knownOne: 1n });
  assert.equal(one.status, 'exact');
  assert.equal(j(one.knownOne), '1n');

  const two = factFromRange(range(), { status: 'exact', knownOne: 2 });
  assert.equal(two.status, 'exact');
  assert.equal(j(two.knownOne), '2n');

  const residue = factFromRange(range(), { status: 'exact', congruence: { modulus: 4, remainder: 3 } });
  assert.equal(residue.status, 'exact');
  assert.deepEqual(j(residue.congruence), { remainder: '3n', modulus: '4n' });
});
