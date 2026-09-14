// Regression for #5648: the live project session persistence must not resolve
// save()/delete() before the durable write completes, and a failed workspace
// autosave (boolean false or throw) must surface to the caller instead of
// being swallowed.
import assert from 'node:assert/strict';
import { createLiveProjectSessionPersistence } from '../js/ai/ui/bridge.js';

function makeProject() {
  return { findings: { investigationSessions: [] }, updatedAt: null };
}

// 1. autosave() === false fails the save.
{
  const project = makeProject();
  const app = { workspace: { project, autosave() { return false; } }, activeProject: project };
  const persistence = createLiveProjectSessionPersistence(app);
  await assert.rejects(
    persistence.save({ id: 's1', goal: 'x' }),
    (error) => /workspace-autosave-failed/.test(error.message),
    'a failed autosave must fail the save, not resolve it',
  );
}

// 2. A throwing autosave surfaces its error.
{
  const project = makeProject();
  const app = { workspace: { project, autosave() { throw new Error('quota exceeded'); } }, activeProject: project };
  const persistence = createLiveProjectSessionPersistence(app);
  await assert.rejects(persistence.save({ id: 's2', goal: 'x' }), /quota exceeded/);
}

// 3. save() resolves only after the durable write ran.
{
  const project = makeProject();
  let savedAt = null;
  const app = { workspace: { project, autosave() { savedAt = Date.now(); return true; } }, activeProject: project };
  const persistence = createLiveProjectSessionPersistence(app);
  let resolved = false;
  const pending = persistence.save({ id: 's3', goal: 'x' }).then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false, 'save() must not resolve before the debounced durable write');
  await pending;
  assert.ok(savedAt, 'the autosave must have run');
  assert.equal(project.findings.investigationSessions.length, 1);
}

// 4. delete() follows the same durable contract.
{
  const project = makeProject();
  project.findings.investigationSessions.push({ id: 'gone' });
  let deletedInStorage = true;
  const app = { workspace: { project, autosave() { return deletedInStorage; } }, activeProject: project };
  const persistence = createLiveProjectSessionPersistence(app);
  deletedInStorage = false;
  await assert.rejects(persistence.delete('gone'), /workspace-autosave-failed/,
    'a failed autosave after deletion must not report success');
  deletedInStorage = true;
  await persistence.delete('gone');
  assert.equal(project.findings.investigationSessions.length, 0);
}

// 5. Burst saves coalesce into one autosave and all resolve together.
{
  const project = makeProject();
  let autosaveCount = 0;
  const app = { workspace: { project, autosave() { autosaveCount++; return true; } }, activeProject: project };
  const persistence = createLiveProjectSessionPersistence(app);
  await Promise.all([
    persistence.save({ id: 'b1' }),
    persistence.save({ id: 'b2' }),
    persistence.save({ id: 'b3' }),
  ]);
  assert.equal(project.findings.investigationSessions.length, 3);
  assert.equal(autosaveCount, 1, 'bursts coalesce into a single autosave');
}

console.log('issue #5648 durable live persistence regressions PASS');
