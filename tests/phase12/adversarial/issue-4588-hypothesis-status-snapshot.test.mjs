import assert from 'node:assert/strict';
import { HypothesisStore } from '../../../js/ai/hypothesis.js';

const evidence = { has() { return false; }, get() { return null; } };
const store = new HypothesisStore(evidence);
store.upsert({ id:'h-accessor', claim:'status authority stays canonical' });
let reads = 0;
const update = { id:'h-accessor' };
Object.defineProperty(update, 'status', {
  enumerable:true,
  get() {
    reads += 1;
    return reads === 1 ? 'open' : 'forged-status';
  },
});
const result = store.upsert(update);
assert.equal(reads, 1, 'status update authority must be snapshotted once');
assert.equal(result.status, 'open', 'the validated status snapshot must be the published status');
assert.ok(['open', 'supported', 'verified', 'rejected'].includes(result.status));
console.log('[phase12] #4588 hypothesis status snapshot passed');
