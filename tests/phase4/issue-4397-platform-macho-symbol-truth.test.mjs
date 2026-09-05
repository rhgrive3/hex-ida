import assert from 'node:assert/strict';
import { machoSymbolTruth } from '../../js/platform/analysis-result.js';

assert.equal(machoSymbolTruth({ format:'elf' }), null);

const missing = machoSymbolTruth({ format:'macho' });
assert.equal(missing.complete, false);
assert.deepEqual(missing.reasons, ['symbol-metadata-unavailable']);
assert.deepEqual(missing.components, {
  chainedFixups:null,
  dyldBindings:null,
  exportTrie:null,
  metadataBudget:null,
});

const malformedOnly = machoSymbolTruth({
  format:'macho',
  metadata:{ machoMetadata:[], chainedFixups:[], exportTrie:[], dyldBindings:[] },
});
assert.equal(malformedOnly.complete, false);
assert.ok(malformedOnly.reasons.includes('symbol-metadata-unavailable'));

const explicitIncomplete = machoSymbolTruth({
  format:'macho',
  metadata:{ machoMetadata:{ complete:false } },
});
assert.equal(explicitIncomplete.complete, false);
assert.deepEqual(explicitIncomplete.reasons, ['metadata-budget:incomplete']);

const complete = machoSymbolTruth({
  format:'macho',
  metadata:{
    machoMetadata:{ complete:true },
    chainedFixups:{ complete:true },
    exportTrie:{ complete:true },
    dyldBindings:{ complete:true, streams:{} },
  },
});
assert.equal(complete.complete, true);
assert.deepEqual(complete.reasons, []);
