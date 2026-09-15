import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DwarfDebugInfoProvider, parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';
import {
  materializedEntries,
  zeroByteAbbrevTable,
  zeroByteAttributeSections,
} from './issue-8752-zero-byte-attribute-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'issue-8752-low-heap-child.mjs');

const BUDGET_DIAGNOSTIC = 'attribute materialization budget exhausted';
const DW_TAG_compile_unit = 0x11;
const DW_TAG_subprogram = 0x2e;
const DW_TAG_variable = 0x34;
const DW_AT_name = 0x03;
const DW_AT_low_pc = 0x11;
const DW_AT_high_pc = 0x12;
const DW_AT_external = 0x3f;
const DW_FORM_addr = 0x01;
const DW_FORM_strp = 0x0e;
const DW_FORM_udata = 0x0f;
const DW_FORM_flag_present = 0x19;
const DW_FORM_implicit_const = 0x21;

function le32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u64(value) {
  let current = BigInt(value);
  const out = [];
  for (let index = 0; index < 8; index += 1) {
    out.push(Number(current & 0xffn));
    current >>= 8n;
  }
  return out;
}

/** One DWARF4 unit with an 8-byte address size. */
function unit(dieBytes, version = 4) {
  const body = [
    version & 0xff, (version >>> 8) & 0xff,
    0x00, 0x00, 0x00, 0x00,
    0x08,
    ...dieBytes,
  ];
  return Uint8Array.from([...le32(body.length), ...body]);
}

function abbrevTable(childTag, attributes) {
  return Uint8Array.from([
    0x01, DW_TAG_compile_unit, 0x01, 0x00, 0x00,
    0x02, childTag, 0x00, ...attributes, 0x00, 0x00,
    0x00,
  ]);
}

function repeated(bytes, times) {
  return Array.from({ length: times }, () => [...bytes]).flat();
}

/** `count` distinct attribute numbers sharing one zero-payload form. */
function zeroByteAttributes(count, form = DW_FORM_flag_present) {
  return Array.from({ length: count }, (_, index) => (form === DW_FORM_implicit_const
    ? [0x20 + index, form, 0x07]
    : [0x20 + index, form])).flat();
}

function probe(sections, budget) {
  return new DwarfDebugInfoProvider().probe({
    snapshotId: 'snap-8752',
    identity: {},
    debugSections: sections,
    endian: 'little',
  }, budget == null ? {} : { budget });
}

test('#8752 a reused wide abbreviation stops inside one shared allowance', () => {
  const sections = zeroByteAttributeSections({ children: 250 });
  const allowance = 16_384;
  const parsed = parseDebugInfo(sections, {
    maxBytesScanned: 64 * 1024 * 1024,
    maxRecords: 200_000,
    maxDepth: 64,
    maxDieAttributeEntries: allowance,
  });

  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.includes(BUDGET_DIAGNOSTIC), parsed.diagnostics.join('; '));
  // Deterministic internal accounting, not a timing proxy: exactly the allowance
  // is materialized and the DIE that would need entry 16,385 is never published.
  assert.equal(materializedEntries(parsed.dies), allowance);
  assert.equal(parsed.dies.size, 3);
});

test('#8752 the allowance is not reset per DIE', () => {
  const debugAbbrev = abbrevTable(DW_TAG_variable, zeroByteAttributes(10));
  const parsed = parseDebugInfo({
    debug_info: unit([0x01, ...repeated([0x02], 5), 0x00]),
    debug_abbrev: debugAbbrev,
  }, {
    maxBytesScanned: 64 * 1024 * 1024,
    maxRecords: 200_000,
    maxDepth: 64,
    maxDieAttributeEntries: 25,
  });

  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.includes(BUDGET_DIAGNOSTIC));
  // Two full children (20 entries) fit; the third dies partway through and is
  // not published, so the walk stops after two children rather than restarting.
  assert.equal(materializedEntries(parsed.dies), 20);
  assert.equal(parsed.dies.size, 3);
});

test('#8752 zero-byte forms are charged even though they scan nothing', () => {
  const shapes = [
    { label: 'DW_FORM_flag_present', attributes: zeroByteAttributes(3) },
    { label: 'DW_FORM_implicit_const', attributes: zeroByteAttributes(3, DW_FORM_implicit_const) },
  ];
  for (const { label, attributes } of shapes) {
    const parsed = parseDebugInfo({
      debug_info: unit([0x01, ...repeated([0x02], 50), 0x00]),
      debug_abbrev: abbrevTable(DW_TAG_variable, attributes),
    }, {
      maxBytesScanned: 64 * 1024 * 1024,
      maxRecords: 200_000,
      maxDepth: 64,
      maxDieAttributeEntries: 4,
    });

    assert.equal(parsed.complete, false, `${label} must consume the shared allowance`);
    assert.ok(parsed.diagnostics.includes(BUDGET_DIAGNOSTIC), `${label}: ${parsed.diagnostics.join('; ')}`);
    assert.equal(parsed.dies.size, 2, `${label}: only the first child may be retained`);
    assert.equal(materializedEntries(parsed.dies), 3, label);
  }
});

test('#8752 the provider reports partial with a budget stop reason, never complete', () => {
  const result = probe(zeroByteAttributeSections({ children: 60 }), {
    maxBytesScanned: 64 * 1024 * 1024,
    maxRecords: 200_000,
    maxDepth: 64,
    maxDieAttributeEntries: 8_192,
  });

  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.ok(result.diagnostics.includes(BUDGET_DIAGNOSTIC));
});

test('#8752 ordinary DWARF keeps exact attributes, symbols, and completeness', () => {
  const debugAbbrev = abbrevTable(DW_TAG_subprogram, [
    DW_AT_name, DW_FORM_strp,
    DW_AT_low_pc, DW_FORM_addr,
    DW_AT_high_pc, DW_FORM_udata,
    DW_AT_external, DW_FORM_flag_present,
  ]);
  const sections = {
    debug_info: unit([0x01, 0x02, 0x00, 0x00, 0x00, 0x00, ...u64(0x1000), 0x20, 0x00]),
    debug_abbrev: debugAbbrev,
    debug_str: Buffer.from('func\0', 'utf8'),
  };
  const parsed = parseDebugInfo(sections);

  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  const die = parsed.dies.get(12);
  assert.equal(die.attributes.size, 4);
  assert.equal(die.attributes.get(DW_AT_name).value, 'func');
  assert.equal(die.attributes.get(DW_AT_name).form, DW_FORM_strp);
  assert.equal(die.attributes.get(DW_AT_low_pc).value, 0x1000n);
  assert.equal(die.attributes.get(DW_AT_high_pc).value, 0x20n);
  assert.equal(die.attributes.get(DW_AT_external).value, 1n);
  assert.equal(die.complete, true);

  const result = probe(sections);
  assert.equal(result.status.completeness, 'complete');
  const [record] = new DwarfDebugInfoProvider().symbols(result, {}).records;
  assert.equal(record.name, 'func');
  assert.equal(record.address, '0x1000');
  assert.equal(record.sizeBytes, 0x20);
  assert.equal(record.descriptor.complete, true);
});

test('#8752 the abbreviation declaration cap still bounds the table itself', () => {
  const parsed = parseDebugInfo({
    debug_info: unit([0x01, 0x02, 0x00]),
    debug_abbrev: zeroByteAbbrevTable({ attributeCount: 40 }),
  }, {
    maxBytesScanned: 64 * 1024 * 1024,
    maxRecords: 200_000,
    maxDepth: 64,
    maxDieAttributeEntries: 65_536,
    maxAbbrevAttributes: 20,
  });

  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.includes('abbreviation attribute budget exhausted'));
  assert.equal(materializedEntries(parsed.dies), 0);
});

test('#8752 the default allowance still admits an ordinary large CU', () => {
  // 1,000 DIEs x 12 attributes is ordinary compiler output and must stay complete.
  const debugAbbrev = abbrevTable(DW_TAG_variable, zeroByteAttributes(12));
  const parsed = parseDebugInfo({
    debug_info: unit([0x01, ...repeated([0x02], 1000), 0x00]),
    debug_abbrev: debugAbbrev,
  });

  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  assert.equal(parsed.dies.size, 1001);
  assert.equal(materializedEntries(parsed.dies), 12_000);
});

test('#8752 the issue reproducer stays inside a 128 MiB child heap', () => {
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', CHILD], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
  const report = JSON.parse(child.stdout);
  assert.ok(report.inputBytes < 32 * 1024, `input must stay ~25 KiB, got ${report.inputBytes}`);
  // 61 full children fit inside the default allowance; the 62nd stops it.
  assert.equal(report.entries, 61 * 8192);
  assert.ok(report.heapUsedMiB < 96, `retained heap must stay bounded, got ${report.heapUsedMiB} MiB`);
});
