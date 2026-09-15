import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeEvidenceRecord } from '../js/runtime-evidence/index.js';

// #8662: a content-addressed runtime evidence record must own an immutable
// snapshot of the exact content it hashed, so that mutating the caller/backend
// payload after publication cannot rewrite published evidence behind a stable
// evidence ID (which would silently corrupt fusion / canonicalization).

function baseOpts(over = {}) {
  return {
    sessionId: 's', experimentId: 'e', caseId: 'c', kind: 'experiment',
    timestamp: '2026-09-13T18:31:07.000Z', occurrence: 'run-1',
    ...over,
  };
}

test('#8662 published record owns its observation payload (caller mutation is inert)', () => {
  const observedState = { returnValue: 1, nested: { flag: 'before' } };
  const branch = { target: '0x1000', taken: true, meta: { label: 'before' } };
  const input = { args: [1, 2] };
  const initialState = { registers: { x0: '1' } };
  const record = createRuntimeEvidenceRecord(baseOpts({ observedState, input, initialState, branchPath: [branch], verdict: 'supported' }));
  const id = record.id;

  observedState.returnValue = 2;
  observedState.nested.flag = 'after';
  branch.taken = false;
  branch.meta.label = 'after';
  input.args[0] = 99;
  initialState.registers.x0 = '99';

  assert.equal(record.id, id, 'evidence id is stable');
  assert.equal(record.observedState.returnValue, 1, 'stored observed value is the owned snapshot, not the mutated caller value');
  assert.equal(record.observedState.nested.flag, 'before');
  assert.equal(record.branchPath[0].taken, true);
  assert.equal(record.branchPath[0].meta.label, 'before');
  assert.equal(record.input.args[0], 1);
  assert.equal(record.initialState.registers.x0, '1');
});

test('#8662 published record and nested content are frozen', () => {
  const record = createRuntimeEvidenceRecord(baseOpts({
    observedState: { returnValue: 7, delta: { mem: [1, 2] } },
    reproducibility: { replayable: true, runs: 3, consistent: true },
  }));
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.observedState));
  assert.ok(Object.isFrozen(record.observedState.delta.mem));
  assert.ok(Object.isFrozen(record.reproducibility));
  assert.ok(Object.isFrozen(record.provenance));
});

test('#8662 owned snapshot preserves structured value types (BigInt / typed arrays)', () => {
  const observedState = { returnValue: 42n, bytes: new Uint8Array([1, 2, 3]) };
  const record = createRuntimeEvidenceRecord(baseOpts({ observedState, branchPath: [] }));
  assert.equal(typeof record.observedState.returnValue, 'bigint');
  assert.equal(record.observedState.returnValue, 42n);
  assert.ok(record.observedState.bytes instanceof Uint8Array);
  observedState.bytes[0] = 99;
  assert.equal(record.observedState.bytes[0], 1, 'typed-array buffer is a distinct owned copy');
});

test('#8662 re-deriving from a frozen record content stays consistent (no id/content split)', () => {
  const observedState = { returnValue: 1 };
  const record = createRuntimeEvidenceRecord(baseOpts({ observedState, branchPath: [] }));
  const again = createRuntimeEvidenceRecord(baseOpts({ observedState: { returnValue: 1 }, branchPath: [] }));
  assert.equal(record.id, again.id, 'same logical content -> same generated id');
});
