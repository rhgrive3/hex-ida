import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDarwinArm64Arguments } from '../../../js/targets/abi/darwin-arm64.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

const int32 = (extra = {}) => ({ type:'int', bits:32, signed:true, ...extra });
const char8 = () => ({ type:'char', bits:8, signed:true });

function classify(args, prototype = {}) {
  return classifyDarwinArm64Arguments({
    callPrototype:{ variadic:true, args, ...prototype },
  }).arguments;
}

test('#8527 compact fixed stack prefix transitions to 8-byte anonymous-vararg slots', () => {
  const args = classify([
    ...Array.from({ length:9 }, char8),
    int32({ variadic:true, unnamed:true, named:false }),
    int32({ variadic:true, unnamed:true, named:false }),
  ], { fixedParameterCount:9 });

  assert.equal(args[8].location, 'stack');
  assert.equal(args[8].offset, 0);
  assert.equal(args[8].bytes, 1);
  assert.equal(args[8].compactDarwinSlot, true);

  assert.equal(args[9].location, 'stack');
  assert.equal(args[9].offset, 8);
  assert.equal(args[9].bytes, 4);
  assert.equal(args[9].alignmentBytes, 8);
  assert.equal(args[9].variadicAnonymous, true);
  assert.equal(args[9].compactDarwinSlot ?? null, null);

  assert.equal(args[10].offset, 16);
  assert.equal(args[10].bytes, 4);
  assert.equal(args[10].alignmentBytes, 8);
});

test('#8527 register-only fixed prefix starts anonymous integer varargs at 0 then 8', () => {
  const args = classify([
    int32(),
    int32({ variadic:true, unnamed:true }),
    int32({ variadic:true, unnamed:true }),
  ], { fixedParameterCount:1 });
  assert.equal(args[0].reg, 'x0');
  assert.deepEqual(args.slice(1).map((arg) => arg.offset), [0, 8]);
});

test('#8527 anonymous double keeps natural 8-byte extent and sequencing', () => {
  const args = classify([
    { type:'double', bits:64, variadic:true, unnamed:true, named:false },
    int32({ variadic:true, unnamed:true, named:false }),
  ], { fixedParameterCount:0 });
  assert.equal(args[0].location, 'stack');
  assert.equal(args[0].offset, 0);
  assert.equal(args[0].bytes, 8);
  assert.equal(args[1].offset, 8);
});

test('#8527 each supported anonymous marker selects the word-slot cursor policy', () => {
  for (const marker of [
    { variadic:true },
    { unnamed:true },
    { named:false },
  ]) {
    const args = classify([
      ...Array.from({ length:9 }, char8),
      int32(marker),
    ]);
    assert.equal(args[9].offset, 8, JSON.stringify(marker));
    assert.equal(args[9].alignmentBytes, 8, JSON.stringify(marker));
    assert.equal(args[9].variadicAnonymous, true, JSON.stringify(marker));
  }

  const fixedCountArgs = classify([
    ...Array.from({ length:9 }, char8),
    int32(),
  ], { fixedParameterCount:9 });
  assert.equal(fixedCountArgs[9].offset, 8);
  assert.equal(fixedCountArgs[9].variadicAnonymous, true);
});

test('#8527 ordinary fixed Darwin stack arguments remain compact', () => {
  const args = classifyDarwinArm64Arguments({
    callPrototype:{ args:Array.from({ length:10 }, char8) },
  }).arguments;
  assert.equal(args[8].offset, 0);
  assert.equal(args[9].offset, 1);
  assert.equal(args[8].compactDarwinSlot, true);
  assert.equal(args[9].compactDarwinSlot, true);
});


test('#8527 arm64e Darwin resolves to the same anonymous-vararg word-slot policy', () => {
  const plugin = resolveABIPlugin({ architecture:'arm64e', platform:'darwin' });
  assert.equal(plugin.id, 'darwin-arm64');
  assert.equal(plugin.stackRules().variadicStackSlotAlignment, 8);
  const args = plugin.classifyArguments({
    callPrototype:{
      variadic:true,
      fixedParameterCount:9,
      args:[...Array.from({ length:9 }, char8), int32()],
    },
  }).arguments;
  assert.equal(args[8].offset, 0);
  assert.equal(args[9].offset, 8);
  assert.equal(args[9].variadicAnonymous, true);
});
