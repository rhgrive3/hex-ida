import assert from 'node:assert/strict';
import {
  ASSUMPTION_TRUST,
  createAssumption,
} from '../js/symbolic/translate/support-matrix.js';

function run() {
  // 1. Valid primitive-string assumption keeps existing canonical results.
  const valid = createAssumption({
    id: 'asm-1',
    kind: 'range',
    statement: 'x < 10',
    source: 'translator',
    originIds: ['inst-1', 'inst-2'],
    trust: ASSUMPTION_TRUST.SEMANTIC_FACT,
  });
  assert.equal(valid.id, 'asm-1');
  assert.equal(valid.kind, 'range');
  assert.equal(valid.statement, 'x < 10');
  assert.equal(valid.source, 'translator');
  assert.deepEqual(valid.originIds, ['inst-1', 'inst-2']);
  assert.equal(valid.trust, 'semantic-fact');
  assert.ok(Object.isFrozen(valid.originIds));

  // Omitted source keeps the default; omitted originIds stays an empty array.
  const defaulted = createAssumption({ id: 'a', kind: 'k', statement: 's' });
  assert.equal(defaulted.source, 'translator');
  assert.deepEqual(defaulted.originIds, []);

  // 2. Structured id/kind/statement/source must not be coerced to canonical strings.
  assert.throws(
    () => createAssumption({ id: ['asm-1'], kind: 'range', statement: 'x < 10', source: 'translator' }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: 'asm-1', kind: ['range'], statement: 'x < 10', source: 'translator' }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: 'asm-1', kind: 'range', statement: ['x < 10'], source: 'translator' }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: 'asm-1', kind: 'range', statement: 'x < 10', source: ['translator'] }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: { value: 'asm-1' }, kind: 'range', statement: 'x < 10', source: 'translator' }),
    TypeError,
  );

  // 3. Required identity/text fields must be non-empty strings.
  assert.throws(() => createAssumption({ id: '', kind: 'k', statement: 's' }), TypeError);
  assert.throws(() => createAssumption({ id: 'a', kind: '', statement: 's' }), TypeError);
  assert.throws(() => createAssumption({ id: 'a', kind: 'k', statement: '' }), TypeError);
  assert.throws(() => createAssumption({ id: 42, kind: 'k', statement: 's' }), TypeError);

  // 4. originIds is Array-only with non-empty string elements; a bare string is
  //    not accepted as a character list and non-Array iterables are rejected.
  assert.throws(
    () => createAssumption({ id: 'a', kind: 'k', statement: 's', originIds: 'abc' }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: 'a', kind: 'k', statement: 's', originIds: new Set(['inst-1']) }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: 'a', kind: 'k', statement: 's', originIds: new Array(1) }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: 'a', kind: 'k', statement: 's', originIds: [['inst-1']] }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: 'a', kind: 'k', statement: 's', originIds: ['inst-1', 7] }),
    TypeError,
  );
  assert.throws(
    () => createAssumption({ id: 'a', kind: 'k', statement: 's', originIds: ['inst-1', ''] }),
    TypeError,
  );

  // 5. The malformed counterexample from the issue never becomes a canonical record.
  assert.throws(
    () => createAssumption({
      id: ['asm-1'],
      kind: ['range'],
      statement: ['x < 10'],
      source: ['translator'],
      originIds: [['inst-1']],
    }),
    TypeError,
  );

  console.log('issue-4686 symbolic assumption constructor schema: PASS');
}

run();
