import assert from 'node:assert/strict';
import test from 'node:test';
import { readCilDefinitions } from '../../../js/managed/cil/metadata-definitions.js';

test('issue #8704: TypeSpec rows charge the object budget before materialization', () => {
  const bytes = new Uint8Array(2);
  const view = new DataView(bytes.buffer);
  const rowCounts = new Array(64).fill(0);
  const tableOffsets = new Array(64).fill(null);
  const rowSizes = new Array(64).fill(0);
  rowCounts[0x1b] = 1;
  tableOffsets[0x1b] = 0;
  rowSizes[0x1b] = 2;

  let objectCharges = 0;
  let operationCharges = 0;
  const admission = {
    chargeObjects(count) {
      objectCharges += count;
      const error = new Error('cil-metadata-resource-limit-objects');
      error.code = 'cil-metadata-resource-limit-objects';
      throw error;
    },
    chargeOperations(count = 1) { operationCharges += count; },
    chargeStringBytes() {},
  };

  assert.throws(
    () => readCilDefinitions(bytes, view, {
      rowCounts,
      tableOffsets,
      rowSizes,
      heapSizes: 0,
      valid: 1n << 0x1bn,
    }, null, null, null, admission),
    error => error?.code === 'cil-metadata-resource-limit-objects',
  );
  assert.equal(objectCharges, 1, 'the single TypeSpec row must be admitted as one retained object');
  assert.equal(operationCharges, 0, 'object admission must happen before decoding/materializing the TypeSpec row');
});
