import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDex, DEX_METADATA_ADMISSION_BUDGET } from '../../../js/managed/dex/parser.js';
import { applyDexIntegrity } from '../fixtures/dex-integrity.mjs';

// #8705 — parseDex() charged nothing for aggregate metadata retention: an
// ordinary unique-`method_ids` image (no aliasing, no contract violation)
// materialized hundreds of MiB of canonical rows before any budget error could
// be returned, aborting constrained workers with a V8 heap failure. The
// aliased-`string_ids` shape of the same boundary is rejected deterministically
// by the enforced strict ordering (`dex-string-ids-order-invalid`, #8717); this
// regression locks BOTH halves: admission refused before materialization, with
// `dex-*` authority, while legitimate spec-sized images keep parsing losslessly.

const uleb = (n) => { const out = []; do { const b = n & 0x7f; n >>>= 7; out.push(b | (n ? 0x80 : 0)); } while (n); return out; };

// Self-contained minimal DEX 039 encoder (no production code): N distinct
// method rows over one `LA;` class / `()V` proto, strings strictly ascending in
// UTF-16 code-unit order, ordered map list, no code items or class defs.
function buildMethodIdsDex(n) {
  const names = new Array(n);
  for (let i = 0; i < n; i++) names[i] = 'a' + String(i).padStart(8, '0');
  const strings = ['LA;', 'V', ...names];
  const enc = new TextEncoder();
  const stringBytes = strings.map((s) => [...uleb(s.length), ...enc.encode(s), 0]);
  const total = 0x70 + 4 * strings.length + 4 * 2 + 12 + 8 * n + 4 + 12 * 6
    + stringBytes.reduce((sum, b) => sum + Math.ceil((b.length + 3) / 4) * 4, 0) + 64;
  const data = new Uint8Array(total);
  const v = new DataView(data.buffer);
  let pos = 0x70;
  const put = (count, width, header) => {
    const p = pos; pos += count * width;
    if (header) { v.setUint32(header, count, true); v.setUint32(header + 4, p, true); }
    return p;
  };
  const stringIds = put(strings.length, 4, 56);
  const typeIds = put(2, 4, 64);
  const protoIds = put(1, 12, 72);
  const methodIds = put(n, 8, 88);
  v.setUint32(typeIds, 0, true); v.setUint32(typeIds + 4, 1, true);
  v.setUint32(protoIds, 1, true); v.setUint32(protoIds + 4, 1, true); v.setUint32(protoIds + 8, 0, true);
  for (let i = 0; i < n; i++) {
    const p = methodIds + i * 8;
    v.setUint16(p, 0, true); v.setUint16(p + 2, 0, true); v.setUint32(p + 4, 2 + i, true);
  }
  pos = Math.ceil(pos / 4) * 4;
  const dataStart = pos;
  const stringDataStart = pos;
  strings.forEach((s, i) => {
    v.setUint32(stringIds + i * 4, pos, true);
    data.set(stringBytes[i], pos); pos += stringBytes[i].length;
    pos = Math.ceil(pos / 4) * 4;
  });
  const maps = [
    [0, 1, 0], [1, strings.length, stringIds], [2, 2, typeIds], [3, 1, protoIds],
    [5, n, methodIds], [0x2002, strings.length, stringDataStart],
  ];
  maps.push([0x1000, 1, pos]);
  v.setUint32(pos, maps.length, true); pos += 4;
  for (const [t, s, o] of maps) { v.setUint16(pos, t, true); v.setUint32(pos + 4, s, true); v.setUint32(pos + 8, o, true); pos += 12; }
  data.set([100, 101, 120, 10, 48, 51, 57, 0]);
  v.setUint32(32, pos, true); v.setUint32(36, 0x70, true); v.setUint32(40, 0x12345678, true);
  v.setUint32(52, maps[maps.length - 1][2], true);
  v.setUint32(104, pos - dataStart, true); v.setUint32(108, dataStart, true);
  return applyDexIntegrity(data.slice(0, pos));
}

// The budget must reject this shape, and the default must sit far below the
// retained-heap class that OOMed (128 MiB worker, ~115 MB retained at 800k).
const OVER_LIMIT = 400_000;
// A spec-shaped upper bound for real-world images: the DEX method/file caps are
// 65 535 rows; those must stay comfortably admissible.
const LEGITIMATE = 65_535;

assert.equal(DEX_METADATA_ADMISSION_BUDGET, 64 * 1024 * 1024);

const big = buildMethodIdsDex(OVER_LIMIT);
assert.ok(big.length > 8_000_000 && big.length < 12_000_000);
// Red-before: the pre-fix parser accepted this image fully (issue measurements:
// 800k rows parsed successfully on 128 MiB, OOMed at 900k; 400k retains ~60 MB
// of JS heap for a ~9 MB input). Green-now: deterministic refusal before
// materialization, never a partial trusted image.
assert.throws(() => parseDex(big, { binaryId: 'issue-8705-over' }),
  (error) => error instanceof TypeError && error.message === 'dex-metadata-admission-budget-exceeded');

// `options.maxMetadataBytes` overrides the bound explicitly and deterministically.
const small = buildMethodIdsDex(1_000);
assert.doesNotThrow(() => parseDex(small, { binaryId: 'issue-8705-small' }));
assert.throws(() => parseDex(small, { binaryId: 'issue-8705-tight', maxMetadataBytes: 1_000 }),
  (error) => error instanceof TypeError && error.message === 'dex-metadata-admission-budget-exceeded');
assert.throws(() => parseDex(small, { binaryId: 'issue-8705-zero', maxMetadataBytes: 0 }),
  (error) => error instanceof TypeError && error.message === 'dex-metadata-admission-budget-exceeded');

// Legitimate spec-sized images keep parsing, fully lossless.
const legit = parseDex(buildMethodIdsDex(LEGITIMATE), { binaryId: 'issue-8705-legit' });
assert.equal(legit.methods.length, LEGITIMATE);
assert.equal(legit.strings.length, LEGITIMATE + 2);
assert.equal(legit.strings[2], 'a00000000');
assert.equal(legit.strings[LEGITIMATE + 1], 'a' + String(LEGITIMATE - 1).padStart(8, '0'));
assert.equal(legit.methods[0].name, 'a00000000');
assert.equal(legit.methods[0].classType, 'LA;');
assert.equal(legit.methods[0].proto.shorty, 'V');
assert.equal(legit.methods[LEGITIMATE - 1].name, 'a00065534');
assert.deepEqual(legit.classes, []);

// Malformed MUTF-8 keeps its existing failure authority (declared count is
// affordable; the decode still owns `dex-malformed-string-data`).
{
  const bytes = buildMethodIdsDex(4).slice();
  const v = new DataView(bytes.buffer);
  const nameOff = v.getUint32(v.getUint32(60, true) + 2 * 4, true);
  bytes[nameOff + 1] = 0xff; // invalid lead byte inside the first name string
  assert.throws(() => parseDex(applyDexIntegrity(bytes), { binaryId: 'issue-8705-mutf8' }),
    (error) => error.message === 'dex-malformed-string-data');
}

// Aliased `string_ids` (two ids -> one `string_data_item`) must stay refused by
// the ordering authority, without scanning the shared payload per reference.
{
  const bytes = buildMethodIdsDex(4).slice();
  const v = new DataView(bytes.buffer);
  const stringIdsOff = v.getUint32(60, true);
  v.setUint32(stringIdsOff + 3 * 4, v.getUint32(stringIdsOff + 2 * 4, true), true);
  assert.throws(() => parseDex(applyDexIntegrity(bytes), { binaryId: 'issue-8705-alias' }),
    (error) => error.message === 'dex-string-ids-order-invalid');
}

// Constrained worker acceptance from the issue: the ~19 MB / 900 000-row image
// used to abort the V8 heap (exit 134); it must now exit as a `dex-*` refusal.
{
  const fixturePath = join(tmpdir(), 'issue-8705-method-ids-900k.dex');
  writeFileSync(fixturePath, buildMethodIdsDex(900_000));
  const parserUrl = pathToFileURL(join(import.meta.dirname, '../../../js/managed/dex/parser.js')).href;
  const child = execFileSync(process.execPath, [
    '--max-old-space-size=128', '--input-type=module', '-e',
    `import { readFileSync } from 'node:fs';
     import { parseDex } from ${JSON.stringify(parserUrl)};
     const bytes = new Uint8Array(readFileSync(${JSON.stringify(fixturePath)}));
     try { const image = parseDex(bytes); console.log('PARSED:' + image.methods.length); }
     catch (error) { console.log('ERR:' + error.message); }`,
  ], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.trim(), 'ERR:dex-metadata-admission-budget-exceeded');
}

console.log('[phase11] issue #8705 DEX aggregate metadata admission budget regression passed');
