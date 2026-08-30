import assert from 'node:assert/strict';
import { foldShapes } from '../js/shapes.js';
import { recoverSchemas } from '../js/schema.js';

// ── #2618: foldShapes preserves unsupported and completeness metadata ──
{
  // Unsupported scan
  const unsupportedScan = {
    unsupported: true,
    incompleteReason: 'unsupported-architecture',
    count: 0,
  };
  const foldedUnsupported = foldShapes(unsupportedScan);
  assert.equal(foldedUnsupported.unsupported, true);
  assert.equal(foldedUnsupported.complete, false);
  assert.equal(foldedUnsupported.incompleteReason, 'unsupported-architecture');

  // Capped scan
  const cappedScan = {
    capped: true,
    count: 0,
  };
  const foldedCapped = foldShapes(cappedScan);
  assert.equal(foldedCapped.capped, true);
  assert.equal(foldedCapped.complete, false);

  // Complete scan
  const completeScan = {
    count: 0,
    complete: true,
  };
  const foldedComplete = foldShapes(completeScan);
  assert.equal(foldedComplete.unsupported, false);
  assert.equal(foldedComplete.complete, true);
}

// ── #2614: recoverSchemas returns unsupported completeness on non-ARM64 architectures ──
{
  const fakeProgram = {
    architecture: 'x86_64',
    functionsReferencing() { return [{ addr: 0x1000n }]; },
    functionRange() { return { start: 0x1000n, end: 0x1100n }; },
  };

  const schemas = await recoverSchemas({
    strings: [{ addr: 0x2000n, text: 'config.json' }],
    program: fakeProgram,
    read: async () => new Uint8Array(256),
    architecture: 'x86_64',
  });

  assert.equal(schemas.length, 0);
  assert.equal(schemas.unsupported, true);
  assert.equal(schemas.complete, false);
  assert.equal(schemas.incompleteReason, 'unsupported-architecture');
}

console.log('Issue #2614, #2618 regression tests PASS!');
