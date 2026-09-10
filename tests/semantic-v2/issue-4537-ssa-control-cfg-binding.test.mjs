import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSemanticSsa } from '../../js/semantics/ssa/validate.js';

const origin = { operationIds: ['issue-4537-fixture'] };
const emptySsa = { contractVersion: '2.0.0', functionId: 'function-4537', definitions: [], uses: [] };

function semanticIr({ kind = 'branch', targets = ['b1'], node = {}, functionCompleteness = 'complete', unknowns = [] } = {}) {
  const values = kind === 'conditional-branch'
    ? [{ id: 'condition', kind: 'entry', machineType: { kind: 'predicate', widthBits: 1 }, sourceEntityId: 'condition', origin }]
    : [];
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'function-4537',
    entryBlockId: 'b0',
    blocks: [
      { id: 'b0', nodeIds: ['control'], origin },
      { id: 'b1', nodeIds: [], origin },
      { id: 'b2', nodeIds: [], origin },
    ],
    values,
    nodes: [{
      id: 'control',
      kind,
      blockId: 'b0',
      inputs: kind === 'conditional-branch' ? ['condition'] : [],
      outputs: [],
      targets,
      origin,
      ...node,
    }],
    completeness: functionCompleteness,
    unknowns,
    origin,
  };
}

function semanticCfg(successors) {
  return {
    functionId: 'function-4537',
    entryBlockId: 'b0',
    blocks: [
      { id: 'b0', successors },
      { id: 'b1', successors: [] },
      { id: 'b2', successors: [] },
    ],
  };
}

function controlUnknowns() {
  return [{ reason: 'control flow is not fully known', categories: ['control'] }];
}

test('#4537 rejects a branch CFG edge that disagrees with the IR target', () => {
  const ir = semanticIr({ targets: ['b1'] });
  const mismatchedCfg = semanticCfg([{ to: 'b2', kind: 'branch' }]);
  assert.throws(
    () => validateSemanticSsa(emptySsa, ir, mismatchedCfg),
    /semantic-ssa-control-flow-mismatch/,
  );
  assert.throws(
    () => validateSemanticSsa(emptySsa, ir, semanticCfg([
      { to: 'b1', kind: 'branch' },
      { to: 'b2', kind: 'branch' },
    ])),
    /semantic-ssa-control-flow-mismatch/,
  );
});

test('#4537 accepts canonical branch and conditional projections', () => {
  assert.doesNotThrow(() => validateSemanticSsa(
    emptySsa,
    semanticIr({ targets: ['b1'] }),
    semanticCfg([{ to: 'b1', kind: 'branch' }]),
  ));
  const conditionalIr = semanticIr({ kind: 'conditional-branch', targets: ['b1', 'b2'] });
  assert.doesNotThrow(() => validateSemanticSsa(
    emptySsa,
    conditionalIr,
    semanticCfg([
      { to: 'b1', kind: 'conditional-true' },
      { to: 'b2', kind: 'conditional-false' },
    ]),
  ));
  assert.throws(
    () => validateSemanticSsa(emptySsa, conditionalIr, semanticCfg([
      { to: 'b1', kind: 'conditional-true' },
      { to: 'b2', kind: 'branch' },
    ])),
    /semantic-ssa-control-flow-mismatch/,
  );
});

test('#4537 rejects a declared one-target conditional edge missing from the CFG', () => {
  const ir = semanticIr({ kind: 'conditional-branch', targets: ['b1'] });
  assert.throws(
    () => validateSemanticSsa(emptySsa, ir, semanticCfg([])),
    /semantic-ssa-control-flow-mismatch/,
  );
  assert.throws(
    () => validateSemanticSsa(emptySsa, ir, semanticCfg([{ to: 'b2', kind: 'fallthrough' }])),
    /semantic-ssa-control-flow-mismatch/,
  );
  assert.doesNotThrow(() => validateSemanticSsa(
    emptySsa,
    ir,
    semanticCfg([{ to: 'b1', kind: 'conditional-true' }]),
  ));
});

test('#4537 compares switch destinations while retaining switch edge kinds', () => {
  const ir = semanticIr({ kind: 'switch', targets: ['b1', 'b2'] });
  assert.doesNotThrow(() => validateSemanticSsa(emptySsa, ir, semanticCfg([
    { to: 'b1', kind: 'switch-case' },
    { to: 'b2', kind: 'switch-default' },
  ])));
  assert.throws(
    () => validateSemanticSsa(emptySsa, ir, semanticCfg([
      { to: 'b1', kind: 'switch-case' },
      { to: 'b2', kind: 'branch' },
    ])),
    /semantic-ssa-control-flow-mismatch/,
  );
});

test('#4537 return and trap projections cannot gain CFG successors', () => {
  for (const kind of ['return', 'trap']) {
    const ir = semanticIr({ kind, targets: [] });
    assert.doesNotThrow(() => validateSemanticSsa(emptySsa, ir, semanticCfg([])));
    assert.throws(
      () => validateSemanticSsa(emptySsa, ir, semanticCfg([{ to: 'b1', kind: 'fallthrough' }])),
      /semantic-ssa-control-flow-mismatch/,
    );
  }
});

test('#4537 preserves unknown and candidate control projections only through unknown CFG edges', () => {
  const candidateIr = semanticIr({
    kind: 'unknown-control-effect',
    targets: ['b1', 'b2'],
    functionCompleteness: 'partial',
    unknowns: controlUnknowns(),
    node: {
      completeness: 'partial',
      unknown: { reason: 'indirect target candidates', categories: ['control'] },
      attributes: { indirectControl: { targetState: 'candidate' } },
    },
  });
  assert.doesNotThrow(() => validateSemanticSsa(emptySsa, candidateIr, semanticCfg([
    { to: 'b1', kind: 'indirect-candidate' },
    { to: 'b2', kind: 'indirect-candidate' },
  ])));
  assert.throws(
    () => validateSemanticSsa(emptySsa, candidateIr, semanticCfg([{ to: 'b1', kind: 'branch' }])),
    /semantic-ssa-control-flow-mismatch/,
  );

  const unknownIr = semanticIr({
    kind: 'unknown-control-effect',
    targets: [],
    functionCompleteness: 'unknown',
    unknowns: controlUnknowns(),
    node: { unknown: { reason: 'unknown destination', categories: ['control'] } },
  });
  assert.doesNotThrow(() => validateSemanticSsa(emptySsa, unknownIr, semanticCfg([{ to: 'b2', kind: 'unknown' }])));

  const incompleteIr = semanticIr({
    kind: 'incomplete',
    targets: [],
    functionCompleteness: 'partial',
    unknowns: controlUnknowns(),
    node: { unknown: { reason: 'incomplete terminator', categories: ['control'], missing: ['successors'] }, completeness: 'partial' },
  });
  assert.doesNotThrow(() => validateSemanticSsa(emptySsa, incompleteIr, semanticCfg([{ to: 'b2', kind: 'unknown' }])));
});

console.log('semantic-v2 issue #4537 SSA control/CFG binding: PASS');
