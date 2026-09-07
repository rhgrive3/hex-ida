import assert from 'node:assert/strict';
import { notableFunctions } from '../js/auto.js';

const funcs = [0x1000n, 0x1010n, 0x1020n];
const symbols = {
  funcs,
  functionCount: funcs.length,
  functionAt(addr) { return { start:addr, end:addr + 0x10n }; },
  nameAt(addr) { return `fn_${addr.toString(16)}`; },
};
const region = { vmAddr:0x1000n, size:0x40n };
const program = {
  functionRange(addr) { return { start:addr, end:addr + 0x10n }; },
  statsOf() { return { total:10, numeric:0, store:0, load:0, cmp:2 }; },
  callCountOf() { return 2; },
};

assert.equal(notableFunctions(program, symbols, region).length, 3);
assert.equal(notableFunctions(program, symbols, region, 1).length, 1);
assert.equal(notableFunctions(program, symbols, region, 0).length, 0);
assert.equal(notableFunctions(program, symbols, region, -1).length, 0);

for (const malformed of [['1'], [], true, false, '1', NaN, Infinity, 1.5, { valueOf() { return 1; } }]) {
  assert.equal(
    notableFunctions(program, symbols, region, malformed).length,
    3,
    `malformed limit ${String(malformed)} must not be coerced into a coverage-reducing count`,
  );
}

console.log('issue #2791 notableFunctions limit validation regression passed');
