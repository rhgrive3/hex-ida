import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySysVAMD64Arguments,
  classifySysVAMD64FunctionReturn,
} from '../../../js/targets/abi/sysv-amd64.js';

const MEMBERS_24 = [0, 8, 16].map((byteOffset) => ({ bits:64, bytes:8, byteOffset }));
const MEMORY_RETURN = Object.freeze({
  returnType:'struct Big',
  aggregate:true,
  returnBits:192,
  returnAggregate:{ bits:192, bytes:24, members:MEMBERS_24, padding:[] },
  returnEightbyteClasses:['MEMORY'],
  returnsValue:true,
});

function userArguments(result) {
  return result.arguments.filter((entry) => Number.isInteger(entry?.index) && entry.index >= 0);
}

test('#6010: proven MEMORY return derives hidden RDI and shifts the first user integer to RSI', () => {
  const result = classifySysVAMD64Arguments({
    callPrototype:{ ...MEMORY_RETURN, args:[{ type:'long', bits:64 }] },
  });
  const hidden = result.arguments.find((entry) => entry?.role === 'indirect-result');
  assert.ok(hidden, 'MEMORY return must publish the caller-provided result-storage pointer');
  assert.equal(hidden.reg, 'rdi');
  assert.equal(hidden.pointer, true);
  assert.equal(hidden.hidden, true);
  assert.equal(userArguments(result)[0]?.reg, 'rsi');
  assert.equal(result.partial, false);
});

test('#6010: hidden RDI shifts the six-register frontier so the sixth user integer is stack-passed', () => {
  const result = classifySysVAMD64Arguments({
    callPrototype:{
      ...MEMORY_RETURN,
      args:Array.from({ length:6 }, () => ({ type:'long', bits:64 })),
    },
  });
  const users = userArguments(result);
  assert.deepEqual(users.slice(0, 5).map((entry) => entry.reg), ['rsi','rdx','rcx','r8','r9']);
  assert.equal(users[5]?.location, 'stack');
  assert.equal(users[5]?.offset, 0);
});

test('#6010: proven MEMORY return publishes the SysV hidden-result return-pointer contract', () => {
  const result = classifySysVAMD64FunctionReturn({ functionPrototype:MEMORY_RETURN });
  assert.equal(result?.reg, 'rax');
  assert.equal(result?.bits, 64);
  assert.equal(result?.indirect, true);
  assert.deepEqual(result?.hiddenResultPointer, { input:'rdi', returned:'rax' });
});

test('#6010: explicit indirectResult behavior remains compatible', () => {
  const result = classifySysVAMD64Arguments({
    callPrototype:{ indirectResult:true, args:[{ type:'long', bits:64 }] },
  });
  assert.equal(result.arguments[0]?.role, 'indirect-result');
  assert.equal(result.arguments[0]?.reg, 'rdi');
  assert.equal(result.arguments[1]?.reg, 'rsi');
  assert.deepEqual(classifySysVAMD64FunctionReturn({ functionPrototype:{ indirectResult:true } }), {
    reg:'rax', bits:64, indirect:true, hiddenResultPointer:{ input:'rdi', returned:'rax' },
  });
});

test('#6010: structured return class cannot mint hidden-sret authority', () => {
  let hostileToStringReads = 0;
  const invalidReturnClasses = [
    ['indirect'],
    { toString() { hostileToStringReads += 1; return 'indirect'; } },
  ];
  for (const returnClass of invalidReturnClasses) {
    const prototype = {
      returnClass,
      returnsValue:true,
      args:[{ type:'long', bits:64 }],
    };
    const args = classifySysVAMD64Arguments({ callPrototype:prototype });
    assert.equal(args.partial, true);
    assert.equal(args.hiddenResultPossible, true);
    assert.equal(args.arguments.some((entry) => entry?.role === 'indirect-result'), false);
    assert.ok(args.arguments.every((entry) => entry?.exact === false && entry?.mustUse === false),
      'structured return-class evidence must not publish exact argument placement');

    const returned = classifySysVAMD64FunctionReturn({ functionPrototype:prototype });
    assert.equal(returned?.partial, true);
    assert.equal(returned?.hiddenResultPossible, true);
    assert.equal(returned?.indirect, undefined);
  }
  assert.equal(hostileToStringReads, 0,
    'structured return-class evidence must be rejected before coercion hooks can run');

  const primitivePrototype = {
    returnClass:'indirect',
    returnsValue:true,
    args:[{ type:'long', bits:64 }],
  };
  const primitiveArgs = classifySysVAMD64Arguments({ callPrototype:primitivePrototype });
  assert.equal(primitiveArgs.partial, false);
  assert.equal(primitiveArgs.arguments[0]?.role, 'indirect-result');
  assert.equal(primitiveArgs.arguments[0]?.reg, 'rdi');
  assert.equal(userArguments(primitiveArgs)[0]?.reg, 'rsi');
  assert.deepEqual(classifySysVAMD64FunctionReturn({ functionPrototype:primitivePrototype }), {
    reg:'rax', bits:64, indirect:true, hiddenResultPointer:{ input:'rdi', returned:'rax' },
  });
});

test('#6010: direct <=16-byte INTEGER aggregate return does not consume RDI', () => {
  const directReturn = {
    returnType:'struct Pair',
    aggregate:true,
    returnBits:128,
    returnAggregate:{ bits:128, bytes:16, members:MEMBERS_24.slice(0, 2), padding:[] },
    returnEightbyteClasses:['INTEGER','INTEGER'],
    returnsValue:true,
  };
  const args = classifySysVAMD64Arguments({
    callPrototype:{ ...directReturn, args:[{ type:'long', bits:64 }] },
  });
  assert.equal(args.arguments.some((entry) => entry?.role === 'indirect-result'), false);
  assert.equal(userArguments(args)[0]?.reg, 'rdi');
  const returned = classifySysVAMD64FunctionReturn({ functionPrototype:directReturn });
  assert.deepEqual(returned.regs, ['rax','rdx']);
  assert.equal(returned.indirect, undefined);
});

test('#6010: malformed aggregate-return evidence makes hidden-RDI presence conservative', () => {
  const malformed = {
    returnType:'struct Bad',
    aggregate:true,
    returnBits:192,
    returnAggregate:{
      bits:192,
      bytes:24,
      members:[{ bits:64, bytes:8, byteOffset:0 }],
      padding:[],
    },
    returnEightbyteClasses:['MEMORY'],
    returnsValue:true,
    args:[{ type:'long', bits:64 }],
  };
  const args = classifySysVAMD64Arguments({ callPrototype:malformed });
  assert.equal(args.partial, true);
  assert.equal(args.hiddenResultPossible, true);
  assert.equal(args.stackArgsUnknown, true);
  assert.ok(args.arguments.length > 0);
  assert.ok(args.arguments.every((entry) => entry?.exact === false && entry?.mustUse === false),
    'no exact user/register placement may be published while hidden RDI is unresolved');

  const returned = classifySysVAMD64FunctionReturn({ functionPrototype:malformed });
  assert.equal(returned.partial, true);
  assert.equal(returned.hiddenResultPossible, true);
});

test('#6010: aggregate return without a proven MEMORY/direct class does not mint exact argument placement', () => {
  const unclassified = {
    returnType:'struct Opaque',
    aggregate:true,
    returnBits:128,
    returnsValue:true,
    args:[{ type:'long', bits:64 }],
  };
  const args = classifySysVAMD64Arguments({ callPrototype:unclassified });
  assert.equal(args.partial, true);
  assert.equal(args.hiddenResultPossible, true);
  assert.ok(args.arguments.every((entry) => entry?.exact === false && entry?.mustUse === false));
});

test('#6010: structured eightbyte class evidence cannot mint hidden-sret authority', () => {
  let hostileToStringReads = 0;
  const invalidClassLists = [
    [['MEMORY']],
    [{ toString() { hostileToStringReads += 1; return 'MEMORY'; } }],
  ];
  for (const returnEightbyteClasses of invalidClassLists) {
    const prototype = {
      ...MEMORY_RETURN,
      returnEightbyteClasses,
      args:[{ type:'long', bits:64 }],
    };
    const args = classifySysVAMD64Arguments({ callPrototype:prototype });
    assert.equal(args.partial, true);
    assert.equal(args.hiddenResultPossible, true);
    assert.equal(args.arguments.some((entry) => entry?.role === 'indirect-result'), false);
    assert.ok(args.arguments.every((entry) => entry?.exact === false && entry?.mustUse === false));

    const returned = classifySysVAMD64FunctionReturn({ functionPrototype:prototype });
    assert.equal(returned.partial, true);
    assert.equal(returned.hiddenResultPossible, true);
    assert.equal(returned.indirect, undefined);
  }
  assert.equal(hostileToStringReads, 0,
    'non-string class evidence must be rejected before any coercion hook can run');
});

test('#6010: 12-byte direct aggregate may partially occupy its final eightbyte', () => {
  const directReturn = {
    returnType:'struct Tail12',
    aggregate:true,
    returnBits:96,
    returnAggregate:{
      bits:96,
      bytes:12,
      members:[
        { bits:64, bytes:8, byteOffset:0 },
        { bits:32, bytes:4, byteOffset:8 },
      ],
      padding:[],
    },
    returnEightbyteClasses:['INTEGER','INTEGER'],
    returnsValue:true,
  };
  const args = classifySysVAMD64Arguments({
    callPrototype:{ ...directReturn, args:[{ type:'long', bits:64 }] },
  });
  assert.equal(args.partial, false);
  assert.equal(args.arguments.some((entry) => entry?.role === 'indirect-result'), false);
  assert.equal(userArguments(args)[0]?.reg, 'rdi');

  const returned = classifySysVAMD64FunctionReturn({ functionPrototype:directReturn });
  assert.equal(returned.partial, undefined);
  assert.equal(returned.indirect, undefined);
  assert.deepEqual(returned.regs, ['rax','rdx']);
  assert.equal(returned.bits, 96);
  assert.equal(returned.bytes, 12);
  assert.deepEqual(returned.pieces.map((piece) => piece.bits), [64, 32]);
});


test('#6010: structured return type cannot suppress proven MEMORY hidden-sret authority', () => {
  let hostileToStringReads = 0;
  const hostileReturnType = {
    toString() {
      hostileToStringReads += 1;
      return 'pointer';
    },
  };
  const prototype = {
    ...MEMORY_RETURN,
    returnType:hostileReturnType,
    args:[{ type:'long', bits:64 }],
  };

  const args = classifySysVAMD64Arguments({ callPrototype:prototype });
  assert.equal(hostileToStringReads, 0,
    'structured return-type evidence must be rejected before coercion hooks can run');
  assert.equal(args.partial, true);
  assert.equal(args.hiddenResultPossible, true);
  assert.equal(args.arguments.some((entry) => entry?.role === 'indirect-result'), false);
  assert.ok(args.arguments.every((entry) => entry?.exact === false && entry?.mustUse === false),
    'malformed return-type evidence must not publish exact argument placement');

  const returned = classifySysVAMD64FunctionReturn({ functionPrototype:prototype });
  assert.equal(hostileToStringReads, 0,
    'return classification must not coerce structured return-type evidence');
  assert.equal(returned?.partial, true);
  assert.equal(returned?.hiddenResultPossible, true);
  assert.equal(returned?.indirect, undefined);

  const pointerPrototype = {
    returnType:'pointer',
    returnsValue:true,
    args:[{ type:'long', bits:64 }],
  };
  const pointerArgs = classifySysVAMD64Arguments({ callPrototype:pointerPrototype });
  assert.equal(pointerArgs.partial, false);
  assert.equal(pointerArgs.arguments.some((entry) => entry?.role === 'indirect-result'), false);
  assert.equal(userArguments(pointerArgs)[0]?.reg, 'rdi');
  assert.deepEqual(classifySysVAMD64FunctionReturn({ functionPrototype:pointerPrototype }), {
    reg:'rax', bits:64,
  });
});
