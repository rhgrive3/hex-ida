import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstructionId } from '../js/core/identity/index.js';
import { createBitVectorValue, createMachineEffectBundle, createMachineOperation, createTemporaryValue } from '../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../js/semantics/ir/from-machine-effects.js';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';

let address = 0x930000n;
function instruction(mnemonic, ops) {
  const instructionId = createInstructionId({
    binaryId:'bin_9300', sliceId:'slice_9300', virtualAddress:address,
    decodeMode:'a64', decoderSemanticVersion:'1',
  });
  address += 4n;
  return { mnemonic, ops, operands:'', instructionId, origin:{ instructionIds:[instructionId] } };
}
const fp = (n,b,p) => ({ k:'reg', cls:'fp', num:n, bits:b, text:`${p}${n}` });
const gp = (n,b=64) => ({ k:'reg', cls:'gp', num:n, bits:b, text:`${b===32?'w':'x'}${n}` });
const elem = (n,size,index) => ({ k:'elem', num:n, size, index, text:`v${n}.${size}[${index}]` });

function lower(bundle, label) {
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, { functionId:`fn:${label}`, blockId:'blk:0', addressWidthBits:64 });
  return ir?.function ?? ir;
}

for (const [label, instr] of [
  ['fcvtzs-w', instruction('fcvtzs', [gp(0,32), fp(1,64,'d')])],
  ['umov-w', instruction('umov', [gp(0,32), elem(1,'s',0)])],
  ['smov-w', instruction('smov', [gp(0,32), elem(1,'h',0)])],
]) {
  test(`#9300 ${label} publishes the architectural W->X widening as canonical zext`, () => {
    const bundle = liftArm64MachineEffects(instr);
    assert.ok(bundle);
    const widening = bundle.operations.find((op) => op.kind === 'value' && op.metadata?.fromBits === 32 && op.metadata?.toBits === 64);
    assert.equal(widening?.opcode, 'zero-extend');
    assert.equal(bundle.operations.some((op) => op.opcode === 'arm64.zero-extend-w-write'), false);
    const fn = lower(bundle, label);
    const zext = fn.nodes.find((node) => node.kind === 'zext' && node.attributes?.fromBits === 32 && node.attributes?.toBits === 64);
    assert.ok(zext, `${label}: Semantic IR must retain a canonical 32->64 zext`);
    assert.equal(fn.nodes.some((node) => node.kind === 'intrinsic' && node.operator === 'arm64.zero-extend-w-write'), false);
  });
}

test('#9300 declared architecture namespaces accept dot qualification for canonical scalar opcodes', () => {
  const instructionId = createInstructionId({
    binaryId:'bin_9300_ns', sliceId:'slice_9300_ns', virtualAddress:0x930100n,
    decodeMode:'a64', decoderSemanticVersion:'1',
  });
  const input = createTemporaryValue('in32', createBitVectorValue(32));
  const output = createTemporaryValue('out64', createBitVectorValue(64));
  const bundle = createMachineEffectBundle({
    instructionId,
    architectureId:'arm64',
    mode:'a64',
    operations:[createMachineOperation({
      kind:'value', opcode:'arm64.zero-extend', inputs:[input], outputs:[output], metadata:{ fromBits:32, toBits:64 },
    })],
    controlEffect:{ kind:'fallthrough' }, possibleFaults:[],
    origin:{ instructionIds:[instructionId] }, completeness:'exact',
  });
  const fn = lower(bundle, 'namespace');
  const zext = fn.nodes.find((node) => node.kind === 'zext');
  assert.ok(zext);
  assert.equal(zext.attributes?.fromBits, 32);
  assert.equal(zext.attributes?.toBits, 64);
});
