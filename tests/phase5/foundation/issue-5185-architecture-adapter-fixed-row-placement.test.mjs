import assert from 'node:assert/strict';
import test from 'node:test';

import { ArchitectureAdapter } from '../../../js/architecture/index.js';

function adapter(definition = {}) {
  return new ArchitectureAdapter({
    id:'issue-5185-fixed-row-placement',
    instructionAlignment:2,
    fixedInstructionSize:4,
    ...definition,
  });
}

function assertPlacementRejected(result) {
  assert.equal(result.ok, false);
  assert.equal(result.code, 'instruction-placement');
}

test('fixed-width placement uses the same row grid as rowForAddress/addressForRow', () => {
  const architecture = adapter();
  const region = { vmAddr:0x1000n, size:0x40n };

  for (const rel of [0n, 4n, 8n]) {
    const address = region.vmAddr + rel;
    assert.equal(architecture.rowForAddress(region, address), Number(rel / 4n));
    assert.equal(architecture.addressForRow(region, Number(rel / 4n)), address);
    assert.deepEqual(architecture.validateInstructionPlacement(region, address, 4), { ok:true });
  }

  for (const rel of [2n, 6n]) {
    const address = region.vmAddr + rel;
    assert.equal(architecture.rowForAddress(region, address), null);
    assertPlacementRejected(architecture.validateInstructionPlacement(region, address, 4));
  }
});

test('equal fixed size/alignment contracts keep their existing valid and invalid positions', () => {
  const architecture = adapter({ instructionAlignment:4, fixedInstructionSize:4 });
  const region = { vmAddr:0x1000n, size:0x20n };

  assert.deepEqual(architecture.validateInstructionPlacement(region, 0x1004n, 4), { ok:true });
  assertPlacementRejected(architecture.validateInstructionPlacement(region, 0x1002n, 4));
});

test('2-byte fixed-width architecture remains valid on each 2-byte row boundary', () => {
  const architecture = adapter({ instructionAlignment:2, fixedInstructionSize:2 });
  const region = { vmAddr:0x1000n, size:0x20n };

  for (const row of [0, 1, 7]) {
    const address = architecture.addressForRow(region, row);
    assert.notEqual(address, null);
    assert.equal(architecture.rowForAddress(region, address), row);
    assert.deepEqual(architecture.validateInstructionPlacement(region, address, 2), { ok:true });
  }
});

test('variable-width default placement remains explicitly unsupported', () => {
  const architecture = adapter({ fixedInstructionSize:null });
  const result = architecture.validateInstructionPlacement({ vmAddr:0x1000n, size:0x20n }, 0x1000n, 4);

  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.equal(result.code, 'unsupported-architecture');
});

test('absolute architecture alignment remains independent from the fixed-width row grid', () => {
  const architecture = adapter({ instructionAlignment:4, fixedInstructionSize:4 });
  const misalignedRegion = { vmAddr:0x1001n, size:0x20n };

  assert.equal(architecture.rowForAddress(misalignedRegion, 0x1001n), null);
  assert.equal(architecture.addressForRow(misalignedRegion, 0), null);
  assertPlacementRejected(architecture.validateInstructionPlacement(misalignedRegion, 0x1001n, 4));

  const splitContract = adapter({ instructionAlignment:2, fixedInstructionSize:4 });
  const alignedRegion = { vmAddr:0x1002n, size:0x20n };
  assert.equal(splitContract.rowForAddress(alignedRegion, 0x1002n), 0);
  assert.equal(splitContract.addressForRow(alignedRegion, 1), 0x1006n);
  assert.deepEqual(splitContract.validateInstructionPlacement(alignedRegion, 0x1002n, 4), { ok:true });
  assert.deepEqual(splitContract.validateInstructionPlacement(alignedRegion, 0x1006n, 4), { ok:true });
});


test('a mapper-valid later row remains placement-valid when the region start itself is not aligned', () => {
  const architecture = adapter({ instructionAlignment:3, fixedInstructionSize:4 });
  const region = { vmAddr:0x1000n, size:0x40n };
  const address = 0x1008n;

  assert.equal(region.vmAddr % 3n, 1n);
  assert.equal(address % 3n, 0n);
  assert.equal(architecture.rowForAddress(region, address), 2);
  assert.equal(architecture.addressForRow(region, 2), address);
  assert.deepEqual(architecture.validateInstructionPlacement(region, address, 4), { ok:true });
});

test('every default fixed-width row address is accepted for an equal-length placement', () => {
  const architecture = adapter();
  const region = { vmAddr:0x2000n, size:0x80n };

  for (let row = 0; row < 16; row += 1) {
    const address = architecture.addressForRow(region, row);
    assert.notEqual(address, null);
    assert.equal(architecture.rowForAddress(region, address), row);
    assert.deepEqual(architecture.validateInstructionPlacement(region, address, 4), { ok:true });
  }
});
