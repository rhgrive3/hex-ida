import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';

const origin = (id) => ({ instructionIds: [`instruction-${id}`] });

function fixture({ operator = 'add', constantFirst = false, throughCasts = false } = {}) {
  const constant = { kind: 'bitvector', widthBits: 64, value: '8' };
  const values = [
    { id: 'arg0', kind: 'definition', metadata: { argumentIndex: 0 } },
    {
      id: 'c8',
      kind: 'definition',
      definitionNodeId: 'const8',
      metadata: { constant },
    },
  ];
  const nodes = [{
    id: 'const8',
    kind: 'const',
    outputs: ['c8'],
    attributes: { constant },
    origin: origin('const8'),
  }];

  let root = 'arg0';
  if (throughCasts) {
    values.push(
      { id: 'arg-copy', kind: 'definition', definitionNodeId: 'copy-arg' },
      { id: 'arg-cast', kind: 'definition', definitionNodeId: 'cast-arg' },
    );
    nodes.push(
      { id: 'copy-arg', kind: 'copy', inputs: ['arg0'], outputs: ['arg-copy'], origin: origin('copy-arg') },
      { id: 'cast-arg', kind: 'bitcast', inputs: ['arg-copy'], outputs: ['arg-cast'], origin: origin('cast-arg') },
    );
    root = 'arg-cast';
  }

  values.push({ id: 'result', kind: 'definition', definitionNodeId: 'binary' });
  nodes.push(
    {
      id: 'binary',
      kind: 'binary',
      operator,
      inputs: constantFirst ? ['c8', root] : [root, 'c8'],
      outputs: ['result'],
      origin: origin('binary'),
    },
    { id: 'return', kind: 'return', inputs: ['result'], origin: origin('return') },
  );
  return { functionId: 'issue-4736-fixture', inputs: ['arg0'], values, nodes };
}

function provenance(options) {
  const summary = buildLocalFunctionSummary(fixture(options), {}, null, null, {
    snapshotId: 'snapshot-4736',
  }).summary;
  return summary.returnProvenance.map(({ kind, argIndex, offset, returnIndex }) => ({
    kind,
    ...(argIndex == null ? {} : { argIndex }),
    ...(offset == null ? {} : { offset }),
    returnIndex,
  }));
}

const argOffset = (offset) => [{ kind: 'arg', argIndex: 0, offset, returnIndex: 0 }];
const unknown = [{ kind: 'unknown', returnIndex: 0 }];

test('issue #4736 keeps arg + constant provenance', () => {
  assert.deepEqual(provenance({ operator: 'add', constantFirst: false }), argOffset('8'));
});

test('issue #4736 makes add provenance invariant to a constant-left operand', () => {
  assert.deepEqual(provenance({ operator: 'add', constantFirst: true }), argOffset('8'));
});

test('issue #4736 keeps arg - constant provenance', () => {
  assert.deepEqual(provenance({ operator: 'sub', constantFirst: false }), argOffset('-8'));
});

test('issue #4736 does not reinterpret constant - arg as root plus offset', () => {
  assert.deepEqual(provenance({ operator: 'sub', constantFirst: true }), unknown);
});

test('issue #4736 follows copy/bitcast roots after a constant-left add', () => {
  assert.deepEqual(provenance({ operator: 'add', constantFirst: true, throughCasts: true }), argOffset('8'));
});

test('issue #4736 add operand permutations publish identical provenance', () => {
  assert.deepEqual(
    provenance({ operator: 'add', constantFirst: true }),
    provenance({ operator: 'add', constantFirst: false }),
  );
});

test('issue #4736 keeps malformed structured left operands fail-closed without coercion', () => {
  const structured = Object.create(null);
  const ir = {
    functionId: 'issue-4736-malformed',
    inputs: ['arg0'],
    values: [
      { id: 'arg0', kind: 'definition', metadata: { argumentIndex: 0 } },
      { id: 'result', kind: 'definition', definitionNodeId: 'binary' },
    ],
    nodes: [
      { id: 'binary', kind: 'binary', operator: 'add', inputs: [structured, 'arg0'], outputs: ['result'], origin: origin('malformed') },
      { id: 'return', kind: 'return', inputs: ['result'], origin: origin('malformed-return') },
    ],
  };
  const summary = buildLocalFunctionSummary(ir, {}, null, null, { snapshotId: 'snapshot-4736' }).summary;
  assert.deepEqual(summary.returnProvenance.map(({ kind, returnIndex }) => ({ kind, returnIndex })), unknown);
});
