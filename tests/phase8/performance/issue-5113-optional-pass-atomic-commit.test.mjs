import assert from 'node:assert/strict';
import test from 'node:test';

import { PassManager } from '../../../js/decompiler/passes/manager.js';

test('#5113 an optional pass failure rolls back top-level partial mutation', () => {
  const manager = new PassManager([
    {
      name: 'optional-broken-transform',
      required: false,
      run(state) {
        state.ast = { kind: 'corrupted-partial-ast' };
        state.typeFacts = ['half-written'];
        throw new Error('rewrite failed halfway');
      },
    },
    {
      name: 'required-finalizer',
      required: true,
      run(state) {
        state.finalizerObserved = { ast: state.ast, typeFacts: state.typeFacts };
        return state;
      },
    },
  ]);

  const state = manager.run({ ast: { kind: 'original-valid-ast' }, typeFacts: [] });
  assert.equal(state.passMetrics[0].ok, false, 'failure recorded');
  assert.ok(state.warnings.some((w) => w.includes('rewrite failed halfway')));
  assert.equal(state.degraded, true);
  assert.equal(state.finalizerObserved.ast.kind, 'original-valid-ast', 'last valid state survives');
  assert.deepEqual(state.finalizerObserved.typeFacts, []);
});

test('#5113 nested Map/array/object mutation by a failed optional pass does not survive', () => {
  const manager = new PassManager([
    {
      name: 'nested-corruptor',
      required: false,
      run(state) {
        state.memo.set('forged', 'x');
        state.rows.push('leaked');
        state.ast.body.kind = 'mutated';
        delete state.mustStay;
        throw new Error('partial nested rewrite');
      },
    },
    {
      name: 'required-finalizer',
      required: true,
      run(state) {
        state.observed = {
          memoHasForged: state.memo.has('forged'),
          rows: [...state.rows],
          bodyKind: state.ast.body.kind,
          mustStay: state.mustStay,
        };
        return state;
      },
    },
  ]);

  const state = manager.run({
    memo: new Map([['real', 'v']]),
    rows: ['a'],
    ast: { body: { kind: 'original' } },
    mustStay: 'present',
  });
  assert.equal(state.observed.memoHasForged, false);
  assert.deepEqual(state.observed.rows, ['a']);
  assert.equal(state.observed.bodyKind, 'original');
  assert.equal(state.observed.mustStay, 'present');
});

test('#5113 a successful optional pass commits its changes atomically', () => {
  const manager = new PassManager([
    {
      name: 'good-transform',
      required: false,
      run(state) {
        state.markers.push('committed');
        state.memo.set('k', 1n);
        state.ast = { kind: 'rewritten' };
        return state;
      },
    },
    {
      name: 'required-finalizer',
      required: true,
      run(state) {
        state.observed = { markers: [...state.markers], memoK: state.memo.get('k'), ast: state.ast };
        return state;
      },
    },
  ]);

  const state = manager.run({ markers: [], memo: new Map(), ast: { kind: 'original' } });
  assert.equal(state.passMetrics[0].ok, true);
  assert.deepEqual(state.observed.markers, ['committed']);
  assert.equal(state.observed.memoK, 1n, 'bigint values survive fork/commit');
  assert.equal(state.observed.ast.kind, 'rewritten');
});

test('#5113 repeated optional failures keep the pipeline on the last valid state', () => {
  const manager = new PassManager([
    {
      name: 'first-failure',
      required: false,
      run(state) { state.value = 'touched'; throw new Error('first'); },
    },
    {
      name: 'second-failure',
      required: false,
      run(state) { state.value = 'touched-again'; throw new Error('second'); },
    },
    {
      name: 'required-finalizer',
      required: true,
      run(state) { state.observed = state.value; return state; },
    },
  ], { timeBudgetMs: 100 });

  const state = manager.run({ value: 'valid' });
  assert.equal(state.passMetrics.filter((m) => m.ok === false).length, 2);
  assert.equal(state.observed, 'valid');
});

test('#5113 a required pass that mutates and throws still propagates the error', () => {
  const manager = new PassManager([
    {
      name: 'required-broken',
      required: true,
      run(state) {
        state.touched = true;
        throw new Error('required failure');
      },
    },
  ]);

  assert.throws(() => manager.run({}), /required failure/);
});

test('#5113 cyclic state survives the fork and rolls back on failure', () => {
  const manager = new PassManager([
    {
      name: 'cyclic-corruptor',
      required: false,
      run(state) {
        state.graph.nodes.push('forged');
        state.graph.root.tag = 'mutated';
        throw new Error('cycle failure');
      },
    },
    {
      name: 'required-finalizer',
      required: true,
      run(state) {
        state.observed = { nodes: [...state.graph.nodes], tag: state.graph.root.tag };
        return state;
      },
    },
  ]);

  const state = manager.run({ graph: { nodes: ['real'], root: { tag: 'original' } } });
  state.graph.root.parent = state.graph;
  assert.deepEqual(state.observed.nodes, ['real']);
  assert.equal(state.observed.tag, 'original');
});
