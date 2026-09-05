import assert from 'node:assert/strict';
import test from 'node:test';

import { apiInfo } from '../../../js/blocks.js';
import {
  createBitVectorValue,
  createMachineOperation,
  createTemporaryValue,
  createUndefinedResultDescriptor,
} from '../../../js/semantics/effects/index.js';

test('BattleCats unknown-call labels are exact names, not allocator or logging regex authority', () => {
  const expected = new Map([
    ['malloc_size', { id:'malloc_size', cat:'memory', args:['ptr'], ret:'length', effect:'read' }],
    ['os_log_type_enabled', { id:'os_log_type_enabled', cat:'log', args:['log','type'], ret:'status', effect:'read' }],
    ['os_log_create', { id:'os_log_create', cat:'log', args:['subsystem','category'], ret:'object', effect:'runtime' }],
  ]);
  for (const [name, meaning] of expected) {
    for (const spelling of [name, `_${name}`]) {
      const actual = apiInfo(spelling);
      assert.ok(actual, spelling);
      for (const [key, value] of Object.entries(meaning)) assert.deepEqual(actual[key], value, `${spelling}:${key}`);
    }
  }

  for (const name of [
    'malloc_size_extra', 'my_malloc_size', '__malloc_size',
    'os_log_type_enabled_extra', 'my_os_log_type_enabled', '__os_log_type_enabled',
    'os_log_create_extra', 'my_os_log_create', '__os_log_create',
  ]) {
    const actual = apiInfo(name);
    assert.notEqual(actual?.id, 'malloc_size', name);
    assert.notEqual(actual?.id, 'os_log_type_enabled', name);
    assert.notEqual(actual?.id, 'os_log_create', name);
  }
});

function valueOperation(undefinedResult) {
  return createMachineOperation({
    kind:'value', opcode:'architectural-boundary',
    inputs:[createBitVectorValue(32, 1n)],
    outputs:[createTemporaryValue('t017-undefined-result', createBitVectorValue(32))],
    undefinedResult,
  });
}

test('undefined-result descriptors snapshot own data without coercion or getter execution', () => {
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
    enumerable: true, configurable: true, writable: true, value: { kind:'source-zero' },
  });
  const preservedProtoCondition = createUndefinedResultDescriptor({
    ...valid, class:'conditional', condition:protoCondition,
  }).condition;
  assert.equal(Object.hasOwn(preservedProtoCondition, '__proto__'), true);
  assert.deepEqual(preservedProtoCondition.__proto__, { kind:'source-zero' });
  assert.equal(Object.getPrototypeOf(preservedProtoCondition), Object.prototype);

  const hidden = { ...valid };
  Object.defineProperty(hidden, 'unreviewed', { enumerable:false, value:true });
  assert.throws(() => createUndefinedResultDescriptor(hidden), /unexpected-undefined-result-field/);

  for (const hostile of [
    new Proxy({ ...valid }, { getPrototypeOf() { throw new Error('hostile'); } }),
    new Proxy({ ...valid }, { ownKeys() { throw new Error('hostile'); } }),
    new Proxy({ ...valid }, { getOwnPropertyDescriptor() { throw new Error('hostile'); } }),
  ]) assert.throws(() => createUndefinedResultDescriptor(hostile), /snapshot-failed/);
});

test('undefined-result conditions retain existing vocabulary but bind explicit operand indices', () => {
  const legacyCondition = { kind:'divide-by-zero', operand:'divisor' };
  const operation = valueOperation({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'legacy-condition', condition:legacyCondition,
  });
  assert.deepEqual(operation.undefinedResult.condition, legacyCondition);

  assert.throws(() => valueOperation({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'out-of-range',
    condition:{ kind:'source-zero', operandIndex:1 },
  }), /condition-operand-out-of-range/);
  assert.throws(() => valueOperation({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'invalid-index',
    condition:{ kind:'source-zero', operandIndex:'0' },
  }), /invalid-undefined-result-condition-operand/);

  let conditionGetterCalls = 0;
  const hostileCondition = { kind:'source-zero', operandIndex:0 };
  Object.defineProperty(hostileCondition, 'kind', {
    enumerable:true, get() { conditionGetterCalls += 1; return 'source-zero'; },
  });
  assert.throws(() => valueOperation({
    widthBits:32, mask:'0xffffffff', class:'conditional', reason:'hostile-condition', condition:hostileCondition,
  }), /invalid-undefined-result-condition/);
  assert.equal(conditionGetterCalls, 0);

  const base = {
    kind:'value', opcode:'add', inputs:[createBitVectorValue(8, 1n)],
    outputs:[createTemporaryValue('t017-malformed', createBitVectorValue(8))],
  };
  assert.throws(() => createMachineOperation({ ...base, undefinedResult:null }), /undefined-result-required/);
  assert.throws(() => createMachineOperation({ ...base, undefinedResult:undefined }), /undefined-result-required/);
  assert.doesNotThrow(() => createMachineOperation(base));
});
