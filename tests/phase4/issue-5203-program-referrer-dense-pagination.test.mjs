import assert from 'node:assert/strict';

import { ProgramIndex } from '../../js/program.js';

const target = 0xa000n;
const refFrom = new BigUint64Array([
  ...Array.from({ length:100 }, (_, i) => 0x1100n + BigInt(i * 4)),
  0x2100n,
]);
const refTo = new BigUint64Array(refFrom.length);
refTo.fill(target);
const refKind = new Uint8Array(refFrom.length);
refKind.fill(1);

const symbols = {
  gen:1,
  functionCount:2,
  functionStartAt(addr) {
    if (addr >= 0x1000n && addr < 0x2000n) return 0x1000n;
    if (addr >= 0x2000n && addr < 0x3000n) return 0x2000n;
    return null;
  },
};

function makeProgram(extra = {}) {
  return new ProgramIndex({
    callFrom:new BigUint64Array(0),
    callTo:new BigUint64Array(0),
    refFrom,
    refTo,
    refKind,
    completeness:{ complete:true, reasons:[] },
    ...extra,
  }, symbols, null);
}

const program = makeProgram();

const one = program.functionsReferencing(target, 1n, 1);
assert.deepEqual(one.map((entry) => entry.addr), [0x1000n]);
assert.equal(one[0].count, 100, 'all refs from the accepted dense function are counted');
assert.equal(one.queryLimited, true, 'an unseen second distinct function keeps limit=1 partial');
assert.equal(one.complete, false);

const two = program.functionsReferencing(target, 1n, 2);
assert.deepEqual(two.map((entry) => entry.addr), [0x1000n, 0x2000n], 'dense first function must not starve the later function');
assert.equal(two[0].count, 100);
assert.equal(two[1].count, 1);
assert.equal(two.queryLimited, false, 'exhausting the target range at the distinct-function limit is complete');
assert.equal(two.complete, true);

const zero = program.functionsReferencing(target, 1n, 0);
assert.equal(zero.length, 0);
assert.equal(zero.queryLimited, true, 'zero limit remains partial when matching referrers exist');
assert.equal(zero.complete, false);

const missing = program.functionsReferencing(0xdeadn, 1n, 2);
assert.equal(missing.length, 0);
assert.equal(missing.complete, true, 'complete source can prove no referrers for an exhausted target range');

const capped = makeProgram({ refsCapped:true }).functionsReferencing(target, 1n, 2);
assert.deepEqual(capped.map((entry) => entry.addr), [0x1000n, 0x2000n]);
assert.equal(capped.complete, false, 'source ref cap remains fail-closed after distinct enumeration');
assert.equal(capped.capped, true);
assert.equal(capped.incompleteReason, 'refs-source-capped');

console.log('issue #5203 dense ProgramIndex referrer regression passed');
