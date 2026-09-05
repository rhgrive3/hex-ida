import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';

const authorization = { kind: 'proposal', token: 'approved-token' };

function executorFor(app) {
  return new CapabilityExecutor({
    app,
    catalog: {
      get(id) {
        return {
          id,
          agentExposed: true,
          requiresApproval: true,
          inputSchema: { type: 'object' },
          category: 'annotation',
        };
      },
    },
  });
}

async function rejectsToolFailed(promise) {
  await assert.rejects(promise, (error) => error?.type === 'tool_failed');
}

{
  let saves = 0;
  const priorAnnotation = { id: 'prior' };
  const priorConfirmed = { id: 'prior-confirmed' };
  const app = {
    projectAnnotations: [priorAnnotation],
    autoReport: { report: { confirmed: [priorConfirmed], deep: [] } },
    workspace: { autosave: () => { saves += 1; return true; } },
  };
  const result = await executorFor(app).execute(
    'annotation.project',
    { id: 'finding-1', value: { claim: 'x' } },
    { authorization },
  );
  assert.equal(result.id, 'finding-1');
  assert.equal(saves, 1);
  assert.equal(app.projectAnnotations.length, 2);
  assert.equal(app.projectAnnotations[0], priorAnnotation);
  assert.equal(app.autoReport.report.confirmed.length, 2);
  assert.equal(app.autoReport.report.confirmed[0], priorConfirmed);
  assert.equal(app.autoReport.report.confirmed[1].source, 'project-annotation');
}

{
  let saves = 0;
  const annotations = [{ id: 'prior' }];
  const confirmed = [{ id: 'prior-confirmed' }];
  const app = {
    projectAnnotations: annotations,
    autoReport: { report: { confirmed, deep: [] } },
    workspace: { autosave: () => { saves += 1; return false; } },
  };
  await rejectsToolFailed(executorFor(app).execute(
    'annotation.project',
    { id: 'finding-2', value: { claim: 'not-durable' } },
    { authorization },
  ));
  assert.equal(saves, 1);
  assert.equal(app.projectAnnotations, annotations, 'rollback must preserve the existing annotation array identity');
  assert.deepEqual(app.projectAnnotations, [{ id: 'prior' }], 'failed autosave must remove the in-memory annotation');
  assert.equal(app.autoReport.report.confirmed, confirmed, 'rollback must preserve the existing confirmed array identity');
  assert.deepEqual(app.autoReport.report.confirmed, [{ id: 'prior-confirmed' }], 'failed autosave must remove the confirmed report entry');
}

{
  const app = {
    workspace: { autosave: () => false },
  };
  await rejectsToolFailed(executorFor(app).execute(
    'annotation.project',
    { id: 'finding-3', value: { claim: 'no-state-leak' } },
    { authorization },
  ));
  assert.equal(app.projectAnnotations, undefined, 'failed autosave must restore an absent projectAnnotations field');
  assert.equal(app.autoReport, undefined, 'failed autosave must restore an absent autoReport field');
}

{
  const annotations = [{ id: 'prior' }];
  const confirmed = [{ id: 'prior-confirmed' }];
  const quotaError = new Error('storage quota exceeded');
  const app = {
    projectAnnotations: annotations,
    autoReport: { report: { confirmed, deep: [] } },
    workspace: { autosave: () => { throw quotaError; } },
  };
  await assert.rejects(
    executorFor(app).execute(
      'annotation.project',
      { id: 'finding-4', value: { claim: 'throws' } },
      { authorization },
    ),
    (error) => error === quotaError,
  );
  assert.deepEqual(app.projectAnnotations, [{ id: 'prior' }]);
  assert.deepEqual(app.autoReport.report.confirmed, [{ id: 'prior-confirmed' }]);
}

{
  const app = {};
  await rejectsToolFailed(executorFor(app).execute(
    'annotation.project',
    { id: 'finding-5', value: { claim: 'no-workspace' } },
    { authorization },
  ));
  assert.equal(app.projectAnnotations, undefined, 'missing persistence adapter must fail before mutation');
  assert.equal(app.autoReport, undefined, 'missing persistence adapter must fail before report mutation');
}

{
  const legacyConfirmed = { legacy: true };
  const app = {
    projectAnnotations: [],
    autoReport: { report: { confirmed: legacyConfirmed, deep: [] } },
    workspace: { autosave: () => true },
  };
  await executorFor(app).execute(
    'annotation.project',
    { id: 'finding-6', value: { claim: 'canonicalize-confirmed' } },
    { authorization },
  );
  assert.ok(Array.isArray(app.autoReport.report.confirmed), 'successful mutation must replace malformed confirmed state with a canonical array');
  assert.equal(app.autoReport.report.confirmed.length, 1);
  assert.equal(app.autoReport.report.confirmed[0].id, 'finding-6');
}

{
  const annotations = [{ id: 'prior' }];
  const legacyConfirmed = { legacy: true };
  const app = {
    projectAnnotations: annotations,
    autoReport: { report: { confirmed: legacyConfirmed, deep: [] } },
    workspace: { autosave: () => false },
  };
  await rejectsToolFailed(executorFor(app).execute(
    'annotation.project',
    { id: 'finding-7', value: { claim: 'restore-malformed-confirmed' } },
    { authorization },
  ));
  assert.deepEqual(app.projectAnnotations, [{ id: 'prior' }]);
  assert.equal(app.autoReport.report.confirmed, legacyConfirmed, 'rollback must restore a prior non-array confirmed value exactly');
}

{
  const legacyAutoReport = 'legacy-report';
  const app = {
    projectAnnotations: [{ id: 'prior' }],
    autoReport: legacyAutoReport,
    workspace: { autosave: () => false },
  };
  await rejectsToolFailed(executorFor(app).execute(
    'annotation.project',
    { id: 'finding-8', value: { claim: 'restore-malformed-report-root' } },
    { authorization },
  ));
  assert.deepEqual(app.projectAnnotations, [{ id: 'prior' }]);
  assert.equal(app.autoReport, legacyAutoReport, 'rollback must restore a malformed prior autoReport root exactly');
}

console.log('issue-3762 AI project annotation autosave regression: ok');
