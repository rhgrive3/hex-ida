import assert from 'node:assert/strict';

import { createProjectOperation } from '../../../js/collaboration/index.js';

const base = {
  projectIdentity: 'project-action-canonical',
  targetEntityId: 'function:1',
  factKind: 'name',
  payload: 'renamed',
};

for (const action of [' set ', 'remove ', '\tresolve', 'resurrect\n']) {
  assert.throws(
    () => createProjectOperation({ ...base, action }),
    (error) => error instanceof TypeError && error.message === 'operation-action-unsupported',
    `whitespace-padded action ${JSON.stringify(action)} must not acquire mutation authority`,
  );
}

for (const action of ['set', 'remove', 'resolve', 'resurrect']) {
  assert.equal(createProjectOperation({ ...base, action }).action, action);
}
assert.equal(createProjectOperation(base).action, 'set');
assert.throws(
  () => createProjectOperation({ ...base, action: '   ' }),
  (error) => error instanceof TypeError && error.message === 'operation-action-required',
);

console.log('collaboration canonical action boundary #3546: PASS');
