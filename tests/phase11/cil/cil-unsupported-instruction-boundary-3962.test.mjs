import assert from 'node:assert/strict';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';

console.log('[phase11] running CIL unsupported-instruction boundary regression for #3962...');

function imageWith(bytecode, codeOffset = 100) {
  return {
    moduleId: 'cil:issue-3962',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode: Uint8Array.from(bytecode),
      headerOffset: codeOffset,
      codeOffset,
      maxStack: 8,
      isTiny: false,
      exceptionClauses: [],
    }],
  };
}

function lift(bytecode, codeOffset) {
  return liftCilMethod(0, imageWith(bytecode, codeOffset));
}

{
  const lifted = lift([
    0x22, 0x2a, 0x00, 0x00, 0x00, // unsupported ldc.r4 + 4-byte immediate
    0x2a,                         // later ret must not be reached after unsupported semantics
  ], 100);
  assert.equal(lifted.aggregateCompleteness, 'partial');
  assert.equal(lifted.bundles.length, 1, 'ldc.r4 immediate bytes must not become fake CIL instructions');
  assert.equal(lifted.bundles[0].opcode, 0x22);
  assert.equal(lifted.bundles[0].completeness, 'partial');
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start:'100', end:'105' }]);
  assert.equal(lifted.bundles[0].controlEffects.length, 0, 'immediate 0x2a must not fabricate ret');
}

{
  const lifted = lift([
    0x23,
    0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // unsupported ldc.r8 payload
    0x2a,
  ], 200);
  assert.equal(lifted.bundles.length, 1);
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start:'200', end:'209' }]);
}

{
  // ldarga.s is a legal unsupported CIL instruction with a one-byte operand.
  const lifted = lift([0x0f, 0x2a, 0x00], 300);
  assert.equal(lifted.bundles.length, 1);
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start:'300', end:'302' }]);
  assert.equal(lifted.bundles[0].controlEffects.length, 0);
}

{
  // FE 06 (ldftn) is an unsupported two-byte opcode with a four-byte token.
  const lifted = lift([0xfe, 0x06, 0x2a, 0x00, 0x00, 0x00, 0x2a], 400);
  assert.equal(lifted.bundles.length, 1);
  assert.equal(lifted.bundles[0].opcode, 0xfe06);
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start:'400', end:'406' }]);
}

{
  const lifted = lift([0x22, 0x2a, 0x00], 500);
  assert.equal(lifted.aggregateCompleteness, 'partial');
  assert.equal(lifted.bundles.length, 1, 'truncated unsupported instruction must consume the remaining tail and stop');
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start:'500', end:'503' }]);
  assert.ok(lifted.bundles[0].unknownEffects.some((effect) => effect.reason === 'unsupported-instruction-boundary-unresolved'));
}

{
  const lifted = lift([0x24, 0x2a, 0x00], 600); // undefined one-byte opcode: operand grammar is not authoritative
  assert.equal(lifted.bundles.length, 1);
  assert.deepEqual(lifted.bundles[0].origin.byteRanges, [{ start:'600', end:'603' }]);
  assert.ok(lifted.bundles[0].unknownEffects.some((effect) => effect.reason === 'unsupported-instruction-boundary-unresolved'));
}

console.log('  ok CIL unsupported-instruction boundary regression passed');
