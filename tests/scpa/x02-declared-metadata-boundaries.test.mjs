import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { openBinary, openBinarySource, MemoryByteSource } from '../../js/binary/index.js';
import { parseSwiftNominalDescriptor } from '../../js/swift.js';
import { ObjcMetadataProvider } from '../../js/metadata/objc.js';
import { inspectLlvmReadobj } from '../../tools/validation/rebuild-independent-oracle.mjs';
import { appleMetadataBytes } from './fixtures/x02-prior120-apple-version-fixtures.mjs';

// Literal Mach-O declarations, without a signature, compiler or device oracle.
function declarations(commands) {
  const bytes = new Uint8Array(512), view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0,0xfeedfacf],[4,0x0100000c],[12,2],
    [16,commands.length],[20,commands.reduce((n,words)=>n+words.length*4,0)]]) view.setUint32(offset,value,true);
  let offset=32;
  for (const words of commands) for (const word of words) { view.setUint32(offset,word,true);offset+=4; }
  return bytes;
}
const loaders = [
  ['resident',(bytes,options)=>openBinary(bytes,options)],
  ['source',(bytes,options)=>openBinarySource(new MemoryByteSource(bytes,{maxReadLength:8}),options)],
];

for (const [name,load] of loaders) {
  test(`X02 tool declarations preserve unknown IDs and stop at the shared budget (${name})`, async () => {
    const bytes=declarations([[0x32,40,1,0x000d0000,0x000e0000,2,1,0x00120103,0xffffffff,0x00020304]]);
    const image=await load(bytes),v=image.metadata.buildVersion;
    assert.deepEqual(v.tools,[{tool:1,version:'18.1.3',rawVersion:0x00120103},{tool:0xffffffff,version:'2.3.4',rawVersion:0x00020304}]);
    assert.equal(v.provenanceVerified,false);assert.equal(v.toolsComplete,true);
    const limited=await load(bytes,{metadataLimits:{records:1}});
    assert.equal(limited.metadata.buildVersion.ntools,2);
    assert.deepEqual(limited.metadata.buildVersion.tools,[]);
    assert.equal(limited.metadata.buildVersion.toolsComplete,false);
    assert.equal(limited.metadata.machoMetadata.complete,false);
  });
  test(`X02 truncated tool declarations publish no build identity (${name})`, async () => {
    await assert.rejects(async()=>load(declarations([[0x32,8]])),/invalid Mach-O load command 0x32 size 8/);
    for (const words of [[0x32,24,1,0,0,1]]) {
      const image=await load(declarations([words]));
      assert.equal(image.metadata.buildVersion,undefined);
      assert.equal(image.metadata.machoMetadata.complete,false);
    }
  });
  test(`X02 signature presence never becomes verification (${name})`, async () => {
    const image=await load(declarations([[0x1d,16,480,32]]));
    assert.equal(image.metadata.signatureState,'code-signature-present');
    assert.deepEqual(image.metadata.codeSignature,{source:'LC_CODE_SIGNATURE',complete:true,cryptographicVerification:false,offset:480,size:32,rangeValid:true});
    assert.equal(image.metadata.machoMetadata.complete,true);
    const absent=await load(declarations([]));assert.equal(absent.metadata.signatureState,undefined);
  });
  test(`X02 malformed and duplicate signature declarations remain incomplete (${name})`, async () => {
    for (const commands of [
      [[0x1d,8]], [[0x1d,16,480,33]], [[0x1d,16,480,0]],
      [[0x1d,16,480,32],[0x1d,16,480,32]],
    ]) {
      const image=await load(declarations(commands));
      assert.equal(image.metadata.signatureState,'code-signature-present');
      assert.equal(image.metadata.codeSignature.complete,false);
      assert.equal(image.metadata.codeSignature.cryptographicVerification,false);
      assert.equal(image.metadata.machoMetadata.complete,false);
    }
  });
}

test('X02 unsupported Swift descriptor formats never read names or layout tails', async () => {
  for (const kind of [16,17,18]) for (const version of [1,255]) {
    const prefix=new Uint8Array(20);new DataView(prefix.buffer).setUint32(0,kind|(version<<8),true);
    const reads=[];
    const result=await parseSwiftNominalDescriptor(async(address,size)=>{
      reads.push([address,size]);assert.equal(address,0x1000n);assert.equal(size,20);return prefix;
    },0x1000n);
    assert.equal(result,null);assert.deepEqual(reads,[[0x1000n,20]]);
  }
});

test('X02 category-only and protocol-only providers retain partial records and reject invalid ranges', async () => {
  const image=openBinary(appleMetadataBytes({noClassList:true}));
  const readAt=(address,size)=>image.readVirtualAsync(address,size);
  for (const [name,kind] of [['__objc_catlist','categories'],['__objc_protolist','protocols']]) {
    const section=image.sections.find(s=>s.name===name);
    const make=sections=>new ObjcMetadataProvider({readAt,sections,binaryIdentity:'x02-classless',
      options:{runtimeSections:{binaryImage:image}}});
    const provider=make([section]),result=await provider.probe();
    assert.equal(result.identity.verdict,'matched-partial');
    assert.equal(result.counts[kind],1);assert.equal(result.completeness.complete,false);
    assert.ok(result.diagnostics.includes('objc-classlist-missing'));
    for (const sections of [[section,section],[{...section,address:-1n}],[{...section,size:NaN}]]) {
      const invalid=make(sections),rejected=await invalid.probe();
      assert.equal(rejected.completeness.complete,false);assert.equal(invalid.cachedIndex,null);
    }
  }
});

const F48_SOURCE = `__attribute__((noinline)) int x02_leaf(int x) {
    return x + 7;
}

__attribute__((noinline)) int x02_call(int x) {
    return x02_leaf(x) ^ 0x5a;
}
`;
const F48_OBJECT_BASE64 = 'z/rt/gwAAAECAACAAQAAAAQAAAAYAQAAACAAAAAAAAAZAAAAmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQAAAAAAAAAOAEAAAAAAAA0AAAAAAAAAAcAAAAHAAAAAQAAAAAAAABfX3RleHQAAAAAAAAAAAAAX19URVhUAAAAAAAAAAAAAAAAAAAAAAAANAAAAAAAAAA4AQAAAgAAAHABAAABAAAAAAQAgAAAAAAAAAAAAAAAADIAAAAYAAAAAQAAAAAADQAAAAAAAAAAAAIAAAAYAAAAeAEAAAMAAACoAQAAIAAAAAsAAABQAAAAAAAAAAEAAAABAAAAAgAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPyMD1QAcABH/C1/WPyMD1X8jA9X9e7+p/QMAkQAAAJRIC4BSAAAISv17wai/IwPV/w9f1gAAAAAcAAAAAgAALRUAAAAOAQAAAAAAAAAAAAABAAAADwEAAAwAAAAAAAAACwAAAA8BAAAAAAAAAAAAAABfeDAyX2NhbGwAX3gwMl9sZWFmAGx0bXAwAAAAAAAA';
const F48_PROVENANCE = Object.freeze({
  compiler: 'clang version 17.0.0 (https://github.com/swiftlang/llvm-project.git 10999b6d034fe318f3d56c83bddb6572593a8bb0)',
  compilerExecutableSha256: 'aa7389d9766be7e61df76cf094ac4f1861fd067e12908d1e9fd5cd7eb2a078f4',
  target: 'arm64e-apple-macos13.0',
  arguments: ['-c','-O1','-ffreestanding','-fno-stack-protector','-msign-return-address=all'],
  sourceSha256: '608bedd0e779fc50bbb6a8b4f3f9f17fc4c1f6abc268098a819238f491c04a49',
  objectSha256: 'aa196ec267e323ad1910ffc17dc72e7c17d13e2f5271f50dedc067c700611bb0',
  reproducedObjectSha256: 'aa196ec267e323ad1910ffc17dc72e7c17d13e2f5271f50dedc067c700611bb0',
  byteLength: 456,
});
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset,true);
const wordOffsets = (bytes, word) => {
  const offsets=[];
  for(let offset=0;offset+4<=bytes.length;offset+=4) if(u32(bytes,offset)===word) offsets.push(offset);
  return offsets;
};

test('X02-F-48 current acceptance uses a pinned compiler-produced arm64e PAC object', () => {
  const bytes=Uint8Array.from(Buffer.from(F48_OBJECT_BASE64,'base64'));
  assert.equal(F48_PROVENANCE.compiler,'clang version 17.0.0 (https://github.com/swiftlang/llvm-project.git 10999b6d034fe318f3d56c83bddb6572593a8bb0)');
  assert.equal(F48_PROVENANCE.compilerExecutableSha256,'aa7389d9766be7e61df76cf094ac4f1861fd067e12908d1e9fd5cd7eb2a078f4');
  assert.equal(F48_PROVENANCE.target,'arm64e-apple-macos13.0');
  assert.deepEqual(F48_PROVENANCE.arguments,['-c','-O1','-ffreestanding','-fno-stack-protector','-msign-return-address=all']);
  assert.equal(sha256(Buffer.from(F48_SOURCE)),F48_PROVENANCE.sourceSha256);
  assert.equal(sha256(bytes),F48_PROVENANCE.objectSha256);
  assert.equal(F48_PROVENANCE.reproducedObjectSha256,F48_PROVENANCE.objectSha256);
  assert.equal(bytes.length,F48_PROVENANCE.byteLength);
  assert.doesNotMatch(F48_SOURCE,/\b(?:__asm__|asm)\b|\.inst\b|0xd50323(?:3f|bf)\b|0xd65f0bff\b/i);
  assert.equal(u32(bytes,0),0xfeedfacf);
  assert.equal(u32(bytes,4),0x0100000c);
  const subtype=u32(bytes,8);
  assert.equal(subtype&0x00ffffff,2);
  assert.equal((subtype&0xff000000)>>>0,0x80000000);
  const image=openBinary(bytes);
  assert.equal(image.format,'macho');assert.equal(image.arch,'arm64e');assert.equal(image.platform,'macOS');
  assert.equal(image.metadata.buildVersion?.minos,'13.0.0');assert.equal(image.metadata.buildVersion?.source,'LC_BUILD_VERSION');
  assert.ok(wordOffsets(bytes,0xd503233f).length>=1,'compiler output must contain PACIASP');
  assert.ok(wordOffsets(bytes,0xd50323bf).length>=1||wordOffsets(bytes,0xd65f0bff).length>=1,
    'compiler output must contain an authenticated return path');
  // F-48 is producer-pinned corpus evidence only. Runtime authentication remains F-47.
  assert.equal(Object.hasOwn(F48_PROVENANCE,'runtimeAuthenticationExecuted'),false);
});

test('X02 current disposition overlay advances F-48 and preserves environment-bound H-02', () => {
  const matrixBytes=fs.readFileSync(new URL('./fixtures/x02-prior120-apple-version-matrix.json',import.meta.url));
  assert.equal(sha256(matrixBytes),'c95ea2ba89d072fe9110565072462d5efca496b72a66ff365d8b8d15a95274ad');
  const matrix=JSON.parse(matrixBytes);
  const overrides=Object.freeze({
    'X02-A-07':'pass','X02-B-01':'pass','X02-B-02':'pass','X02-D-13':'pass',
    'X02-E-11':'pass','X02-F-48':'pass','X02-G-03':'pass',
  });
  const llvmEnvironment=inspectLlvmReadobj();
  const environmentOverrides=Object.freeze({
    'X02-H-02':llvmEnvironment.available?'pass':'environment-excluded',
  });
  const counts={};
  for(const row of matrix.rows){
    const value=environmentOverrides[row.id]??overrides[row.id]??row.expectedDisposition;
    counts[value]=(counts[value]??0)+1;
  }
  assert.deepEqual(counts,llvmEnvironment.available
    ?{pass:116,'evidence-gap':3,'environment-excluded':1}
    :{pass:115,'evidence-gap':3,'environment-excluded':2});
  const f48=matrix.rows.find(row=>row.id==='X02-F-48');
  assert.equal(f48?.check,'evidence-missing');assert.equal(f48?.expectedDisposition,'evidence-gap');
  assert.match(f48?.gap?.needed??'',/Compiler\/OS\/version-pinned real arm64e fixtures/);
  const h02=matrix.rows.find(row=>row.id==='X02-H-02');
  assert.equal(h02?.check,'llvm-environment');assert.equal(h02?.expectedDisposition,'environment-excluded');
  if(llvmEnvironment.available){
    assert.equal(typeof llvmEnvironment.executableDigest,'string');
    assert.ok(llvmEnvironment.executableDigest.length>0);
    assert.equal(typeof llvmEnvironment.version,'string');
    assert.ok(llvmEnvironment.version.length>0);
  }
});
