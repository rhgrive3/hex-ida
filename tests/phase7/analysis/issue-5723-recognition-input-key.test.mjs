import assert from 'node:assert/strict';
import test from 'node:test';

import { __demandDrivenInternalsForTests } from '../../../js/analysis/demand-driven-runtime.js';

test('#5723 recognition input identity changes with KnowledgeDB revision', () => {
  const app = {
    backend:{ gen:1 },
    symbols:{ gen:2 },
    knowledge:{ revision:0 },
    fields:null,
  };
  const before = __demandDrivenInternalsForTests.recognitionInputKey(app);
  app.knowledge.revision = 1;
  const after = __demandDrivenInternalsForTests.recognitionInputKey(app);
  assert.notEqual(after, before, 'knowledge mutation must change recognition cache identity');
});
