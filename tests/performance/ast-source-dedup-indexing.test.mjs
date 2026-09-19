import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceOf, mergeSource } from '../../js/decompiler/ast/nodes.js';

test('wide source provenance switches from prefix scans to indexed deduplication', () => {
  const values = Array.from({ length: 512 }, (_, index) => index);
  const originalSome = Array.prototype.some;
  let widePrefixScans = 0;
  Array.prototype.some = function patchedSome(...args) {
    if (this.length >= 8) widePrefixScans += 1;
    return Reflect.apply(originalSome, this, args);
  };
  let source;
  try { source = sourceOf({ rows: values }); }
  finally { Array.prototype.some = originalSome; }
  assert.deepEqual(source.rows, values);
  assert.ok(widePrefixScans <= 2, `wide canonical source performed ${widePrefixScans} prefix scans`);
});

test('mergeSource keeps first-occurrence order while indexing wide accumulated provenance', () => {
  const inputs = Array.from({ length: 256 }, (_, index) => ({ rows:[index % 128], ir:[`ir_${index % 64}`] }));
  const originalSome = Array.prototype.some;
  let widePrefixScans = 0;
  Array.prototype.some = function patchedSome(...args) {
    if (this.length >= 8) widePrefixScans += 1;
    return Reflect.apply(originalSome, this, args);
  };
  let merged;
  try { merged = mergeSource(...inputs); }
  finally { Array.prototype.some = originalSome; }
  assert.deepEqual(merged.rows, Array.from({ length:128 }, (_, index) => index));
  assert.deepEqual(merged.ir, Array.from({ length:64 }, (_, index) => `ir_${index}`));
  assert.ok(widePrefixScans <= 4, `wide merged source performed ${widePrefixScans} prefix scans`);
});
