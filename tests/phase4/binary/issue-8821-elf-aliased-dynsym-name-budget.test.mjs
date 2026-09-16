/**
 * #8821 — aliased `DT_SYMTAB` `st_name` offsets must be interned and budgeted.
 *
 * Many symbol records may legally share one string-table entry. `stringAt()`
 * re-decoded and retained a fresh copy per record while `DynamicSymbolBudget`
 * costed only fixed per-object estimates, so a ~112 KiB ELF with 600 records
 * sharing one 100,000-byte name aborted a 128 MiB V8 heap and still reported a
 * complete, unstopped budget.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ByteView } from '../../../js/binary/reader.js';
import { parseELF } from '../../../js/binary/elf.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';
import { buildAliasedDynsymElf } from './issue-8821-aliased-dynsym-fixture.mjs';

const FIXTURE_ENTRYPOINT = fileURLToPath(new URL('./issue-8821-aliased-dynsym-fixture.mjs', import.meta.url));
const LOAD_FILE_OFF = 0x100;
const VA_BIAS = 0x1000 - LOAD_FILE_OFF;

function blankImage(bytes) {
  return {
    bits: 64,
    imageBase: BigInt(LOAD_FILE_OFF + VA_BIAS),
    metadata: { machine: 62, type: 3 },
    warnings: [],
    libraries: [],
    symbols: [],
    imports: [],
    exports: [],
    functions: [],
    relocations: [],
    sections: [],
    segments: [{
      address: BigInt(LOAD_FILE_OFF + VA_BIAS),
      fileOffset: BigInt(LOAD_FILE_OFF),
      fileSize: BigInt(bytes.length - LOAD_FILE_OFF),
      perms: { read: true, write: false, execute: true },
    }],
    sectionAt() { return null; },
    segmentAt() { return null; },
  };
}

function decodeWithLimits({ records, nameLength, mode = 'shared', limits }) {
  const { bytes, dynamicLength } = buildAliasedDynsymElf({ records, nameLength, mode });
  const image = blankImage(bytes);
  parseProgramDynamic(
    new ByteView(bytes, { littleEndian: true }),
    [{ type: 2, offset: BigInt(0x200), filesz: BigInt(dynamicLength) }],
    image,
    64,
    { dynamicSymbolLimits: limits },
  );
  return { image, budget: image.metadata.programDynamicSymbolBudget };
}

test('#8821: 599 aliases of one 100,000-byte st_name resolve once and stay exact', () => {
  const bytes = buildAliasedDynsymElf({ records: 600, nameLength: 100000 }).bytes;
  assert.ok(bytes.length < 120 * 1024, 'the counterexample must stay a sub-128-KiB file');
  const image = parseELF(bytes);
  const shared = 'A'.repeat(100000);
  assert.equal(image.symbols.length, 599);
  assert.equal(image.symbols.filter((sym) => sym.name === shared).length, 599);
  const budget = image.metadata.programDynamicSymbolBudget;
  // One shared entry plus the canonical null symbol at offset 0.
  assert.equal(budget.stringBytes, (100000 + 1) * 2 + 2);
  assert.equal(budget.stopped, false);
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
});

test('#8821: the aliased-dynsym counterexample survives a 128 MiB heap', () => {
  const run = spawnSync(process.execPath, ['--max-old-space-size=128', FIXTURE_ENTRYPOINT], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(run.status, 0, `constrained-heap parse failed: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.symbols, 599);
  assert.equal(result.partial, false);
  assert.equal(result.budget.stringBytes, (100000 + 1) * 2 + 2);
});

test('#8821: string cost is charged into the retained-memory estimate', () => {
  const shared = decodeWithLimits({ records: 50, nameLength: 4096, limits: {} });
  const aliased = decodeWithLimits({ records: 500, nameLength: 4096, limits: {} });
  assert.equal(shared.budget.stringBytes, aliased.budget.stringBytes, 'alias count must not change string accounting');
  assert.ok(aliased.budget.estimatedBytes > aliased.budget.stringBytes, 'record estimates stay additive with string estimates');
  assert.ok(aliased.budget.estimatedBytes >= aliased.budget.stringBytes);
});

test('#8821: a low string ceiling refuses the over-budget name and marks the result partial', () => {
  const { image, budget } = decodeWithLimits({ records: 300, nameLength: 100000, limits: { maxStringBytes: 4096 } });
  assert.equal(budget.stopped, true);
  assert.match(String(budget.reason), /decoded string bytes exceed 4096/);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(budget.stringBytes <= 4096);
  assert.equal(image.symbols.length, 0, 'no symbol may retain an unaffordable name');
  assert.equal(image.imports.length, 0);
});

test('#8821: distinct long names are bounded in aggregate even when interning cannot help', () => {
  const { image, budget } = decodeWithLimits({ records: 10, nameLength: 5000, mode: 'distinct', limits: { maxStringBytes: 20000 } });
  assert.equal(budget.stopped, true);
  assert.ok(budget.stringBytes <= 20000);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.symbols.length < 10, `${image.symbols.length} symbols decoded under a 20000-byte ceiling`);
});

test('#8821: a long name inside the ceiling is preserved exactly', () => {
  const { image, budget } = decodeWithLimits({ records: 4, nameLength: 5000, limits: {} });
  assert.equal(budget.stopped, false);
  assert.equal(image.symbols.length, 3);
  assert.ok(image.symbols.every((sym) => sym.name === 'A'.repeat(5000)));
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
});

test('#8821: a repeated unterminated alias reports the #2167 defect once, not per record', () => {
  const truncated = buildAliasedDynsymElf({ records: 120, nameLength: 8192 });
  // Remove the single terminator so every alias points at unterminated bytes.
  truncated.bytes[truncated.strtabFileOff + 1 + 8192] = 0x41;
  const view = new DataView(truncated.bytes.buffer);
  view.setBigUint64(0x200 + 2 * 16 + 8, BigInt(truncated.strtabLength - 1), true); // DT_STRSZ
  const image = blankImage(truncated.bytes);
  parseProgramDynamic(
    new ByteView(truncated.bytes, { littleEndian: true }),
    [{ type: 2, offset: BigInt(0x200), filesz: BigInt(truncated.dynamicLength) }],
    image,
    64,
    {},
  );
  const diagnostics = (image.metadata.programDynamicDiagnostics || [])
    .filter((line) => line.includes('is not NUL-terminated'));
  assert.equal(diagnostics.length, 1, 'one shared defect per offset');
  assert.equal(image.warnings.filter((w) => w.includes('is not NUL-terminated')).length, 1);
  assert.equal(image.symbols.length, 0);
  assert.equal(image.metadata.programDynamicPartial, true);
});
