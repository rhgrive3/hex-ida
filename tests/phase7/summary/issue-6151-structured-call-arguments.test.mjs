import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';

// #6151: composeCallReturnProvenance() used `callNode.call.arguments` elements
// directly as value ids. Raw/partial IR carries the canonical structured
// argument spelling ({ valueId: 'v0', ... }); for those the composed caller
// provenance degraded to unknown even though the callee's arg-return
// provenance is fully resolvable. escape.js already unwraps
// `argument?.valueId ?? argument`; the local summary composer now does too.

const SNAPSHOT_ID = 'snapshot_issue_6151';
const STATUS = {
  snapshotId: SNAPSHOT_ID,
  analyzerId: 'issue-6151-callee',
  analyzerVersion: '1',
  completeness: 'complete',
};

function calleeSummary() {
  // Callee: return 0 = argument 0 + 8.
  return createFunctionSummary({
    functionId: 'fn_callee',
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '8' }],
    status: STATUS,
  });
}

// Raw IR (the same pre-validation shape the composer accepts from partial IR
// sources): caller(arg0) { ret0 = call callee(arg0); return ret0 }.
function callerIr(argumentList, { metadataArgumentLookup = false } = {}) {
  return {
    functionId: 'fn_caller',
    ...(metadataArgumentLookup ? {} : { inputs: ['arg0'] }),
    values: [
      {
        id: 'arg0', kind: 'computed', definitionNodeId: 'def-arg0', machineType: { kind: 'bitvector', widthBits: 64 },
        ...(metadataArgumentLookup ? { metadata: { argumentIndex: 0 } } : {}),
      },
      { id: 'ret0', kind: 'computed', definitionNodeId: 'call0', machineType: { kind: 'bitvector', widthBits: 64 } },
    ],
    nodes: [
      { id: 'def-arg0', kind: 'definition', blockId: 'entry', inputs: [], outputs: ['arg0'] },
      {
        id: 'call0',
        blockId: 'entry',
        kind: 'call',
        inputs: ['arg0'],
        outputs: ['ret0'],
        call: {
          targetEntityIds: ['fn_callee'],
          arguments: argumentList,
          returns: ['ret0'],
          memoryRead: { scope: 'none' },
          memoryWrite: { scope: 'none' },
          stateReads: [],
          stateWrites: [],
          controlEffects: [],
          determinism: 'deterministic',
          noreturn: false,
          mayThrow: false,
          summarySource: 'issue-6151-fixture',
          completeness: 'complete',
        },
      },
      { id: 'return0', blockId: 'entry', kind: 'return', inputs: ['ret0'] },
    ],
    blocks: [],
  };
}

function compose(argumentList, options = {}) {
  const { summary } = buildLocalFunctionSummary(callerIr(argumentList, options), null, { definitions: [], uses: [] }, null, {
    snapshotId: SNAPSHOT_ID,
    calleeSummaries: new Map([['fn_callee', calleeSummary()]]),
  });
  assert.ok(summary, 'the caller summary publishes');
  return summary.returnProvenance ?? [];
}

test('#6151 a structured { valueId } argument composes the callee arg provenance', () => {
  const composed = compose([{ valueId: 'arg0' }]);
  const argFact = composed.find((prov) => prov.kind === 'arg' && prov.returnIndex === 0);
  assert.ok(argFact, `the structured argument must compose kind:arg provenance, got ${JSON.stringify(composed)}`);
  assert.equal(argFact.argIndex, 0, 'the composed argument is the caller formal arg0');
  assert.equal(argFact.offset, '8', 'the callee offset rides through composition');
  assert.ok(!composed.some((prov) => prov.kind === 'unknown' && prov.returnIndex === 0),
    'a resolvable provenance must not degrade to unknown');
});

test('#6151 metadata on a structured argument does not change its value identity', () => {
  const composed = compose([{ valueId: 'arg0', machineType: { kind: 'bitvector', widthBits: 64 }, role: 'pointer' }]);
  assert.ok(composed.some((prov) => prov.kind === 'arg' && prov.argIndex === 0 && prov.offset === '8'));
});

test('#6151 plain string arguments keep composing provenance (no regression)', () => {
  const composed = compose(['arg0']);
  assert.ok(composed.some((prov) => prov.kind === 'arg' && prov.argIndex === 0 && prov.offset === '8'));
});

test('#6151 a structured argument without a valueId fails closed to unknown', () => {
  const composed = compose([{ notAValueId: true }]);
  assert.ok(composed.some((prov) => prov.kind === 'unknown' && prov.returnIndex === 0),
    'an argument without a resolvable value must stay conservative');
});

test('#6151 malformed structured arguments never use object coercion for formal lookup', () => {
  for (const argument of [{}, { valueId: null }, Object.create(null)]) {
    const composed = compose([argument], { metadataArgumentLookup: true });
    assert.ok(composed.some((prov) => prov.kind === 'unknown' && prov.returnIndex === 0),
      'malformed structured arguments must remain explicit unknown');
  }
});
