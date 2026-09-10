import assert from 'node:assert/strict';
import test from 'node:test';

import { ArchitectureAdapter } from '../../../js/architecture/index.js';

function adapter() {
  return new ArchitectureAdapter({
    id:'issue-4615-signed-hex-address',
    instructionAlignment:1,
    fixedInstructionSize:1,
  });
}

test('ArchitectureAdapter accepts +0x addresses advertised by its integer grammar', () => {
  const architecture = adapter();
  const region = { vmAddr:0n, size:0x40n };

  assert.equal(architecture.rowForAddress(region, '0x10'), 16);
  assert.equal(architecture.rowForAddress(region, '+0x10'), 16);
  assert.equal(architecture.rowForAddress(region, '  +0X10  '), 16);
  assert.deepEqual(architecture.validateInstructionPlacement(region, '+0x10', 1), { ok:true });
});

test('ArchitectureAdapter preserves the sign of -0x addresses', () => {
  const architecture = adapter();
  const region = { vmAddr:-0x20n, size:0x40n };

  assert.equal(architecture.rowForAddress(region, '-0x10'), 16);
  assert.equal(architecture.rowForAddress(region, '  -0X10  '), 16);
  assert.deepEqual(architecture.validateInstructionPlacement(region, '-0x10', 1), { ok:true });
  assert.equal(architecture.rowForAddress({ vmAddr:0n, size:1n }, '-0x0'), 0);
});

test('signed decimal behavior remains equivalent to signed hexadecimal behavior', () => {
  const architecture = adapter();
  const positive = { vmAddr:0n, size:0x40n };
  const negative = { vmAddr:-0x20n, size:0x40n };

  assert.equal(architecture.rowForAddress(positive, '+16'), architecture.rowForAddress(positive, '+0x10'));
  assert.equal(architecture.rowForAddress(negative, '-16'), architecture.rowForAddress(negative, '-0x10'));
});

test('signed hexadecimal normalization keeps arbitrary-width BigInt precision', () => {
  const architecture = adapter();
  const base = 0x123456789abcdef01234567890n;
  const region = { vmAddr:base, size:4n };
  const signedHex = `+0x${base.toString(16)}`;

  assert.equal(architecture.rowForAddress(region, signedHex), 0);
  assert.deepEqual(architecture.validateInstructionPlacement(region, signedHex, 1), { ok:true });
});

test('malformed and non-primitive addresses remain fail-closed', () => {
  const architecture = adapter();
  const region = { vmAddr:0n, size:0x40n };

  for (const value of ['+-0x10', '0x', '0xGG', '', '  ', true, ['0x10'], { value:'0x10' }, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(architecture.rowForAddress(region, value), null, `must reject ${String(value)}`);
    assert.equal(architecture.validateInstructionPlacement(region, value, 1).ok, false, `placement must reject ${String(value)}`);
  }
});
