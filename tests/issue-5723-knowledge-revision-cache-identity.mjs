import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeDB } from '../js/knowledge/index.js';

test('#5723 remember/reject/clear advance the knowledge revision; reads do not', async () => {
  const db = new KnowledgeDB({});
  const before = db.revision;
  await db.remember({ fingerprint: { hash: 'h-1', schema: 'v1' }, sourceBinaryHash: 'fixture', names: ['KnownFunction'], userConfirmed: true });
  const afterRemember = db.revision;
  assert.ok(afterRemember > before, 'remember must advance the revision');
  await db.reject({ sourceBinaryHash: 'fixture', candidateName: 'nope' });
  assert.ok(db.revision > afterRemember, 'reject must advance the revision');
  const beforeClear = db.revision;
  await db.clear();
  assert.ok(db.revision > beforeClear, 'clear must advance the revision');
});
