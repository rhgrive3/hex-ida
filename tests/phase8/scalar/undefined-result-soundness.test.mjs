import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { isFull } from '../../../js/decompiler/phase8/range.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

test('SCCP cannot promote a masked result to an exact constant', () => {
  const f = fixture('undefined-result-soundness');
  f.block(0);
  const value = f.binary('add', f.constant(1n, 8), f.constant(2n, 8), 8);
  value.def.extra = {
    ...(value.def.extra ?? {}),
    attributes: { machineEffects: { undefinedResult: { widthBits: 8, mask: '0xf0', class: 'partial', reason: 'formal-partial-result' } } },
  };
  f.ret();
  const ir = f.build();
  const state = seedAnalysisState(ir);
  const outcome = runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, { analysis: state, ir }, {});
  assert.equal(outcome.committed, true);
  const facts = state.get('ranges');
  assert.equal(facts.constants.has(value.id), false);
  assert.equal(isFull(facts.ranges.get(value.id)), true);
  assert.match(facts.overdefinedReasons.get(value.id), /architecturally undefined result bits/);
});
