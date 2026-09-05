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

{
  const notes = {
    structs: [{ name: 'Pair', fields: [{ offset: 0, name: 'left', type: 'int' }] }],
    dirty: false,
  };
  const before = structuredClone(notes.structs);

  await assert.rejects(
    executorFor({ notes }).execute(
      'annotation.struct-field',
      { struct: 'Pair', offset: 4, field: 'right', type: 'int' },
      { authorization },
    ),
    (error) => error?.type === 'tool_failed' && /adapter is unavailable/i.test(error.message),
  );

  assert.deepEqual(notes.structs, before, 'missing persistence adapter must not mutate structure state');
  assert.equal(notes.dirty, false, 'missing persistence adapter must preserve the previous dirty state');
}

console.log('issue-3758 annotation save adapter regression: ok');
