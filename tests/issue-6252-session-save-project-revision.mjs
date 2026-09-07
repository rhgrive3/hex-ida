// #6252 — AI session persistence must not advance the project revision that
// ObservationStore binds tool results to. Saving investigation session
// bookkeeping (memory/messages) used to bump project.updatedAt, which was the
// projectRevision authority, so the detailRef returned to the model went
// stale on the very next model step.
import assert from 'node:assert/strict';
import test from 'node:test';

test('#6252 session save/delete does not invalidate observation detailRef', async () => {
  const { ObservationStore } = await import('../js/ai/tools/storage/observation-store.js');
  const { createProjectSessionPersistence } = await import('../js/ai/session-core/index.js');

  const project = {
    updatedAt: '2026-01-01T00:00:00.000Z',
    findings: { investigationSessions: [] },
  };
  const context = { binaryIdentity: 'bin-A', analysisRevision: 'rev-1', project };

  const persistence = createProjectSessionPersistence(project);
  const observations = new ObservationStore({ context });
  // Production ordering: turn executor saves session bookkeeping (update +
  // updateMemory + appendMessage) before any tool runs, so the semantic
  // revision is initialized before the first ObservationStore.put().
  await persistence.save({ id: 'ai_1', messages: [] });
  const record = observations.put({
    tool: 'demo_tool',
    arguments: { address: '0x1000' },
    fullResult: { rows: [1, 2, 3] },
  });
  const before = project.analysisSemanticRevision;

  // project.updatedAt still advances for user-visible autosave bookkeeping...
  assert.notEqual(project.updatedAt, '2026-01-01T00:00:00.000Z');
  // ...but the semantic revision that bindings use must not.
  assert.equal(project.analysisSemanticRevision, before);

  // detailRef issued before the saves is still retrievable.
  assert.equal(observations.get(record.id).id, record.id);
  assert.deepEqual(observations.detail({ detailRef: record.id }).data.rows, [1, 2, 3]);

  // Deterministic cache is not needlessly missed by session bookkeeping.
  const again = observations.put({
    tool: 'demo_tool',
    arguments: { address: '0x1000' },
    fullResult: { rows: [1, 2, 3] },
  });
  assert.equal(again.id, record.id);

  await persistence.delete('ai_1');
  assert.equal(project.analysisSemanticRevision, before);
  assert.equal(observations.get(record.id).id, record.id);
});

test('#6252 real annotation/name/comment changes still invalidate bindings', async () => {
  const { ObservationStore, analysisBinding } = await import('../js/ai/tools/storage/observation-store.js');

  const project = { updatedAt: '2026-01-01T00:00:00.000Z', analysisSemanticRevision: 'rev-0', findings: {} };
  const observations = new ObservationStore({ context: { binaryIdentity: 'bin-A', analysisRevision: 'rev-1', project } });
  const record = observations.put({ tool: 'demo_tool', arguments: {}, fullResult: {} });
  assert.equal(record.binding.projectRevision, 'rev-0');

  // A real semantic project change advances the revision (host responsibility).
  project.analysisSemanticRevision = 'rev-1';
  assert.notEqual(observations.binding().key, record.binding.key);
  assert.throws(() => observations.get(record.id), /stale-detail-ref/);

  // Analysis-level revision remains part of the binding too.
  const b1 = analysisBinding({ projectRevision: 'p1' });
  const b2 = analysisBinding({ projectRevision: 'p2' });
  assert.notEqual(b1.key, b2.key);
  // And analysisRevision fallback still works for contexts without project.
  assert.equal(analysisBinding({ binaryIdentity: 'b', analysisRevision: 'a1' }).analysisRevision, 'a1');
});
