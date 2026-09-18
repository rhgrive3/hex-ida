import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';

const SNAPSHOT_ID = 'snapshot-issue-4003';

function directReturnIr(metadata, { inputs } = {}) {
  return {
    functionId: 'fn_direct',
    ...(inputs === undefined ? {} : { inputs }),
    values: [{ id: 'v-ret', metadata }],
    nodes: [{ id: 'ret', kind: 'return', inputs: ['v-ret'], outputs: [] }],
  };
}

function directProvenance(metadata, options = {}) {
  const { summary } = buildLocalFunctionSummary(
    directReturnIr(metadata, options),
    null,
    { definitions: [], uses: [] },
    null,
    { snapshotId: SNAPSHOT_ID },
  );
  assert.ok(summary, 'local summary must publish');
  return summary.returnProvenance;
}

function calleeSummary() {
  return createFunctionSummary({
    functionId: 'fn_callee',
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '8' }],
    status: {
      snapshotId: SNAPSHOT_ID,
      analyzerId: 'issue-4003-callee',
      analyzerVersion: '1',
      completeness: 'complete',
      stopReason: null,
    },
  });
}

function composedProvenance(argumentMetadata) {
  const ir = {
    functionId: 'fn_caller',
    values: [
      { id: 'arg0', metadata: argumentMetadata },
      { id: 'ret0', definitionNodeId: 'call0' },
    ],
    nodes: [
      {
        id: 'call0',
        kind: 'call',
        inputs: ['arg0'],
        outputs: ['ret0'],
        call: {
          targetEntityIds: ['fn_callee'],
          arguments: ['arg0'],
          returns: ['ret0'],
          memoryRead: { scope: 'none' },
          memoryWrite: { scope: 'none' },
          stateReads: [],
          stateWrites: [],
          controlEffects: [],
          determinism: 'deterministic',
          noreturn: false,
          mayThrow: false,
          summarySource: 'issue-4003-fixture',
          completeness: 'complete',
        },
      },
      { id: 'ret', kind: 'return', inputs: ['ret0'], outputs: [] },
    ],
  };
  const { summary } = buildLocalFunctionSummary(ir, null, { definitions: [], uses: [] }, null, {
    snapshotId: SNAPSHOT_ID,
    calleeSummaries: new Map([['fn_callee', calleeSummary()]]),
  });
  assert.ok(summary, 'composed local summary must publish');
  return summary.returnProvenance;
}

function assertUnknown(provenance, message) {
  assert.equal(provenance.length, 1, message);
  assert.equal(provenance[0]?.kind, 'unknown', message);
  assert.equal(provenance[0]?.returnIndex, 0, message);
}

function assertArg(provenance, offset = '0') {
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0]?.kind, 'arg');
  assert.equal(provenance[0]?.returnIndex, 0);
  assert.equal(provenance[0]?.argIndex, 0);
  assert.equal(provenance[0]?.offset, offset);
}

test('#4003 metadata formal argument indices are primitive safe-integer numbers only', () => {
  const coercibleObject = { valueOf: () => 0 };
  const throwingObject = { valueOf: () => { throw new Error('argument index coercion must not run'); } };
  for (const value of [
    '0', ['0'], true, false, {}, coercibleObject, throwingObject, Symbol('0'), 0n, 0.5, NaN, Infinity, -1,
  ]) {
    assertUnknown(
      directProvenance({ argumentIndex: value }),
      `malformed argumentIndex ${String(value)} must not become argument provenance`,
    );
  }

  assertArg(directProvenance({ argumentIndex: 0 }));
});

test('#4003 legacy metadata aliases share the same strict index contract', () => {
  for (const field of ['argIndex', 'abiArgIndex']) {
    assertUnknown(directProvenance({ [field]: ['0'] }), `${field} arrays must fail closed`);
    assertUnknown(directProvenance({ [field]: '0' }), `${field} numeric strings must fail closed`);
    assertArg(directProvenance({ [field]: 0 }));
  }
});

test('#4003 canonical ir.inputs positional identity remains authoritative', () => {
  assertArg(directProvenance({ argumentIndex: ['not-authority'] }, { inputs: ['v-ret'] }));
});

test('#4003 interprocedural return composition cannot launder malformed caller metadata', () => {
  assertUnknown(
    composedProvenance({ argumentIndex: ['0'] }),
    'a malformed caller argument index must not compose callee arg provenance',
  );

  assertArg(composedProvenance({ argumentIndex: 0 }), '8');
});
