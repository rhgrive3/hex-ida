import assert from 'node:assert/strict';
import test from 'node:test';

import { ArchitectureAdapter } from '../../../js/architecture/index.js';

function adapter(definition = {}) {
  return new ArchitectureAdapter({
    id:'issue-4613-alignment',
    instructionAlignment:4,
    fixedInstructionSize:4,
    ...definition,
  });
}

test('ArchitectureAdapter default mapping preserves aligned fixed-width instruction locations', () => {
  const architecture = adapter();
  const region = { vmAddr:0x1000n, size:0x20n };

  assert.equal(architecture.rowForAddress(region, 0x1000n), 0);
  assert.equal(architecture.rowForAddress(region, 0x1004n), 1);
  assert.equal(architecture.addressForRow(region, 1), 0x1004n);
  assert.deepEqual(architecture.validateInstructionPlacement(region, 0x1004n, 4), { ok:true });
});

test('ArchitectureAdapter rejects a region-relative row whose absolute VM address violates instruction alignment', () => {
  const architecture = adapter();
  const region = { vmAddr:0x1001n, size:0x20n };

  assert.equal(architecture.rowForAddress(region, 0x1001n), null);
  assert.equal(architecture.addressForRow(region, 0), null);

  const placement = architecture.validateInstructionPlacement(region, 0x1001n, 4);
  assert.equal(placement.ok, false);
  assert.equal(placement.code, 'instruction-placement');
  assert.equal(placement.architecture, architecture.id);
});

test('ArchitectureAdapter still rejects a misaligned address inside an aligned region', () => {
  const architecture = adapter();
  const region = { vmAddr:0x1000n, size:0x20n };

  assert.equal(architecture.rowForAddress(region, 0x1002n), null);
  const placement = architecture.validateInstructionPlacement(region, 0x1002n, 4);
  assert.equal(placement.ok, false);
  assert.equal(placement.code, 'instruction-placement');
});

test('instructionAlignment is not replaced by absolute fixedInstructionSize alignment', () => {
  const architecture = adapter({ instructionAlignment:2, fixedInstructionSize:4 });
  const region = { vmAddr:0x1002n, size:0x20n };

  assert.equal(architecture.rowForAddress(region, 0x1002n), 0);
  assert.equal(architecture.rowForAddress(region, 0x1006n), 1);
  assert.equal(architecture.addressForRow(region, 0), 0x1002n);
  assert.equal(architecture.addressForRow(region, 1), 0x1006n);
  assert.deepEqual(architecture.validateInstructionPlacement(region, 0x1002n, 4), { ok:true });
});

test('instruction length validation remains unchanged', () => {
  const architecture = adapter();
  const region = { vmAddr:0x1000n, size:0x20n };

  const placement = architecture.validateInstructionPlacement(region, 0x1000n, 8);
  assert.equal(placement.ok, false);
  assert.equal(placement.code, 'instruction-placement');
});
