import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fuse, evidence, decide, independentGroupCount,
  VERDICT, GROUP,
} from '../js/evidence.js';

const ev = (code, strength) => evidence(code, strength == null ? 1 : strength, {});
const CANDIDATES = { candidates: 200 };
const cand = (codes) => ({ fusion: fuse(codes.map((c) => ev(c)), CANDIDATES) });
const weakRunnerUp = () => cand(['field-name-weak']);
const THREE_GROUPS = [
  'field-name-asked', 'class-name',
  'getter-verified', 'setter-verified', 'rmw-verified',
  'type-declared',
];

test('#4341 issue-minimal repro: forged count over empty items/groups cannot confirm', () => {
  const result = decide([
    {
      fusion: {
        logOdds: 20,
        probability: 0.999999,
        verified: true,
        identifying: 1,
        independentGroups: 3,
        groups: [],
        items: [],
      },
    },
  ]);
  assert.notEqual(result.verdict, VERDICT.CONFIRMED, '証拠0件＋捏造countでconfirmedになっている');
  assert.equal(independentGroupCount(result.top.fusion), 0);
  assert.ok(result.missing.includes('need-independent-evidence'));
});

test('#4341 fractional/negative/unsafe independentGroups fail closed to 0', () => {
  assert.equal(independentGroupCount({ independentGroups: 3.5 }), 0);
  assert.equal(independentGroupCount({ independentGroups: -2 }), 0);
  assert.equal(independentGroupCount({ independentGroups: Number.MAX_SAFE_INTEGER + 1 }), 0);
  assert.equal(independentGroupCount({ independentGroups: Infinity }), 0);
  assert.equal(independentGroupCount({ independentGroups: '3' }), 0);
});

test('#4341 malformed groups arrays are not counted as independent evidence', () => {
  assert.equal(independentGroupCount({ groups: [{}, {}, {}] }), 0);
  assert.equal(independentGroupCount({ groups: ['not-a-group', 'also-not', 'metadata'] }), 0);
  assert.equal(independentGroupCount({ groups: [GROUP.METADATA, GROUP.METADATA, GROUP.DATAFLOW], independentGroups: 3 }), 0);
});

test('#4341 duplicate group entries are not counted as extra independent groups', () => {
  assert.equal(independentGroupCount({ groups: [GROUP.METADATA, GROUP.METADATA] }), 1);
  assert.equal(independentGroupCount({ groups: [GROUP.RUNTIME, GROUP.RUNTIME, GROUP.RUNTIME] }), 1);
});

test('#4341 count/groups/items mismatch fails closed even with otherwise valid metadata', () => {
  assert.equal(independentGroupCount({ groups: [GROUP.METADATA, GROUP.DATAFLOW], independentGroups: 3 }), 0);
  assert.equal(independentGroupCount({ groups: [GROUP.METADATA, GROUP.DATAFLOW], independentGroups: 1.5 }), 0);
});

test('#4341 real items re-derive the count; metadata cannot inflate past the evidence', () => {
  const f = cand(THREE_GROUPS).fusion;
  const inflated = Object.assign({}, f, { independentGroups: 99 });
  assert.equal(independentGroupCount(inflated), f.independentGroups);
  const emptied = { logOdds: 20, probability: 0.999999, verified: 3, identifying: 1, independentGroups: 3, items: [] };
  assert.equal(independentGroupCount(emptied), 0);
});

test('#4341 canonical fuse output keeps its independent count and confirmed verdict', () => {
  const top = cand(THREE_GROUPS);
  assert.equal(independentGroupCount(top.fusion), top.fusion.independentGroups);
  assert.equal(top.fusion.independentGroups, 3);
  const res = decide([top, weakRunnerUp()]);
  assert.equal(res.verdict, VERDICT.CONFIRMED, '正統な3群が確定できなくなった: ' + res.verdict);
});

test('#4341 legacy fusion without items keeps validated canonical metadata', () => {
  assert.equal(independentGroupCount({ groups: [GROUP.METADATA, GROUP.DATAFLOW, GROUP.STRUCTURAL] }), 3);
  assert.equal(independentGroupCount({ groups: [GROUP.METADATA, GROUP.DATAFLOW, GROUP.STRUCTURAL], independentGroups: 3 }), 3);
  assert.equal(independentGroupCount({ independentGroups: 2 }), 2);
  assert.equal(independentGroupCount({ independentGroups: 0 }), 0);
});
