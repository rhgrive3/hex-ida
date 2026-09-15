/**
 * #8678 — repeated `.shstrtab` offsets must not decode unbudgeted long names.
 *
 * A conforming ELF may point every section header at one shared `sh_name`
 * offset. Section-name resolution used to re-scan and re-decode that string per
 * reference, outside every metadata limit, so a ~412 KiB file could retain
 * hundreds of MiB of duplicate text and terminate the process. Resolution must
 * be memoized per distinct offset and charged against the ELF metadata budget.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseELF } from '../../../js/binary/elf.js';
import { distinctNameFixture, sharedOffsetFixture } from './issue-8678-shared-shstrtab-fixture.mjs';

const FIXTURE_ENTRYPOINT = fileURLToPath(new URL('./issue-8678-shared-shstrtab-fixture.mjs', import.meta.url));

function summarize(bytes, options) {
  const image = parseELF(bytes, options);
  return {
    names: image.sections.map((s) => s.name),
    metadata: image.metadata.elfMetadata,
    warnings: image.warnings,
  };
}

test('#8678: 2,499 sections sharing one 256 KiB sh_name decode it exactly once', () => {
  const bytes = sharedOffsetFixture({ shnum: 2500, nameLength: 262142 });
  assert.equal(bytes.length, 422208);
  const { names, metadata } = summarize(bytes);
  const shared = 'A'.repeat(262142);
  assert.equal(names.filter((name) => name === shared).length, 2499);
  assert.equal(metadata.complete, true);
  assert.deepEqual(metadata.reasons, []);
  // One shared offset = one scan and one retained string, not one per reference.
  // Raw section-header admission is also charged before each object is built.
  assert.equal(metadata.used.stringBytes, shared.length * 2);
  assert.equal(metadata.used.inputBytes, 2500 * 64 + 262143 + 1);
  assert.equal(metadata.used.records, 2500 + 2);
  // 2,500 structural header objects plus two distinct resolved name offsets.
  assert.equal(metadata.used.estimatedHeapBytes, 2500 * 384 + shared.length * 2 + 2 * 32);
});

test('#8678: the shared-name counterexample survives a 128 MiB heap', () => {
  const run = spawnSync(process.execPath, ['--max-old-space-size=128', FIXTURE_ENTRYPOINT], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(run.status, 0, `constrained-heap parse failed: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.sharedNameSections, 2499);
  assert.equal(result.metadata.complete, true);
  assert.equal(result.metadata.used.stringBytes, 262142 * 2);
});

test('#8678: one repeated unterminated sh_name is scanned once and never published', () => {
  const bytes = sharedOffsetFixture({ shnum: 300, nameLength: 65536, terminated: false });
  const { names, metadata } = summarize(bytes);
  assert.equal(names.length, 300);
  assert.ok(names.every((name) => /^section_\d+$/.test(name)), 'no unterminated name may be published');
  assert.equal(new Set(names).size, 300);
  assert.equal(metadata.complete, true);
  assert.equal(metadata.used.inputBytes, 300 * 64 + 65536 + 1);
  assert.equal(metadata.used.records, 300 + 2);
  assert.equal(metadata.used.stringBytes, 0);
});

test('#8678: distinct long names beyond the aggregate budget stop in a controlled partial state', () => {
  const bytes = distinctNameFixture({ count: 6, nameLength: 1000 });
  const { names, metadata } = summarize(bytes, { metadataLimits: { stringBytes: 5000 } });
  assert.equal(metadata.complete, false);
  assert.ok(metadata.reasons.includes('budget:section-name:stringBytes'), JSON.stringify(metadata.reasons));
  assert.ok(metadata.used.stringBytes <= 5000);
  assert.equal(names.filter((name) => name === 'N'.repeat(1000)).length, 2);
  assert.equal(names.filter((name) => /^section_\d+$/.test(name)).length, 5);
});

test('#8678: budget exhaustion is also enforced through the default limits', () => {
  // Each name saturates the per-string span cap, so eight of them fill the
  // default 16 MiB aggregate string budget and the ninth must stop the pass.
  const span = (1 << 20) - 1;
  const bytes = distinctNameFixture({ count: 10, nameLength: span });
  const { names, metadata } = summarize(bytes);
  assert.equal(metadata.complete, false);
  assert.ok(metadata.reasons.includes('budget:section-name:stringBytes'));
  assert.equal(names.filter((name) => name.length === span).length, 8);
  assert.ok(metadata.used.stringBytes <= 16 * 1024 * 1024);
});

test('#8678: an aborted caller signal yields partial metadata, not unbounded work', () => {
  const controller = new AbortController();
  controller.abort();
  const { metadata } = summarize(sharedOffsetFixture({ shnum: 10, nameLength: 4096 }), { signal: controller.signal });
  assert.equal(metadata.complete, false);
  assert.ok(metadata.reasons.includes('budget:aborted'));
});

for (const bits of [32, 64]) {
  for (const littleEndian of [true, false]) {
    test(`#8678: ELF${bits} ${littleEndian ? 'little' : 'big'}-endian shares one decoded name`, () => {
      const bytes = sharedOffsetFixture({ bits, littleEndian, shnum: 40, nameLength: 4096 });
      const { names, metadata } = summarize(bytes);
      assert.equal(names.filter((name) => name === 'A'.repeat(4096)).length, 39);
      assert.equal(metadata.used.stringBytes, 4096 * 2);
      assert.equal(metadata.used.records, 40 + 2);
      assert.equal(metadata.complete, true);
    });
  }
}
