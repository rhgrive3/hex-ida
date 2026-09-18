import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPACT_DIFF_FUNCTION_SET_SCHEMA,
  createCompactFunctionSet,
  materializeCompactFunctionSet,
} from '../../../js/diff/compact-function-set.js';

function compact(symbolAddresses, symbolNames, functionAddresses = [0x1000n]) {
  return {
    schema: COMPACT_DIFF_FUNCTION_SET_SCHEMA,
    functionAddresses,
    symbolAddresses,
    symbolNames,
    count: functionAddresses.length,
    architecture: 'arm64',
    evidenceProfile: 'symmetric-symbol-fast/v1',
  };
}

test('#3759 structured symbol addresses cannot alias canonical function addresses', () => {
  for (const address of [
    ['4096'],
    [4096],
    true,
    { toString: () => '4096' },
  ]) {
    const rows = materializeCompactFunctionSet(compact([address], ['forged_name']));
    assert.equal(rows[0].address, 0x1000n);
    assert.equal(rows[0].name, null, `structured address ${String(address)} must not bind a symbol name`);
  }
});

test('#3759 malformed primitive address values fail closed', () => {
  for (const address of [false, 4096.5, -1, '']) {
    const rows = materializeCompactFunctionSet(compact([address], ['forged_name']));
    assert.equal(rows[0].name, null, `malformed primitive address ${String(address)} must not bind a symbol name`);
  }
});

test('#3759 padded primitive decimal addresses retain canonical normalization', () => {
  for (const address of ['04096', ' 4096 ']) {
    const rows = materializeCompactFunctionSet(compact([address], ['normalized_name']));
    assert.equal(rows[0].name, 'normalized_name', `primitive address ${JSON.stringify(address)} must use the existing canonical identity`);
  }
});

test('#3759 non-string symbol names are not retained as function identity', () => {
  for (const name of [['forged_name'], { toString: () => 'forged_name' }, true, 1]) {
    const rows = materializeCompactFunctionSet(compact([0x1000n], [name]));
    assert.equal(rows[0].name, null);
  }
});

test('#3759 valid primitive u64 address forms preserve symbol identity', () => {
  for (const address of [0x1000n, 0x1000, '4096', '0x1000']) {
    const rows = materializeCompactFunctionSet(compact([address], ['valid_name']));
    assert.equal(rows[0].name, 'valid_name');
  }
});

test('#3759 malformed serialized entries fail closed without discarding valid neighbors', () => {
  const rows = materializeCompactFunctionSet(compact(
    [0x1000n, ['8192'], 0x3000n],
    ['first', 'forged_second', 'third'],
    [0x1000n, 0x2000n, 0x3000n],
  ));
  assert.deepEqual(rows.map((row) => row.name), ['first', null, 'third']);
});

test('#3759 producer sanitizes malformed symbol identity columns before publication', () => {
  const produced = createCompactFunctionSet({
    funcs: [0x1000n, 0x2000n],
    addrs: [['4096'], 0x2000n],
    names: ['forged_first', 'second'],
    functionStartsComplete: true,
  }, 'arm64');
  assert.deepEqual(materializeCompactFunctionSet(produced).map((row) => row.name), [null, 'second']);
  assert.deepEqual([...produced.symbolAddresses], [0x2000n]);
  assert.deepEqual(produced.symbolNames, ['second']);
});
