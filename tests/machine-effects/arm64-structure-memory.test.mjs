import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
const arrangements = Object.freeze([
  ['8b', 8, 8], ['16b', 16, 8], ['4h', 4, 16], ['8h', 8, 16],
  ['2s', 2, 32], ['4s', 4, 32], ['1d', 1, 64], ['2d', 2, 64],
]);

function instruction(mnemonic, operandText) {
  return lift(mnemonic, parseOperands(operandText));
}

function lift(mnemonic, ops) {
  const instructionId = `arm64-structure-memory-${sequence++}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    ops,
    mode:'a64',
    origin:{ instructionIds:[instructionId] },
  });
}

function mapping(mnemonic, registerCount, laneCount, memoryElementIndex) {
  if (mnemonic.endsWith('1')) {
    return {
      registerIndex:Math.floor(memoryElementIndex / laneCount),
      laneIndex:memoryElementIndex % laneCount,
    };
  }
  return {
    registerIndex:memoryElementIndex % registerCount,
    laneIndex:Math.floor(memoryElementIndex / registerCount),
  };
}

function registerList(start, count, arrangement) {
  return Array.from({ length:count }, (_, index) => `v${(start + index) & 31}.${arrangement}`).join(', ');
}

function assertMemoryMapping(effect, mnemonic, arrangement, registerStart, registerCount, laneCount, elementBits) {
  assert.equal(effect.completeness, 'exact', `${mnemonic} ${arrangement}: exact effect required`);
  assert.equal(effect.metadata.arrangement, arrangement);
  assert.equal(effect.metadata.laneCount, laneCount);
  assert.equal(effect.metadata.elementBits, elementBits);
  assert.equal(effect.metadata.registerCount, registerCount);

  const memoryOperations = effect.operations.filter((operation) => operation.kind === 'memory-read' || operation.kind === 'memory-write');
  const expectedCount = registerCount * laneCount;
  assert.equal(memoryOperations.length, expectedCount);
  const direction = mnemonic.startsWith('ld') ? 'memory-read' : 'memory-write';
  assert.ok(memoryOperations.every((operation) => operation.kind === direction));
  for (let memoryElementIndex = 0; memoryElementIndex < expectedCount; memoryElementIndex++) {
    const operation = memoryOperations[memoryElementIndex];
    const { registerIndex, laneIndex } = mapping(mnemonic, registerCount, laneCount, memoryElementIndex);
    assert.equal(operation.metadata.memoryElementIndex, memoryElementIndex);
    assert.equal(operation.metadata.accessOrder, memoryElementIndex);
    assert.equal(operation.metadata.structureRegisterIndex, registerIndex);
    assert.equal(operation.metadata.registerId, `v${(registerStart + registerIndex) & 31}`);
    assert.equal(operation.metadata.elementIndex, laneIndex);
    assert.equal(operation.access.widthBits, elementBits);
    const address = operation.access.addressExpr;
    assert.equal(address.kind, 'add');
    assert.equal(address.right.value, String(memoryElementIndex * elementBits / 8));
  }

  if (mnemonic.startsWith('ld')) {
    const inserts = effect.operations.filter((operation) => operation.kind === 'value' && operation.opcode === 'insert-lane');
    assert.equal(inserts.length, expectedCount);
    for (const operation of inserts) {
      const { laneIndex } = operation.metadata;
      const registerIndex = operation.metadata.structureRegisterIndex;
      assert.equal(operation.metadata.registerId, `v${(registerStart + registerIndex) & 31}`);
      assert.equal(operation.metadata.laneIndex, laneIndex);
      const memoryElementIndex = mnemonic.endsWith('1')
        ? registerIndex * laneCount + laneIndex
        : laneIndex * registerCount + registerIndex;
      assert.equal(operation.metadata.memoryElementIndex, memoryElementIndex);
    }
    const writes = effect.operations.filter((operation) => operation.kind === 'register-write' && operation.metadata?.purpose === 'arm64-structure-load');
    assert.deepEqual(writes.map((operation) => operation.register.registerId),
      Array.from({ length:registerCount }, (_, index) => `v${(registerStart + index) & 31}`));
  } else {
    const extracts = effect.operations.filter((operation) => operation.kind === 'value' && operation.opcode === 'extract-lane');
    assert.equal(extracts.length, expectedCount);
    for (const operation of extracts) {
      const { laneIndex } = operation.metadata;
      const registerIndex = operation.metadata.structureRegisterIndex;
      assert.equal(operation.metadata.registerId, `v${(registerStart + registerIndex) & 31}`);
      assert.equal(operation.metadata.laneIndex, laneIndex);
      const memoryElementIndex = mnemonic.endsWith('1')
        ? registerIndex * laneCount + laneIndex
        : laneIndex * registerCount + registerIndex;
      assert.equal(operation.metadata.memoryElementIndex, memoryElementIndex);
    }
  }
}

test('LD1–LD4 and ST1–ST4 map every allowed vector arrangement exactly', () => {
  for (const [arrangement, laneCount, elementBits] of arrangements) {
    for (const { mnemonic, registerCounts } of [
      { mnemonic:'ld1', registerCounts:[1,2,3,4] },
      { mnemonic:'ld2', registerCounts:[2] },
      { mnemonic:'ld3', registerCounts:[3] },
      { mnemonic:'ld4', registerCounts:[4] },
      { mnemonic:'st1', registerCounts:[1,2,3,4] },
      { mnemonic:'st2', registerCounts:[2] },
      { mnemonic:'st3', registerCounts:[3] },
      { mnemonic:'st4', registerCounts:[4] },
    ]) {
      for (const registerCount of registerCounts) {
        if (arrangement === '1d' && (!mnemonic.endsWith('1') || registerCount > 2)) continue;
        const start = 29;
        const text = `{ ${registerList(start, registerCount, arrangement)} }, [x8]`;
        const effect = instruction(mnemonic, text);
        assertMemoryMapping(effect, mnemonic, arrangement, start, registerCount, laneCount, elementBits);
        assert.equal(effect.metadata.deinterleaved, !mnemonic.endsWith('1'));
      }
    }
  }
});

test('reserved .1d structure-list combinations remain partial with a named reason', () => {
  for (const [mnemonic, registerCount] of [
    ['ld1', 3], ['ld1', 4], ['ld2', 2], ['ld3', 3], ['ld4', 4],
    ['st1', 3], ['st1', 4], ['st2', 2], ['st3', 3], ['st4', 4],
  ]) {
    const text = `{ ${registerList(0, registerCount, '1d')} }, [x8]`;
    const effect = instruction(mnemonic, text);
    assert.equal(effect.completeness, 'partial', `${mnemonic} ${text}`);
    assert.equal(effect.unknownEffects.reason, 'arm64-structure-memory-arrangement-unencodable-for-register-list');
  }
});

test('structure loads validate immediate post-index stride and update the base afterward', () => {
  const effect = instruction('ld3', '{ v5.4s, v6.4s, v7.4s }, [x8], #48');
  assert.equal(effect.completeness, 'exact');
  const reads = effect.operations.filter((operation) => operation.kind === 'memory-read');
  assert.equal(reads.length, 12);
  assert.equal(reads[0].access.addressExpr.kind, 'temporary', 'post-index accesses start at the original base');
  for (let index = 1; index < reads.length; index++) {
    assert.equal(reads[index].access.addressExpr.right.value, String(index * 4));
  }
  const lastRead = effect.operations.findLastIndex((operation) => operation.kind === 'memory-read');
  const writeback = effect.operations.findIndex((operation) => operation.kind === 'register-write'
    && operation.metadata?.purpose === 'address-writeback');
  assert.ok(writeback > lastRead, 'post-index writeback follows the structure reads and vector writes');
  const addition = effect.operations.find((operation) => operation.kind === 'value'
    && operation.metadata?.purpose === 'address-writeback');
  assert.equal(addition.inputs[1].value, '48');
  assert.equal(effect.metadata.addressing.mode, 'post');
  assert.equal(effect.metadata.addressing.writebackDisplacement, '48');
});

test('structure stores use an X register for post-index writeback', () => {
  const effect = instruction('st2', '{ v30.2d, v31.2d }, [x12], x13');
  assert.equal(effect.completeness, 'exact');
  assert.equal(effect.metadata.addressing.writebackRegister, 'x13');
  assert.equal(effect.operations.filter((operation) => operation.kind === 'memory-write').length, 4);
  assert.ok(effect.operations.some((operation) => operation.kind === 'register-read'
    && operation.register.registerId === 'x12'), 'the base register is read');
  assert.ok(effect.operations.some((operation) => operation.kind === 'register-read'
    && operation.register.registerId === 'x13'), 'the writeback register is read');
  const lastWrite = effect.operations.findLastIndex((operation) => operation.kind === 'memory-write');
  const baseWriteback = effect.operations.findIndex((operation) => operation.kind === 'register-write'
    && operation.register.registerId === 'x12' && operation.metadata?.purpose === 'address-writeback');
  assert.ok(baseWriteback > lastWrite, 'register post-index writeback follows the structure stores');
  const addition = effect.operations.find((operation) => operation.kind === 'value'
    && operation.metadata?.purpose === 'address-writeback');
  assert.equal(addition.inputs.length, 2);
  assert.equal(addition.metadata.writebackRegister, 'x13');
});

test('unmodeled structure encodings remain partial with a named reason', () => {
  const [baseMemory] = parseOperands('[x8]');
  const badArrangement = lift('ld3', [{
    k:'list',
    regs:[0,1,2].map((num) => ({ k:'reg', cls:'vec', bits:128, num, arr:'3s', text:`v${num}.3s` })),
  }, baseMemory]);
  assert.equal(badArrangement.completeness, 'partial');
  assert.equal(badArrangement.unknownEffects.reason, 'arm64-structure-memory-arrangement-unencodable');

  const badStride = instruction('ld3', '{ v0.4s, v1.4s, v2.4s }, [x8], #16');
  assert.equal(badStride.completeness, 'partial');
  assert.equal(badStride.unknownEffects.reason, 'arm64-structure-memory-post-index-immediate-does-not-match-transfer-size');

  const brokenList = instruction('st2', '{ v0.8b, v2.8b }, [x8]');
  assert.equal(brokenList.completeness, 'partial');
  assert.equal(brokenList.unknownEffects.reason, 'arm64-structure-memory-register-list-must-be-consecutive');

  const [memory] = parseOperands('[x8]');
  const conflictingAddress = lift('ld1', [{ k:'list', regs:[{ k:'reg', cls:'vec', bits:128, num:0, arr:'8b', text:'v0.8b' }] }, {
    ...memory,
    disp:{ k:'imm', value:16n, text:'#16' },
    addressDisp:{ k:'imm', value:8n, text:'#8' },
  }]);
  assert.equal(conflictingAddress.completeness, 'partial');
  assert.equal(conflictingAddress.unknownEffects.reason, 'arm64-structure-memory-conflicting-address-displacement-evidence');
});
