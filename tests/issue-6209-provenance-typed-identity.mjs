import assert from 'node:assert/strict';
import { mergeSource, sourceOf, expr, structuralKey } from '../js/decompiler/ast/nodes.js';

console.log('Testing #6209: source provenance identity keeps its canonical type.');

// 1. Structured IDs no longer alias a canonical primitive identity on merge.
const merged = mergeSource({ ssaDefs: ['def-A'] }, { ssaDefs: [['def-A']] });
assert.deepEqual(merged.ssaDefs, []);
// The malformed entries were dropped, not string-aliased into one identity.
assert.equal(merged.ssaDefs.includes('def-A'), false);

// 2. The same root cause is closed for ir / ssaUses / rows / addresses.
assert.deepEqual(mergeSource({ ir: [7] }, { ir: [[7]] }).ir, [7]);
assert.deepEqual(mergeSource({ ir: ['7'] }, { ir: [['7']] }).ir, []);
assert.deepEqual(mergeSource({ ssaUses: [3] }, { ssaUses: [[3]] }).ssaUses, [3]);
assert.deepEqual(mergeSource({ rows: [2] }, { rows: [[2]] }).rows, [2]);
assert.deepEqual(mergeSource({ rows: ['2'] }, { rows: [['2']] }).rows, []);
assert.deepEqual(mergeSource({ addresses: [0x1000n] }, { addresses: [[0x1000n]] }).addresses, [0x1000n]);
assert.deepEqual(mergeSource({ addresses: ['0x1000'] }, { addresses: [['0x1000']] }).addresses, []);
assert.deepEqual(mergeSource({ ssaDefs: true }, { ssaDefs: {} }).ssaDefs, []);
assert.deepEqual(mergeSource({ rows: -1 }, { rows: 1.5 }).rows, []);

// 3. BigInt is canonical only for address provenance; numeric identity fields reject it.
assert.deepEqual(sourceOf({ addresses: [7n, 7] }).addresses, [7n, 7]);
for (const field of ['ssaDefs', 'ssaUses', 'ir', 'rows']) {
  assert.deepEqual(sourceOf({ [field]: [7n] })[field], [], `${field} must reject bigint identity`);
}

// 4. Canonical merge/dedupe results are preserved.
assert.deepEqual(mergeSource({ rows: [1] }, { rows: [1, 2] }).rows, [1, 2]);
assert.deepEqual(mergeSource({ addresses: [0x1000n] }, { addresses: [0x1000n] }).addresses, [0x1000n]);
assert.deepEqual(sourceOf({ ssaDef: 12, ssaUse: 14, irId: 3, row: 4, address: 0x1000n }).ssaDefs, [12]);

// 5. Malformed metadata never collides with the canonical load identity.
const location = { kind: 'stack', key: 'slot', name: 'slot', text: 'slot' };
const canonical = expr.load(location, 64, sourceOf({ ssaDefs: [7] }));
const aliased = expr.load(location, 64, sourceOf({ ssaDefs: [[7]] }));
const stringy = expr.load(location, 64, sourceOf({ ssaDefs: ['7'] }));
const bigIntSsa = expr.load(location, 64, sourceOf({ ssaDefs: [7n] }));
const bigIntIr = expr.load(location, 64, sourceOf({ ir: [7n] }));
const bigIntRow = expr.load(location, 64, sourceOf({ rows: [7n] }));
assert.notEqual(structuralKey(canonical), structuralKey(aliased));
assert.notEqual(structuralKey(canonical), structuralKey(stringy));
assert.notEqual(structuralKey(canonical), structuralKey(bigIntSsa));
assert.notEqual(structuralKey(canonical), structuralKey(bigIntIr));
assert.notEqual(structuralKey(canonical), structuralKey(bigIntRow));
assert.equal(structuralKey(canonical), structuralKey(expr.load(location, 64, sourceOf({ ssaDefs: [7] }))));

// 6. Explicit MemorySSA / loadIdentity paths keep their existing semantics.
assert.match(structuralKey(expr.load(location, 64, null, { memoryVersion: 5 })), /:mem:5$/);
assert.match(structuralKey(expr.load(location, 64, null, { loadIdentity: 'L9' })), /:load:"L9"$/);
assert.match(structuralKey(expr.load(location, 64, sourceOf({ ir: [9] }))), /:ir:9$/);
assert.match(structuralKey(expr.load(location, 64, sourceOf({ rows: [9] }))), /:row:9$/);
assert.match(structuralKey(expr.load(location, 64, null)), /:anon:\d+$/);

console.log('#6209: All tests passed successfully.');
