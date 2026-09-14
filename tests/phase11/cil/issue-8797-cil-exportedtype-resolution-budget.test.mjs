import assert from 'node:assert/strict';
import { buildCil, cilTables } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { overlayCilManifestSecurity } from '../../../js/managed/cil/metadata-manifest-security.js';

console.log('[phase11] running issue #8797 nested ExportedType resolution complexity tests...');

const utf8 = s => new TextEncoder().encode(s);
const align4 = n => Math.ceil(n / 4) * 4;
const pad = b => { const p = new Uint8Array(align4(b.length)); p.set(b); return p; };
function heap() {
  const s = [0], idx = {};
  const put = n => { idx[n] = s.length; s.push(...utf8(n), 0); };
  put('A.netmodule'); put('B.netmodule'); put('Widget'); put('Example'); put('T');
  return { bytes: s, idx };
}
function image(rows) {
  const { bytes: strings, idx } = heap();
  const tables = cilTables(rows);
  const blob = Uint8Array.from([0, 0x03, 0xaa, 0xbb, 0xcc]);
  const content = 0x400 + align4(tables.bytes.length) + align4(pad(Uint8Array.from(strings)).length)
    + align4(pad(blob).length) + 128;
  return buildCil({
    methods: [{ name: 'Run', body: [0x2a] }],
    imageSize: 0x300 + content + 8192,
    metadataSize: content + 8192,
    streams: [
      { name: '#~', bytes: tables.bytes },
      { name: '#Strings', bytes: pad(Uint8Array.from(strings)) },
      { name: '#Blob', bytes: pad(blob) },
    ],
  }).bytes;
}
function exportedRows(N, cycle = false) {
  const { idx } = heap(); const tName = idx['T'];
  const assemblyRefs = new Uint8Array(20); const av = new DataView(assemblyRefs.buffer);
  av.setUint16(0, 1, true); av.setUint16(14, idx['Widget'], true);
  const et = new Uint8Array(N * 14); const ev = new DataView(et.buffer);
  for (let rid = 1; rid <= N; rid++) {
    const p = (rid - 1) * 14; ev.setUint16(p + 8, tName, true);
    if (cycle) {
      const nxt = rid < N ? rid + 1 : 1;                    // closes the ring
      ev.setUint32(p, 0x00000002, true); ev.setUint16(p + 12, (nxt << 2) | 2, true);
    } else if (rid < N) {
      ev.setUint32(p, 0x00000002, true);                    // NestedPublic
      ev.setUint16(p + 12, ((rid + 1) << 2) | 2, true);      // -> ExportedType rid+1
    } else {
      ev.setUint32(p, 0x00200001, true);                    // Public | Forwarder
      ev.setUint16(p + 12, (1 << 2) | 1, true);              // -> AssemblyRef #1
    }
  }
  return image(new Map([[0x23, { count: 1, bytes: assemblyRefs }], [0x27, { count: N, bytes: et }]]));
}
const rawManifest = (bytes, options = {}) =>
  overlayCilManifestSecurity(bytes, overlayCilMetadata(bytes, parseCilBase(bytes, options), options), options);

// Correctness: every row in a valid nested chain still resolves to the terminal
// AssemblyRef, and resolution completes on the default (generous) budget.
{
  const image = exportedRows(2000);
  const parsed = parseCil(image, { binaryId: 'chain' });
  assert.equal(parsed.exportedTypes.length, 2000);
  assert.ok(parsed.exportedTypes.every(r =>
    r.resolvedImplementation.table === 0x23 && r.resolvedImplementation.rid === 1),
  'path-compressed memoization must preserve the terminal resolution for every row');
}

// Availability (red: pre-fix the from-scratch per-row walk is O(N^2) and there is
// no admission bound). A work budget must fail closed with a deterministic code
// before the quadratic traversal completes.
assert.throws(
  () => rawManifest(exportedRows(2000), { binaryId: 'budget', resourceBudget: { maxWork: 50 } }),
  /cil-metadata-resource-limit-work/,
  'the ExportedType resolution walk must be admitted by the shared metadata work budget',
);

// A linear memoized walk stays inside a modest budget derived from row count.
assert.doesNotThrow(
  () => rawManifest(exportedRows(2000), { binaryId: 'linear', resourceBudget: { maxWork: 20000 } }),
  'linear (memoized) resolution must fit a budget proportional to unique rows',
);

// Cycle detection authority is preserved by memoization.
assert.throws(
  () => rawManifest(exportedRows(10, true), { binaryId: 'cycle' }),
  /cil-exported-type-implementation-cycle/,
  'a nested ExportedType implementation cycle must still fail closed',
);

console.log('[phase11] issue #8797 nested ExportedType resolution complexity tests passed');
