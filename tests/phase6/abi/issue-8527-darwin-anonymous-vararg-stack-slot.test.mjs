import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DARWIN_ARM64_ABI,
  classifyDarwinArm64Arguments,
} from '../../../js/targets/abi/darwin-arm64.js';
import { classifyAAPCS64Arguments } from '../../../js/targets/abi/aapcs64.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

// Issue #8527: after the compact fixed-argument area is exhausted, an anonymous
// Darwin vararg must not be allocated with the compact natural-size cursor.
// Apple anonymous varargs are stack-only (#6041) and live in the separate Stage
// C variadic area, which is word based: a 4-byte `int` vararg takes an 8-byte
// slot, so the next anonymous argument starts a full word later.
//
// Compiler truth (`clang -target arm64-apple-macos13 -O1`):
//   sink(1,2,3,4,5,6,7,8,9, 0x11223344, 0x55667788);
//     strb w10, [sp]            // ninth fixed char at sp+0 (compact)
//     stp  x9, x8, [sp, #8]     // varargs at sp+8 and sp+16
// Before this fix the classifier published the varargs at sp+4 and sp+8.

const WORD_BYTES = 8;
const GPRS = Array.from({ length: 8 }, () => ({ type:'uint64_t', bits:64 }));
const anonymousInt = { type:'int', bits:32, signed:true, variadic:true, unnamed:true, named:false };
const anonymousDouble = { type:'double', bits:64, variadic:true, unnamed:true, named:false };

function classify(args, extra = {}) {
  return classifyDarwinArm64Arguments({ callPrototype:{ args, ...extra } });
}

test('#8527 nine fixed chars + two anonymous int varargs match the compiler layout', () => {
  const result = classify([
    ...Array.from({ length:9 }, () => ({ type:'char', bits:8, signed:true })),
    anonymousInt,
    anonymousInt,
  ], { variadic:true, fixedParameterCount:9 });

  const fixed = result.arguments[8];
  const first = result.arguments[9];
  const second = result.arguments[10];

  assert.equal(fixed.location, 'stack');
  assert.equal(fixed.offset, 0, 'the ninth fixed char stays in the compact area at sp+0');
  assert.equal(fixed.bytes, 1);
  assert.equal(fixed.compactDarwinSlot, true);
  assert.equal(fixed.variadicAnonymous ?? null, null);

  assert.equal(first.location, 'stack');
  assert.equal(first.offset, 8, 'the first anonymous vararg starts at the next 8-byte boundary');
  assert.equal(first.variadicAnonymous, true);
  assert.equal(first.varargSlotBytes, WORD_BYTES);
  assert.equal(first.varargSlotAlignmentBytes, WORD_BYTES);
  assert.equal(first.compactDarwinSlot, false, 'the compact cursor rule must not advance a vararg');

  assert.equal(second.offset, 16, 'the second anonymous vararg advances by one word, not by 4 bytes');
  assert.equal(second.variadicAnonymous, true);
});

test('#8527 anonymous varargs advance by the word slot, never by their natural size', () => {
  const result = classify([
    { type:'char *', pointer:true, bits:64 },
    anonymousInt,
    anonymousInt,
  ], { variadic:true, fixedParameterCount:1 });

  assert.equal(result.arguments[0].reg, 'x0');
  assert.equal(result.arguments[1].offset, 0);
  assert.equal(result.arguments[2].offset, WORD_BYTES, 'offsets are 0 and 8, never 0 and 4');
});

test('#8527 a fixed stack prefix ending off an 8-byte boundary rounds the vararg cursor up', () => {
  const result = classify([...GPRS, { type:'char', bits:8 }, anonymousInt],
    { variadic:true, fixedParameterCount:9 });

  assert.equal(result.arguments[8].offset, 0, 'fixed char stays compact');
  assert.equal(result.arguments[8].bytes, 1);
  assert.equal(result.arguments[9].offset, 8, 'alignUp(1, 8) = 8');
});

test('#8527 anonymous double varargs stay stack-only with 8-byte sequencing', () => {
  const result = classify([...GPRS, anonymousDouble, anonymousDouble],
    { variadic:true, fixedParameterCount:8 });

  assert.equal(result.arguments[8].location, 'stack');
  assert.equal(result.arguments[8].offset, 0);
  assert.equal(result.arguments[8].bytes, 8);
  assert.equal(result.arguments[9].offset, 8);
  assert.ok(!result.srcs.some((src) => src.reg === 'v0'), 'v0 must not back an anonymous vararg');
});

test('#8527 mixed anonymous scalar varargs preserve order and word progression', () => {
  const result = classify([
    ...GPRS,
    anonymousInt,
    { type:'uint64_t', bits:64, variadic:true, unnamed:true },
    anonymousInt,
  ], { variadic:true, fixedParameterCount:8 });

  const varargs = result.arguments.slice(8);
  assert.deepEqual(varargs.map((a) => a.offset), [0, WORD_BYTES, 2 * WORD_BYTES]);
  assert.deepEqual(varargs.map((a) => a.index), [8, 9, 10]);
  assert.ok(varargs.every((a) => a.variadicAnonymous === true));
});

test('#8527 every anonymous-vararg detection route selects the same cursor policy', () => {
  const prefix = [...GPRS, { type:'char', bits:8 }];
  const routes = [
    { label:'variadic flag', descriptor:{ type:'int', bits:32, variadic:true }, proto:{ variadic:true, fixedParameterCount:9 } },
    { label:'unnamed flag', descriptor:{ type:'int', bits:32, unnamed:true }, proto:{ variadic:true, fixedParameterCount:9 } },
    { label:'named:false flag', descriptor:{ type:'int', bits:32, named:false }, proto:{ variadic:true, fixedParameterCount:9 } },
    { label:'index past fixedParameterCount', descriptor:{ type:'int', bits:32 }, proto:{ variadic:true, fixedParameterCount:9 } },
  ];

  for (const route of routes) {
    const result = classify([...prefix, route.descriptor], route.proto);
    const argument = result.arguments[9];
    assert.equal(argument.variadicAnonymous, true, `${route.label} must select the vararg area`);
    assert.equal(argument.offset, WORD_BYTES, `${route.label} must use the word cursor`);
    assert.equal(argument.varargSlotAlignmentBytes, WORD_BYTES);
    assert.equal(argument.compactDarwinSlot, false);
  }

  // Control: a named fixed argument inside the fixed range keeps the compact
  // natural-size rule, so the vararg policy is not applied globally.
  const namedFixed = classify([...prefix, { type:'int', bits:32 }],
    { variadic:true, fixedParameterCount:10 });
  assert.equal(namedFixed.arguments[9].offset, 4);
  assert.equal(namedFixed.arguments[9].compactDarwinSlot, true);
  assert.equal(namedFixed.arguments[9].variadicAnonymous ?? null, null);
});

test('#8527 ordinary non-variadic trailing arguments keep compact natural slots', () => {
  const result = classify([...GPRS, { type:'char', bits:8 }, { type:'char', bits:8 }]);
  assert.equal(result.arguments[8].offset, 0);
  assert.equal(result.arguments[9].offset, 1);
  assert.equal(result.arguments[9].compactDarwinSlot, true);
  assert.equal(result.variadicTail, null);
});

test('#8527 the published vararg contract and the concrete entries agree', () => {
  const rules = DARWIN_ARM64_ABI.stackRules();
  assert.equal(rules.variadicAnonymousArguments, 'stack-only');
  assert.equal(rules.variadicStackSlotAlignment, WORD_BYTES);

  const result = classify([...GPRS, anonymousInt], { variadic:true, fixedParameterCount:8 });
  assert.equal(result.variadicTail.slotAlignmentBytes, WORD_BYTES);
  assert.equal(result.arguments[8].varargSlotAlignmentBytes, rules.variadicStackSlotAlignment,
    'the expanded vararg entry must agree with the declared vararg slot alignment');
});

test('#8527 anonymous varargs still never consume argument registers (#6041 control)', () => {
  const result = classify([{ type:'char *', pointer:true, bits:64 }, anonymousInt],
    { variadic:true, fixedParameterCount:1 });
  assert.equal(result.arguments[0].reg, 'x0');
  assert.equal(result.arguments[1].location, 'stack');
  assert.ok(!result.srcs.some((src) => src.reg === 'x1'));
});

test('#8527 ARM64e Darwin routing uses the same word-based vararg layout', () => {
  const plugin = resolveABIPlugin({ architecture:'arm64e', platform:'darwin' });
  assert.equal(plugin.id, DARWIN_ARM64_ABI.id);
  assert.equal(plugin.semanticIdentity, DARWIN_ARM64_ABI.semanticIdentity);

  const result = plugin.classifyArguments({
    callPrototype:{ variadic:true, fixedParameterCount:9,
      args:[...Array.from({ length:9 }, () => ({ type:'char', bits:8 })), anonymousInt, anonymousInt] },
  });
  assert.deepEqual(result.arguments.slice(8).map((a) => a.offset), [0, 8, 16]);
});

test('#8527 generic AAPCS64 stack scheduling is unchanged', () => {
  const result = classifyAAPCS64Arguments({
    callPrototype:{ args:[...GPRS, { type:'char', bits:8 }, { type:'char', bits:8 }] },
  });
  assert.equal(result.arguments[8].offset, 0);
  assert.equal(result.arguments[8].bytes, 8, 'generic AAPCS64 still uses full 8-byte stack slots');
  assert.equal(result.arguments[9].offset, 8);
  assert.equal(result.arguments[9].varargSlotBytes ?? null, null);
  assert.equal(result.arguments[9].varargSlotAlignmentBytes ?? null, null);
  assert.equal(result.arguments[9].compactDarwinSlot ?? null, null);
});
