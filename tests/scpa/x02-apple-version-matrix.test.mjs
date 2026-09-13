/** X-02 fixed-denominator local acceptance. A green test for a product gap
 * proves the gap was observed, not that the positive requirement is satisfied.
 * No observations are read as an oracle; all expected contracts are preflight.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBinary, openBinarySource } from '../../js/binary/index.js';
import { describeMachOPointerSite, machOPointerMetadataRevision, resolveMachOPointer } from '../../js/binary/macho-dyld.js';
import { SwiftMetadataProvider } from '../../js/metadata/swift.js';
import { isLanguageRecordAuthoritative } from '../../js/metadata/provider.js';
import { ObjcMetadataProvider } from '../../js/metadata/objc.js';
import { buildObjcRuntimeModel, resolveObjcDispatch } from '../../js/objc.js';
import { queryNativeAppleMetadata } from '../../js/analysis/apple/native-metadata.js';
import { queryMachOPointerView } from '../../js/analysis/apple/scoped-metadata.js';
import { chainedImportSymbols } from '../../js/chained.js';
import { stableDigest } from '../../js/core/identity/index.js';
import { createFormatSafeRebuildTransaction, inspectFormatSafeImage, validateFormatSafeMutation } from '../../js/rebuild/format-safe.js';
import { materializeRebuildTransaction, validateRebuildTransaction, publishRebuildTransaction } from '../../js/rebuild/transaction-v2.js';
import { LLVM_READOBJ_EXPECTED_VERSION, inspectLlvmReadobj, createLlvmReadobjOracle } from '../../tools/validation/rebuild-independent-oracle.mjs';
import { fixture as worldFixture, workFor } from './helpers.mjs';
import { inputFor, hashBytes, REAL_MACHO_PATH } from './fixtures/x02-apple-version-fixtures.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const matrixBytes = fs.readFileSync(new URL('./fixtures/x02-apple-version-matrix.json', import.meta.url));
const MATRIX_SHA256 = 'c95ea2ba89d072fe9110565072462d5efca496b72a66ff365d8b8d15a95274ad';
assert.equal(hashBytes(matrixBytes), MATRIX_SHA256, 'Frozen denominator changed: audit and re-freeze explicitly, never silently drop rows');
const matrix = JSON.parse(matrixBytes);
const dispositions = ['pass', 'product-gap', 'evidence-gap', 'environment-excluded'];
assert.equal(matrix.rowCount, 120);
assert.equal(matrix.rows.length, matrix.rowCount);
assert.equal(new Set(matrix.rows.map(r => r.id)).size, matrix.rowCount);
assert.deepEqual([...new Set(matrix.rows.map(r => r.family))], Object.keys(matrix.families));
for (const row of matrix.rows) {
  for (const field of ['id','requirement','family','architecture','format','inputClass','osIdentity','compilerIdentity','runtimeIdentity','inputSha256','sourceOrGenerator','entrypoint','downstreamConsumer','expectedContract','oracle','expectedDisposition','notes']) assert.ok(Object.hasOwn(row, field), `${row.id}: missing ${field}`);
  assert.ok(dispositions.includes(row.expectedDisposition));
}
const jsonSafe = value => JSON.parse(JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? v.toString() : v));
const passed = (observedStatus, details={}) => ({classification:'pass',observedStatus,details});
const productGap = (observedStatus, details={}) => ({classification:'product-gap',observedStatus,details});
const u64 = (bytes, at=0) => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getBigUint64(at,true);
const digest = bytes => `bytes:${stableDigest(Array.from(bytes))}`;
const loaderVersion = 'hex-loader:openBinary:v1';

function scopeFor(row) {
  return worldFixture(d => {
    d.binarySet[0].sourceIdentity.sha256 = row.inputSha256;
    d.binarySet[0].loadMapHash = 'x02-loader-map:' + row.inputSha256;
    d.binarySet[0].relocationViewHash = 'x02-fixups:' + row.inputSha256;
    d.profile.osModel = 'darwin'; d.profile.abi = 'darwin-arm64'; d.profile.abiRevision = '2';
  });
}
async function owners(bytes,row,signal=null) {
  const image = openBinary(bytes);
  assert.equal(image.format,'macho');
  // A lossless loader field-name adapter, NOT completed metadata injection.
  const sections = image.sections.map(s => ({...s, vmAddr:s.address, section:s.name}));
  const readAt = (address,length) => image.readVirtualAsync(address,length);
  const common = {sections,readAt,binaryIdentity:'sha256:'+row.inputSha256,architecture:image.arch,platform:image.platform,
    options:{budget:128,signal,binaryImage:image,imageBase:image.imageBase,
      resolvePointer:(raw,context)=>resolveMachOPointer(image, raw,context),
      runtimeSections:{binaryImage:image,architecture:image.arch,
        categoryList:sections.find(s=>s.name==='__objc_catlist'),protocolList:sections.find(s=>s.name==='__objc_protolist')}}};
  const swift = new SwiftMetadataProvider(common), objc = new ObjcMetadataProvider(common);
  const swiftProbe = await swift.probe(), objcProbe = await objc.probe();
  return {image,sections,readAt,swift,objc,swiftProbe,objcProbe};
}
function nativeContext(owned,scope,row) {
  return {swiftIndex:owned.swift.cachedIndex,objcIndex:owned.objc.cachedIndex,
    sourceIdentity:{binaryId:'binary-scpa-test',sliceId:'slice-arm64',sourceId:'sha256:'+row.inputSha256,generation:scope.world.generation},
    isCurrent:()=>true};
}
async function nativeQuery(t,row,owned,request,mutate=null) {
  const scope=scopeFor(row),context=nativeContext(owned,scope,row); mutate?.(context);
  return queryNativeAppleMetadata(request,{...scope,snapshotId:'x02-snapshot',work:workFor(t),getContext:async()=>context});
}
function partialProvider(probe,provider) {
  // `authoritative` includes bounded matched-partial identities in this API.
  // The actual completeness + per-record authority gates must remain closed.
  assert.equal(probe.identity.verdict,'matched-partial');
  assert.equal(probe.completeness.complete,false);
  assert.equal(probe.status.completeness,'partial');
  const records=[...provider.types().records,...provider.methods().records];
  for(const record of records)assert.equal(isLanguageRecordAuthoritative(probe,record),false);
}
function notExecutionProof(result) {
  assert.equal(result.status,'completed');assert.equal(result.exact,false);
  assert.equal(result.bytesRevalidated,false);assert.ok(Object.isFrozen(result.records));
  assert.ok(result.remaining.includes('runtime-image-set-open'));
}
async function pointerQuery(t,row,bytes,image,storage) {
  const scope=scopeFor(row),rawBytes=image.readVirtual(storage,8);
  assert.equal(rawBytes?.length,8);
  const raw=u64(rawBytes),offset=image.addressToOffset(storage);
  assert.deepEqual(rawBytes,bytes.slice(Number(offset),Number(offset)+8));
  const context={worldId:scope.world.id,snapshotId:'x02-snapshot',binaryId:'binary-scpa-test',sliceId:'slice-arm64',
    storageAddress:String(storage),artifactId:'loader:'+row.inputSha256,byteBinding:'host-read-current-source',
    rawValue:String(raw),loaderRevision:machOPointerMetadataRevision(image),image,
    evidenceIds:['x02-byte-read:'+row.inputSha256+':'+String(offset)],isCurrent:()=>hashBytes(bytes)===row.inputSha256};
  const result=await queryMachOPointerView({storageAddress:String(storage)},
    {...scope,snapshotId:'x02-snapshot',work:workFor(t),getContext:async()=>context});
  assert.equal(result.exact,false);assert.equal(result.authority,'metadata-declaration-only');
  assert.equal(result.pointer.rawValue,raw);assert.equal(result.pointer.storageAddress,storage);
  return result;
}
function freshTransaction(bytes) {
  return createFormatSafeRebuildTransaction({binaryId:'fixture:x02:real-macho',source:bytes,sourceHash:digest(bytes),format:'macho',architecture:'x86_64',loaderVersion,
    mutation:{kind:'macho-section-size',segment:'__TEXT',section:'__text',size:80}});
}
function loaderReparse({transaction,original,output}) {
  const image=openBinary(output),ok=image.format===transaction.format&&image.arch===transaction.architecture;
  return {ok,status:ok?'passed':'rejected',format:image.format,architecture:image.arch,loaderVersion,sourceHash:digest(original),outputHash:digest(output)};
}
async function rebuilt(bytes) {
  const transaction=freshTransaction(bytes);
  const materialized=await materializeRebuildTransaction(transaction,bytes,{maxOutputBytes:bytes.length});
  assert.equal(materialized.status,'materialized');assert.equal(transaction.requireIndependentOracle,true);
  assert.equal(materialized.publication,'not-published');
  return {transaction,materialized};
}
let corpus;
function localCorpus() {
  if(corpus)return corpus;
  const machos=[];
  function walk(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())walk(file);
      else if(entry.isFile()) {
        const fd=fs.openSync(file,'r'),head=Buffer.alloc(16);let count;
        try { count=fs.readSync(fd,head,0,16,0); } finally { fs.closeSync(fd); }
        if(count>=16&&[0xfeedfacf,0xfeedface,0xcefaedfe,0xcffaedfe].includes(head.readUInt32LE(0)))
          machos.push(path.relative(ROOT,file).split(path.sep).join('/'));
      }
    }
  }
  walk(path.join(ROOT,'tests'));
  corpus={machos:machos.sort(),scope:'all regular files under tests; Mach-O magic scan; local provenance manifests inspected separately'};
  return corpus;
}

async function observe(t,row,bytes) {
  const e=row.expectedContract;
  if(row.check==='evidence-missing') {
    const found=localCorpus();assert.deepEqual(found.machos,[REAL_MACHO_PATH]);
    assert.ok(fs.existsSync(path.join(ROOT,'docs/解析ツール改善.md.txt')),'Original requirement exists; do not fabricate its absence');
    return {classification:'evidence-gap',observedStatus:'unavailable',details:{inventory:found,missing:row.gap.needed}};
  }
  if(row.check==='environment-runtime') {
    assert.ok(process.platform!=='darwin'||process.arch!=='arm64');
    return {classification:'environment-excluded',observedStatus:'not-executed',details:{platform:process.platform,architecture:process.arch,authenticationExecuted:false}};
  }
  if(row.check==='real-identity') {
    const provenance=JSON.parse(fs.readFileSync(path.join(ROOT,'tests/phase12/rebuild/fixtures/manifest.json')));
    const item=provenance.fixtures.find(r=>r.path===REAL_MACHO_PATH);
    assert.equal(item.real,true);assert.equal(item.producer,e.producer);assert.equal(item.sha256,row.inputSha256);
    assert.equal(provenance.provenance.sourceSha256,e.sourceSha256);
    assert.equal(hashBytes(fs.readFileSync(path.join(ROOT,provenance.provenance.sourcePath))),e.sourceSha256);
    assert.equal(provenance.provenance.compiler,row.compilerIdentity.value);
    const image=openBinary(bytes);assert.equal(image.arch,'x86_64');assert.equal(image.metadata.buildVersion.minos,e.minos);
    assert.equal(image.addressToOffset(0n),384n);assert.equal(image.offsetToAddress(384n),0n);
    return passed('completed',{compiler:provenance.provenance.compiler,buildVersion:image.metadata.buildVersion,runtimeVersion:'unknown',firstTextByte:bytes[384]});
  }
  if(row.check==='unknown-identities') {
    const image=openBinary(bytes);assert.equal(image.metadata.buildVersion,undefined);
    assert.equal(row.compilerIdentity.status,'unknown');assert.equal(row.runtimeIdentity.status,'unknown');
    return passed('unknown',{buildVersion:null,compilerVersion:null,runtimeVersion:null});
  }
  if(['platform-unknown','deployment','build-tool-gap'].includes(row.check)) {
    const image=openBinary(bytes),version=image.metadata.buildVersion;
    if(row.check==='platform-unknown') {
      assert.equal(version.platform,e.platform);assert.equal(image.platform,e.platformName);
      return passed('unknown',{buildVersion:version,verifiedOS:null});
    }
    if(row.check==='deployment') {
      assert.equal(version.minos,e.minos);assert.equal(version.sdk,e.sdk);
      return passed('completed',{buildVersion:version,producerOS:'unknown',executingOS:'unknown'});
    }
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),at=32+72+8*80;
    assert.equal(v.getUint32(at,true),0x32);assert.equal(v.getUint32(at+20,true),1);
    assert.equal(v.getUint32(at+24,true),e.declaredTool);assert.equal(v.getUint32(at+28,true),0x00120103);
    assert.equal(version.tools,undefined);assert.equal(version.toolVersions,undefined);
    return productGap('identity-not-retained',{declaredTool:e.declaredTool,declaredVersion:e.declaredVersion,observed:version});
  }
  if(row.check==='cache-sync'||row.check==='cache-async') {
    let error;
    try { if(row.check==='cache-sync')openBinary(bytes);else await openBinarySource(bytes); } catch(caught) {error=caught;}
    assert.ok(error instanceof Error);assert.match(error.message,/対応していない実行ファイル形式/);
    return productGap('unsupported',{error:error.message,limitation:'Header dispatch only; not a complete real shared-cache fixture.'});
  }
  if(row.check==='source-cancel') {
    const c=new AbortController();c.abort(new Error('x02-cancelled'));
    await assert.rejects(openBinarySource(bytes,{signal:c.signal}),/abort|cancel/i);
    return passed('cancelled',{published:false});
  }
  if(row.check==='rebased-address'||row.check==='source-address') {
    const image=row.check==='source-address'?await openBinarySource(bytes):openBinary(bytes),storage=BigInt(e.storage);
    assert.equal(image.addressToOffset(storage),BigInt(e.fileOffset));assert.equal(image.offsetToAddress(BigInt(e.fileOffset)),storage);
    const rawBytes=await image.readVirtualAsync(storage,8);assert.equal(u64(rawBytes),BigInt(e.raw));
    assert.equal(resolveMachOPointer(image, u64(rawBytes),{address:storage}),BigInt(e.target));
    assert.notEqual(storage,BigInt(e.fileOffset));
    return passed('completed',{storage,raw:BigInt(e.raw),normalized:BigInt(e.target),fileOffset:e.fileOffset,actualDyldSlideExecuted:false});
  }
  if(['chain-supported','chain-partial','non-member','legacy-import','pac','pac-unauth','pac-stale','pac-invalid'].includes(row.check)) {
    const image=openBinary(bytes),base=BigInt(row.options.base||'0x100000000'),storage=base+0x300n,raw=u64(bytes,0x300);
    const view=describeMachOPointerSite(image,raw,storage),fixups=image.metadata.chainedFixups;
    if(row.check==='chain-partial') {
      assert.equal(fixups.complete,false);
      if(e.reason==='unsupportedPointerFormats')assert.ok(fixups.unsupportedPointerFormats.includes(row.options.format));
      else if(['compressed-symbol-pool','unknown-symbol-pool-format','invalid-or-truncated-payload'].includes(e.reason))assert.equal(fixups.partialReason,e.reason);
      else if(['unsupported-version','unsupported-import-format'].includes(e.reason))assert.equal(fixups.importsPartialReason,e.reason);
      else assert.equal(fixups.bindingSitesComplete,false);
      assert.equal(view.authenticationVerified,false);assert.equal(view.executionTargetExact,false);
      if(row.options.format===14)assert.equal(resolveMachOPointer(image, raw,{address:storage}),null);
      return passed('partial',{fixups,view,warnings:image.warnings});
    }
    if(row.check==='non-member') {
      assert.equal(view.status,e.status);assert.equal(view.decoded,null);
      assert.equal(image.imports[0].sites.length,0);
      return passed('unknown',{view,sites:image.imports[0].sites});
    }
    if(row.check==='legacy-import') {
      const names=await chainedImportSymbols(new Blob([bytes]),0);
      assert.deepEqual(names.map(n=>n.name),e.names);assert.deepEqual(names.map(n=>Number(n.addr-base)),e.offsets);
      assert.equal(image.imports[0].sites[0].address,storage);
      return passed('completed',{legacyNames:names,publicImport:image.imports[0],sharedCachePath:false});
    }
    if(row.check==='pac-invalid') {
      assert.equal(describeMachOPointerSite(image,-1n,storage),null);assert.equal(describeMachOPointerSite(image,raw,-1n),null);
      assert.equal(resolveMachOPointer(image, {value:raw},{address:storage}),null);
      assert.equal(resolveMachOPointer(image, raw,{address:-1n}),null);
      return passed('rejected',{invalidScalar:true,invalidAddress:true});
    }
    if(row.check==='pac-stale') {
      const changed=bytes.slice();new DataView(changed.buffer).setBigUint64(0x300,raw^1n,true);
      const current=u64(changed,0x300),stale=describeMachOPointerSite(image,current,storage);
      assert.equal(stale.status,e.status);assert.equal(stale.decoded,null);
      assert.equal(resolveMachOPointer(image, current,{address:storage}),null);
      return passed('unknown',{view:stale,mutatedInputSha256:hashBytes(changed)});
    }
    assert.equal(fixups.complete,true);assert.equal(view.status,'recorded-site');assert.equal(view.coverage.complete,true);
    const scoped=await pointerQuery(t,row,bytes,image,storage);
    assert.equal(scoped.status,'completed');assert.equal(scoped.pointer.authenticationVerified,false);assert.equal(scoped.pointer.executionTargetExact,false);
    if(row.check==='chain-supported') {
      assert.equal(view.pointerFormat,e.format);assert.equal(view.decoded.bind,e.bind);
      assert.equal(view.decoded.ordinal,e.pointerOrdinal);assert.equal(view.decoded.addend,BigInt(e.pointerAddend));
      const imp=image.imports.find(i=>i.name==='_target');assert.ok(imp);assert.equal(imp.ordinal,e.libraryOrdinal);
      assert.equal(imp.library,'/libX.dylib');assert.equal(imp.addend,BigInt(e.importAddend));
      if(e.bind) {assert.equal(imp.sites.length,1);assert.equal(imp.sites[0].address,storage);assert.equal(imp.sites[0].offset,0x300n);assert.equal(imp.sites[0].addend,BigInt(e.pointerAddend));assert.equal(resolveMachOPointer(image, raw,{address:storage}),null);}
      else {assert.equal(imp.sites.length,0);assert.equal(view.decoded.target,base+0x200n);assert.equal(resolveMachOPointer(image, raw,{address:storage}),base+0x200n);}
      return passed('completed',{fixups,import:imp,view,remaining:scoped.remaining});
    }
    if(row.check==='pac-unauth') {
      assert.equal(view.decoded.authenticated,false);assert.equal(view.decoded.addend,BigInt(e.addend));
      assert.equal(view.decoded.authenticationKey,null);assert.equal(view.decoded.discriminator,null);
      return passed('completed',{view,remaining:scoped.remaining});
    }
    assert.equal(view.pointerFormat,e.format);assert.equal(view.decoded.authenticated,true);
    assert.equal(view.decoded.bind,e.bind);assert.equal(view.decoded.authenticationKey,e.key);
    assert.equal(view.decoded.discriminator,e.diversity);assert.equal(view.decoded.addressDiversity,e.addressDiversity);
    assert.equal(view.authenticationVerified,e.authenticationVerified);assert.equal(view.executionTargetExact,e.executionTargetExact);
    assert.ok(scoped.remaining.includes('authentication-success-unproven'));
    if(e.bind){assert.equal(view.decoded.target,null);assert.equal(view.decoded.ordinal,0);assert.equal(resolveMachOPointer(image, raw,{address:storage}),null);}
    else {assert.equal(view.decoded.target,base+0x200n);assert.equal(resolveMachOPointer(image, raw,{address:storage}),base+0x200n);assert.notEqual(raw,view.decoded.target);}
    return passed('completed',{view,normalized:resolveMachOPointer(image, raw,{address:storage}),remaining:scoped.remaining});
  }
  if(row.check==='swift-cancel') {
    const c=new AbortController();c.abort(new Error('x02-cancelled'));
    let value,error;try{value=await owners(bytes,row,c.signal);}catch(caught){error=caught;}
    if(error)assert.match(error.message,/abort|cancel/i);else assert.notEqual(value.swiftProbe.authoritative,true);
    return passed('cancelled',{error:error?.message||null,authoritative:value?.swiftProbe.authoritative??false});
  }
  if(['A','D','E'].includes(row.family)) {
    const owned=await owners(bytes,row),sm=owned.swift.cachedModel,om=owned.objc.cachedModel;
    if(row.check==='swift-abi'||row.check==='objc-abi') {
      const probe=row.check==='swift-abi'?owned.swiftProbe:owned.objcProbe;
      assert.equal(probe.identity.toolchainVersion,e.label);assert.equal(row.compilerIdentity.status,'unknown');assert.equal(row.runtimeIdentity.status,'unknown');
      return passed('unknown',{abiLabel:probe.identity.toolchainVersion,identityVerdict:probe.identity.verdict,verifiedCompiler:null,verifiedRuntime:null});
    }
    if(row.check==='native-stale') {
      await assert.rejects(nativeQuery(t,row,owned,{kind:'swift-type'},context=>{
        if(e.staleKind==='generation')context.sourceIdentity.generation='stale-generation';
        if(e.staleKind==='slice')context.sourceIdentity.sliceId='other-slice';
        if(e.staleKind==='current')context.isCurrent=()=>false;
      }),/native-apple-source-binding|native-apple-owner-stale/);
      return passed('rejected',{staleKind:e.staleKind});
    }
    if(row.check==='native-unavailable') {
      const scope=scopeFor(row),result=await queryNativeAppleMetadata({kind:'swift-type'},{...scope,snapshotId:'x02-snapshot',work:workFor(t)});
      assert.equal(result.status,'unsupported');assert.equal(result.exact,false);
      return passed('unsupported',{result,realInputDiscovery:false});
    }
    if(row.check==='swift-version-gap') {
      const type=sm.types.find(x=>x.address===0x1000n);assert.equal(type.flags,e.knownObservedFlags);
      assert.equal(sm.complete,true);assert.equal(owned.swiftProbe.identity.verdict,'matched-authoritative');
      const result=await nativeQuery(t,row,owned,{kind:'swift-type',address:'0x1000'});notExecutionProof(result);assert.equal(result.total,1);
      return productGap('completed-authoritative-for-unknown-version',{descriptorVersion:e.unknownVersion,modelComplete:sm.complete,providerIdentity:owned.swiftProbe.identity,result});
    }
    if(row.check==='swift-generic-class') {
      const table=sm.vtables.find(v=>v.typeAddress===0x1200n);assert.equal(table.address,BigInt(e.tableAddress));assert.equal(table.methods[0].impl,BigInt(e.target));
      const result=await nativeQuery(t,row,owned,{kind:'swift-vtable',address:'0x1200'});notExecutionProof(result);assert.equal(result.total,1);
      return passed('completed',{table,result});
    }
    if(row.check==='swift-resilient') {
      assert.equal(sm.vtables.length,e.vtables);assert.equal(sm.completeness.vtables.complete,e.complete);partialProvider(owned.swiftProbe,owned.swift);
      const result=await nativeQuery(t,row,owned,{kind:'swift-vtable',address:'0x1200'});notExecutionProof(result);assert.equal(result.total,0);
      return passed('partial',{completeness:sm.completeness,warnings:sm.warnings,result});
    }
    if(row.check==='swift-generic-partial') {
      const generic=sm.genericContexts.find(g=>g.typeAddress===0x1300n);
      assert.equal(generic.complete,e.complete);assert.equal(generic.substitutions,null);partialProvider(owned.swiftProbe,owned.swift);
      const result=await nativeQuery(t,row,owned,{kind:'swift-generic',address:'0x1300'});notExecutionProof(result);assert.equal(result.records[0].complete,false);
      return passed('partial',{generic,result});
    }
    if(row.check==='swift-types-partial'||row.check==='swift-capture-partial') {
      const capture=row.check==='swift-capture-partial',part=capture?sm.completeness.captures:sm.completeness.types;
      assert.equal(part.complete,e.complete);partialProvider(owned.swiftProbe,owned.swift);
      if(capture)assert.equal(sm.captureDescriptors.length,e.count);if(e.types!=null)assert.equal(sm.types.length,e.types);
      const result=await nativeQuery(t,row,owned,{kind:capture?'swift-capture':'swift-type'});notExecutionProof(result);
      if(capture)assert.equal(result.total,0);
      return passed('partial',{completeness:part,result});
    }
    if(row.check.startsWith('swift-')) {
      const kind=row.check,result=await nativeQuery(t,row,owned,{kind,...(kind==='swift-generic'?{address:'0x1300'}:kind==='swift-vtable'?{address:'0x1200'}:{})});
      notExecutionProof(result);assert.equal(result.total,e.count);
      if(kind==='swift-generic') {
        const g=result.records[0];assert.equal(g.complete,true);assert.equal(g.parameters[0].hasKeyArgument,true);
        assert.equal(g.requirements[0].parameter.text,e.parameter);assert.equal(g.requirements[0].type.text,e.type);assert.equal(g.requirements[0].satisfied,e.satisfied);assert.equal(g.substitutions,null);
        assert.equal(owned.swift.cachedIndex.genericContextsByType.get('4864')[0],sm.genericContexts[0]);
      }else if(kind==='swift-capture') {
        const c=result.records[0];assert.equal(c.captureTypes[0].type.text,e.type);assert.equal(c.metadataSources[0].source.text,e.source);assert.equal(c.objectLayout,e.objectLayout);assert.equal(c.substitutions,null);
      }else {
        assert.equal(BigInt(result.records[0].address),BigInt(e.target));
        if(kind==='swift-witness'){assert.equal(BigInt(result.records[0].entriesAddress),BigInt(e.entriesAddress));assert.equal(BigInt(result.records[0].tableAddress),BigInt(e.tableAddress));assert.equal(BigInt(result.records[0].rawTarget),BigInt(e.target));assert.equal(result.records[0].pointerResolved,true);}
      }
      return passed('completed',{result,runtimeSubstitutions:'unknown'});
    }
    if(row.check==='objc-classless-gap') {
      assert.equal(owned.objcProbe.identity.verdict,e.providerVerdict);assert.equal(owned.objc.cachedIndex,null);
      const direct=await buildObjcRuntimeModel(owned.readAt,null,{sections:owned.sections,binaryImage:owned.image,architecture:owned.image.arch,categoryList:owned.sections.find(s=>s.name==='__objc_catlist'),protocolList:owned.sections.find(s=>s.name==='__objc_protolist')},null,owned.image.imageBase);
      assert.equal(direct.categories.length,e.categoryCount);assert.equal(direct.protocols.length,e.protocolCount);
      const result=await nativeQuery(t,row,owned,{kind:'objc-selector',selector:'save:'});assert.equal(result.status,'unsupported');assert.equal(result.exact,false);
      return productGap('unsupported',{provider:owned.objcProbe,directCounts:{categories:direct.categories.length,protocols:direct.protocols.length},result});
    }
    if(row.check==='objc-partial') {
      assert.equal(om.runtimeCompleteness.complete,e.complete);partialProvider(owned.objcProbe,owned.objc);
      const dispatch=resolveObjcDispatch(owned.objc.cachedIndex,{selector:'save:'});assert.equal(dispatch.resolved,null);
      if(row.options.badImp)assert.equal(om.names.some(n=>n.addr===0x10001n),false);
      return passed('partial',{completeness:om.runtimeCompleteness,dispatch});
    }
    assert.equal(om.runtimeCompleteness.complete,true);
    if(row.check==='objc-category') {
      const category=om.categories[0];assert.equal(category.name,e.category);assert.equal(category.className,e.owner);assert.equal(category.instanceMethods[0].imp,BigInt(e.target));assert.equal(category.instanceMethods[0].implementationProven,true);
      const result=await nativeQuery(t,row,owned,{kind:'objc-selector',selector:'save:'});notExecutionProof(result);assert.ok(result.records.some(r=>r.source==='category'));
      return passed('completed',{category,result});
    }
    if(row.check==='objc-protocol') {
      assert.equal(om.protocols[0].name,e.name);
      const requirements=owned.objc.cachedIndex.protocolRequirementsBySelector.get('-:save:');
      assert.equal(requirements?.length,1);assert.equal(requirements[0].selector,e.selector);assert.equal(requirements[0].imp,null);
      return passed('completed',{protocol:om.protocols[0],requirements});
    }
    if(row.check==='objc-selector'||row.check==='objc-imp') {
      const request=row.check==='objc-selector'?{kind:'objc-selector',selector:'save:'}:{kind:'objc-imp',address:e.target};
      const result=await nativeQuery(t,row,owned,request);notExecutionProof(result);assert.equal(result.total,e.count);
      if(e.targets)assert.deepEqual(result.records.map(r=>BigInt(r.address).toString(16)).sort(),e.targets.map(s=>BigInt(s).toString(16)).sort());
      return passed('completed',{result});
    }
    if(row.check==='objc-open'||row.check==='objc-ambiguous') {
      const dispatch=resolveObjcDispatch(owned.objc.cachedIndex,{selector:'save:',...(row.check==='objc-ambiguous'?{receiverType:'Widget'}:{})});
      assert.equal(dispatch.resolved,e.resolved);assert.equal(dispatch.candidates.length,e.count);
      if(row.check==='objc-open')assert.equal(dispatch.partial,true);
      return passed(row.check==='objc-open'?'unknown':'ambiguous',{dispatch});
    }
  }
  if(row.check==='signed-reject'||row.check==='signature-gap') {
    const image=openBinary(bytes),safe=inspectFormatSafeImage(bytes);
    assert.equal(safe.snapshot.signatureState,'code-signature-present');
    if(row.check==='signature-gap') {
      for(const field of ['signatureState','codeSignature','signature'])assert.equal(image.metadata[field],undefined);
      return productGap('signature-state-not-retained',{publicMetadata:image.metadata,formatSafeSignature:safe.snapshot.signatureState,cryptographicVerification:false});
    }
    assert.throws(()=>createFormatSafeRebuildTransaction({binaryId:'x02:signed',source:bytes,sourceHash:digest(bytes),format:'macho',architecture:'arm64',loaderVersion,mutation:{kind:'macho-min-version',version:0x000d0100}}),/format-safe-signed-or-build-identified-input-unsupported/);
    return passed('rejected',{signatureState:safe.snapshot.signatureState,resigned:false,launched:false});
  }
  if(['G','H'].includes(row.family)) {
    const {transaction,materialized}=await rebuilt(bytes),output=materialized.bytes;
    if(row.check==='llvm-environment') {
      const tool=inspectLlvmReadobj();
      assert.equal(LLVM_READOBJ_EXPECTED_VERSION,e.requiredVersion);
      assert.equal(tool.expectedVersion,e.requiredVersion);
      assert.equal(e.available,false);assert.equal(tool.available,false);
      assert.deepEqual(e.unavailableReasons,['independent-oracle-tool-unavailable','independent-oracle-tool-version-mismatch']);
      assert.ok(e.unavailableReasons.includes(tool.reason), 'Pinned oracle must fail closed with an explicit unavailability reason');
      if(tool.reason==='independent-oracle-tool-unavailable')assert.equal(tool.executable,null);
      else {assert.ok(tool.executable);assert.equal(tool.version?.includes(e.requiredVersion)??false,false);}
      const result=await createLlvmReadobjOracle()({transaction,original:bytes,output});assert.equal(result.ok,false);
      return {classification:'environment-excluded',observedStatus:'unavailable',details:{tool,result,independentOraclePassed:false}};
    }
    if(row.check==='oracle-blocks-publication') {
      const validation=await validateRebuildTransaction(transaction,materialized,{original:bytes,loaderReparse,validators:{layout:validateFormatSafeMutation,'format-invariants':validateFormatSafeMutation}});
      assert.equal(validation.status,'invalid');assert.equal(validation.validators.find(v=>v.validator==='independent-differential').executed,false);
      let promoted=false;const publication=await publishRebuildTransaction(materialized,validation,{atomicPromote:async()=>{promoted=true;throw new Error('must not promote');}});
      assert.equal(promoted,false);assert.equal(publication.status,'rejected');
      return passed('rejected',{validation,publication});
    }
    if(row.check==='rewrite-negative') {
      if(e.mode==='stale') {
        const changed=bytes.slice();changed[400]^=1;
        const r=await materializeRebuildTransaction(transaction,changed);assert.equal(r.status,'rejected');assert.equal(r.reason,'rebuild-v2-source-identity-mismatch');return passed('rejected',{result:r});
      }
      if(e.mode==='cancel') {
        const c=new AbortController();c.abort();const r=await materializeRebuildTransaction(transaction,bytes,{signal:c.signal});assert.equal(r.status,'cancelled');return passed('cancelled',{result:r});
      }
      if(e.mode==='budget') {
        const r=await materializeRebuildTransaction(transaction,bytes,{maxOutputBytes:bytes.length-1});assert.equal(r.status,'rejected');assert.equal(r.reason,'rebuild-v2-output-budget-exceeded');return passed('rejected',{result:r});
      }
      let candidate;
      if(e.mode==='truncated')candidate=output.slice(0,-1);
      else {candidate=output.slice();new DataView(candidate.buffer).setBigUint64(transaction.expectedOriginalState.formatSafe.sectionHeaderOffset+40,79n,true);}
      const result=validateFormatSafeMutation({transaction,original:bytes,output:candidate});assert.equal(result.ok,false);
      return passed('rejected',{result,outputSha256:hashBytes(candidate)});
    }
    const before=openBinary(bytes),after=openBinary(output);
    assert.equal(before.sections.find(s=>s.name==='__text').size,77n);assert.equal(after.sections.find(s=>s.name==='__text').size,80n);
    assert.equal(output.length,568);assert.notDeepEqual(output,bytes);assert.equal(after.arch,'x86_64');
    assert.equal(validateFormatSafeMutation({transaction,original:bytes,output}).ok,true);
    assert.equal(loaderReparse({transaction,original:bytes,output}).ok,true);
    const changed=[];for(let i=0;i<bytes.length;i++)if(bytes[i]!==output[i])changed.push(i);
    // Independent literal section-header location: header 32 + segment 72 + size field 40.
    assert.deepEqual(changed,[144]);assert.equal(bytes[144],77);assert.equal(output[144],80);
    if(row.check==='deterministic') {
      const again=await rebuilt(inputFor(row));assert.equal(again.transaction.transactionId,transaction.transactionId);
      assert.deepEqual(again.materialized.bytes,output);assert.equal(again.materialized.outputHash,materialized.outputHash);
      assert.deepEqual(openBinary(again.materialized.bytes).metadata,after.metadata);
    }
    return passed('completed',{beforeSize:'77',afterSize:'80',changedOffsets:changed,outputSha256:hashBytes(output),transactionId:transaction.transactionId,outputHash:materialized.outputHash,independentOraclePassed:false,published:false});
  }
  throw new Error(`No acceptance handler for ${row.id} / ${row.check}`);
}

for (const row of matrix.rows) {
  test(`${row.id} ${row.requirement}`, {timeout:10000}, async t => {
    let outcome;
    try {
      const bytes=inputFor(row);
      assert.equal(bytes===null?null:hashBytes(bytes),row.inputSha256);
      assert.equal(bytes?.length??0,row.inputByteLength);
      assert.equal(bytes===null?null:hashBytes(inputFor(row)),row.inputSha256,'generator determinism');
      outcome=await observe(t,row,bytes);
      assert.equal(outcome.classification,row.expectedDisposition,`${row.id}: requirement classification changed`);
      t.diagnostic('X02_RESULT '+JSON.stringify(jsonSafe({id:row.id,family:row.family,inputClass:row.inputClass,inputSha256:row.inputSha256,
        matrixSha256:MATRIX_SHA256,expectedDisposition:row.expectedDisposition,...outcome})));
    }catch(error) {
      t.diagnostic('X02_RESULT '+JSON.stringify(jsonSafe({id:row.id,family:row.family,inputClass:row.inputClass,inputSha256:row.inputSha256,
        matrixSha256:MATRIX_SHA256,expectedDisposition:row.expectedDisposition,classification:outcome?.classification||'product-gap',
        observedStatus:'unexpected-test-failure',details:{message:error.message,stack:error.stack}})));
      throw error;
    }
  });
}
