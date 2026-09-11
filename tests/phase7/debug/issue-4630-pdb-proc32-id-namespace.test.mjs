import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PDB_PROVIDER_ID,
  PDB_PROVIDER_VERSION,
  PdbDebugInfoProvider,
  parseSymbolRecords,
} from '../../../js/analysis/debug/pdb.js';

const S_GPROC32 = 0x1110;
const S_LPROC32_ID = 0x1146;
const S_GPROC32_ID = 0x1147;

function procRecord(kind, typeOrId, name) {
  const encoded = new TextEncoder().encode(name);
  const bytes = new Uint8Array(40 + encoded.length);
  const view = new DataView(bytes.buffer);
  // Record length excludes the 2-byte length field. The fixed PROCSYM32
  // fields occupy bytes [2,39), followed by the NUL-terminated name.
  view.setUint16(0, bytes.length - 2, true);
  view.setUint16(2, kind, true);
  view.setUint32(16, 4, true); // procedure byte length
  view.setUint32(28, typeOrId, true);
  view.setUint32(32, 0x20, true);
  view.setUint16(36, 1, true);
  bytes[38] = 0;
  bytes.set(encoded, 39);
  bytes[39 + encoded.length] = 0;
  return bytes;
}

function concat(...chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function providerResult(symbols) {
  return {
    providerId: PDB_PROVIDER_ID,
    providerVersion: PDB_PROVIDER_VERSION,
    identity: { observed: 'guid/1' },
    parsed: {
      symbols,
      // Deliberately collide with the numeric IPI FuncId. If an ID procedure
      // is misread as a TPI TypeIndex, it will resolve this unrelated type.
      tpi: {
        types: new Map([
          [0x1000, {
            kind: 'aggregate', keyword: 'struct', name: 'Wrong',
            sizeBytes: 8, forwardReference: false,
          }],
          [0x1005, {
            kind: 'procedure', returnType: 0x0074,
          }],
        ]),
      },
      sectionHeaders: [],
    },
  };
}

test('#4630 regular PROC32 keeps a TPI TypeIndex while PROC32_ID keeps an IPI FuncId', () => {
  const stream = concat(
    procRecord(S_GPROC32, 0x1005, 'regular'),
    procRecord(S_GPROC32_ID, 0x1000, 'global-id'),
    procRecord(S_LPROC32_ID, 0x1000, 'local-id'),
  );
  const parsed = parseSymbolRecords(stream);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.symbols.length, 3);
  assert.deepEqual([...parsed.unmodelled].sort((a, b) => a - b), [S_LPROC32_ID, S_GPROC32_ID]);

  assert.equal(parsed.symbols[0].typeIndex, 0x1005);
  assert.equal(parsed.symbols[0].functionIdIndex, undefined);

  for (const symbol of parsed.symbols.slice(1)) {
    assert.equal(symbol.typeIndex, null, 'IPI FuncId must not be exposed as a TPI TypeIndex');
    assert.equal(symbol.functionIdIndex, 0x1000);
    assert.equal(symbol.kind, 'procedure');
    assert.equal(symbol.isFunction, true);
  }
});

test('#4630 provider does not mint type authority from PROC32_ID without IPI resolution', () => {
  const parsed = parseSymbolRecords(concat(
    procRecord(S_GPROC32, 0x1005, 'regular'),
    procRecord(S_GPROC32_ID, 0x1000, 'id-proc'),
  ));
  const provider = new PdbDebugInfoProvider();
  const page = provider.types(providerResult(parsed));

  assert.equal(page.records.length, 1, 'unresolved IPI procedure IDs must not reach TPI type recovery');
  assert.equal(page.records[0].name, 'regular');
  assert.equal(page.records[0].descriptor.complete, true);
  assert.equal(page.records[0].descriptor.claim.name, 'int (*)()');
});
