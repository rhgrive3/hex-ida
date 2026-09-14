import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import {
  irFor,
  OP,
} from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return {
    model: buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress }),
    rowOfAddress,
  };
}

for (const mnemonic of ['paciasp', 'pacibsp', 'autiasp', 'autibsp', 'xpaclri']) {
  const { model, rowOfAddress } = modelOf([
    'mov x30, #0x1234',
    mnemonic,
    'mov x0, x30',
    'ret',
  ]);
  const ir = irFor(model, { rowOfAddress, cacheRevision:`issue-2093-${mnemonic}` });
  const auth = ir.instructions.find((instruction) => instruction.row === 1 && instruction.op === OP.UNKNOWN);
  const consume = ir.instructions.find((instruction) => instruction.row === 2 && instruction.op === OP.MOV);
  assert.equal(auth?.dst?.reg, 'x30', `${mnemonic} must create a new x30 definition`);
  assert.equal(auth?.dst?.const, null, `${mnemonic} must cut the old exact LR constant`);
  assert.strictEqual(consume?.args?.[0]?.value, auth?.dst,
    `${mnemonic} consumers must reach the post-authentication x30 definition`);
  assert.equal(consume?.args?.[0]?.value?.const, null,
    `${mnemonic} must not preserve the pre-authentication x30 constant`);
  const sourceRegs = (auth?.args ?? []).map((arg) => arg.value?.reg).filter(Boolean);
  assert.ok(sourceRegs.includes('x30'), `${mnemonic} must preserve its LR read dependency`);
  if (mnemonic !== 'xpaclri') assert.ok(sourceRegs.includes('sp'), `${mnemonic} must preserve its SP modifier dependency`);
}

{
  const proto = {
    args: [{ type:'opaque', bits:64, hfa:false, members:2, pointer:false }],
    returnsValue: false,
  };
  const { model, rowOfAddress } = modelOf(['bl #0x100000008', 'ret', 'ret']);
  model.instructions[0].callPrototype = proto;
  const opts = { rowOfAddress, functionPrototype:proto };

  const first = irFor(model, opts);
  const firstCall = first.instructions.find((instruction) => instruction.op === OP.CALL);
  assert.deepEqual(firstCall?.extra?.callArguments?.[0]?.reg, 'x0');

  proto.args[0].hfa = true;
  const second = irFor(model, opts);
  const secondCall = second.instructions.find((instruction) => instruction.op === OP.CALL);
  assert.notStrictEqual(second, first, 'HFA mutation must invalidate the cached IR');
  assert.deepEqual(secondCall?.extra?.callArguments?.[0]?.regs, ['v0', 'v1']);

  proto.args[0].members = 4;
  const third = irFor(model, opts);
  const thirdCall = third.instructions.find((instruction) => instruction.op === OP.CALL);
  assert.notStrictEqual(third, second, 'HFA member-count mutation must invalidate the cached IR');
  assert.deepEqual(thirdCall?.extra?.callArguments?.[0]?.regs, ['v0', 'v1', 'v2', 'v3']);

  proto.args[0].hfa = false;
  proto.args[0].members = 1;
  proto.args[0].pointer = true;
  const fourth = irFor(model, opts);
  const fourthCall = fourth.instructions.find((instruction) => instruction.op === OP.CALL);
  assert.notStrictEqual(fourth, third, 'pointer classification mutation must invalidate the cached IR');
  assert.equal(fourthCall?.extra?.callArguments?.[0]?.reg, 'x0');
  assert.equal(fourthCall?.extra?.callArguments?.[0]?.pointer, true);
}

console.log('issues #2093/#2120 ARM64 compatibility regressions: PASS');
