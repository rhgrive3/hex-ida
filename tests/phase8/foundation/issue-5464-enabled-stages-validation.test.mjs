import assert from 'node:assert/strict';
import test from 'node:test';

import { runPhase8Vertical } from '../../../js/decompiler/phase8/index.js';

const ir = { values: [], instructions: [], blocks: [], entry: 0 };
const budget = { shouldAbort: () => false };

test('#5464 an unknown enabled stage fails closed instead of publishing empty success', () => {
  assert.throws(
    () => runPhase8Vertical({ ir, enabledStages: ['scalar-optimizaton'] }, budget),
    (error) => error?.message === 'phase8-enabled-stage-unknown:scalar-optimizaton',
    'a typo in a stage selector must not become a published complete ledger',
  );
});

test('#5464 a non-array enabledStages selector fails closed', () => {
  assert.throws(
    () => runPhase8Vertical({ ir, enabledStages: 'canonical-facts' }, budget),
    (error) => error?.message === 'phase8-enabled-stages-invalid',
  );
});

test('#5464 known stage selections still run and publish', () => {
  const outcome = runPhase8Vertical({ ir, enabledStages: ['canonical-facts'] }, budget);
  assert.equal(outcome.ledger.published, true);
  assert.equal(outcome.ledger.passes.length, 1);
});
