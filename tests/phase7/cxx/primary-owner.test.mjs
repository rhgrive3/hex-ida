import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrimaryOwnerResolver } from '../../../js/analysis/cxx/primary-owner.js';
import { createCxxQueryPlanner } from '../../../js/analysis/cxx/query-recovery.js';

const record = (className, typeinfoAddress, bases = [], extra = {}) => ({ className, typeinfoAddress,
  offsetToTop: 0n, isSecondary: false, slots: [{ address: 100n }], bases, ...extra });
const base = (className, typeinfoAddress, extra = {}) => ({ className, typeinfoAddress,
  offsetToTop: 0n, isVirtual: false, isPublic: true, ...extra });

test('shared inherited slot binds to the declaring primary owner through exact RTTI identities', () => {
  const owner = record('Base', 1n), child = record('Child', 2n, [base('Base', 1n)]);
  const leaf = record('Leaf', 3n, [base('Child', 2n)]), classes = [owner, child, leaf];
  assert.equal(createPrimaryOwnerResolver(classes)(100n, 'Base'), owner);
  const symbols = { funcs: [100n], addrs: [100n], names: ['_ZNK4Base8GetCountEv'] };
  const planner = createCxxQueryPlanner({ symbols, classEvidence: { classes }, isExecutable: () => true });
  assert.deepEqual(planner.plan('base count').map(row => [row.address, row.className, row.proof]),
    [[100n, 'Base', 'declaring-primary-vtable-owner']]);
  assert.equal(createPrimaryOwnerResolver(classes)(100n, 'Child'), null);
});

test('unrelated folded implementations, ambiguous RTTI, secondary and virtual bases fail closed', () => {
  const owner = record('Base', 1n);
  const bad = [record('Other', 2n), record('Child', 2n, [base('Base', 9n)]),
    record('Child', 2n, [base('Base', 1n, { offsetToTop: 8n })]),
    record('Child', 2n, [base('Base', 1n, { isVirtual: true })]),
    record('Child', 2n, [base('Base', 1n)], { offsetToTop: -8n, isSecondary: true }),
    record('Child', 2n, [base('Base', 1n), base('Base', 1n)]),
    record('Child', 2n, [base(null, 1n)])];
  for (const child of bad) assert.equal(createPrimaryOwnerResolver([owner, child])(100n, 'Base'), null);
  assert.equal(createPrimaryOwnerResolver([owner, record('Base', 2n)])(100n, 'Base'), null);
  assert.equal(createPrimaryOwnerResolver([owner])(101n, 'Base'), null);
});

test('cycles, graph budget, adjusting thunks and conflicting symbol aliases remain excluded', () => {
  const owner = record('Base', 1n), child = record('Child', 2n, [base('Child', 2n)]);
  assert.equal(createPrimaryOwnerResolver([owner, child])(100n, 'Base'), null);
  const valid = [owner, record('Child', 2n, [base('Base', 1n)])];
  assert.equal(createPrimaryOwnerResolver(valid)(100n, 'Base', { maxNodes: 1 }), null);
  for (const names of [['_ZThn8_NK4Base8GetCountEv'], ['_ZNK4Base8GetCountEv', '_ZNK5Other8GetCountEv']]) {
    const symbols = { funcs: [100n], addrs: names.map(() => 100n), names };
    assert.deepEqual(createCxxQueryPlanner({ symbols, classEvidence: { classes: valid }, isExecutable: () => true })
      .plan('base count'), []);
  }
});
