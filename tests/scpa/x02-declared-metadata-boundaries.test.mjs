import assert from 'node:assert/strict';
import test from 'node:test';
import { openBinary, openBinarySource, MemoryByteSource } from '../../js/binary/index.js';
import { parseSwiftNominalDescriptor } from '../../js/swift.js';
import { ObjcMetadataProvider } from '../../js/metadata/objc.js';
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
