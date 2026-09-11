import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeEvidenceRecord } from '../../../js/runtime-evidence/index.js';
import { legacyEvidenceToCanonicalGraph } from '../../../js/core/evidence/compat.js';

const base = { sessionId:'s', experimentId:'e', caseId:'c', kind:'experiment', provenanceGroup:'runtime:s:e:c', timestamp:'2026-09-10T00:00:00.000Z', observedState:{returnValue:1}, verdict:'supported' };

test('#5546 identical content/timestamp occurrences remain distinct in one correlation group', () => {
  const a=createRuntimeEvidenceRecord(base), b=createRuntimeEvidenceRecord(base);
  assert.notEqual(a.id,b.id);
  assert.equal(a.provenance.observationGroup,b.provenance.observationGroup);
  assert.doesNotThrow(()=>legacyEvidenceToCanonicalGraph({runtimeEvidence:[a,b]}));
});

test('#5546 explicit occurrence is deterministic and typed', () => {
  const a=createRuntimeEvidenceRecord({...base,occurrence:'run-1'}), b=createRuntimeEvidenceRecord({...base,occurrence:'run-1'});
  assert.equal(a.id,b.id);
  for (const occurrence of [{toString(){throw new Error('coerce');}}, [], true, -1, 1.5, -1n, 'a/b']) {
    assert.throws(()=>createRuntimeEvidenceRecord({...base,occurrence}), /runtime evidence occurrence must be a canonical primitive identity/);
  }
  assert.doesNotThrow(()=>createRuntimeEvidenceRecord({...base,occurrence:0}));
  assert.doesNotThrow(()=>createRuntimeEvidenceRecord({...base,occurrence:0n}));
});

test('#4327 bare and explicit-id records do not consume occurrence identity', () => {
  const bare=createRuntimeEvidenceRecord({sessionId:'s2',experimentId:'e',caseId:'c',kind:'observation'});
  assert.equal(bare.id,'runtime:s2:e:c:observation');
  const explicit=createRuntimeEvidenceRecord({...base,id:'explicit-evidence-id'});
  assert.equal(explicit.id,'explicit-evidence-id');
});

test('#5495 noncanonical kind spellings remain injective', () => {
  const a=createRuntimeEvidenceRecord({sessionId:'k',kind:'a/b'}), b=createRuntimeEvidenceRecord({sessionId:'k',kind:'a?b'});
  assert.notEqual(a.id,b.id);
  const l1=createRuntimeEvidenceRecord({sessionId:'k',kind:'x'.repeat(200)+'1'}), l2=createRuntimeEvidenceRecord({sessionId:'k',kind:'x'.repeat(200)+'2'});
  assert.notEqual(l1.id,l2.id);
});
