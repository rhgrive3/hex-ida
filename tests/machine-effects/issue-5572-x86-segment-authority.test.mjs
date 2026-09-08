import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { x86EffectiveAddressExpression } from '../../js/targets/architecture/x86_64/effects/addressing.js';

function decodedWithSegment(segment) {
  return createX86DecodedInstruction({
    address:0x1000n,
    length:3,
    rawBytes:[0x48,0x8b,0x00],
    instructionCode:1,
    instructionFamily:'mov',
    detailAvailable:true,
    detailStatus:'complete',
    detail:{
      operands:[{
        type:'memory',
        access:'read',
        widthBits:64,
        memory:{
          base:'rax',
          index:null,
          scale:1,
          displacement:0n,
          addressSizeBits:64,
          segment,
        },
      }],
    },
  });
}

for (const [input, canonical, space] of [
  [null, null, 'memory'],
  [undefined, null, 'memory'],
  ['FS', 'fs', 'tls'],
  ['gs', 'gs', 'tls'],
  ['ds', 'ds', 'memory'],
  ['ss', 'ss', 'memory'],
]) {
  const decoded = decodedWithSegment(input);
  const operand = decoded.detail.operands[0];
  assert.equal(operand.memory.segment, canonical);
  const address = x86EffectiveAddressExpression(decoded, operand);
  assert.ok(address, `expected effective address for segment ${String(input)}`);
  assert.equal(address.space, space);
  assert.equal(address.expression.segment, canonical);
}

for (const segment of [
  ['fs'],
  ['gs'],
  { toString() { return 'fs'; } },
  true,
  1,
  '',
  'not-a-segment',
]) {
  assert.throws(
    () => decodedWithSegment(segment),
    /x86-decoded-instruction-invalid-memory-segment/,
    `malformed segment must not acquire canonical segment authority: ${String(segment)}`,
  );
}

console.log('issue-5572 x86 segment authority regression: ok');
