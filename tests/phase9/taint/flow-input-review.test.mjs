import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaintFlow } from '../../../js/symbolic/taint/flow.js';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';
import { identity } from './fixtures.mjs';
const models = createTaintModels({id:'flow-review',version:'1',provenance:'unit regression',sinks:[{id:'sink',valueId:'out'}]});

test('an explicitly missing data dependency is TOP, not untainted', () => {
  const flow = createTaintFlow({ identity, models });
  flow.value('out', [undefined], 'data');
  assert.equal(flow.solve().sinks[0].taint.kind, 'top');
});

test('flow input traversal reserves its work before walking entries', () => {
  const flow = createTaintFlow({ identity, models, limits: { workItems: 16 } });
  assert.throws(() => flow.value('out', new Array(17).fill(null), 'data'), /budget:workItems/);
});

test('flow rejects a non-array dependency producer without invoking its iterator', () => {
  const flow = createTaintFlow({ identity, models }); let invoked = false;
  const iterable = { *[Symbol.iterator]() { invoked = true; yield null; } };
  assert.throws(() => flow.value('out', iterable, 'data'), /invalid-flow-inputs/);
  assert.equal(invoked, false);
});
