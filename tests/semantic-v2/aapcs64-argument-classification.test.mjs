import assert from 'node:assert/strict';
import { classifyCallArguments } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

// #3285 — AAPCS64 parameter metadata authorities are primitive safe integers.
{
  const good = classifyCallArguments({
    callPrototype: { args: [{ type: 'float', hfa: true, members: 4, bits: 32 }] },
  }, {});
  assert.deepEqual(good.arguments[0].regs, ['v0', 'v1', 'v2', 'v3']);
  assert.equal(good.arguments[0].bits, 32);

  const structured = classifyCallArguments({
    callPrototype: { args: [{ type: 'float', hfa: true, members: ['4'], bits: ['32'] }] },
  }, {});
  assert.deepEqual(
    structured.arguments[0].regs,
    ['v0'],
    'structured members must fall back to 1 register rather than being coerced via Number()',
  );
  assert.equal(
    structured.arguments[0].bits,
    64,
    'structured bits must fall back to default 64 bits rather than being coerced via Number()',
  );

  const nonHfa = classifyCallArguments({
    callPrototype: { args: [{ type: 'float', hfa: false, members: 4, bits: 32 }] },
  }, {});
  assert.equal(nonHfa.arguments[0].abiClass, 'fp', 'non-hfa float must be classified as fp');
  assert.equal(nonHfa.arguments[0].reg, 'v0');
}

// #3272 — AAPCS64 Stage C rule C.3: a spilled HFA exhausts NSRN.
{
  const result = classifyCallArguments({
    callPrototype: { args: [
      { abiClass: 'float', bits: 64 },
      { abiClass: 'float', bits: 64 },
      { abiClass: 'float', bits: 64 },
      { abiClass: 'float', bits: 64 },
      { abiClass: 'float', bits: 64 },
      { abiClass: 'float', bits: 64 },
      { abiClass: 'hfa', members: 3, bits: 64 },
      { abiClass: 'float', bits: 64 },
    ] },
  }, {});
  assert.equal(result.arguments[6].location, 'stack', 'spilled HFA must be assigned to the stack');
  assert.equal(result.arguments[6].bytes, 24, 'spilled 3-member 64-bit HFA must span 24 bytes');
  assert.equal(result.arguments[6].offset, 0, 'spilled HFA must start at stack offset 0');
  assert.equal(result.arguments[7].location, 'stack', 'post-spill FP arguments must stay on the stack');
  assert.equal(result.arguments[7].offset, 24, 'post-spill FP argument must use stack offset 24');

  const normal = classifyCallArguments({
    callPrototype: { args: [
      { abiClass: 'float', bits: 64 },
      { abiClass: 'float', bits: 64 },
    ] },
  }, {});
  assert.equal(normal.arguments[1].reg, 'v1', 'the non-spill register path is unchanged');
}

// #6082 — buildIR preserves startAddress=0n without collapsing to null.
{
  const { buildIR } = await import('../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js');
  const insn = { row: 0, address: 0n, mnemonic: 'nop', operands: [] };
  const model = {
    instructions: [insn],
    basicBlocks: [{ startRow: 0, endRow: 0, rows: [0] }],
    startAddress: 0n,
  };
  const ir = buildIR(model);
  assert.equal(ir.startAddress, 0n, 'startAddress=0n must be preserved as 0n');

  const nonzero = buildIR({ ...model, startAddress: 0x1000n });
  assert.equal(nonzero.startAddress, 0x1000n);

  const missing = buildIR({ ...model, startAddress: undefined });
  assert.equal(missing.startAddress, null);
}

console.log('aapcs64 argument classification: PASS');
