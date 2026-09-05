import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionDecodedFunction } from '../../../js/analysis/semantic-function.js';

function decoded(addresses) {
  return addresses.map((address) => ({ address:BigInt(address), length:4n, mnemonic:'x' }));
}

function plugin({ kinds = {}, targets = {} } = {}) {
  return {
    classifyControlFlow(instruction) {
      return Object.hasOwn(kinds, instruction.address.toString())
        ? kinds[instruction.address.toString()]
        : 'fallthrough';
    },
    directControlTarget(instruction) {
      return Object.hasOwn(targets, instruction.address.toString())
        ? targets[instruction.address.toString()]
        : null;
    },
  };
}

function blockAt(blocks, address) {
  return blocks.find((block) => block.startAddress === BigInt(address));
}

test('canonical direct-branch target representations keep the existing edge', () => {
  for (const target of [4n, 4, '4', '0x4']) {
    const blocks = partitionDecodedFunction(decoded([0, 4]), plugin({
      kinds:{ 0:'branch', 4:'return' },
      targets:{ 0:target },
    }));
    assert.equal(blocks.length, 2);
    assert.deepEqual(blockAt(blocks, 0).successors, [{ to:'block-4', kind:'branch' }]);
  }
});

test('structured or non-canonical control kinds cannot mint definite CFG edges', () => {
  const malformedKinds = [
    ['branch'],
    new String('branch'),
    true,
    1,
    'branch ',
  ];
  for (const kind of malformedKinds) {
    const blocks = partitionDecodedFunction(decoded([0, 4]), plugin({
      kinds:{ 0:kind, 4:'return' },
      targets:{ 0:4n },
    }));
    assert.deepEqual(blockAt(blocks, 0).successors, []);
  }

  let coercions = 0;
  const coercibleKind = {
    toString() {
      coercions += 1;
      return 'branch';
    },
  };
  const blocks = partitionDecodedFunction(decoded([0, 4]), plugin({
    kinds:{ 0:coercibleKind, 4:'return' },
    targets:{ 0:4n },
  }));
  assert.deepEqual(blockAt(blocks, 0).successors, []);
  assert.equal(coercions, 0);
});

test('structured targets cannot become canonical branch addresses', () => {
  for (const target of [[4], true, new Number(4)]) {
    const blocks = partitionDecodedFunction(decoded([0, 4]), plugin({
      kinds:{ 0:'branch', 4:'return' },
      targets:{ 0:target },
    }));
    assert.deepEqual(blockAt(blocks, 0).successors, []);
  }

  let coercions = 0;
  const coercibleTarget = {
    valueOf() {
      coercions += 1;
      return 4;
    },
    toString() {
      coercions += 1;
      return '4';
    },
  };
  const blocks = partitionDecodedFunction(decoded([0, 4]), plugin({
    kinds:{ 0:'branch', 4:'return' },
    targets:{ 0:coercibleTarget },
  }));
  assert.deepEqual(blockAt(blocks, 0).successors, []);
  assert.equal(coercions, 0);
});

test('canonical conditional branch keeps target and fallthrough successors', () => {
  const blocks = partitionDecodedFunction(decoded([0, 4, 8]), plugin({
    kinds:{ 0:'conditional-branch', 4:'return', 8:'return' },
    targets:{ 0:8n },
  }));
  assert.deepEqual(blockAt(blocks, 0).successors, [
    { to:'block-8', kind:'conditional-true' },
    { to:'block-4', kind:'conditional-false' },
  ]);
});

test('return, unknown and nullish fallthrough semantics remain conservative', () => {
  const returned = partitionDecodedFunction(decoded([0, 4]), plugin({
    kinds:{ 0:'return', 4:'fallthrough' },
  }));
  assert.equal(returned.length, 2);
  assert.deepEqual(blockAt(returned, 0).successors, []);

  const unknown = partitionDecodedFunction(decoded([0, 4]), plugin({
    kinds:{ 0:'unknown', 4:'fallthrough' },
  }));
  assert.equal(unknown.length, 2);
  assert.deepEqual(blockAt(unknown, 0).successors, []);

  for (const kind of [null, undefined, '']) {
    const fallthrough = partitionDecodedFunction(decoded([0, 4]), plugin({
      kinds:{ 0:kind, 4:'return' },
    }));
    assert.equal(fallthrough.length, 1);
  }
});

test('ordinary calls still fall through inside a block while proven noreturn calls terminate it', () => {
  const callPlugin = plugin({ kinds:{ 0:'call', 4:'return' }, targets:{ 0:4n } });

  const ordinary = partitionDecodedFunction(decoded([0, 4]), callPlugin, {
    callPrototype:{ noreturn:false },
  });
  assert.equal(ordinary.length, 1);

  const noreturn = partitionDecodedFunction(decoded([0, 4]), callPlugin, {
    callPrototype:{ noreturn:true },
  });
  assert.equal(noreturn.length, 2);
  assert.deepEqual(blockAt(noreturn, 0).successors, []);
});
