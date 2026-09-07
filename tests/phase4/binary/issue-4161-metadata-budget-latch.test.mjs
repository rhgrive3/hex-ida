import assert from 'node:assert/strict';
import test from 'node:test';
import { createELFMetadataBudget } from '../../../js/binary/elf-budget.js';
import { createMachOMetadataBudget } from '../../../js/binary/macho-budget.js';
import { createPEMetadataBudget } from '../../../js/binary/pe-loader.js';

const formats = [
  ['ELF', createELFMetadataBudget, 'elfMetadata'],
  ['Mach-O', createMachOMetadataBudget, 'machoMetadata'],
  ['PE', createPEMetadataBudget, 'peMetadata'],
];
const dimensions = ['inputBytes', 'records', 'objects', 'stringBytes', 'operations', 'estimatedHeapBytes'];

for (const [name, create, metadataKey] of formats) {
  for (const dimension of dimensions) {
    test(`${name}: ${dimension} exhaustion cannot resume in a later metadata stage`, () => {
      const image = { metadata: {}, warnings: [] };
      const budget = create(image, { limits: { [dimension]: 3 } });
      assert.equal(budget.take({ [dimension]: 1 }, 'symbols'), true);
      assert.equal(budget.take({ [dimension]: 3 }, 'relocations'), false);
      const used = { ...budget.used };
      const reasons = [...image.metadata[metadataKey].reasons];
      const warnings = [...image.warnings];
      assert.equal(budget.take({ [dimension]: 1 }, 'unwind'), false);
      assert.equal(budget.take({}, 'empty-stage'), false);
      assert.equal(budget.stopped, true);
      assert.deepEqual(budget.used, used);
      assert.deepEqual(image.metadata[metadataKey].reasons, reasons, 'retain the first failure');
      assert.deepEqual(image.warnings, warnings, 'do not emit a warning per subsequent take');
      assert.equal(image.metadata[metadataKey].complete, false);
    });
  }

  test(`${name}: elapsed-time failure remains latched below the next sampling boundary`, () => {
    const realNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const image = { metadata: {}, warnings: [] };
      const budget = create(image, { limits: { wallClockMs: 1 } });
      now = 2;
      assert.equal(budget.take({ operations: 1024 }), false);
      assert.equal(budget.take({ records: 1 }), false, 'smaller work cannot evade a prior timeout');
      assert.equal(budget.stopped, true);
      assert.equal(budget.used.records, 0);
      assert.deepEqual(image.metadata[metadataKey].reasons, ['budget:wall-clock']);
    } finally {
      Date.now = realNow;
    }
  });

  test(`${name}: abort and mutable diagnostics cannot clear the execution latch`, () => {
    const image = { metadata: {}, warnings: [] };
    const signal = { aborted: true };
    const budget = create(image, { signal });
    assert.equal(budget.take({ records: 1 }), false);
    assert.equal(budget.stopped, true);
    // The execution state must not be inferred from an editable diagnostic object.
    signal.aborted = false;
    image.metadata[metadataKey].complete = true;
    image.metadata[metadataKey].reasons.length = 0;
    assert.equal(budget.take({ records: 1 }), false);
    assert.equal(budget.used.records, 0);
    assert.equal(budget.stopped, true);
  });

  test(`${name}: ordinary partial metadata is recoverable, independent budgets remain usable`, () => {
    const image = { metadata: {}, warnings: [] };
    const budget = create(image, { limits: { records: 1 } });
    assert.equal(budget.partial('malformed-optional-table'), false);
    assert.equal(budget.take({ records: 1 }), true);
    assert.equal(budget.stopped, false);
    assert.equal(image.metadata[metadataKey].complete, false);
    assert.equal(budget.take({ records: 1 }), false);
    const fresh = create({ metadata: {}, warnings: [] }, { limits: { records: 1 } });
    assert.equal(fresh.take({ records: 1 }), true);
  });
}

test('Mach-O: warning exhaustion also prevents later metadata work', () => {
  const image = { metadata: {}, warnings: [] };
  const budget = createMachOMetadataBudget(image, { limits: { warnings: 1 } });
  assert.equal(budget.warn('first'), true);
  assert.equal(budget.warn('second'), false);
  assert.equal(budget.take({ records: 1 }), false);
  assert.deepEqual(image.warnings, ['first']);
});
