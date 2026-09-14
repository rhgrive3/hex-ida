import assert from 'node:assert/strict';
import { canonicalJson } from '../../tools/validation/machine-effects/differential-harness.mjs';

const objectCycle = {};
objectCycle.self = objectCycle;
assert.throws(() => canonicalJson(objectCycle), /non-serializable-cycle/);

const arrayCycle = [];
arrayCycle.push(arrayCycle);
assert.throws(() => canonicalJson(arrayCycle), /non-serializable-cycle/);

const mapCycle = new Map();
mapCycle.set('self', mapCycle);
assert.throws(() => canonicalJson(mapCycle), /non-serializable-cycle/);

const setCycle = new Set();
setCycle.add(setCycle);
assert.throws(() => canonicalJson(setCycle), /non-serializable-cycle/);

const shared = { value: 1 };
assert.equal(canonicalJson([shared, shared]), '[{"value":1},{"value":1}]');

console.log('issue-2308 canonical container cycle guard: PASS');
