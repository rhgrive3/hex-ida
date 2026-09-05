import test from 'node:test';
import assert from 'node:assert/strict';
import { PdbDebugInfoProvider } from '../js/analysis/debug/pdb.js';

const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0';
const BLOCK = 512;
const GUID = '11111111-2222-3333-4444-555555555555';

function guidBytes() {
  const hex = GUID.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Minimal MSF: stream 0 (empty), 1 (info, age 1), 2 (empty TPI), 3 (DBI with
// the given age), 4 (empty symbol stream).
function msf(dbiAge) {
  const info = new Uint8Array(28);
  const infoView = new DataView(info.buffer);
  infoView.setUint32(0, 20000404, true); // version
  infoView.setUint32(4, 0, true); // signature
  infoView.setUint32(8, 1, true); // age
  info.set(guidBytes(), 12);

  const dbi = new Uint8Array(64);
  const dbiView = new DataView(dbi.buffer);
  dbiView.setInt32(0, -1, true); // versionSignature
  dbiView.setUint32(4, 0, true);
  dbiView.setUint32(8, dbiAge, true); // age
  dbiView.setUint16(20, 4, true); // symRecordStreamIndex -> stream 4

  const streamBlocks = [[], [3], [], [5], []];
  const sizes = [0, info.length, 0, dbi.length, 0];
  const directoryBody = [sizes.length, ...sizes, ...streamBlocks.flat()];
  const directory = new Uint8Array(directoryBody.length * 4);
  const directoryView = new DataView(directory.buffer);
  directoryBody.forEach((value, index) => directoryView.setUint32(index * 4, value, true));

  const totalBlocks = 7;
  const file = new Uint8Array(totalBlocks * BLOCK);
  const latin1 = (text) => [...text].map((ch) => ch.charCodeAt(0) & 0xff);
  file.set(latin1(MSF_MAGIC), 0);
  const view = new DataView(file.buffer);
  view.setUint32(32, BLOCK, true);
  view.setUint32(40, totalBlocks, true);
  view.setUint32(44, directory.length, true);
  view.setUint32(52, 1, true); // block map at block 1
  view.setUint32(1 * BLOCK, 2, true); // block map entry: directory lives in block 2
  file.set(directory, 2 * BLOCK);
  file.set(info, 3 * BLOCK);
  file.set(dbi, 5 * BLOCK);
  return file;
}

function image(dbiAge) {
  return {
    identity: { codeView: { guid: GUID, age: 1 } },
    pdbBytes: msf(dbiAge),
  };
}

test('6042: matching DBI age stays authoritative', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(image(1));
  assert.equal(result.identity.verdict, 'matched-authoritative');
});

test('6042: foreign-age DBI is not authoritative', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(image(2));
  assert.equal(result.identity.verdict, 'identity-mismatch');
  assert.match(result.identity.detail ?? '', /DBI age/);
});
