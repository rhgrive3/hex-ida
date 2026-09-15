/**
 * Child process for the #8733 low-heap regression.
 *
 * It runs the alias reproducer through the production provider path under a
 * deliberately small V8 heap. Before the fix the same input retained roughly one
 * decoded copy of the string per aliasing DIE and aborted the heap; now it must
 * finish and report `complete`.
 */
import assert from 'node:assert/strict';

import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';
import { strpAliasReproducer } from './issue-8733-strp-alias-fixture.mjs';

const aliases = Number(process.env.HEX_ALIASES || 1000);
const stringLength = Number(process.env.HEX_STRING_LENGTH || 65_535);
const debugSections = strpAliasReproducer({ aliases, stringLength });

const provider = new DwarfDebugInfoProvider();
const result = provider.probe({
  snapshotId: 'repro-8733',
  identity: {},
  debugSections,
}, {
  budget: {
    maxBytesScanned: 64 * 1024 * 1024,
    maxRecords: 200_000,
    maxDepth: 64,
  },
});

assert.equal(result.status.completeness, 'complete', `provider must stay complete: ${result.diagnostics.join('; ')}`);
assert.equal(result.counts.dies, aliases + 1);

const heap = process.memoryUsage().heapUsed;
process.stdout.write(JSON.stringify({
  aliases,
  inputBytes: debugSections.debug_info.length + debugSections.debug_abbrev.length + debugSections.debug_str.length,
  heapUsedMiB: Math.round(heap / (1024 * 1024)),
  dies: result.counts.dies,
}));
