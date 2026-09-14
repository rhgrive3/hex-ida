/**
 * #3791 analyzeFunction: atomic exclusive PAIR loads (LDXP/LDAXP) carry two GP
 * destinations. The second destination must be a WRITE, not an argument read.
 *
 *   ldxp x0, x1, [x2]  -> writes {x0,x1}, reads {x2}, argRegs [2]
 *   ldaxp x3, x4, [x5] -> second destination is not an input
 *   ldp / ldpsw / ldnp -> non-regression
 *   category coverage  -> ldxp/ldaxp are loads; stxp/stlxp are stores
 */
import assert from 'node:assert/strict';
import { analyzeFunction } from '../../js/analyze.js';
import { categoryOf } from '../../js/arm64.js';
import { CHUNK_ROWS } from '../../js/backend.js';

console.log('Testing #3791 analyzeFunction LDXP/LDAXP pair destination...');

function backend(lines) {
  const mn = [], ops = [];
  lines.forEach((t, i) => { const s = t.indexOf(' '); mn[i] = s < 0 ? t : t.slice(0, s); ops[i] = s < 0 ? '' : t.slice(s + 1); });
  return { fetchChunk: async (_id, c) => (c === 0 ? { mn, ops } : { mn: [], ops: [] }), readAt: async () => ({ found: false, bytes: new Uint8Array() }) };
}
async function analyze(lines) {
  const region = { id: 'issue-3791', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(backend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

/* acceptance 1: ldxp x0,x1,[x2] -> argRegs [2] */
const ldxp = await analyze(['ldxp x0, x1, [x2]', 'ret']);
assert.deepEqual(ldxp.argRegs, [2], 'ldxp must not count its second destination x1 as an argument');
assert.ok(ldxp.loads >= 1, 'ldxp must be counted as a load');

/* acceptance 2: ldaxp x3,x4,[x5] -> second destination not an input */
const ldaxp = await analyze(['ldaxp x3, x4, [x5]', 'ret']);
assert.deepEqual(ldaxp.argRegs, [5], 'ldaxp must treat operand 1 as a destination, not an input');

/* acceptance 4: a later read of the second destination is not promoted to input */
const later = await analyze(['ldxp x0, x1, [x2]', 'add x3, x1, x1', 'ret']);
assert.deepEqual(later.argRegs, [2], 'reading x1 after ldxp must not resurface it as a function input');

/* acceptance 3: ordinary pair loads keep working */
for (const mn of ['ldp', 'ldpsw', 'ldnp']) {
  const r = await analyze([`${mn} x0, x1, [x2]`, 'ret']);
  assert.deepEqual(r.argRegs, [2], `${mn} second destination must remain a write (non-regression)`);
}

/* sibling category lock */
assert.equal(categoryOf('ldxp'), 'load', 'ldxp must classify as a load');
assert.equal(categoryOf('ldaxp'), 'load', 'ldaxp must classify as a load');
assert.equal(categoryOf('stxp'), 'store', 'stxp must classify as a store');
assert.equal(categoryOf('stlxp'), 'store', 'stlxp must classify as a store');

console.log('#3791 analyzeFunction LDXP/LDAXP pair destination passed');
