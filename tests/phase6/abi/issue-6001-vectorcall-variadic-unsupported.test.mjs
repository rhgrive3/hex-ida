import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMicrosoftVectorcallArguments } from '../../../js/targets/abi/microsoft-vectorcall.js';

/* Microsoft documents that `__vectorcall` "can't use a vararg variable length
 * argument list", so vectorcall+variadic is a contradictory prototype, not a
 * partially known ABI. It must fail closed instead of publishing exact
 * fixed-parameter placements for a call that cannot exist. */
for (const flag of ['variadic', 'varargs']) {
  const result = classifyMicrosoftVectorcallArguments({
    callPrototype:{
      callingConvention:'vectorcall',
      [flag]:true,
      args:[{ type:'int', bits:32 }],
    },
  });
  assert.equal(result.unsupported, true, `${flag} vectorcall must be unsupported`);
  assert.equal(result.partial, true, `${flag} vectorcall must be partial`);
  assert.equal(result.reason, 'microsoft-vectorcall-variadic-unsupported');
  assert.equal(result.callingConvention, 'vectorcall');
  assert.deepEqual(result.arguments, [],
    `${flag} vectorcall must not publish exact argument placements`);
  assert.deepEqual(result.srcs, [],
    `${flag} vectorcall must not publish register sources`);
  assert.equal(result.stackArgsUnknown, true);
  assert.equal(result.stackArgsMayContainPointers, true);
  const exactPublished = (result.arguments ?? []).some((entry) => entry?.mustUse === true && entry?.possible === false);
  assert.equal(exactPublished, false);
}

/* Valid non-variadic vectorcall keeps its exact classification. */
{
  const result = classifyMicrosoftVectorcallArguments({
    callPrototype:{
      callingConvention:'vectorcall',
      args:[{ type:'int', bits:32 }, { type:'double', bits:64 }, { type:'int *' }],
    },
  });
  assert.equal(result.unsupported, undefined);
  assert.equal(result.arguments[0]?.reg, 'rcx');
  assert.equal(result.arguments[0]?.mustUse, true);
  assert.equal(result.arguments[1]?.location, 'register');
  assert.equal(result.arguments[1]?.mustUse, true);
  assert.equal(result.arguments[2]?.pointer, true);
}

/* The convention-mismatch unsupported path is unchanged. */
{
  const result = classifyMicrosoftVectorcallArguments({
    callPrototype:{ callingConvention:'sysv', args:[{ type:'int' }] },
  });
  assert.equal(result.unsupported, true);
  assert.equal(result.reason, 'microsoft-vectorcall-calling-convention-mismatch');
}
