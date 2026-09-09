import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';

const origin = (id) => ({ instructionIds: [`instruction-${id}`] });

function returnFixture({ operator = 'add', constant = '16', throughCasts = false, malformed = false, float = false, metadataConstant = true, multiReturn = false } = {}) {
  const values = [
    { id: 'arg0', kind: 'definition', metadata: { argumentIndex: 0 } },
    {
      id: 'const-value',
      kind: 'definition',
      definitionNodeId: 'const-node',
      ...(metadataConstant ? { metadata: { constant: float ? { kind: 'float', widthBits: 64, value: constant } : { kind: 'bitvector', widthBits: 64, value: constant } } } : {}),
    },
    { id: 'sum', kind: 'definition', definitionNodeId: 'binary-node' },
  ];
  const nodes = [
    {
      id: 'const-node',
      kind: 'const',
      outputs: ['const-value'],
      attributes: {
        constant: malformed
          ? { kind: 'bitvector', widthBits: 64, value: 'not-an-integer' }
          : float
            ? { kind: 'float', widthBits: 64, value: constant }
            : { kind: 'bitvector', widthBits: 64, value: constant },
      },
      origin: origin('const'),
    },
    { id: 'binary-node', kind: 'binary', operator, inputs: ['arg0', 'const-value'], outputs: ['sum'], origin: origin('binary') },
  ];
  let returnValue = 'sum';
  if (throughCasts) {
    values.push(
      { id: 'copy-value', kind: 'definition', definitionNodeId: 'copy-node' },
      { id: 'cast-value', kind: 'definition', definitionNodeId: 'cast-node' },
    );
    nodes.push(
      { id: 'copy-node', kind: 'copy', inputs: ['sum'], outputs: ['copy-value'], origin: origin('copy') },
      { id: 'cast-node', kind: 'bitcast', inputs: ['copy-value'], outputs: ['cast-value'], origin: origin('cast') },
    );
    returnValue = 'cast-value';
  }
  const inputs = ['arg0'];
  const returnInputs = [returnValue];
  if (multiReturn) {
    inputs.push('arg1');
    values.push({ id: 'arg1', kind: 'definition', metadata: { argumentIndex: 1 } });
    returnInputs.push('arg1');
  }
  nodes.push({ id: 'return-node', kind: 'return', inputs: returnInputs, origin: origin('return') });
  return { functionId: 'fixture', inputs, values, nodes };
}

function summaryFor(ir, options = {}) {
  return buildLocalFunctionSummary(ir, {}, null, null, options).summary;
}

test('issue #4463 reads Semantic IR v2 attributes.constant for add/sub provenance', () => {
  const add = summaryFor(returnFixture({ operator: 'add', metadataConstant: false }));
  const sub = summaryFor(returnFixture({ operator: 'sub', metadataConstant: false }));
  assert.deepEqual(add.returnProvenance.map(({ kind, argIndex, offset, returnIndex }) => ({ kind, argIndex, offset, returnIndex })), [
    { kind: 'arg', argIndex: 0, offset: '16', returnIndex: 0 },
  ]);
  assert.deepEqual(sub.returnProvenance.map(({ kind, argIndex, offset, returnIndex }) => ({ kind, argIndex, offset, returnIndex })), [
    { kind: 'arg', argIndex: 0, offset: '-16', returnIndex: 0 },
  ]);
});

test('issue #4463 preserves copy/bitcast traversal and multi-return indexes', () => {
  const summary = summaryFor(returnFixture({ throughCasts: true, multiReturn: true }));
  assert.deepEqual(summary.returnProvenance.map(({ kind, argIndex, offset, returnIndex }) => ({ kind, argIndex, offset, returnIndex })), [
    { kind: 'arg', argIndex: 0, offset: '16', returnIndex: 0 },
    { kind: 'arg', argIndex: 1, offset: '0', returnIndex: 1 },
  ]);
});

test('issue #4463 keeps malformed and non-integer constants unknown', () => {
  const malformed = summaryFor(returnFixture({ malformed: true }));
  assert.deepEqual(malformed.returnProvenance.map(({ kind, returnIndex }) => ({ kind, returnIndex })), [
    { kind: 'unknown', returnIndex: 0 },
  ]);

  const nonInteger = summaryFor(returnFixture({ float: true }));
  assert.deepEqual(nonInteger.returnProvenance.map(({ kind, returnIndex }) => ({ kind, returnIndex })), [
    { kind: 'unknown', returnIndex: 0 },
  ]);
});

test('issue #4463 composes canonical callee offset provenance at the caller', () => {
  const callee = summaryFor({ ...returnFixture(), functionId: 'callee' });
  const caller = {
    functionId: 'caller',
    inputs: ['caller-arg'],
    values: [
      { id: 'caller-arg', kind: 'definition', metadata: { argumentIndex: 0 } },
      { id: 'call-result', kind: 'definition', definitionNodeId: 'call-node' },
    ],
    nodes: [
      {
        id: 'call-node',
        kind: 'call',
        inputs: ['caller-arg'],
        outputs: ['call-result'],
        call: {
          targetValueIds: [], targetEntityIds: ['callee'], arguments: ['caller-arg'], returns: ['call-result'],
          memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' }, stateReads: [], stateWrites: [],
          controlEffects: [], determinism: 'deterministic', noreturn: false, mayThrow: false,
          summarySource: 'issue-4463-fixture', completeness: 'complete',
        },
        origin: origin('call'),
      },
      { id: 'caller-return', kind: 'return', inputs: ['call-result'], origin: origin('caller-return') },
    ],
  };
  const summary = summaryFor(caller, { calleeSummaries: new Map([['callee', callee]]) });
  assert.deepEqual(summary.returnProvenance.map(({ kind, argIndex, offset, returnIndex }) => ({ kind, argIndex, offset, returnIndex })), [
    { kind: 'arg', argIndex: 0, offset: '16', returnIndex: 0 },
  ]);
});

console.log('issue #4463 local summary constant provenance: PASS');
