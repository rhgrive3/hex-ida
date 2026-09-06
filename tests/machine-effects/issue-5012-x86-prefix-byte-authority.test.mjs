import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';

function decoded(prefixes) {
  return createX86DecodedInstruction({
    address:0n,
    length:1,
    bytes:[0x90],
    instructionCode:1,
    instructionFamily:'general',
    detailStatus:'complete',
    prefixes,
  });
}

const canonical = decoded({ legacy:[0xf0,0x66] });
assert.deepEqual([...canonical.detail.prefixes.legacy], [0xf0,0x66]);

const legacyBytes = Uint8Array.of(0xf0);
const copiedLegacy = decoded({ legacy:legacyBytes });
legacyBytes[0] = 0;
assert.deepEqual([...copiedLegacy.detail.prefixes.legacy], [0xf0]);

assert.deepEqual(
  [...decoded({ legacy:[], vector:{ kind:'vex2', bytes:[0xc5,0xf8] } }).detail.prefixes.vector.bytes],
  [0xc5,0xf8],
);
assert.deepEqual(
  [...decoded({ legacy:[], vector:{ kind:'vex2', bytes:Uint8Array.of(0xc5,0xf8) } }).detail.prefixes.vector.bytes],
  [0xc5,0xf8],
);

const malformedLegacy = [
  ['240'],
  [496],
  [-16],
  [240.5],
  [NaN],
  [Infinity],
  [true],
  [[0xf0]],
  [{ valueOf() { return 0xf0; } }],
  new Uint16Array([0xf0]),
];
malformedLegacy.push(new Array(1));

for (const legacy of malformedLegacy) {
  assert.throws(
    () => decoded({ legacy }),
    { name:'TypeError', message:'x86-decoded-instruction-invalid-legacy-prefix-byte' },
  );
}

for (const bytes of [
  ['197'],
  [453],
  [-59],
  [197.5],
  [false],
  new Uint16Array([0xc5]),
]) {
  assert.throws(
    () => decoded({ legacy:[], vector:{ kind:'vex2', bytes } }),
    { name:'TypeError', message:'x86-decoded-instruction-invalid-vector-prefix-byte' },
  );
}

assert.deepEqual([...decoded({}).detail.prefixes.legacy], []);
assert.deepEqual(
  [...decoded({ vector:{ kind:'vex2' } }).detail.prefixes.vector.bytes],
  [],
);

console.log('issue-5012 x86 prefix-byte authority regression: PASS');
