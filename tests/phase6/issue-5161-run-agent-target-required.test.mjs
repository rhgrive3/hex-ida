import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTION_SCHEMA } from '../../js/ai/schema.js';
import { createActionRunner } from '../../js/ai/interaction/actions.js';
import { normalizeResponse } from '../../js/ai/render/normalize.js';
import { sanitizeActions, validateAIResult, validateSchema } from '../../js/ai/validation.js';

const invalidTargets = [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['whitespace', ' \t\n '],
  ['non-string', 42],
];

test('#5161 schema requires a non-blank string target for run-agent', () => {
  for (const [label, target] of invalidTargets) {
    const action = target === undefined ? { kind:'run-agent' } : { kind:'run-agent', target };
    assert.equal(validateSchema(action, ACTION_SCHEMA).ok, false, `${label} schema input must fail closed`);
  }
  assert.equal(validateSchema({ kind:'run-agent', target:'  inspect the save path  ' }, ACTION_SCHEMA).ok, true);
  assert.doesNotThrow(() => validateAIResult({
    mode:'chat', style:'analyst', answer:'ok',
    actions:[{ kind:'run-agent', target:'  inspect the save path  ', label:'Investigate with Agent' }],
  }));
});

test('#5161 sanitizeActions drops missing/null/blank/non-string goals and trims valid goals', () => {
  const values = invalidTargets.map(([label, target]) => ({ label, kind:'run-agent', target }));
  values.push({ kind:'run-agent', target:'  inspect the save path  ', label:'custom presentation' });
  assert.deepEqual(sanitizeActions(values), [{
    kind:'run-agent', target:'inspect the save path', label:'custom presentation',
  }]);
});

test('#5161 normalization never invents a goal from the run-agent presentation label', () => {
  const model = normalizeResponse({ answer:'ok', actions:[
    { kind:'run-agent', label:'Investigate with Agent' },
    { kind:'run-agent', target:null, label:'Investigate with Agent' },
    { kind:'run-agent', target:'   ', label:'Investigate with Agent' },
    { kind:'run-agent', target:42, label:'Investigate with Agent' },
    { kind:'run-agent', target:'  inspect the save path  ', label:'custom label' },
  ] });
  assert.deepEqual(model.actions.map(({ kind, target, label }) => ({ kind, target, label })), [{
    kind:'run-agent', target:'inspect the save path', label:'custom label',
  }]);
});

test('#5161 runner refuses invalid goals and asks only the normalized target', async () => {
  const opened = [];
  const asked = [];
  const assistant = {
    open: () => opened.push('open'),
    ask: (goal, options) => asked.push({ goal, options }),
  };
  const run = createActionRunner({}, { assistant });

  for (const [, target] of invalidTargets) {
    await run({ kind:'run-agent', target, label:'Investigate with Agent' });
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(asked, []);

  await run({ kind:'run-agent', target:'  inspect the save path  ', label:'different UI label' });
  await run({ kind:'run-agent', target:'inspect the save path', label:'another UI label' });
  assert.deepEqual(opened, ['open', 'open']);
  assert.deepEqual(asked, [
    { goal:'inspect the save path', options:{ mode:'agent' } },
    { goal:'inspect the save path', options:{ mode:'agent' } },
  ]);
});

test('#5161 preserves review-proposal and address navigation action contracts', () => {
  const model = normalizeResponse({ answer:'ok', actions:[
    { kind:'review-proposal', target:'proposal_1' },
    { kind:'open-function', target:'0x1000' },
  ] });
  assert.deepEqual(model.actions.map(({ kind, target, address }) => ({ kind, target, address })), [
    { kind:'review-proposal', target:'proposal_1', address:null },
    { kind:'open-function', target:'0x1000', address:0x1000n },
  ]);
});

console.log('issue #5161 run-agent target contract: PASS');
