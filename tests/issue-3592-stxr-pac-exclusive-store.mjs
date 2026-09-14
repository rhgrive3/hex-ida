/**
 * #3592 blocks-base ARM64 exclusive-store + PAC branch/call instruction-model regression.
 *
 *   stxr/stlxr : operand 0 is the exclusive status-result WRITE, the data operand
 *                is a READ, and the memory width must come from the data register.
 *   braa/brab/braaz/brabz : authenticated indirect BRANCH (no destination).
 *   blraaz/blrabz         : authenticated indirect CALL.
 *
 * Guard: ordinary stores / blr / br / sttr semantics must not regress.
 */
import assert from 'node:assert/strict';
import { makeInstruction, buildBasicBlocks } from '../js/blocks-base.js';

console.log('Testing #3592 blocks-base exclusive-store + PAC branch/call...');

/* ── STXR / STLXR: status-result write, data/base read, data-derived width ── */

for (const mn of ['stxr', 'stlxr']) {
  const x = makeInstruction({ row:0, address:0x1000n, mn, ops:'w0, x1, [x2]' });
  assert.ok(x.writes.includes('x0'), `${mn} must write the status-result register x0`);
  assert.ok(x.reads.includes('x1') && x.reads.includes('x2'), `${mn} must read data x1 and base x2`);
  assert.ok(!x.reads.includes('x0'), `${mn} must not treat status x0 as an argument read`);
  assert.equal(x.memory && x.memory.kind, 'store', `${mn} must remain a memory store`);
  assert.equal(x.memory.size, 8, `${mn} X-data form must record an 8-byte memory access`);

  const w = makeInstruction({ row:0, address:0x1000n, mn, ops:'w0, w1, [x2]' });
  assert.equal(w.memory.size, 4, `${mn} W-data form must record a 4-byte memory access`);
  assert.ok(w.writes.includes('x0') && !w.reads.includes('x0'), `${mn} W-data keeps x0 write / no x0 read`);
}
console.log('  ok 1 stxr/stlxr status write + data-derived width (#3592)');

/* ── PAC authenticated indirect branch ──────────────────────────────────── */

for (const mn of ['braa', 'brab', 'braaz', 'brabz']) {
  const i = makeInstruction({ row:0, address:0x1000n, mn, ops:'x0, x1' });
  assert.equal(i.isBranch, true, `${mn} must be recognised as a branch`);
  assert.equal(i.isCall, false, `${mn} must not be a call`);
  assert.ok(i.reads.includes('x0') && i.reads.includes('x1'), `${mn} must read target and auth registers`);
  assert.ok(!i.writes.includes('x0'), `${mn} must not treat the target register as a destination write`);
  assert.equal(i.unknownMnemonic, false, `${mn} must not be flagged unknown`);
}

/* ── PAC authenticated indirect call (zero-modifier forms) ──────────────── */

for (const mn of ['blraaz', 'blrabz']) {
  const i = makeInstruction({ row:0, address:0x1000n, mn, ops:'x0' });
  assert.equal(i.isCall, true, `${mn} must be recognised as a call`);
  assert.equal(i.isBranch, true, `${mn} must be a terminator`);
  assert.ok(i.reads.includes('x0'), `${mn} must read its indirect target register`);
}
console.log('  ok 2 PAC authenticated branch/call classification (#3592)');

/* ── CFG: an unconditional indirect authenticated branch terminates its block ── */

const insns = [
  makeInstruction({ row:0, address:0x1000n, mn:'mov', ops:'x0, x1' }),
  makeInstruction({ row:1, address:0x1004n, mn:'braa', ops:'x0, x1' }),
  makeInstruction({ row:2, address:0x1008n, mn:'mov', ops:'x2, x3' }),
];
const cfg = buildBasicBlocks(insns, {});
const braaBlock = cfg.blocks.find((b) => b.rows.includes(1));
const nextBlock = cfg.blocks.find((b) => b.startRow === 2);
assert.ok(braaBlock && nextBlock, 'braa must terminate its block and make row 2 a new block leader');
assert.equal(braaBlock.endRow, 1, 'the braa block must terminate on the braa row');
console.log('  ok 3 braa is a CFG terminator with no fallthrough (#3592)');

/* ── Non-regression: ordinary stores, blr, br, sttr keep semantics ──────── */

const str = makeInstruction({ row:0, address:0x1000n, mn:'str', ops:'x0, [x1]' });
assert.deepEqual(str.writes, [], 'ordinary str must keep no destination write');
assert.ok(str.reads.includes('x0') && str.reads.includes('x1'), 'ordinary str reads value and base');

const sttr = makeInstruction({ row:0, address:0x1000n, mn:'sttr', ops:'x0, [x1]' });
assert.deepEqual(sttr.writes, [], 'sttr must keep no destination write');

const blr = makeInstruction({ row:0, address:0x1000n, mn:'blr', ops:'x0' });
assert.equal(blr.isCall, true, 'blr remains a call');
assert.ok(blr.writes.includes('x30'), 'blr keeps the link-register write');

const br = makeInstruction({ row:0, address:0x1000n, mn:'br', ops:'x0' });
assert.equal(br.isBranch, true, 'br remains a branch');
assert.deepEqual(br.writes, [], 'br must not write its target register');

const blraa = makeInstruction({ row:0, address:0x1000n, mn:'blraa', ops:'x0, x1' });
assert.equal(blraa.isCall, true, 'blraa remains a call');
assert.ok(blraa.reads.includes('x0') && blraa.reads.includes('x1'), 'blraa reads target and auth');
console.log('  ok 4 ordinary store / blr / br / blraa semantics preserved (#3592)');

console.log('#3592 blocks-base exclusive-store + PAC regression passed');
