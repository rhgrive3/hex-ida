import test from 'node:test';
import assert from 'node:assert/strict';

import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';
import { isDebugRecordAuthoritative } from '../../../js/analysis/debug/provider.js';

// The DBI stream header repeats the PDB Info stream age (LLVM PDB docs,
// DbiStreamHeader::Age). A PDB whose info stream matches the binary but whose
// DBI belongs to another generation is internally inconsistent and must not
// stay authoritative over the DBI-selected symbol/module streams (#6042).

const GUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

function buildPdb({ infoAge = 1, dbiAge = 1, dbiSize = 64, dbiVersionSignature = -1, dbiVersionHeader = 19990903 } = {}) {
  const blockSize = 64;
  const blockCount = 6;
  const bytes = new Uint8Array(blockSize * blockCount);
  const view = new DataView(bytes.buffer);
  const magic = new TextEncoder().encode('Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0');
  bytes.set(magic, 0);
  view.setUint32(32, blockSize, true);
  view.setUint32(36, 1, true); // FreeBlockMapBlock: spec-legal value (#5672)
  view.setUint32(40, blockCount, true);
  view.setUint32(44, 32, true);
  view.setUint32(52, 1, true);

  view.setUint32(blockSize, 2, true);
  let cursor = blockSize * 2;
  view.setUint32(cursor, 4, true); cursor += 4;
  for (const size of [0, 28, 56, dbiSize]) {
    view.setUint32(cursor, size, true);
    cursor += 4;
  }
  for (const block of [3, 4, 5]) {
    view.setUint32(cursor, block, true);
    cursor += 4;
  }

  // PDB info stream (stream 1 / block 3).
  cursor = blockSize * 3;
  view.setUint32(cursor, 20000404, true);
  view.setUint32(cursor + 4, 0, true);
  view.setUint32(cursor + 8, infoAge, true);
  const match = /^([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{12})$/.exec(GUID);
  view.setUint32(cursor + 12, Number.parseInt(match[1], 16), true);
  view.setUint16(cursor + 16, Number.parseInt(match[2], 16), true);
  view.setUint16(cursor + 18, Number.parseInt(match[3], 16), true);
  const rest = match[4] + match[5];
  for (let index = 0; index < 8; index += 1) {
    bytes[cursor + 20 + index] = Number.parseInt(rest.slice(index * 2, index * 2 + 2), 16);
  }

  // Structurally valid empty TPI stream (stream 2 / block 4).
  cursor = blockSize * 4;
  view.setUint32(cursor + 4, 56, true);
  view.setUint32(cursor + 8, 0x1000, true);

  // DBI header (stream 3 / block 5) with a native-compatible shape and its own generation age.
  view.setInt32(blockSize * 5, dbiVersionSignature, true);
  view.setUint32(blockSize * 5 + 4, dbiVersionHeader, true);
  view.setUint32(blockSize * 5 + 8, dbiAge, true);
  return bytes;
}

function probe(options) {
  const provider = new PdbDebugInfoProvider();
  return provider.probe({
    snapshotId: 'snapshot-6042',
    identity: { codeView: { guid: GUID.toLowerCase(), age: 1, path: 'app.pdb' } },
    pdbBytes: buildPdb(options),
  });
}

test('#6042: consistent info/DBI ages stay matched-authoritative', () => {
  const result = probe({ infoAge: 1, dbiAge: 1 });
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.ok(!result.diagnostics.some((d) => d.includes('DBI stream age')), JSON.stringify(result.diagnostics));
});

test('#6042: a DBI age that contradicts the info stream downgrades authority', () => {
  const result = probe({ infoAge: 1, dbiAge: 2 });
  assert.equal(result.identity.verdict, 'identity-mismatch', 'a mixed-generation PDB is not authoritative');
  assert.ok(result.diagnostics.some((d) => d.includes('DBI stream age')), JSON.stringify(result.diagnostics));
  assert.equal(result.authoritative, false);
});

test('#6042: matching CodeView/Info ages without a parsed DBI stay unavailable', () => {
  for (const dbiSize of [0, 63]) {
    const result = probe({ infoAge: 1, dbiAge: 1, dbiSize });
    assert.equal(result.identity.verdict, 'identity-unavailable');
    assert.equal(result.identity.detail, 'PDB DBI header is missing or truncated');
    assert.equal(result.authoritative, false);
    assert.equal(result.status.completeness, 'partial');
    assert.equal(result.status.stopReason, 'evidence-missing');
    assert.ok(result.diagnostics.includes('PDB DBI header is missing or truncated'));

    const candidate = {
      kind: 'symbol',
      entityId: 'probe',
      name: 'probe',
      address: null,
      sizeBytes: null,
      descriptor: null,
      providerId: result.providerId,
      providerVersion: result.providerVersion,
      buildIdentity: result.identity.observed,
      evidenceIds: ['pdb:test'],
    };
    assert.equal(isDebugRecordAuthoritative(result, candidate), false);
  }
});

test('#6042: a sized DBI with an invalid signature or version stays unavailable', () => {
  for (const options of [
    { dbiVersionSignature: 0 },
    { dbiVersionHeader: 19990604 },
  ]) {
    const result = probe({ infoAge: 1, dbiAge: 1, ...options });
    assert.equal(result.identity.verdict, 'identity-unavailable');
    assert.equal(result.identity.detail, 'PDB DBI header is missing or truncated');
    assert.equal(result.authoritative, false);
    assert.equal(result.parsed.dbi, null);
    assert.equal(result.status.completeness, 'partial');
  }
});

test('#6042: the authoritative record filter drops symbols from a mismatched DBI', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe({
    snapshotId: 'snapshot-6042',
    identity: { codeView: { guid: GUID.toLowerCase(), age: 1, path: 'app.pdb' } },
    pdbBytes: buildPdb({ infoAge: 1, dbiAge: 2 }),
  });
  assert.ok(result.parsed, 'the parse still travels with the result for inspection');
  // Use a canonical provider record so this assertion reaches the identity
  // verdict check instead of failing early on record shape (#6042).
  const page = { records: [{
    kind: 'symbol',
    entityId: 'probe',
    name: 'probe',
    address: '0x1000',
    sizeBytes: 1,
    descriptor: null,
    providerId: result.providerId,
    providerVersion: result.providerVersion,
    buildIdentity: result.identity.observed,
    evidenceIds: ['pdb:test'],
  }] };
  assert.equal(isDebugRecordAuthoritative(result, page.records[0]), false);
  const filtered = provider.authoritativeRecords(
    result,
    () => ({ records: page.records, nextCursor: null, truncated: false }),
    {},
  );
  assert.deepEqual(filtered.records, []);
});
