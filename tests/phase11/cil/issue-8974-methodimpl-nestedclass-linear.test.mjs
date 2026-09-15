import assert from 'node:assert/strict';
import test from 'node:test';
import { readCilDefinitions, bindCilMetadataTables } from '../../../js/managed/cil/metadata-definitions.js';
import { readCilTableLayout } from '../../../js/managed/cil/metadata-context.js';
import { metadataRowSize } from '../../../js/managed/cil/metadata-layout.js';

// #8974 (with the NestedClass cycle check folded, see batch plan): binding
// MethodImpl rows copied the implementing body's frozen override-token array
// once per row and re-scanned the whole per-class list for duplicates, and
// the NestedClass acyclicity proof re-walked every enclosing chain from every
// TypeDef — all Θ(N²) on fully valid metadata. Binding must stage mutable
// builders, use O(1) membership authority, and prove chains once, with the
// same fail-closed codes and identical token/order authority.

const VIRTUAL = 0x0040;
const u16v = (view, offset, value) => view.setUint16(offset, value, true);
// MethodDefOrRef coded index (1 tag bit): tag 0 = MethodDef.
const METHODDEF_ORREF = rid => (rid << 1) | 0;
// TypeDefOrRef coded index (2 tag bits): tag 0 = TypeDef.
const TYPEDEF_ORREF = rid => (rid << 2) | 0;

function tablesStream(tableCounts, heapSizes = 0) {
  // Independent byte-level #~ stream: header + row counts + row bytes per
  // table in ascending ECMA order (mirrors tests/phase11/fixtures layout).
  const entries = [...tableCounts].sort((a, b) => a[0] - b[0]);
  const length = 24 + entries.length * 4 + entries.reduce((n, [, , bytes]) => n + bytes.length, 0);
  const bytes = new Uint8Array(length), v = new DataView(bytes.buffer);
  bytes[4] = 2; bytes[6] = heapSizes;
  let valid = 0n, pos = 24;
  for (const [table] of entries) { valid |= 1n << BigInt(table); }
  v.setBigUint64(8, valid, true);
  const rowCounts = new Array(64).fill(0);
  for (const [table, count] of entries) { v.setUint32(pos, count, true); pos += 4; rowCounts[table] = count; }
  const offsets = new Map();
  for (const [table, , rowBytes] of entries) { offsets.set(table, pos); bytes.set(rowBytes, pos); pos += rowBytes.length; }
  return { bytes, rowCounts, offsets, heapSizes };
}

function layoutFor(stream) {
  const view = new DataView(stream.bytes.buffer);
  const end = stream.bytes.length;
  let pos = 24 + stream.rowCounts.filter(c => c > 0).length * 4;
  const tableOffsets = new Array(64).fill(null), rowSizes = new Array(64).fill(0);
  for (let table = 0; table < 64; table++) {
    const rows = stream.rowCounts[table];
    if (!rows) continue;
    const size = metadataRowSize(table, stream.rowCounts, stream.heapSizes);
    tableOffsets[table] = pos; rowSizes[table] = size; pos += rows * size;
  }
  assert.equal(pos, end, 'fixture table stream must be exactly covered');
  let valid = 0n;
  for (let t = 0; t < 64; t++) if (stream.rowCounts[t]) valid |= 1n << BigInt(t);
  return { rowCounts: stream.rowCounts, tableOffsets, rowSizes, heapSizes: stream.heapSizes, valid };
}

const readRowsView = stream => ({ bytes: stream.bytes, view: new DataView(stream.bytes.buffer) });

function methodImplFixture(n) {
  // Base (TypeDef 1) declares M (MethodDef 1) and D..Dn (rids 2..n+1); Child
  // (TypeDef 2) implements each declaration with the single body rid n+2.
  // All rows valid and distinct => only the binding loop can be quadratic.
  const methodCount = n + 2;
  const methodBytes = new Uint8Array(methodCount * 14), mv = new DataView(methodBytes.buffer);
  for (let i = 0; i < methodCount; i++) {
    u16v(mv, i * 14 + 6, i === n + 1 ? 0x0c6 | VIRTUAL : 0x05c6 | VIRTUAL);
    u16v(mv, i * 14 + 10, i === n + 1 ? 2 : 1); // declaring TypeDef rid
    u16v(mv, i * 14 + 12, 1); // ParamList (no Param table)
    mv.setUint32(i * 14, 0, true); // rva 0 (abstract) except body below
  }
  mv.setUint32((n + 1) * 14, 0x2001, true); // body rid n+2 has an RVA (unused by binding)
  // TypeDef (heapSizes 0): flags u32, name u16, namespace u16, extends
  // coded(2) u16, FieldList u16, MethodList u16 => 12 bytes.
  const typeBytes = new Uint8Array(2 * 14), tv = new DataView(typeBytes.buffer);
  tv.setUint32(0, 0x81, true); u16v(tv, 4, 1); u16v(tv, 6, 2); u16v(tv, 8, 0); u16v(tv, 10, 1); u16v(tv, 12, 1);
  tv.setUint32(14, 0x81, true); u16v(tv, 14 + 4, 3); u16v(tv, 14 + 6, 2); u16v(tv, 14 + 8, 0); u16v(tv, 14 + 10, 1); u16v(tv, 14 + 12, n + 2);
  const implBytes = new Uint8Array(n * 6), rv = new DataView(implBytes.buffer);
  for (let i = 0; i < n; i++) {
    u16v(rv, i * 6, 2);                       // Class = Child
    u16v(rv, i * 6 + 2, METHODDEF_ORREF(n + 2)); // MethodBody = Impl
    u16v(rv, i * 6 + 4, METHODDEF_ORREF(i + 1)); // MethodDeclaration = M_i
  }
  const stream = tablesStream([
    [0x02, 2, typeBytes],
    [0x06, methodCount, methodBytes],
    [0x19, n, implBytes],
  ]);
  const { bytes, view } = readRowsView(stream);
  return { bytes, view, layout: layoutFor(stream), n };
}

function nestedChainFixture(depth, extraRows = []) {
  // extraRows: [nested, enclosing] pairs inserted FIRST (so duplicate/nested
  // authority fires before the canonical chain rows are bound).
  const typeBytes = new Uint8Array(depth * 14), tv = new DataView(typeBytes.buffer);
  for (let i = 0; i < depth; i++) {
    const p = i * 14;
    tv.setUint32(p, 0x102, true);
    u16v(tv, p + 4, 1); u16v(tv, p + 6, 2);
    u16v(tv, p + 8, i === 0 ? 0 : TYPEDEF_ORREF(i)); // extends previous type
    u16v(tv, p + 10, 1); u16v(tv, p + 12, 1);
  }
  const rows = (depth - 1) + extraRows.length;
  const nestBytes = new Uint8Array(rows * 4), nv = new DataView(nestBytes.buffer);
  extraRows.forEach(([nested, enclosing], i) => {
    u16v(nv, i * 4, nested);
    u16v(nv, i * 4 + 2, enclosing);
  });
  for (let i = 0; i < depth - 1; i++) {
    u16v(nv, (extraRows.length + i) * 4, i + 2); // nested rid
    u16v(nv, (extraRows.length + i) * 4 + 2, i + 1); // enclosing rid
  }
  const stream = tablesStream([
    [0x02, depth, typeBytes],
    [0x29, rows, nestBytes],
  ]);
  const { bytes, view } = readRowsView(stream);
  return { bytes, view, layout: layoutFor(stream), depth };
}

// #Strings heap with a few names; definitions text() reads via indexes given
// above use heap offsets 1/2/3 for short ASCII names.
const stringsStream = (() => {
  const text = ['\0', 'A\0', 'N\0', 'T\0'];
  const bytes = new Uint8Array(text.reduce((n, s) => n + s.length, 0));
  let pos = 0;
  for (const s of text) { bytes.set(new TextEncoder().encode(s), pos); pos += s.length; }
  return { offset: 0, size: bytes.length, bytes };
})();

function decode(fixture) {
  return readCilDefinitions(fixture.bytes, fixture.view, fixture.layout, stringsStream);
}

function timeDecode(fixture) {
  const started = process.hrtime.bigint();
  const defs = decode(fixture);
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, defs };
}

test('#8974 MethodImpl binding stages tokens once per body, not one frozen copy per row', () => {
  const small = timeDecode(methodImplFixture(2000));
  assert.equal(small.defs.methods[2001].explicitOverrideTokens.length, 2000);
  assert.ok(Object.isFrozen(small.defs.methods[2001].explicitOverrideTokens));
  const large = timeDecode(methodImplFixture(10000));
  assert.equal(large.defs.methods[10001].explicitOverrideTokens.length, 10000);
  assert.ok(large.ms < small.ms * 15 + 150,
    `explicitOverrideTokens binding scaled quadratically: 2k=${small.ms.toFixed(1)}ms 10k=${large.ms.toFixed(1)}ms`);
});

test('#8974 per-class duplicate detection is membership-indexed with identical authority', () => {
  const small = timeDecode(methodImplFixture(2000));
  const large = timeDecode(methodImplFixture(10000));
  assert.ok(large.ms < small.ms * 15 + 150,
    `class override-list scan scaled quadratically: 2k=${small.ms.toFixed(1)}ms 10k=${large.ms.toFixed(1)}ms`);
  const child = large.defs.types[1];
  assert.equal(child.methodImpls.length, 10000);
  assert.equal(child.methodImpls[0].rid, 1);
  assert.equal(child.methodImpls[9999].rid, 10000);
  assert.equal(child.methodImpls[9999].methodDeclarationToken, `0x06${(10000).toString(16).padStart(6, '0')}`);
  assert.equal(large.defs.methods[10001].explicitOverrideTokens[0], '0x06000001');
  assert.equal(large.defs.methods[10001].explicitOverrideTokens[9999], `0x06${(10000).toString(16).padStart(6, '0')}`);
  // 2k fixture keeps the same shape.
  assert.equal(small.defs.types[1].methodImpls[1999].methodDeclarationToken, `0x06${(2000).toString(16).padStart(6, '0')}`);
});

test('#8974 MethodImpl duplicate/invalid authority still fails closed', () => {
  const ok = timeDecode(methodImplFixture(2));
  assert.equal(ok.defs.methods[3].explicitOverrideTokens.length, 2);

  const dupFixture = methodImplFixture(2);
  // Overwrite row 2's declaration with row 1's (both Class=Child, body=Impl):
  // same (class, declaration) => declaration-duplicate.
  const dv = new DataView(dupFixture.bytes.buffer);
  u16v(dv, dupFixture.layout.tableOffsets[0x19] + 6 + 4, METHODDEF_ORREF(1));
  assert.throws(() => decode(dupFixture), /cil-methodimpl-declaration-duplicate/);

  const nonVirtual = methodImplFixture(2);
  const nv = new DataView(nonVirtual.bytes.buffer);
  // Drop Virtual (0x0040) from the declaring method (rid 2, bound by row 1)
  // while a row still binds it as an explicit declaration: 0x05c6 & ~0x0040 =
  // 0x0586 keeps every other flag but clears virtual => declaration-not-virtual.
  nv.setUint16(nonVirtual.layout.tableOffsets[0x06] + 1 * 14 + 6, 0x0586, true);
  assert.throws(() => decode(nonVirtual), /cil-methodimpl-declaration-not-virtual/);
});

test('#8974 NestedClass binding scales linearly on a valid deep chain', () => {
  const a = timeDecode(nestedChainFixture(2000));
  const boundA = bindCilMetadataTables(a.defs, new Uint8Array(0));
  assert.equal(boundA.types[1999].enclosingTypeToken, `0x02${(1999).toString(16).padStart(6, '0')}`);
  const b = timeDecode(nestedChainFixture(10000));
  const started = process.hrtime.bigint();
  const boundB = bindCilMetadataTables(b.defs, new Uint8Array(0));
  const bindMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(boundB.types[1].enclosingTypeToken, '0x02000001');
  assert.ok(bindMs < 60, `NestedClass bind scaled badly: ${bindMs.toFixed(1)}ms for 10k chain`);
});

test('#8974 enclosing cycles fail closed with the same code', () => {
  // 30-deep chain plus a closing back-edge (type 1 nested in type 2).
  const cycle = nestedChainFixture(30, [[1, 2]]);
  assert.throws(() => bindCilMetadataTables(decode(cycle), new Uint8Array(0)), /cil-nested-class-cycle/);
  // A second row re-nesting an already-nested type is a duplicate, and the
  // binding must not be softened by the chain memo.
  const dup = nestedChainFixture(8, [[3, 5]]);
  assert.throws(() => bindCilMetadataTables(decode(dup), new Uint8Array(0)), /cil-nested-class-nested-duplicate/);
  // Self-reference still fails at row binding, before any chain walk.
  const self = nestedChainFixture(5, [[3, 3]]);
  assert.throws(() => bindCilMetadataTables(decode(self), new Uint8Array(0)), /cil-nested-class-self-referential/);
});
