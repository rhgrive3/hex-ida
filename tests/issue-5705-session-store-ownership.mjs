// Regression for #5705: createInvestigationSession() shared array references
// with the caller's input (and message element objects), so a post-create
// mutation of the caller object silently rewrote the registered store session
// without update()/persist(). Store-owned arrays are now detached copies.
import assert from 'node:assert/strict';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';

{
  const store = new InvestigationSessionStore();
  const input = {
    id: 'session-shared',
    hypotheses: [{ id: 'hyp-1', claim: 'original' }],
    confirmedFindings: [{ id: 'ev-1', title: 'original' }],
    rejectedHypotheses: [],
    proposedActions: [],
    messages: [{ role: 'user', content: 'original' }],
  };
  const session = await store.create(input);

  // Mutating the caller's input after create() must not touch the store.
  input.hypotheses[0].claim = 'caller-tampered';
  input.confirmedFindings.push({ id: 'ev-forged' });
  input.messages[0].content = 'caller-tampered';

  const loaded = await store.get('session-shared');
  assert.equal(loaded.hypotheses[0].claim, 'original', 'store hypotheses must be detached from caller state');
  assert.equal(loaded.confirmedFindings.length, 1, 'store findings must not gain caller-forged entries');
  assert.equal(loaded.messages[0].content, 'original', 'store message elements must be detached copies');
}

{
  // The returned session object is equally detached from future caller arrays.
  const store = new InvestigationSessionStore();
  const hypotheses = [{ id: 'hyp-2', claim: 'keep' }];
  const session = await store.create({ id: 'session-detached', hypotheses });
  hypotheses[0].claim = 'mutated';
  const loaded = await store.get('session-detached');
  assert.equal(loaded.hypotheses[0].claim, 'keep', 'the registered session keeps its own copy');
  assert.equal(session.hypotheses[0].claim, 'keep');
}
