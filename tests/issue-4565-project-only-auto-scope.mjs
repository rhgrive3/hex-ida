import assert from 'node:assert/strict';

import { createTurnSnapshot } from '../js/ai/control/snapshot.js';
import { initialScope, ScopeController, scopeForIntent } from '../js/ai/control/scope.js';

// #4565: a project-only snapshot still carries binaryId === 'fallback:unbound',
// so the project-only branch of initialScope() was unreachable.

{
  const snapshot = createTurnSnapshot({ projectId: 'project-1' }, { scope: 'auto' });
  assert.equal(snapshot.projectIdentity, 'project-1');
  assert.equal(snapshot.binaryId, 'fallback:unbound');
  assert.equal(snapshot.binaryIdentity.confidence, 'none');
  assert.equal(snapshot.binaryIdentity.kind, 'fallback');
  assert.equal(initialScope(snapshot), 'project',
    '#4565 project-only snapshot must auto-select project scope, not binary');
}

// A real content binding keeps the historical binary result.
{
  const snapshot = createTurnSnapshot({ projectId: 'project-1', binaryHash: 'hash-4565' }, { scope: 'auto' });
  assert.equal(initialScope(snapshot), 'binary', '#4565 a strong binary binding still wins');
}

// A weak fallback binding keeps the existing binary semantics.
{
  const snapshot = createTurnSnapshot({ projectId: 'project-1', fileInfo: { name: 'sample.bin' } }, { scope: 'auto' });
  assert.equal(snapshot.binaryIdentity.confidence, 'weak');
  assert.equal(initialScope(snapshot), 'binary', '#4565 weak fallback binding stays binary, as before');
}

// Existing selection/function precedence is untouched.
{
  const withFunction = createTurnSnapshot({ projectId: 'project-1', binaryHash: 'hash-4565', currentFunction: { address: '0x1000' } }, { scope: 'auto' });
  assert.equal(initialScope(withFunction), 'function');
  const withSelection = createTurnSnapshot({ projectId: 'project-1', selection: { start: '0x100', end: '0x200' } }, { scope: 'auto' });
  assert.equal(initialScope(withSelection), 'selection');
}

// Project-only snapshot through the real controller, and intent expansion intact.
{
  const snapshot = createTurnSnapshot({ projectId: 'project-1' }, { scope: 'auto' });
  const controller = new ScopeController(snapshot, 'auto');
  assert.equal(controller.effectiveScope, 'project', '#4565 controller auto scope starts at project');
  assert.equal(scopeForIntent('project-query', snapshot), 'project');
}

console.log('issue-4565-project-only-auto-scope: ok');
