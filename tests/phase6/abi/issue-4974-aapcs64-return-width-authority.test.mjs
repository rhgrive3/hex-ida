import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../../js/blocks.js';
import {
  buildIR,
  OP,
} from '../../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

const BASE = 0x49740000n;

function asm(lines) {
  return lines.map((line, index) => {
    const text = String(line).trim();
    const split = text.indexOf(' ');
    return {
      row:index,
      address:BASE + BigInt(index) * 4n,
      mn:split < 0 ? text : text.slice(0, split),
      ops:split < 0 ? '' : text.slice(split + 1).trim(),
    };
  });
}

function build(lines, options = {}) {
  const rowOfAddress = (address) => {
    const relative = address - BASE;
    if (relative < 0n || relative >= BigInt(lines.length) * 4n) return null;
    return Number(relative / 4n);
  };
  const model = buildSemanticModel(asm(lines), {
    startRow:0,
    endRow:lines.length - 1,
    rowOfAddress,
  });
  return buildIR(model, { rowOfAddress, ...options });
}

function callWith(prototype) {
  const ir = build(['bl #0x49741000', 'ret'], {
    callPrototypeFor:() => prototype,
  });
  return ir.instructions.find((instruction) => instruction.op === OP.CALL);
}

function returnWith(prototype) {
  const ir = build(['ret'], { functionPrototype:prototype });
  return ir.instructions.find((instruction) => instruction.op === OP.RET);
}

let call = callWith({ returnType:'int', returnBits:32, returnsValue:true });
assert.equal(call.dst?.reg, 'x0');
assert.equal(call.dst?.bits, 32, 'primitive integer returnBits must remain authoritative');

call = callWith({ returnType:'int', bits:16, returnsValue:true });
assert.equal(call.dst?.bits, 16, 'canonical bits alias must remain supported when returnBits is absent');

call = callWith({ returnType:'int', returnBits:['32'], returnsValue:true });
assert.equal(call.dst?.bits, 64, 'structured integer returnBits must fall back instead of minting exact width');

call = callWith({ returnType:'double', returnBits:['32'], returnsValue:true });
assert.equal(call.dst?.reg, 'v0');
assert.equal(call.dst?.bits, 64, 'structured FP returnBits must not mint an exact SIMD width');

let coercions = 0;
const hostileWidth = {
  [Symbol.toPrimitive]() { coercions += 1; return 32; },
  valueOf() { coercions += 1; return 32; },
  toString() { coercions += 1; return '32'; },
};
call = callWith({ returnType:'int', returnBits:hostileWidth, returnsValue:true });
assert.equal(call.dst?.bits, 64, 'coercible object returnBits must fail closed to the ABI default');
assert.equal(coercions, 0, 'call return-width validation must not invoke coercion hooks');

let ret = returnWith({ returnType:'int', returnBits:32, returnsValue:true });
assert.equal(ret.extra?.returnReg, 'x0');
assert.equal(ret.args?.[0]?.bits, 32, 'primitive function returnBits must remain authoritative');

ret = returnWith({ returnType:'int', returnBits:['32'], returnsValue:true });
assert.equal(ret.args?.[0]?.bits, 64, 'structured function returnBits must not mint exact RET source width');

ret = returnWith({ returnType:'double', returnBits:hostileWidth, returnsValue:true });
assert.equal(ret.extra?.returnReg, 'v0');
assert.equal(ret.args?.[0]?.bits, 64, 'FP RET width must use the same strict authority rule');
assert.equal(coercions, 0, 'RET return-width validation must not invoke coercion hooks');

console.log('issue #4974 AAPCS64 return-width authority: ok');
