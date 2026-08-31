import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../../js/analysis/schema-recovery-task.js';

test('#2819 partial schema recovery is not reused across stronger budgets', async () => {
  const programBudgets = [];
  const app = {
    backend: { gen: 1 },
    store: { get() { return null; } },
    ensureStrings: async () => ({ complete: true }),
    ensureProgram: async ({ budget } = {}) => {
      programBudgets.push(budget?.maxSchemas ?? null);
      return null;
    },
  };

  const small = await recoverSchemasForUi(app, { budget: { maxSchemas: 1 } });
  assert.equal(small.complete, false);
  assert.equal(app.schemas, undefined, 'partial small-budget result must not become canonical app cache');

  const large = await recoverSchemasForUi(app, { budget: { maxSchemas: 10 } });
  assert.equal(large.complete, false);
  assert.deepEqual(programBudgets, [1, 10], 'stronger budget must get a distinct producer instead of first-budget-wins reuse');

  clearSchemaRecoveryTasks(app);
});
