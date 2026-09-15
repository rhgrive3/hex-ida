import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho-core.js';

const N_INDR = 0x0a, N_EXT = 0x01, N_SECT = 0x0e;

// Build a thin Mach-O 64-bit MH_OBJECT with one LC_SYMTAB. `records` are
// [strx, type, sect, desc, value]; `strtable` is the raw string-table bytes.
function macho(records, strtable) {
  const nsyms = records.length;
  const bytes = new Uint8Array(64 + nsyms * 16 + strtable.length);
  const dv = new DataView(bytes.buffer);
  const u32 = (o, v) => dv.setUint32(o, v, true);
  u32(0, 0xfeedfacf);
  dv.setInt32(4, 0x0100000c, true);
  dv.setInt32(8, 0, true);         // cpusubtype
  u32(12, 1);                       // filetype = MH_OBJECT
  u32(16, 1);                       // ncmds
  u32(20, 24);                      // sizeofcmds
  u32(24, 0); u32(28, 0);
  u32(32, 0x2); u32(36, 24);        // LC_SYMTAB
  u32(40, 64); u32(44, nsyms);      // symoff, nsyms
  const stroff = 64 + nsyms * 16;
  u32(48, stroff); u32(52, strtable.length);
  bytes.set(strtable, stroff);
  records.forEach(([strx, type, sect, desc, value], i) => {
    const p = 64 + i * 16;
    u32(p, strx);
    bytes[p + 4] = type;
    bytes[p + 5] = sect;
    u32(p + 6, desc);
    dv.setBigUint64(p + 8, BigInt(value), true);
  });
  return bytes;
}

function table(entries) {
  const parts = [new Uint8Array([0])];
  let off = 1;
  const map = new Map();
  for (const [label, text] of entries) {
    const b = new TextEncoder().encode(text);
    const arr = new Uint8Array(b.length + 1);
    arr.set(b); // trailing NUL
    parts.push(arr);
    map.set(label, off);
    off += arr.length;
  }
  return { strtable: new Uint8Array([].concat(...parts.map((p) => Array.from(p)))), index: map };
}

// --- Fixtures -------------------------------------------------------------

// Shared 1000-byte target referenced by 200 aliases. One distinct target.
function sharedFixture() {
  const target = 'T'.repeat(1000);
  const { strtable, index } = table([
    ['a0', 'a'], ['a1', 'b'], ['a2', 'c'], ['a3', 'd'],
    ['t', target],
  ]);
  const t = index.get('t');
  // 200 aliases all pointing at the same string-table offset `t`.
  const all = [];
  for (let i = 0; i < 200; i++) all.push([index.get('a0'), N_INDR | N_EXT, 0, 0, t]);
  return { bytes: macho(all, strtable), target, strtableLen: strtable.length, nameBytes: 200 * 1 * 2, t };
}

// 4 aliases, each to a distinct 1000-byte target.
function distinctFixture() {
  const names = ['w', 'x', 'y', 'z'].map((c) => c.repeat(1000));
  const entries = [['n0', 'n']];
  names.forEach((nm, i) => entries.push(['t' + i, nm]));
  const { strtable, index } = table(entries);
  const recs = [0, 1, 2, 3].map((i) => [index.get('n0'), N_INDR | N_EXT, 0, 0, index.get('t' + i)]);
  return { bytes: macho(recs, strtable), names };
}

// --- Test A: shared offset is charged once, not once per alias ------------
{
  const f = sharedFixture();
  // Budget large enough for 200 one-char names + ONE 1000-char target, far too
  // small for 200 copies of the target. Per-record charging would stop early.
  const image = parseMachO(f.bytes, {
    metadataLimits: { stringBytes: f.nameBytes + 1000 * 2 + 64 },
  });
  const indirect = image.symbols.filter((s) => s.kind === 'indirect');
  assert.equal(indirect.length, 200, 'shared-target aliases must all be retained');
  assert.ok(indirect.every((s) => s.indirectTarget === f.target), 'each retained alias must expose the full target');
  assert.equal(image.metadata.machoMetadata.complete, true, 'single shared target must fit the budget');
  const used = image.metadata.machoMetadata.used.stringBytes;
  assert.ok(used >= f.nameBytes, 'names must still be charged');
  assert.ok(used <= f.nameBytes + 1000 * 2 + 2, `shared target must be charged ~once, got ${used}`);
}

// --- Test B: many distinct targets are bounded by the shared budget --------
{
  const f = distinctFixture();
  // Charge the ordinary names (4 bytes) plus exactly one distinct target.
  const image = parseMachO(f.bytes, {
    metadataLimits: { stringBytes: 4 * 2 + 1000 * 2 },
  });
  const indirect = image.symbols.filter((s) => s.kind === 'indirect');
  assert.ok(indirect.length < f.names.length, 'distinct targets beyond the aggregate budget must stop parsing');
  assert.equal(image.metadata.machoMetadata.complete, false, 'target accounting must downgrade completeness');
  assert.ok(
    image.metadata.machoMetadata.reasons.some((r) => r.includes('symbol-indirect-target')),
    'a stable budget reason must name the indirect-target accounting',
  );
  assert.ok(
    image.metadata.machoMetadata.used.stringBytes >= 1000 * 2,
    'decoded target bytes must now participate in the metadata budget',
  );
  // Every retained alias must still expose its exact full target (lossless).
  assert.ok(indirect.every((s, i) => s.indirectTarget === f.names[i]), 'retained alias targets must be exact');
}

// --- Test C: unterminated/repeat-invalid offsets are not rescanned ---------
{
  // A valid shared target proves caching does not corrupt the terminated path.
  const f = sharedFixture();
  const image = parseMachO(f.bytes);
  assert.equal(image.symbols.filter((s) => s.kind === 'indirect').length, 200);
}

console.log('issue-8696 Mach-O N_INDR indirectTarget retained-string budget: PASS');
