/**
 * Child process for the #8752 low-heap regression.
 *
 * The reproducer is the issue's exact shape: one abbreviation declaring the
 * 8,192 vendor-extension attributes as zero-byte DW_FORM_flag_present, reused by
 * 250 child DIEs from a ~25 KiB input. Under the default byte/record/depth caps
 * that used to materialize ~2,000,000 attribute entries and abort a 128 MiB V8
 * heap; the shared materialization budget must stop it first.
 */
import assert from 'node:assert/strict';

import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';
import { materializedEntries, zeroByteAttributeSections } from './issue-8752-zero-byte-attribute-fixture.mjs';

const sections = zeroByteAttributeSections({ children: 250 });
const provider = new DwarfDebugInfoProvider();
const result = provider.probe({
  snapshotId: 'repro-8752',
  identity: {},
  debugSections: sections,
  endian: 'little',
});

assert.equal(result.status.completeness, 'partial', 'a reused wide abbreviation must not publish complete evidence');
assert.equal(result.status.stopReason, 'budget-exhausted');
assert.ok(result.diagnostics.includes('attribute materialization budget exhausted'));

const entries = materializedEntries(result.parsed.dies);
assert.ok(entries <= 500_000, `retained attribute entries must stay bounded, got ${entries}`);

process.stdout.write(JSON.stringify({
  inputBytes: sections.debug_info.length + sections.debug_abbrev.length,
  dies: result.counts.dies,
  entries,
  heapUsedMiB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
}));
