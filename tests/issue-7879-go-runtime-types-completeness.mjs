import assert from 'node:assert/strict';
import { GoMetadataProvider } from '../js/metadata/go.js';
import { parseUnifiedLanguageMetadata } from '../js/metadata/index.js';

function writeCString(buf, off, value) {
  for (let i = 0; i < value.length; i++) buf[off + i] = value.charCodeAt(i);
  buf[off + value.length] = 0;
}

function createPclntab120() {
  const buf = new Uint8Array(1024);
  const view = new DataView(buf.buffer);
  const ptrSize = 8;
  const textStart = 0x400000n;
  const nameTabStart = 128;
  const cutabStart = 192;
  const filetabStart = 224;
  const pctabStart = 256;
  const pclnStart = 384;
  const funcOff = 64;
  const funcPos = pclnStart + funcOff;

  view.setUint32(0, 0xfffffff1, true);
  buf[4] = 0;
  buf[5] = 0;
  buf[6] = 1;
  buf[7] = ptrSize;
  view.setBigUint64(8, 1n, true); // nfunc
  view.setBigUint64(16, 0n, true); // nfiles
  view.setBigUint64(24, textStart, true);
  view.setBigUint64(32, BigInt(nameTabStart), true);
  view.setBigUint64(40, BigInt(cutabStart), true);
  view.setBigUint64(48, BigInt(filetabStart), true);
  view.setBigUint64(56, BigInt(pctabStart), true);
  view.setBigUint64(64, BigInt(pclnStart), true);

  writeCString(buf, nameTabStart, 'main.main');
  view.setUint32(pclnStart, 0x1000, true);
  view.setUint32(pclnStart + 4, funcOff, true);
  view.setUint32(funcPos, 0x1000, true);
  view.setInt32(funcPos + 4, 0, true);
  view.setInt32(funcPos + 8, 0, true);
  view.setInt32(funcPos + 12, 0, true);
  return buf;
}

const pclntabBuffer = createPclntab120();
const sections = [
  { name: '.gopclntab' },
  { name: '.rodata' },
  { name: '.typelink' },
];
const provider = new GoMetadataProvider({
  pclntabBuffer,
  sections,
  binaryIdentity: 'sha256:issue-7879',
  architecture: 'x86_64',
  platform: 'linux',
});

const result = provider.probe();
assert.equal(provider.symbols().records.length, 1, 'pclntab symbol extraction remains available');
assert.equal(provider.types().records.length, 0, 'runtime type enumeration is still unimplemented');
assert.equal(result.identity.verdict, 'matched-partial');
assert.equal(result.completeness.complete, false);
assert.equal(result.status.completeness, 'partial');
assert.deepEqual(result.completeness.reasons, ['go-runtime-types-unscanned']);
assert.deepEqual(result.identity.coverage?.recordKinds, ['symbol']);
assert.deepEqual(result.identity.coverage?.addresses, ['0x401000']);


// Omitting section descriptors does not prove that the binary has no runtime
// type metadata; the provider still has not scanned that domain.
const noSectionEvidence = new GoMetadataProvider({
  pclntabBuffer,
  sections: [],
  binaryIdentity: 'sha256:issue-7879-no-sections',
}).probe();
assert.equal(noSectionEvidence.identity.verdict, 'matched-partial');
assert.equal(noSectionEvidence.completeness.complete, false);
assert.deepEqual(noSectionEvidence.completeness.reasons, ['go-runtime-types-unscanned']);

// Existing function-table budget accounting remains intact while the separate
// unscanned type domain also keeps the whole provider incomplete.
const cappedProvider = new GoMetadataProvider({
  pclntabBuffer,
  sections,
  binaryIdentity: 'sha256:issue-7879-capped',
  options: { maxRecords: 0 },
});
const capped = cappedProvider.probe();
assert.equal(capped.completeness.capped, true);
assert.equal(capped.completeness.scanned, 0);
assert.equal(capped.completeness.parsed, 0);
assert.equal(capped.completeness.complete, false);
assert.deepEqual(capped.completeness.reasons, ['go-runtime-types-unscanned']);
assert.deepEqual(capped.identity.coverage?.recordKinds, ['symbol']);
assert.deepEqual(capped.identity.coverage?.addresses, []);

const unified = await parseUnifiedLanguageMetadata({
  pclntabBuffer,
  sections,
  binaryIdentity: 'sha256:issue-7879',
  architecture: 'x86_64',
  platform: 'linux',
});
assert.equal(unified.results.length, 1);
assert.equal(unified.results[0].result.identity.verdict, 'matched-partial');
assert.equal(unified.results[0].result.completeness.complete, false);
assert.equal(unified.complete, false, 'unscanned runtime type domain prevents whole-metadata completeness');

console.log('issue-7879 Go runtime-type completeness regression passed');
