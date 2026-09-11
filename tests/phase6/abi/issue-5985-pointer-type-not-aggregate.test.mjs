import assert from 'node:assert/strict';
import { classifyMicrosoftX64Arguments, classifyMicrosoftX64ReturnDecision } from '../../../js/targets/abi/microsoft-x64.js';
import { classifySysVAMD64Arguments, classifySysVAMD64FunctionReturn } from '../../../js/targets/abi/sysv-amd64.js';

// #5985: `struct Foo *` is a plain 64-bit pointer at the ABI boundary. The
// type-string classifiers matched both `pointer` (via `*`) and `aggregate`
// (via `struct`), and the return-side aggregate test had no pointer
// exclusion at all, so pointer-typed values fell into the unproven-aggregate
// partial path instead of exact register/return semantics.

for (const type of ['struct Foo *', 'union U *', 'Foo *', 'const struct Bar *']) {
  const msx64 = classifyMicrosoftX64Arguments({ callPrototype: { args: [{ type }] } });
  assert.equal(msx64.arguments[0].pointer, true, `${type}: pointer flag`);
  assert.equal(msx64.arguments[0].aggregate ?? false, false, `${type}: must not double-classify as aggregate (msx64)`);
  assert.equal(msx64.arguments[0].location, 'register', `${type}: msx64 pointer argument is exact`);
  assert.equal(msx64.arguments[0].reg, 'rcx');
  assert.equal(msx64.arguments[0].partial ?? false, false, `${type}: no partial aggregate demotion (msx64)`);

  const sysv = classifySysVAMD64Arguments({ callPrototype: { args: [{ type }] } });
  assert.equal(sysv.arguments[0].pointer, true, `${type}: pointer flag (sysv)`);
  assert.equal(sysv.arguments[0].aggregate ?? false, false, `${type}: must not double-classify as aggregate (sysv)`);
  assert.equal(sysv.arguments[0].location, 'register', `${type}: sysv pointer argument is exact`);
  assert.equal(sysv.arguments[0].reg, 'rdi');
}

// Metadata-conflict candidates remain possible inputs, not a definitive placement.
{
  const conflict = classifyMicrosoftX64Arguments({
    callPrototype:{ args:[{ type:'__m256', bits:128 }] },
  });
  assert.equal(conflict.arguments[0].abiClass, 'vector-width-conflict');
  assert.deepEqual(conflict.arguments[0].candidateRegisters, ['rcx', 'xmm0']);
  assert.equal(conflict.stackArgsUnknown, true);
  assert.deepEqual(
    conflict.srcs.map((source) => source.reg),
    ['rcx', 'xmm0'],
  );
}

// Return-side pointer exclusion.
{
  const msx64Return = classifyMicrosoftX64ReturnDecision({ returnType: 'struct Foo *' });
  assert.equal(msx64Return.kind, 'direct', 'msx64 pointer return must not take the aggregate path');
  const sysvReturn = classifySysVAMD64FunctionReturn({ returnType: 'union U *' });
  assert.equal(sysvReturn.reg, 'rax', 'sysv pointer return must be the plain RAX integer return');
}

// Genuine aggregates keep their aggregate classification.
{
  const msx64Aggregate = classifyMicrosoftX64Arguments({ callPrototype: {
    args: [{ type: 'struct Foo', aggregate: true, bits: 64, trivialForCalls: true }],
  } });
  assert.equal(msx64Aggregate.arguments[0].aggregate, true);
  assert.equal(msx64Aggregate.arguments[0].location, 'register');
  const sysvAggregate = classifySysVAMD64Arguments({ callPrototype: {
    args: [{ type: 'struct Foo', aggregate: true, bits: 64 }],
  } });
  assert.match(sysvAggregate.arguments[0].abiClass, /aggregate/, 'sysv genuine aggregate keeps its aggregate identity');}

console.log('x86-64 pointer-vs-aggregate type-string authority (#5985): PASS');
