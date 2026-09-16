import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBitVectorValue,
  createMachineOperation,
  createTemporaryValue,
  createUndefinedResultDescriptor,
} from '../../js/semantics/effects/index.js';

function valueOperation(undefinedResult) {
  return createMachineOperation({
    kind:'value', opcode:'architectural-boundary',
    inputs:[createBitVectorValue(32, 1n)],
    outputs:[createTemporaryValue('t017-undefined-result', createBitVectorValue(32))],
    undefinedResult,
  });
}

test('undefined-result condition arrays never silently lose sparse entries', () => {
  const descriptor = (condition) => createUndefinedResultDescriptor({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'array-shape', condition,
  });
  const dense = ['source-zero', { operandIndex:0 }, null];
  assert.deepEqual(descriptor(dense).condition, dense);

  const trailingHole = ['source-zero'];
  trailingHole.length = 2;
  const interiorHole = ['source-zero', , 'fallback'];
  for (const condition of [trailingHole, interiorHole, new Array(2)]) {
    assert.throws(() => descriptor(condition), /invalid-undefined-result-condition/);
  }

  let lengthReads = 0;
  const trappedLength = new Proxy(dense, {
    get(target, key, receiver) {
      if (key === 'length') { lengthReads += 1; throw new Error('unexpected-length-read'); }
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(descriptor(trappedLength).condition, dense);
  assert.equal(lengthReads, 0);
});

test('undefined-result descriptors snapshot own data without coercion or getters', () => {
  const valid = { widthBits:32, mask:'0xffffffff', class:'fully', reason:'strict-snapshot' };
  let coercions = 0;
  assert.throws(() => createUndefinedResultDescriptor({
    ...valid, widthBits:{ valueOf() { coercions += 1; return 32; } },
  }), /invalid-undefined-result-width/);
  assert.throws(() => createUndefinedResultDescriptor({
    ...valid, mask:{ toString() { coercions += 1; return '0xffffffff'; } },
  }), /invalid-undefined-result-mask/);
  assert.equal(coercions, 0);

  let getterCalls = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'widthBits', { enumerable:true, get() { getterCalls += 1; return 32; } });
  assert.throws(() => createUndefinedResultDescriptor(accessor), /requires-enumerable-data-property/);
  assert.equal(getterCalls, 0);
  assert.throws(() => createUndefinedResultDescriptor(Object.assign(Object.create({ inherited:true }), valid)), /invalid-prototype/);

  const protoCondition = {};
  Object.defineProperty(protoCondition, '__proto__', {
    enumerable:true, configurable:true, writable:true, value:{ kind:'source-zero' },
  });
  const preserved = createUndefinedResultDescriptor({
    ...valid, class:'conditional', condition:protoCondition,
  }).condition;
  assert.equal(Object.hasOwn(preserved, '__proto__'), true);
  assert.deepEqual(preserved.__proto__, { kind:'source-zero' });
  assert.equal(Object.getPrototypeOf(preserved), Object.prototype);

  const hidden = { ...valid };
  Object.defineProperty(hidden, 'unreviewed', { enumerable:false, value:true });
  assert.throws(() => createUndefinedResultDescriptor(hidden), /unexpected-undefined-result-field/);
});

test('undefined-result conditions bind explicit operand indices', () => {
  const legacyCondition = { kind:'divide-by-zero', operand:'divisor' };
  assert.deepEqual(valueOperation({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'legacy-condition', condition:legacyCondition,
  }).undefinedResult.condition, legacyCondition);

  assert.throws(() => valueOperation({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'out-of-range',
    condition:{ kind:'source-zero', operandIndex:1 },
  }), /condition-operand-out-of-range/);
  assert.throws(() => valueOperation({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'invalid-index',
    condition:{ kind:'source-zero', operandIndex:'0' },
  }), /invalid-undefined-result-condition-operand/);

  let getterCalls = 0;
  const hostileCondition = { kind:'source-zero', operandIndex:0 };
  Object.defineProperty(hostileCondition, 'kind', {
    enumerable:true, get() { getterCalls += 1; return 'source-zero'; },
  });
  assert.throws(() => valueOperation({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'hostile-condition', condition:hostileCondition,
  }), /invalid-undefined-result-condition/);
  assert.equal(getterCalls, 0);

  const base = {
    kind:'value', opcode:'add', inputs:[createBitVectorValue(8, 1n)],
    outputs:[createTemporaryValue('t017-malformed', createBitVectorValue(8))],
  };
  assert.throws(() => createMachineOperation({ ...base, undefinedResult:null }), /undefined-result-required/);
  assert.throws(() => createMachineOperation({ ...base, undefinedResult:undefined }), /undefined-result-required/);
  assert.doesNotThrow(() => createMachineOperation(base));
});
