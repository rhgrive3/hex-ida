import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverHighVariables } from '../../../js/decompiler/types/high-variables.js';

test('high-variable address-taken recovery indexes stack address bases once', () => {
  const count = 192;
  const values = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    kind: 'local',
    reg: `x${index % 29}`,
    uses: [],
  }));
  let addressReads = 0;
  const instructions = Array.from({ length: count }, (_, index) => {
    const address = { stack: index % 11 === 0, base: values[(index * 17) % count] };
    return Object.defineProperty({ op: 'load' }, 'addr', {
      enumerable: true,
      configurable: true,
      get() { addressReads += 1; return address; },
    });
  });
  const result = recoverHighVariables({ values, instructions }, { values: new Map() });
  assert.equal(result.groups.length, count);
  assert.ok(addressReads <= count + 4, `instruction address scan was repeated per SSA value: ${addressReads}`);
});
