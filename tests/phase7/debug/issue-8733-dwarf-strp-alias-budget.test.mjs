import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DwarfDebugInfoProvider, parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';
import { distinctStrings, strpAliasReproducer, strpAliasSections } from './issue-8733-strp-alias-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'issue-8733-low-heap-child.mjs');

const FILLER = 'A';
const DW_TAG_variable = 0x34;

function referencedNames(result) {
  return [...result.dies.values()]
    .filter((die) => die.tag === DW_TAG_variable)
    .map((die) => ({ value: die.attributes.get(0x03)?.value ?? null, complete: die.complete }));
}

test('#8733 aliases to one debug_str entry decode once, not once per DIE', () => {
  const stringLength = 4096;
  const aliases = 500;
  const sections = strpAliasReproducer({ aliases, stringLength });
  // One scan of the string plus the .debug_info/abbreviation overhead is enough
  // when aliases are cached; the uncached path scanned 500 x 4097 bytes here.
  const parsed = parseDebugInfo(sections, {
    maxBytesScanned: 8192,
    maxRecords: 200_000,
    maxDepth: 8,
  });

  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  assert.equal(parsed.dies.size, aliases + 1);
  const references = referencedNames(parsed);
  assert.equal(references.length, aliases);
  assert.ok(references.every((entry) => entry.value === FILLER.repeat(stringLength)));
  assert.ok(references.every((entry) => entry.complete));
});

test('#8733 aliases to one debug_line_str entry share one decoded value', () => {
  const lineString = `${'l'.repeat(2048)}\0`;
  const debugAbbrev = Uint8Array.from([
    0x01, 0x11, 0x01, 0x00, 0x00,
    0x02, 0x34, 0x00, 0x03, 0x1f, 0x00, 0x00,
    0x00,
  ]);
  const body = [
    0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x01,
    ...Array.from({ length: 200 }, () => [0x02, 0x00, 0x00, 0x00, 0x00]).flat(),
    0x00,
  ];
  const debugInfo = Uint8Array.from([body.length & 0xff, (body.length >>> 8) & 0xff, 0, 0, ...body]);
  const parsed = parseDebugInfo({
    debug_info: debugInfo,
    debug_abbrev: debugAbbrev,
    debug_line_str: Buffer.from(lineString, 'utf8'),
  }, { maxBytesScanned: 4096, maxRecords: 200_000, maxDepth: 8 });

  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  assert.equal(parsed.dies.size, 201);
  const references = referencedNames(parsed);
  assert.equal(references.length, 200);
  assert.ok(references.every((entry) => entry.value === 'l'.repeat(2048)));
});

test('#8733 DWARF5 strx aliases reuse the cached debug_str decode', () => {
  const stringLength = 2048;
  const debugStr = Uint8Array.from([...new Uint8Array(stringLength).fill(FILLER.charCodeAt(0)), 0]);
  // One contribution: 4-byte length, version, padding, then entry 0 -> offset 0.
  const strOffsets = Uint8Array.from([
    8, 0, 0, 0,
    0x05, 0x00,
    0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const debugAbbrev = Uint8Array.from([
    0x01, 0x11, 0x01, 0x72, 0x17, 0x00, 0x00,
    0x02, 0x34, 0x00, 0x03, 0x25, 0x00, 0x00,
    0x00,
  ]);
  const body = [
    0x05, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x08, 0x00, 0x00, 0x00,
    ...Array.from({ length: 150 }, () => [0x02, 0x00]).flat(),
    0x00,
  ];
  const debugInfo = Uint8Array.from([body.length & 0xff, (body.length >>> 8) & 0xff, 0, 0, ...body]);
  const parsed = parseDebugInfo({
    debug_info: debugInfo,
    debug_abbrev: debugAbbrev,
    debug_str: debugStr,
    debug_str_offsets: strOffsets,
  }, { maxBytesScanned: 6000, maxRecords: 200_000, maxDepth: 8 });

  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  assert.equal(parsed.dies.size, 151);
  const references = referencedNames(parsed);
  assert.equal(references.length, 150);
  assert.ok(references.every((entry) => entry.value === FILLER.repeat(stringLength)));
});

test('#8733 distinct string offsets are charged against the decoded-string budget', () => {
  const { bytes, offsets } = distinctStrings(8, 512);
  const sections = strpAliasSections({ offsets, stringBytes: bytes });
  // One retained string costs its cache entry plus two bytes per decoded char,
  // so only four of the eight distinct strings fit inside this budget.
  const budget = {
    maxBytesScanned: 64 * 1024 * 1024,
    maxRecords: 200_000,
    maxDepth: 8,
    maxDecodedStringBytes: 4 * (64 + 512 * 2),
  };
  const parsed = parseDebugInfo(sections, budget);

  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.includes('decoded string budget exhausted'));

  const result = new DwarfDebugInfoProvider().probe({
    snapshotId: 'snap-8733-budget',
    identity: {},
    debugSections: sections,
  }, { budget });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.ok(result.diagnostics.includes('decoded string budget exhausted'));
});

test('#8733 the cache cannot alias equal offsets across string sections', () => {
  const debugAbbrev = Uint8Array.from([
    0x01, 0x11, 0x01, 0x00, 0x00,
    0x02, 0x34, 0x00, 0x03, 0x0e, 0x00, 0x00, // DW_AT_name / DW_FORM_strp
    0x03, 0x34, 0x00, 0x03, 0x1f, 0x00, 0x00, // DW_AT_name / DW_FORM_line_strp
    0x00,
  ]);
  const body = [
    0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x01,
    0x02, 0x00, 0x00, 0x00, 0x00,
    0x03, 0x00, 0x00, 0x00, 0x00,
    0x00,
  ];
  const debugInfo = Uint8Array.from([body.length, 0, 0, 0, ...body]);
  const parsed = parseDebugInfo({
    debug_info: debugInfo,
    debug_abbrev: debugAbbrev,
    debug_str: Buffer.from('from-str\0', 'utf8'),
    debug_line_str: Buffer.from('from-line-str\0', 'utf8'),
  });

  assert.equal(parsed.complete, true, parsed.diagnostics.join('; '));
  const values = referencedNames(parsed).map((entry) => entry.value);
  assert.deepEqual(values, ['from-str', 'from-line-str']);
});

test('#8733 a repeated invalid alias stays fail-closed instead of becoming cached evidence', () => {
  const sections = strpAliasReproducer({ aliases: 20, stringLength: 16 });
  // No NUL terminator anywhere: every alias of offset 0 is invalid, and caching
  // the failure must not turn it into a resolved string.
  const parsed = parseDebugInfo({ ...sections, debug_str: new Uint8Array(16).fill(FILLER.charCodeAt(0)) });
  const references = referencedNames(parsed);

  assert.equal(references.length, 20);
  assert.ok(references.every((entry) => entry.value === null), 'invalid strings must never resolve');
  assert.ok(references.every((entry) => entry.complete === false));
  assert.ok(parsed.diagnostics.some((entry) => entry.includes('unsupported form')));

  const result = new DwarfDebugInfoProvider().probe({
    snapshotId: 'snap-8733-invalid',
    identity: {},
    debugSections: { ...sections, debug_str: new Uint8Array(16).fill(FILLER.charCodeAt(0)) },
  });
  assert.equal(result.status.completeness, 'partial');
});

test('#8733 the reproducer finishes inside a small child heap', () => {
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', CHILD], {
    encoding: 'utf8',
    env: { ...process.env, HEX_ALIASES: '1000', HEX_STRING_LENGTH: '65535' },
    maxBuffer: 32 * 1024 * 1024,
  });

  assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
  const report = JSON.parse(child.stdout);
  assert.equal(report.dies, 1001);
  assert.ok(report.inputBytes < 80 * 1024, `input must stay small, got ${report.inputBytes}`);
  // The uncached path retained ~72 MiB of duplicate strings for this input; the
  // cached path must stay an order of magnitude below a 64 MiB heap.
  assert.ok(report.heapUsedMiB < 24, `retained heap must stay bounded, got ${report.heapUsedMiB} MiB`);
});
