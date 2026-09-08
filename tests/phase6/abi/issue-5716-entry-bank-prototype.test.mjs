import assert from 'node:assert/strict';
import { recoverFunctionPrototype } from '../../../js/decompiler/types/prototype.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { AAPCS64_ABI, resolveABIPlugin } from '../../../js/targets/abi/index.js';

const adapter = semanticAbiAdapter(AAPCS64_ABI);
const value = (id) => ({ id, uses:[{}] });
const hfa2 = {
  type:'H2', hfa:true, bits:128, bytes:16, alignmentBytes:8,
  members:[
    { type:'double', bits:64, bytes:8, byteOffset:0 },
    { type:'double', bits:64, bytes:8, byteOffset:8 },
  ],
};

// Call-side scalar FP placement and entry-side bank metadata identify the same
// physical register without pretending that the entry classifier knows whether
// the value is scalar FP, vector, HFA, or HVA.
{
  const call = AAPCS64_ABI.classifyArguments({ callPrototype:{ args:[{ type:'double', bits:64 }] } });
  const callArgument = call.arguments[0];
  const entry = AAPCS64_ABI.classifyEntryRegister(callArgument.reg);
  assert.equal(callArgument.reg, 'v0');
  assert.equal(callArgument.abiClass, 'fp');
  assert.equal(entry.reg, callArgument.reg);
  assert.equal(entry.abiClass, 'fp-vector');
}

// The entry classifier's bank metadata must make a mixed integer/FP entry
// recover into separate ABI banks; v-register indexes and aliases remain the
// established physical-bank values.
{
  const prototype = recoverFunctionPrototype(
    { args:new Map([['x0',value(1)],['v0',value(2)],['v1',value(3)]]), instructions:[] },
    { values:new Map(), ret:null },
    { abiAdapter:adapter },
  );
  assert.deepEqual(prototype.argumentBanks.integer.map((argument) => argument.reg), ['x0']);
  assert.deepEqual(prototype.argumentBanks.fp.map((argument) => argument.reg), ['v0', 'v1']);
  assert.deepEqual(prototype.argumentBanks.fp.map((argument) => argument.abiClass), ['fp-vector', 'fp-vector']);
  assert.equal(prototype.argumentBanks.fp[0].bankIndex, 8);
  assert.equal(prototype.argumentBanks.fp[1].bankIndex, 9);
}

// HFA call-side pieces and prototype-aware entry recovery retain both v0/v1
// pieces, while the separate x0 argument remains in the integer bank.
{
  const call = AAPCS64_ABI.classifyArguments({ callPrototype:{ args:[{ type:'uint64_t', bits:64 }, hfa2] } });
  const hfaArgument = call.arguments[1];
  assert.equal(hfaArgument.abiClass, 'hfa');
  assert.deepEqual(hfaArgument.regs, ['v0', 'v1']);
  assert.deepEqual(hfaArgument.pieces.map((piece) => piece.reg), ['v0', 'v1']);
  assert.deepEqual(hfaArgument.regs.map((reg) => AAPCS64_ABI.classifyEntryRegister(reg).abiClass), ['fp-vector', 'fp-vector']);

  const prototype = recoverFunctionPrototype(
    { args:new Map([['x0',value(10)],['v0',value(11)],['v1',value(12)]]), instructions:[] },
    { values:new Map(), ret:null },
    { abiAdapter:adapter, functionPrototype:{ parameters:[{ type:'uint64_t', bits:64 }, hfa2] } },
  );
  const recoveredHfa = prototype.arguments.find((argument) => argument.aggregate === true);
  assert.ok(recoveredHfa);
  assert.equal(recoveredHfa.abiClass, 'hfa');
  assert.deepEqual(recoveredHfa.regs, ['v0', 'v1']);
  assert.deepEqual(recoveredHfa.pieces.map((piece) => piece.reg), ['v0', 'v1']);
  assert.deepEqual(prototype.argumentBanks.integer.map((argument) => argument.reg), ['x0']);
  assert.deepEqual(prototype.argumentBanks.fp.map((argument) => argument.reg), ['v0', 'v1']);
}

// Darwin inherits the same entry-bank contract, while registers outside v0-v7
// remain incoming state and are not fabricated as arguments.
{
  for (const platform of ['ios', 'darwin']) {
    const plugin = resolveABIPlugin({ architecture:'arm64', platform });
    assert.equal(plugin.classifyEntryRegister('v0').abiClass, 'fp-vector');
    assert.equal(plugin.classifyEntryRegister('v7').abiClass, 'fp-vector');
    assert.equal(plugin.classifyEntryRegister('v8').kind, 'incoming-register-state');
    assert.equal(plugin.classifyEntryRegister('x30').kind, 'incoming-register-state');
  }
}

console.log('issue-5716 entry-bank/prototype integration: PASS');
