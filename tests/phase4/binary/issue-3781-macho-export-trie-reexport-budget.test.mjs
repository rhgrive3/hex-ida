import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { createMachOMetadataBudget } from '../../../js/binary/macho-budget.js';
import { parseExportTrie } from '../../../js/binary/macho-dyld.js';

function singleTerminalTrie(name, payload) {
  const edge = new TextEncoder().encode(name);
  const childOffset = 4 + edge.length;
  assert.ok(childOffset < 0x80 && payload.length < 0x80);
  return Uint8Array.from([
    0x00, 0x01,
    ...edge, 0x00,
    childOffset,
    payload.length,
    ...payload,
    0x00,
  ]);
}

function terminalNode(payload) {
  assert.ok(payload.length < 0x80);
  return Uint8Array.from([payload.length, ...payload, 0x00]);
}

function twoTerminalTrie(payloadA, payloadB) {
  const nodeA = terminalNode(payloadA);
  const nodeB = terminalNode(payloadB);
  const offsetA = 8;
  const offsetB = offsetA + nodeA.length;
  assert.ok(offsetB < 0x80);
  return Uint8Array.from([
    0x00, 0x02,
    0x61, 0x00, offsetA,
    0x62, 0x00, offsetB,
    ...nodeA,
    ...nodeB,
  ]);
}

function reexportPayload(ordinal = 1, imported = '') {
  const name = new TextEncoder().encode(imported);
  assert.ok(ordinal >= 0 && ordinal < 0x80 && name.length < 0x80);
  return [0x08, ordinal, ...name, 0x00];
}

function makeImage() {
  const imageBase = 0x100000000n;
  return {
    imageBase,
    exports: [],
    functions: [],
    metadata: {},
    warnings: [],
    sectionAt(address) {
      return address >= imageBase && address < imageBase + 0x1000n
        ? { perms: { execute: true } }
        : null;
    },
  };
}

function runBytes(bytes, limits) {
  const image = makeImage();
  const budget = createMachOMetadataBudget(image, { limits });
  const status = parseExportTrie(
    new ByteView(bytes),
    { offset: 0, size: bytes.length },
    image,
    budget,
  );
  return { image, budget, status };
}

function run(name, payload, limits) {
  return runBytes(singleTerminalTrie(name, payload), limits);
}

// Normal export output already obeys the output object ceiling.
{
  const { image, budget, status } = run('ex', [0x02, 0x20], { objects: 2 });
  assert.equal(status.complete, false);
  assert.equal(status.budgetExceeded, true);
  assert.equal(image.exports.length, 0);
  assert.equal(budget.used.objects, 2);
}

// Re-export must fail at the same boundary instead of materializing a third object.
{
  const { image, budget, status } = run('re', reexportPayload(1, 'target'), { objects: 2 });
  assert.equal(status.complete, false);
  assert.equal(status.budgetExceeded, true);
  assert.equal(image.exports.length, 0);
  assert.equal(budget.used.objects, 2);
  assert.ok(image.warnings.some((warning) => warning.includes('shared metadata output budget exceeded')));
}

// The retained prefix + imported target are both charged before publication.
{
  const { image, budget, status } = run('re', reexportPayload(1, 'target'), { objects: 3, stringBytes: 15 });
  assert.equal(status.complete, false);
  assert.equal(status.budgetExceeded, true);
  assert.equal(image.exports.length, 0);
  assert.equal(budget.used.stringBytes, 0);
}

{
  const { image, budget, status } = run('re', reexportPayload(1, 'target'), { objects: 3, stringBytes: 16 });
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].name, 're');
  assert.equal(image.exports[0].kind, 'reexport');
  assert.equal(image.exports[0].ordinal, 1);
  assert.equal(image.exports[0].imported, 'target');
  assert.equal(budget.used.objects, 3);
  assert.equal(budget.used.stringBytes, 16);
}

// Empty imported-name preserves alias semantics and charges only the retained prefix.
{
  const { image, budget, status } = run('re', reexportPayload(1), { objects: 3, stringBytes: 4 });
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].imported, null);
  assert.equal(budget.used.objects, 3);
  assert.equal(budget.used.stringBytes, 4);
}

// Multiple re-exports cannot materialize beyond the object ceiling.
{
  const bytes = twoTerminalTrie(reexportPayload(1), reexportPayload(2));
  const { image, budget, status } = runBytes(bytes, { objects: 4 });
  assert.equal(status.complete, false);
  assert.equal(status.budgetExceeded, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].name, 'a');
  assert.equal(budget.used.objects, 4);
}

console.log('issue-3781-macho-export-trie-reexport-budget: PASS');
