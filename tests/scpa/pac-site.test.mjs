import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteView } from '../../js/binary/reader.js';
import { parseChainedBindingSites, describeMachOPointerSite, machOPointerMetadataRevision } from '../../js/binary/macho-dyld.js';
import { queryMachOPointerView } from '../../js/analysis/apple/scoped-metadata.js';
import { fixture, workFor } from './helpers.mjs';
// Hand-encoded layout packets test the production parser, not authentication.
function loaded(format, raw) {
  const data = new Uint8Array(0x1000), v = new DataView(data.buffer), base = 0x800;
  v.setBigUint64(0x100, raw, true); v.setUint32(base + 4, 28, true);
  v.setUint32(base + 28, 1, true); v.setUint32(base + 32, 8, true); v.setUint32(base + 36, 24, true);
  v.setUint16(base + 40, 0x1000, true); v.setUint16(base + 42, format, true);
  v.setUint16(base + 56, 1, true); v.setUint16(base + 58, 0x100, true);
  const image = { imageBase: 0x1000n, metadata: {}, warnings: [],
    segments: [{ address: 0x1000n, size: 0x1000n, fileOffset: 0n, fileSize: 0x1000n }],
    addressToOffset: address => address - 0x1000n };
  const status = parseChainedBindingSites(new ByteView(data), { offset: base, size: 0x80 }, image, [{ sites: [] }]);
  return { image, status, view: describeMachOPointerSite(image, raw, 0x1100n) };
}
for (const format of [1, 7, 9, 10, 12]) for (const bind of [false, true]) for (const key of [0,1,2,3]) {
  test(`loader retains encoded PAC fields format ${format} bind ${bind} key ${key}`, () => {
    const low = bind ? 0n : 0x1234n, diversity = 0xa55an, addressDiversity = key % 2 !== 0;
    const raw = (1n<<63n) | (BigInt(bind)<<62n) | (BigInt(key)<<49n) | (BigInt(addressDiversity)<<48n) | (diversity<<32n) | low;
    const { status, view } = loaded(format,raw);
    assert.equal(status.bindingSitesComplete,true); assert.equal(view.status,'recorded-site');
    assert.equal(view.decoded.authenticationKey,key); assert.equal(view.decoded.discriminator,Number(diversity));
    assert.equal(view.decoded.addressDiversity,addressDiversity); assert.equal(view.decoded.bind,bind);
    assert.equal(view.decoded.target,bind?null:0x2234n); assert.equal(view.authenticationVerified,false);
    assert.equal(view.executionTargetExact,false); assert.equal(view.decoded.next,0);
  });
}
for (const diversity of [0n,1n,65535n]) test(`PAC diversity boundary ${diversity}`, () => {
  const {view}=loaded(12,(1n<<63n)|(diversity<<32n)); assert.equal(view.decoded.discriminator,Number(diversity));
  assert.equal(view.decoded.authenticationKey,0); assert.equal(view.decoded.addressDiversity,false);
});
test('unauthenticated and unsupported layouts do not acquire auth fields from overlapping bits',()=>{
  // Formats 2/6 reserve bits 44..50, so using bits 48..50 there is
  // structurally invalid rather than a valid unauthenticated control (#4216).
  for(const format of [1,7,9,10,12]) {
    const {view}=loaded(format,0x7n<<48n);
    assert.equal(view.decoded.authenticationKey,null); assert.equal(view.decoded.discriminator,null);
  }
  assert.equal(loaded(14,1n<<63n).view.decoded,null);
});
test('24-bit auth bind ordinal remains separate from diversity',()=>{
  const {view,status}=loaded(12,(3n<<62n)|(0xffffn<<32n)|0xabcdefn);
  assert.equal(view.decoded.ordinal,0xabcdef); assert.equal(view.decoded.discriminator,65535);
  assert.equal(status.bindingSitesComplete,false); // ordinal intentionally outside import table
});
test('current pointer query exposes metadata without authentication or target authority',async t=>{
  const f=fixture(),raw=(1n<<63n)|(2n<<49n)|(1n<<48n)|(0xfacen<<32n)|0x20n;
  const {image}=loaded(12,raw), context={worldId:f.world.id,snapshotId:'snap',binaryId:'binary-scpa-test',sliceId:'slice-arm64',
    storageAddress:0x1100n,rawValue:raw,image,loaderRevision:machOPointerMetadataRevision(image),artifactId:'loader',
    byteBinding:'host-read-current-source',evidenceIds:['source-bytes'],isCurrent:()=>true};
  const r=await queryMachOPointerView({storageAddress:'4352'},{...f,snapshotId:'snap',work:workFor(t),getContext:()=>context});
  assert.equal(r.pointer.decoded.authenticationKey,2); assert.equal(r.pointer.authenticationVerified,false);
  assert.ok(r.remaining.includes('authentication-success-unproven'));
  assert.ok(!r.remaining.includes('authentication-context-not-retained-by-owner'));
  assert.equal(describeMachOPointerSite(image,raw^1n,0x1100n).decoded,null);
});
