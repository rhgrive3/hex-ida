import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/index.js';

// #5418: the MachineEffects -> legacy v1 address projection minted legacy
// `uxtw`/`sxtw` index modifiers for every zero-extend/sign-extend expression,
// regardless of extension width. `uxtw`/`sxtw` mean "extend the low 32-bit
// word to the 64-bit address"; re-labelling other widths changes the effective
// address (e.g. a 64->64 sign-extend became "use the low 32 bits signed").
// The modifier may only be minted when 32->64 is proven, matching the
// Semantic IR v2->v1 `extensionToken()` gate (toBits === 64 && fromBits === 32).

const INST = createInstructionId({
  binaryId: 'bin_5418', sliceId: 'slice_5418', virtualAddress: 0x1000n,
  decodeMode: 'a64', decoderSemanticVersion: '1',
});
const ORIGIN = {
  instructionIds: [INST],
  byteRanges: [{ binaryId: 'bin_5418', start: 0x20n, end: 0x24n }],
  virtualRanges: [{ imageId: 'image_5418', sliceId: 'slice_5418', start: 0x1000n, end: 0x1004n }],
};
const reg = (id, bits = 64) => createRegisterValue(id, bits);

function loweredAddressWith(right) {
  const loaded = createTemporaryValue('v', createBitVectorValue(64));
  const access = createMemoryAccess({
    space: 'memory',
    addressExpr: {
      kind: 'add',
      left: { kind: 'register', registerId: 'x0', widthBits: 64 },
      right,
    },
    widthBits: 64,
    alignment: 8,
    endian: 'little',
  });
  const input = createMachineEffectBundle({
    instructionId: INST,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [createMachineOperation({ id: 'load', kind: 'memory-read', access, value: loaded })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: ORIGIN,
    completeness: 'exact',
    statePreservation: undefined,
  });
  const lowered = lowerMachineEffectsToLegacyV1(input);
  return lowered.find((x) => x.op === OP.LOAD)?.addr ?? null;
}

const regNode = (id, widthBits) => ({ kind: 'register', registerId: id, widthBits });
const extendNode = (kind, fromBits, toBits, value) => ({
  kind, ...(fromBits === undefined ? {} : { fromBits }), ...(toBits === undefined ? {} : { toBits }), value,
});

// 32->64 extensions are the only shapes the legacy v1 address can express
// losslessly; the modifier tokens must survive them (parity with v2->v1).
{
  const addr = loweredAddressWith(extendNode('zero-extend', 32, 64, regNode('w4', 32)));
  assert.equal(addr?.base, 'x0');
  assert.equal(addr?.index, 'w4');
  assert.equal(addr?.extend, 'uxtw');
}
{
  const addr = loweredAddressWith(extendNode('sign-extend', 32, 64, regNode('w5', 32)));
  assert.equal(addr?.index, 'w5');
  assert.equal(addr?.extend, 'sxtw');
}
// A 32-bit temporary feeding the extension keeps the same verdict.
{
  const wide = createTemporaryValue('w32', createBitVectorValue(32));
  const addr = loweredAddressWith(extendNode('zero-extend', 32, 64, wide));
  assert.equal(addr?.index, '$me:w32');
  assert.equal(addr?.extend, 'uxtw');
}

// Every non-32->64 width (or missing width evidence) must fail closed: no
// modifier, and no index term derived from the extension expression.
for (const [label, node] of [
  ['zero-extend 16->64', extendNode('zero-extend', 16, 64, regNode('x2', 16))],
  ['sign-extend 16->64', extendNode('sign-extend', 16, 64, regNode('x2', 16))],
  ['zero-extend 64->64', extendNode('zero-extend', 64, 64, regNode('x1', 64))],
  ['sign-extend 64->64', extendNode('sign-extend', 64, 64, regNode('x1', 64))],
  ['zero-extend 32->32', extendNode('zero-extend', 32, 32, regNode('w6', 32))],
  ['missing widths', extendNode('sign-extend', undefined, undefined, regNode('x3', 64))],
  ['missing fromBits only', extendNode('sign-extend', undefined, 64, regNode('x3', 32))],
  ['missing toBits only', extendNode('sign-extend', 32, undefined, regNode('x3', 32))],
  ['contradictory inner width', extendNode('sign-extend', 32, 64, regNode('x1', 64))],
]) {
  const addr = loweredAddressWith(node);
  assert.notEqual(addr?.extend, 'uxtw', `${label} must not mint uxtw`);
  assert.notEqual(addr?.extend, 'sxtw', `${label} must not mint sxtw`);
  assert.equal(addr?.extend ?? null, null, `${label} must fail closed with no modifier`);
  assert.equal(addr?.index ?? null, null, `${label} must not publish an index term`);
  // The projection stays a well-formed conservative address record.
  assert.equal(addr?.widthBits, 64);
  assert.ok('rawAddressExpr' in addr);
}
