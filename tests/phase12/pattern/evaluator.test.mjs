import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePattern, evaluatePattern, parsePattern, patternSupportTruth } from '../../../js/pattern/index.js';

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/profile-evidence/pattern-struct.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const fixturePattern = compilePattern(fixture.pattern, { snapshotId: fixture.snapshotId });
const fixtureResult = evaluatePattern(fixturePattern, {
  snapshotId: fixture.snapshotId,
  read: (offset, length) => Uint8Array.from(fixture.bytes).slice(Number(offset), Number(offset) + length),
  size: fixture.bytes.length,
});
assert.equal(fixtureResult.status, 'complete', 'canonical profile fixture must be evaluated by the production pattern runtime');
assert.equal(fixtureResult.value.fields.magic.value, 0x12345678);

const compiled = compilePattern('struct Header { magic: u32le; count: u8[4]; }', { snapshotId: 'snapshot-a' });
const bytes = Uint8Array.from([0x78, 0x56, 0x34, 0x12, 1, 2, 3, 4]);
const result = evaluatePattern(compiled, { snapshotId: 'snapshot-a', read: (offset, length) => bytes.slice(Number(offset), Number(offset) + length), size: bytes.length });
assert.equal(result.status, 'complete');
assert.equal(result.value.fields.magic.value, 0x12345678);
assert.equal(result.value.fields.count.length, 4);
assert.equal(result.value.fields.count.expand(2).value, 3);
assert.equal(result.value.fields.count.expand(2).provenance.offset, '6');
assert.equal(patternSupportTruth().mutation, 'unsupported');
assert.throws(() => evaluatePattern(compiled, bytes, { snapshotId: 'snapshot-b' }), /snapshot-mismatch/);

const dynamic = compilePattern({ kind: 'struct', name: 'Dynamic', fields: [
  { name: 'count', type: { kind: 'primitive', name: 'u8' } },
  { name: 'values', type: { kind: 'array', element: { kind: 'primitive', name: 'u8' }, count: 'count' } },
] });
const dynamicResult = evaluatePattern(dynamic, Uint8Array.from([3, 9, 8, 7]), { maxEntries: 1 });
assert.equal(dynamicResult.status, 'complete');
assert.equal(dynamicResult.value.fields.values.length, 3);
assert.equal(dynamicResult.value.fields.values.expand(0).value, 9);
const bomb = evaluatePattern(dynamic, Uint8Array.from([255, 1, 2, 3]), { maxEntries: 1 });
assert.equal(bomb.status, 'complete', 'lazy array declaration itself is bounded');
assert.equal(bomb.value.fields.values.expand(0).value, 1);
assert.throws(() => compilePattern('{"kind":"script","source":"while(true){}"}'), /pattern-root-must-be-struct/);

const duplicateModule = { kind: 'module', root: 'Root', structs: [
  { kind: 'struct', name: 'Item', fields: [{ name: 'a', type: { kind: 'primitive', name: 'u8' } }] },
  { kind: 'struct', name: 'Item', fields: [{ name: 'b', type: { kind: 'primitive', name: 'u16le' } }] },
  { kind: 'struct', name: 'Root', fields: [{ name: 'item', type: { kind: 'named', name: 'Item' } }] },
] };
assert.throws(() => compilePattern(duplicateModule), /pattern-duplicate-struct:Item/,
  'duplicate struct names must not compile with order-dependent resolution');
const distinctModule = { kind: 'module', root: 'Root', structs: [
  { kind: 'struct', name: 'Item', fields: [{ name: 'a', type: { kind: 'primitive', name: 'u8' } }] },
  { kind: 'struct', name: 'Root', fields: [{ name: 'item', type: { kind: 'named', name: 'Item' } }] },
] };
const distinctResult = evaluatePattern(compilePattern(distinctModule), Uint8Array.from([0x11]));
assert.equal(distinctResult.value.fields.item.fields.a.value, 0x11, 'distinct struct names keep working');
console.log('[phase12] bounded declarative pattern tests passed');
