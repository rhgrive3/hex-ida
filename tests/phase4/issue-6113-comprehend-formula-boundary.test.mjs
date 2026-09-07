import assert from 'node:assert/strict';
import { formulaOf, matchFormulas } from '../../js/comprehend.js';

for (const text of [
  ['攻撃力×120÷100'],
  { toString: () => '攻撃力×120÷100' },
  120,
  true,
  new String('攻撃力×120÷100'),
]) {
  assert.equal(formulaOf(text), null, 'structured formula text must not become evidence');
}

const primitive = formulaOf('攻撃力×120÷100');
assert.deepEqual(primitive?.mul, [120n]);
assert.deepEqual(primitive?.div, [100n]);

const step = {
  row: 1,
  address: 0x1000n,
  expr: {
    k: 'bin',
    op: 'mul',
    a: { k: 'reg', reg: 'x0', row: 0 },
    b: { k: 'const', v: 120n },
  },
};
assert.equal(
  matchFormulas([step], [{ row: 1, text: ['攻撃力×120'] }], null),
  null,
  'matchFormulas must not consume structured label text',
);
assert.equal(
  matchFormulas([step], [{ row: 1, text: '攻撃力×120' }], null)?.matched,
  1,
  'primitive formula labels must remain matchable',
);

console.log('issue-6113-comprehend-formula-boundary: ok');
