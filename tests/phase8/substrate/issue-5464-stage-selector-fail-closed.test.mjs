import assert from 'node:assert/strict';
import test from 'node:test';

import { INTERACTIVE_STAGES, PASS_STAGES, phase8Passes, runPhase8Vertical } from '../../../js/decompiler/phase8/index.js';

/**
 * #5464: a stage selector is a closed-set contract. The pass descriptor side
 * already validates `stage` against PASS_STAGES; the run side used to accept
 * any iterable and silently select zero passes for an unrecognized name,
 * publishing "complete" with an empty optimizer set. Unknown must be explicit,
 * never empty.
 */

const CONTEXT = Object.freeze({
  ir: {
    values: [{ id: 1, origin: { instructionIds: ['instruction_1'] } }, { id: 2, origin: { instructionIds: ['instruction_2'] } }],
    blocks: [{ id: 'entry' }],
    entry: 'entry',
    origin: { instructionIds: ['instruction_1'] },
  },
  types: null,
  opts: {},
});

test('#5464: an unknown stage name fails closed instead of selecting nothing', () => {
  assert.throws(() => phase8Passes({ stages: ['definitely-not-a-stage'] }),
    (error) => error instanceof TypeError && /phase8-unknown-stage:definitely-not-a-stage/.test(error.message));
});

test('#5464: malformed selectors fail closed, including iterable-but-not-stage payloads', () => {
  assert.throws(() => phase8Passes({ stages: 'gvn' }),
    (error) => error instanceof TypeError && /phase8-unknown-stage:g/.test(error.message),
    'a string iterates to characters, none of which is a stage');
  assert.throws(() => phase8Passes({ stages: ['scalar-optimization', 'nope'] }), /phase8-unknown-stage:nope/);
  assert.throws(() => phase8Passes({ stages: 7 }), /phase8-stages-invalid/);
  assert.throws(() => phase8Passes({ stages: {} }), /phase8-stages-invalid/);
});

test('#5464: canonical selectors keep working', () => {
  const scalarOnly = phase8Passes({ stages: ['scalar-optimization'] });
  assert.ok(scalarOnly.length > 0);
  assert.ok(scalarOnly.every(({ descriptor }) => descriptor.stage === 'scalar-optimization'));
  const allStages = phase8Passes({ stages: [...PASS_STAGES] });
  assert.equal(allStages.length, phase8Passes().length, 'the full selector is the default selection');
  assert.ok(allStages.every(({ descriptor }) => PASS_STAGES.includes(descriptor.stage)));
  assert.ok(phase8Passes().length > 0);
  assert.deepEqual([...INTERACTIVE_STAGES], ['canonical-facts']);
});

test('#5464: the vertical withholds its ledger for an unknown stage selector', () => {
  const outcome = runPhase8Vertical({ ...CONTEXT, enabledStages: ['definitely-not-a-stage'] }, {});
  assert.equal(outcome.ledger.published, false);
  assert.equal(outcome.ledger.status, 'failed');
  assert.equal(outcome.ledger.completeness, 'unknown');
  assert.equal(outcome.ledger.stopReason, 'stage-selector-invalid');
  assert.ok(outcome.ledger.diagnostics.some((d) => d.code === 'phase8.stages.invalid'));
  assert.equal(outcome.analysis, null, 'no analysis state was seeded or fabricated for a withheld run');
});
