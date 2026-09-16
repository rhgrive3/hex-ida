import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';
import { sharedOffsetFixture } from './issue-8678-shared-shstrtab-fixture.mjs';

test('#8714 review regression: raw section-header fan-out is admitted before object materialization', () => {
  const bytes = sharedOffsetFixture({ shnum: 512, nameLength: 8 });
  const image = parseELF(bytes, { metadataLimits: { records: 1 } });
  const meta = image.metadata.elfMetadata;

  assert.equal(meta.complete, false);
  assert.ok(meta.reasons.includes('budget:section-header:records'), JSON.stringify(meta.reasons));
  assert.equal(meta.used.records, 1, 'the shared structural budget must stop at the configured record ceiling');
  assert.equal(image.sections.length, 1, 'only the admitted section header may become a canonical section object');
  assert.ok(image.warnings.some((warning) => warning.includes('ELF metadata budget exhausted: section-header:records')));
});
