import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { recoverFunctionPrototype } from '../../../js/decompiler/types/prototype.js';
import { AAPCS64_ABI, RISCV_LP64_ABI, UNKNOWN_ABI } from '../../../js/targets/abi/index.js';

function prototypeFor(abi, args, types = {}) {
  return recoverFunctionPrototype(
    { args:new Map(args), instructions:[] },
    { values:new Map(), ...types },
    { abiAdapter:semanticAbiAdapter(abi) },
  );
}

test('HEX-C3-02: prototype recovery follows the selected RISC-V profile', () => {
  const a0 = { id:1, reg:'x10', uses:[{}] };
  const prototype = prototypeFor(RISCV_LP64_ABI, [['x10', a0]]);

  assert.equal(prototype.convention, 'lp64');
  assert.ok(prototype.arguments.some((argument) => argument.reg === 'x10'));
});

test('HEX-C3-02: unsupported ABI evidence stays explicitly unknown', () => {
  const x0 = { id:2, reg:'x0', uses:[{}] };
  const prototype = prototypeFor(UNKNOWN_ABI, [['x0', x0]]);

  assert.equal(prototype.conventionKnown, false);
  assert.equal(prototype.arguments.length, 0);
  assert.equal(prototype.returnLocationKnown, false);
});

test('HEX-C3-02: stale ABI semantic identity cannot publish a supported prototype', () => {
  const staleAdapter = Object.freeze({
    id:'aapcs64', semanticVersion:'1', semanticIdentity:'aapcs64@1', architectureId:'arm64',
  });
  const x0 = { id:3, reg:'x0', uses:[{}] };
  const prototype = recoverFunctionPrototype(
    { args:new Map([['x0',x0]]), instructions:[] },
    { values:new Map() },
    { abiAdapter:staleAdapter },
  );

  assert.equal(AAPCS64_ABI.semanticIdentity, 'aapcs64@2');
  assert.equal(prototype.conventionKnown, false);
  assert.deepEqual(prototype.arguments, []);
});

test('HEX-C3-02: canonical aggregate pieces remain one prototype argument', () => {
  const parameter = { type:'struct Pair', aggregate:true, bits:128,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
  const canonical = AAPCS64_ABI.classifyArguments(
    { callPrototype:{ parameters:[parameter] } },
    { callPrototype:{ parameters:[parameter] } },
  );
  const x0 = { id:4, reg:'x0', uses:[{}] };
  const x1 = { id:5, reg:'x1', uses:[{}] };
  const prototype = recoverFunctionPrototype(
    { args:new Map([['x0',x0],['x1',x1]]), instructions:[] },
    { values:new Map() },
    { abiAdapter:semanticAbiAdapter(AAPCS64_ABI), functionPrototype:{ parameters:[parameter] } },
  );

  assert.equal(canonical.partial, false);
  assert.deepEqual(canonical.arguments[0].regs, ['x0','x1']);
  assert.equal(prototype.arguments.length, 1);
  assert.deepEqual(prototype.arguments[0].regs, ['x0','x1']);
});
