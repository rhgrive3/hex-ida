import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

const instructionId = createInstructionId({
  binaryId: 'bin_issue_3611',
  sliceId: 'slice_issue_3611',
  virtualAddress: 0x4010n,
  decodeMode: 'synthetic-mode',
  decoderSemanticVersion: '1',
});
const origin = {
  instructionIds: [instructionId],
  byteRanges: [{ binaryId: 'bin_issue_3611', start: 0n, end: 4n }],
};
const result = createTemporaryValue('value', createBitVectorValue(32));

function makeBundle(condition) {
  return createMachineEffectBundle({
    instructionId,
    architectureId: 'synthetic-neutral-isa',
    mode: 'synthetic-mode',
    operations: [createMachineOperation({
      kind: 'register-read',
      id: 'effect.read',
      register: createRegisterValue('bank.a', 32, { view: 'view:bank.a' }),
      value: result,
    })],
    controlEffect: {
      kind: 'conditional-branch',
      condition,
      target: { kind: 'absolute-address', value: '16' },
      fallthrough: { kind: 'absolute-address', value: '20' },
    },
    possibleFaults: [],
    origin,
    completeness: 'exact',
  });
}

const fallbackBundle = makeBundle({ kind: 'absolute-address', value: '1' });
const explicitWidthBundle = makeBundle({ kind: 'absolute-address', widthBits: 32, value: '1' });

function lower(bundle, addressWidthBits) {
  return lowerMachineEffectBundleToSemanticIr(bundle, {
    functionId: 'function',
    blockId: 'block',
    addressWidthBits,
  });
}
function addressValues(ir) {
  return ir.values.filter((value) => value.machineType?.kind === 'address');
}

const canonical = lower(fallbackBundle, 64);
assert.deepEqual(
  addressValues(canonical).map((value) => value.machineType.widthBits),
  [64],
  'primitive positive safe-integer context width must remain authoritative',
);

for (const value of [['64'], '64', true, new Number(64), 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(
    addressValues(lower(fallbackBundle, value)).length,
    0,
    `non-canonical addressWidthBits must not become address authority: ${String(value)}`,
  );
}

let coercions = 0;
const coercibleWidth = {
  valueOf() { coercions += 1; return 64; },
  toString() { coercions += 1; return '64'; },
};
assert.equal(addressValues(lower(fallbackBundle, coercibleWidth)).length, 0);
assert.equal(coercions, 0, 'addressWidthBits must not invoke caller-controlled coercion hooks');

assert.deepEqual(
  addressValues(lower(explicitWidthBundle, ['64'])).map((value) => value.machineType.widthBits),
  [32],
  'malformed context width must not suppress an independent explicit expression width',
);

let addressWidthReads = 0;
const hostileContext = Object.create(null, {
  functionId: { value: 'function', enumerable: true },
  blockId: { value: 'block', enumerable: true },
  addressWidthBits: {
    enumerable: true,
    get() {
      addressWidthReads += 1;
      return addressWidthReads === 1 ? 64 : ['32'];
    },
  },
});
const hostileResult = lowerMachineEffectBundleToSemanticIr(fallbackBundle, hostileContext);
assert.equal(addressWidthReads, 1, 'addressWidthBits must be snapshotted exactly once');
assert.deepEqual(addressValues(hostileResult).map((value) => value.machineType.widthBits), [64]);

console.log('semantic-v2 issue #3611 lowering address-width type boundary: PASS');
