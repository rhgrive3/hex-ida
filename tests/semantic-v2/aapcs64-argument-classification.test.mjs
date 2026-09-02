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
  assert.notDeepEqual(
    structured.arguments[0].regs,
    ['v0', 'v1', 'v2', 'v3'],
    'structured metadata must not mint a four-register HFA',
  );
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
  assert.equal(result.arguments[7].location, 'stack', 'post-spill FP arguments must stay on the stack');

  const normal = classifyCallArguments({
    callPrototype: { args: [
      { abiClass: 'float', bits: 64 },
      { abiClass: 'float', bits: 64 },
    ] },
  }, {});
  assert.equal(normal.arguments[1].reg, 'v1', 'the non-spill register path is unchanged');
}

console.log('aapcs64 argument classification: PASS');
