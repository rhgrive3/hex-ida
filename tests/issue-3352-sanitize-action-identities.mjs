import assert from 'node:assert/strict';
import { sanitizeActions } from '../js/ai/validation.js';

const proposalStore = {
  has(id) { return id === 'p1'; },
};

const evidenceStore = {
  has(id) { return id === 'ev1'; },
  hasAddress(address) { return address === '0x1000'; },
};

const addressExists = (address) => address === '0x1000';

assert.deepEqual(
  sanitizeActions([{ kind: 'review-proposal', target: 'p1' }], { proposalStore }),
  [{ kind: 'review-proposal', target: 'p1' }],
  'canonical proposal IDs remain accepted',
);

for (const target of [['p1'], { toString: () => 'p1' }, 1, true]) {
  assert.deepEqual(
    sanitizeActions([{ kind: 'review-proposal', target }], { proposalStore }),
    [],
    'structured/non-string proposal IDs must fail closed',
  );
}

assert.deepEqual(
  sanitizeActions([{ kind: 'open-address', target: '0x1000', evidenceId: 'ev1' }], {
    evidenceStore,
    addressExists,
  }),
  [{ kind: 'open-address', target: '0x1000', evidenceId: 'ev1' }],
  'canonical evidence IDs remain accepted',
);

for (const evidenceId of [['ev1'], { toString: () => 'ev1' }, 1, true]) {
  assert.deepEqual(
    sanitizeActions([{ kind: 'open-address', target: '0x1000', evidenceId }], {
      evidenceStore,
      addressExists,
    }),
    [{ kind: 'open-address', target: '0x1000' }],
    'structured/non-string evidence IDs must not alias canonical evidence identities',
  );
}

assert.deepEqual(
  sanitizeActions([{ kind: 'navigate', target: '0x1000', evidenceId: 'ev1' }], { evidenceStore, addressExists }),
  [],
  'unsupported action kinds remain rejected before identity validation',
);

console.log('ok issue #3352 sanitize action identities');
