import test from 'node:test';
import assert from 'node:assert/strict';
import { AAPCS64_ABI } from '../../../js/targets/abi/aapcs64.js';

test('AAPCS64 classifyFunctionReturn handles null/undefined/empty option shapes without throwing', () => {
  // Previously threw TypeError: Cannot convert undefined or null to object in aggregateBoolean
  assert.equal(AAPCS64_ABI.classifyFunctionReturn({}), null);
  assert.equal(AAPCS64_ABI.classifyFunctionReturn(null), null);
  assert.equal(AAPCS64_ABI.classifyFunctionReturn(undefined), null);

  const res = AAPCS64_ABI.classifyFunctionReturn({ returnType: 'uint64' });
  assert.equal(res?.reg, 'x0');
  assert.equal(res?.bits, 64);

  const res2 = AAPCS64_ABI.classifyFunctionReturn({ returnsValue: true });
  assert.equal(res2?.reg, 'x0');
});
