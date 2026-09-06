import assert from 'node:assert/strict';
import { classifyDarwinArm64Arguments } from '../../../js/targets/abi/darwin-arm64.js';

const classify = (args) => classifyDarwinArm64Arguments({ callPrototype:{ args } });

function aggregate(bits, options = {}) {
  const bytes = bits / 8;
  const members = Array.from({ length:bytes / 8 }, (_unused, index) => ({
    type:'uint64_t', bits:64, bytes:8, byteOffset:index * 8,
  }));
  return {
    type:`struct ${bits}`,
    aggregate:true,
    bits,
    ...(options.mayContainPointers ? { mayContainPointers:true } : {}),
    layout:{ bits, bytes, members },
  };
}

const scalar = () => ({ type:'uint64_t', bits:64 });

{
  const eight = classify([aggregate(64)]);
  assert.deepEqual(eight.arguments[0].regs, ['x0']);
  assert.equal(eight.arguments[0].abiClass, 'aggregate');
  assert.equal(eight.arguments[0].pointer, false);

  const sixteen = classify([aggregate(128)]);
  assert.deepEqual(sixteen.arguments[0].regs, ['x0', 'x1']);
  assert.equal(sixteen.arguments[0].abiClass, 'aggregate');
  assert.equal(sixteen.arguments[0].pointer, false);
}

{
  const twentyFour = classify([aggregate(192, { mayContainPointers:true })]);
  const arg = twentyFour.arguments[0];
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x0');
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(arg.pointer, true);
  assert.equal(arg.bits, 64);
  assert.equal(arg.bytes, 8);
  assert.equal(arg.pointeeBits, 192);
  assert.equal(arg.aggregate, true);
  assert.equal(arg.callerCopy, true);
  assert.equal(arg.mayContainPointers, true);
  assert.deepEqual(arg.pieces, [{
    pieceIndex:0, order:0, reg:'x0', bits:64, bytes:8, byteOffset:0,
    abiClass:'aggregate-indirect-copy',
  }]);
  assert.deepEqual(twentyFour.srcs.map((source) => source.reg), ['x0']);
  assert.equal(twentyFour.srcs.some((source) => source.reg === 'x1' || source.reg === 'x2'), false);
}

{
  const thirtyTwo = classify([aggregate(256)]);
  assert.equal(thirtyTwo.arguments[0].reg, 'x0');
  assert.equal(thirtyTwo.arguments[0].abiClass, 'aggregate-indirect-copy');
  assert.equal(thirtyTwo.srcs.length, 1);
}

{
  const preceded = classify([scalar(), scalar(), aggregate(192)]);
  assert.equal(preceded.arguments[2].reg, 'x2');
  assert.equal(preceded.arguments[2].abiClass, 'aggregate-indirect-copy');
  assert.equal(preceded.srcs.at(-1).purpose, 'aggregate-indirect-copy');
}

{
  const exhausted = classify([...Array.from({ length:8 }, scalar), aggregate(192)]);
  const arg = exhausted.arguments[8];
  assert.equal(arg.location, 'stack');
  assert.equal(arg.offset, 0);
  assert.equal(arg.bytes, 8);
  assert.equal(arg.pointer, true);
  assert.equal(arg.callerCopy, true);
  assert.equal(arg.pointeeBits, 192);
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(exhausted.stackArguments.length, 1);
  assert.equal(exhausted.stackArgsMayContainPointers, true);
}

{
  const compactLead = classify([
    ...Array.from({ length:8 }, scalar),
    { type:'uint8_t', bits:8 },
    aggregate(192),
  ]);
  assert.equal(compactLead.arguments[8].location, 'stack');
  assert.equal(compactLead.arguments[8].offset, 0);
  assert.equal(compactLead.arguments[8].bytes, 1);
  assert.equal(compactLead.arguments[9].location, 'stack');
  assert.equal(compactLead.arguments[9].offset, 8);
  assert.equal(compactLead.arguments[9].bytes, 8);
  assert.equal(compactLead.arguments[9].abiClass, 'aggregate-indirect-copy');
}

{
  const hfa = classify([{
    type:'hfa4', hfa:true, bits:256,
    layout:{
      bits:256, bytes:32,
      members:Array.from({ length:4 }, (_unused, index) => ({
        type:'double', bits:64, bytes:8, byteOffset:index * 8,
      })),
    },
  }]);
  assert.equal(hfa.arguments[0].abiClass, 'hfa');
  assert.deepEqual(hfa.arguments[0].regs, ['v0', 'v1', 'v2', 'v3']);
  assert.notEqual(hfa.arguments[0].callerCopy, true);
}

{
  const unproven = classify([{ type:'struct Big', aggregate:true, bits:192 }]);
  assert.equal(unproven.arguments[0].location, 'unknown');
  assert.equal(unproven.arguments[0].reason, 'darwin-arm64-aggregate-size-layout-not-proven');
  assert.equal(unproven.partial, true);
}

console.log('issue #5601 Darwin ARM64 large aggregate indirect-copy classification: ok');
