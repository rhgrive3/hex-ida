import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionDecodedFunction } from '../../js/analysis/semantic-function.js';
import { partitionDecodedFunction as partitionDecodedFunctionBase } from '../../js/analysis/semantic-function-base.js';

const partitions = [
  ['public', partitionDecodedFunction],
  ['base', partitionDecodedFunctionBase],
];

function decoded(entries) {
  return entries.map(([address, kind, target = null, callPrototype = null]) => ({
    address:BigInt(address),
    length:4n,
    kind,
    target:target == null ? null : BigInt(target),
    ...(callPrototype == null ? {} : { callPrototype }),
  }));
}

function plugin() {
  return {
    classifyControlFlow(instruction) { return instruction.kind; },
    directControlTarget(instruction) { return instruction.target; },
  };
}

function blockAt(blocks, address) {
  return blocks.find((block) => block.startAddress === BigInt(address));
}

for (const [route, partition] of partitions) {
  test(`${route}: per-call resolver terminates only the direct call bound to noreturn evidence`, () => {
    const fatalTarget = 0x1000n;
    const normalTarget = 0x2000n;
    const seen = [];
    const blocks = partition(decoded([
      [0, 'call', fatalTarget],
      [4, 'fallthrough'],
      [8, 'call', normalTarget],
      [12, 'return'],
    ]), plugin(), {
      callPrototypeFor(target, call) {
        seen.push([target, call.address]);
        if (target === fatalTarget) return { noreturn:true, returnType:'void' };
        if (target === normalTarget) return { noreturn:false, returnType:'int' };
        return null;
      },
    });

    assert.deepEqual(seen, [[fatalTarget, 0n], [normalTarget, 8n]]);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blockAt(blocks, 0).instructions.map(({ decoded:instruction }) => instruction.address), [0n]);
    assert.deepEqual(blockAt(blocks, 0).successors, []);
    assert.deepEqual(blockAt(blocks, 4).instructions.map(({ decoded:instruction }) => instruction.address), [4n, 8n, 12n]);
  });

  test(`${route}: unknown per-call prototype keeps ordinary call fallthrough`, () => {
    const blocks = partition(decoded([
      [0, 'call', 0x1000n],
      [4, 'return'],
    ]), plugin(), { callPrototypeFor:() => null });
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].instructions.map(({ decoded:instruction }) => instruction.address), [0n, 4n]);
  });

  test(`${route}: indirect calls can bind noreturn evidence by callsite identity`, () => {
    const blocks = partition(decoded([
      [0, 'call'],
      [4, 'return'],
    ]), plugin(), {
      callPrototypeFor(target, call) {
        assert.equal(target, null);
        return call.address === 0n ? { noreturn:true } : null;
      },
    });
    assert.equal(blocks.length, 2);
    assert.deepEqual(blockAt(blocks, 0).successors, []);
  });

  test(`${route}: instruction-bound evidence outranks the resolver for the same callsite`, () => {
    let resolverCalls = 0;
    const blocks = partition(decoded([
      [0, 'call', 0x1000n, { noreturn:false }],
      [4, 'return'],
    ]), plugin(), {
      callPrototypeFor() {
        resolverCalls += 1;
        return { noreturn:true };
      },
    });
    assert.equal(resolverCalls, 0);
    assert.equal(blocks.length, 1);
  });

  test(`${route}: legacy global noreturn fallback is retained only for a single callsite`, () => {
    const single = partition(decoded([
      [0, 'call', 0x1000n],
      [4, 'return'],
    ]), plugin(), { callPrototype:{ noreturn:true } });
    assert.equal(single.length, 2, 'PR #944 single-call behavior must remain');

    const multiple = partition(decoded([
      [0, 'call', 0x1000n],
      [4, 'fallthrough'],
      [8, 'call', 0x2000n],
      [12, 'return'],
    ]), plugin(), { callPrototype:{ noreturn:true } });
    assert.equal(multiple.length, 1, 'function-global prototype must not mark unrelated calls noreturn');
  });

  test(`${route}: resolver is evaluated once per callsite so CFG passes consume one stable authority`, () => {
    let calls = 0;
    const blocks = partition(decoded([
      [0, 'call', 0x1000n],
      [4, 'return'],
    ]), plugin(), {
      callPrototypeFor() {
        calls += 1;
        return { noreturn:true };
      },
    });
    assert.equal(calls, 1);
    assert.equal(blocks.length, 2);
  });
}