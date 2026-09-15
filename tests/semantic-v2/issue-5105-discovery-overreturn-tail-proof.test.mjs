import test from 'node:test';
import assert from 'node:assert/strict';
import { __symmetricWorkspaceInternalsForTests } from '../../js/diff/symmetric-workspace-runtime.js';

const DISCOVERY_GLOBAL_CAP = 400000;
const TEXT = { id: 'text', vmAddr: '0x1000', size: 0x1000, exec: true };

test('#5105 mixed duplicate/new prefix cannot hide a fresh dropped over-return tail', async () => {
  const known = new Set([0x77n]);
  const symbols = {
    functionStartsComplete: false,
    functionCount: DISCOVERY_GLOBAL_CAP - 2,
    addFunctions(starts) {
      let added = 0;
      for (const start of starts) {
        if (known.has(start)) continue;
        known.add(start);
        added++;
      }
      this.functionCount += added;
      return added;
    },
    functionEvidence(start) {
      return known.has(start) ? { source: 'metadata', confidence: 0.7, confirmed: false } : null;
    },
  };
  const baseline = {
    symbols,
    backend: {
      guessFunctions(_regionId, share) {
        assert.equal(share, 2, 'fixture must exercise a two-entry admitted prefix');
        return Promise.resolve({
          starts: [0x77n, 0x100n, 0x200n],
          discoveryComplete: true,
        });
      },
    },
    slice: { regions: [TEXT] },
  };

  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});

  assert.equal(symbols.functionCount, DISCOVERY_GLOBAL_CAP - 1,
    'only the fresh admitted-prefix start may debit the global budget');
  assert.equal(known.has(0x200n), false,
    'the fresh dropped-tail start must not be ingested beyond the share');
  assert.equal(symbols.functionDiscovery.complete, false,
    'an unproven dropped tail must demote completeness');
  assert.equal(symbols.functionDiscovery.regions[0].complete, false);
  assert.equal(symbols.functionDiscovery.regions[0].capped, true);
  assert.deepEqual(symbols.functionDiscovery.reasons, ['text:backend-result-exceeds-budget']);
});
