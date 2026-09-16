import { deepFreeze } from '../../core/identity/index.js';
import { createManagedModuleId } from '../shared/identity.js';
import { readCilGenericMetadata } from './metadata-generics.js';
import { parseCilMethodSignature, parseCilPropertySignature } from './call-signature-types.js';
import { readCilMetadataContext } from './metadata-context.js';

const METHOD_DEF_TABLE=0x06, FILE_TABLE=0x26, METHOD_ATTRIBUTE_STATIC=0x0010;
function fail(code){throw new TypeError(code)}
function range(bytes,off,size,code){if(!Number.isSafeInteger(off)||!Number.isSafeInteger(size)||off<0||size<0||off>bytes.length-size)fail(code)}
function compressed(bytes,offset,code){
 if(!Number.isSafeInteger(offset)||offset<0||offset>=bytes.length)fail(code);
 const b0=bytes[offset];
 if((b0&0x80)===0)return {value:b0,next:offset+1};
 if((b0&0xc0)===0x80){if(offset+1>=bytes.length)fail(code);const value=((b0&0x3f)<<8)|bytes[offset+1];if(value<0x80)fail(code);return {value,next:offset+2}}
 if((b0&0xe0)===0xc0){if(offset+3>=bytes.length)fail(code);const value=((b0&0x1f)*0x1000000)+(bytes[offset+1]<<16)+(bytes[offset+2]<<8)+bytes[offset+3];if(value<0x4000)fail(code);return {value,next:offset+4}}
 fail(code);
}
function blobAt(bytes,stream,index,code){
 if(!stream||!Number.isSafeInteger(index)||index<1||index>=stream.size)fail(code);
 range(bytes,stream.offset,stream.size,code);const heap=bytes.subarray(stream.offset,stream.offset+stream.size),length=compressed(heap,index,code);
 if(length.next>heap.length-length.value)fail(code);
 return heap.subarray(length.next,length.next+length.value);
}
function typeDefOrRefCounts(layout){return [layout.rowCounts[0x02]||0,layout.rowCounts[0x01]||0,layout.rowCounts[0x1b]||0]}
function validateParamAuthority(bytes,defs,layout,blobStream,admission=null){
 const byToken=new Map((defs.params||[]).map(row=>[row.token,row])),typeRows=typeDefOrRefCounts(layout);
 for(const method of defs.methods){
  admission?.chargeOperations(1);
  const owned=(method.params||[]).map(token=>{const row=byToken.get(token);if(!row)fail('cil-param-owner-missing');return row});
  const seen=new Set();let returnRows=0;
  for(const param of owned){
   if(param.sequence===0){if(++returnRows>1)fail('cil-param-return-duplicate');continue}
   if(seen.has(param.sequence))fail('cil-param-sequence-duplicate');seen.add(param.sequence);
  }
  if(!owned.some(param=>param.sequence>0))continue;
  const signature=parseCilMethodSignature(blobAt(bytes,blobStream,method.signatureBlobIndex,'cil-call-signature-invalid'),typeRows);
  for(const param of owned)if(param.sequence>signature.parameters.length)fail('cil-param-sequence-out-of-range');
 }
}
function decodePropertyAuthority(bytes,defs,layout,blobStream,admission=null){
 if(!(defs.properties||[]).length)return [];
 admission?.chargeObjects(defs.properties.length);
 const typeRows=typeDefOrRefCounts(layout);
 return defs.properties.map(row=>{
  admission?.chargeOperations(1);
  const raw=blobAt(bytes,blobStream,row.typeBlobIndex,'cil-property-signature-invalid');
  const signature=parseCilPropertySignature(raw,typeRows);
  return {...row,rawSignature:Object.freeze(Array.from(raw)),signature};
 });
}
function skipCustomMods(blob,pos,rowCounts,code){
 while(blob[pos]===0x1f||blob[pos]===0x20){
  const encoded=compressed(blob,pos+1,code),tag=encoded.value&0x03,rid=encoded.value>>>2,table=[0x02,0x01,0x1b][tag];
  if(table==null||rid<1||rid>(rowCounts[table]||0))fail(code);
  pos=encoded.next;
 }
 return pos;
}
function validateManagedEntrySignature(blob,rowCounts){
 const code='cil-entrypoint-signature-invalid';
 if(!(blob instanceof Uint8Array)||blob.length<3)fail(code);
 let pos=0;
 // Entry points are static, non-generic managed DEFAULT methods. HASTHIS,
 // EXPLICITTHIS, GENERIC and vararg/unmanaged calling conventions are invalid.
 if(blob[pos++]!==0x00)fail(code);
 const count=compressed(blob,pos,code);if(count.value!==0&&count.value!==1)fail(code);pos=count.next;
 pos=skipCustomMods(blob,pos,rowCounts,code);const ret=blob[pos++];if(ret!==0x01&&ret!==0x08&&ret!==0x09)fail(code);
 if(count.value===1){
  pos=skipCustomMods(blob,pos,rowCounts,code);if(blob[pos++]!==0x1d)fail(code);
  pos=skipCustomMods(blob,pos,rowCounts,code);if(blob[pos++]!==0x0e)fail(code);
 }
 if(pos!==blob.length)fail(code);
}
function validateManagedEntryAuthority(bytes,parsed,defs,layout,blobStream){
 const token=parsed.entryPointToken;
 if(token==null||token===0||parsed.entryTargetKind==='native-rva')return;
 const rid=token&0x00ffffff;
 if(parsed.entryTargetKind==='method-def'){
  const method=defs.methods[rid-1];if(!method)fail('cil-entrypoint-methoddef-row-missing');
  if((method.accessFlags&METHOD_ATTRIBUTE_STATIC)===0)fail('cil-entrypoint-method-not-static');
  validateManagedEntrySignature(blobAt(bytes,blobStream,method.signatureBlobIndex,'cil-entrypoint-signature-invalid'),layout.rowCounts);
  return;
 }
 if(parsed.entryTargetKind==='file'){
  if(!Number.isSafeInteger(rid)||rid<1||rid>(layout.rowCounts[FILE_TABLE]||0))fail('cil-entrypoint-file-row-missing');
 }
}
// `context` is the already-validated layout/definition graph from
// metadata-context.js (#8704). Omitting it (undefined) builds exactly one such
// graph here; passing `null` states that the image has no CLI metadata to
// overlay. A caller that already validated never pays for a second graph.
export function overlayCilMetadata(bytes,parsed,context,options={}){
 const ctx=context===undefined?readCilMetadataContext(bytes,options):context;if(!ctx)return parsed;
 const {bytes:u8,view,pe,meta,layout,defs,usStream,blobStream,admission}=ctx;
 const blobHeap=ctx.blobHeap;
 const userStrings=new Map();
 if(usStream){
  const usHeap=u8.subarray(usStream.offset,usStream.offset+usStream.size),utf16=new TextDecoder('utf-16le');
  const usLength=(offset)=>{try{return compressed(usHeap,offset,'cil-user-string-invalid');}catch{return null;}};
  for(let offset=1;offset<usHeap.length;){
   const length=usLength(offset);
   if(length==null)break;
   const entryBytes=length.next-offset+length.value;
   if(entryBytes<=0)break;
   admission?.chargeOperations(1);
   admission?.chargeStringBytes(length.value);
   const payload=usHeap.subarray(length.next,length.next+Math.max(length.value-1,0));
   try{userStrings.set(offset,Object.freeze(utf16.decode(payload)));admission?.chargeObjects(1)}catch{}
   offset=length.next+length.value;
  }
 }
 const genericMetadata=readCilGenericMetadata(u8,view,layout,ctx.stringsStream,defs);validateParamAuthority(u8,defs,layout,blobStream,admission);const properties=decodePropertyAuthority(u8,defs,layout,blobStream,admission);validateManagedEntryAuthority(u8,parsed,defs,layout,blobStream);const byOffset=new Map((parsed.methodBodies??[]).map(b=>[b.headerOffset,b])),methodBodies=[],methods=[];
 for(const method of defs.methods){admission?.chargeOperations(1);const out={...method,bodyIndex:null};if(method.rva!==0){const off=pe.mapRva(method.rva,1,'cil-method-rva-unmapped'),body=byOffset.get(off);if(!body)fail('cil-method-rva-unmapped');out.bodyIndex=methodBodies.length;methodBodies.push({...body,token:method.token,rid:method.rid})}methods.push(out)}
 // ECMA-335 II.22.28: Implementation == null resources live inside the CLI
 // Resources directory at the recorded Offset. Each blob is a 4-byte length
 // prefix followed by the payload; both must stay inside the directory or the
 // image fails closed instead of publishing an unresolvable resource (#7753).
 const dir=pe.resources;
 const manifestResources=defs.manifestResources.map((row)=>{
  if(row.implementation!=null)return row;
  admission?.chargeOperations(1);
  const start=dir.offset+row.offset;
  if(!Number.isSafeInteger(row.offset)||row.offset<0||row.offset+4>dir.size)fail('cil-manifest-resource-offset-invalid');
  const length=view.getUint32(start,true);
  if(length>dir.size-4-row.offset)fail('cil-manifest-resource-payload-out-of-bounds');
  const payload=u8.subarray(start+4,start+4+length);
 return {...row,location:'embedded',payload};
 });

 // II.22.18: each FieldRVA must map into the loaded PE image. The metadata
 // root is metadata, not initial data, so an RVA aliasing it is invalid (#7545).
 const metadataStart=pe.metadataOffset,metadataEnd=pe.metadataOffset+pe.metadataSize;
 for(const row of defs.fieldRvas??[]){
  admission?.chargeOperations(1);
  const off=pe.mapRva(row.rva,1,'cil-fieldrva-rva-unmapped');
  if(off>=metadataStart&&off<metadataEnd)fail('cil-fieldrva-rva-metadata-area');
  row.fileOffset=off;
 }

  const moduleName = defs.module?.name || parsed.moduleName || 'Assembly.dll';
  const moduleId = createManagedModuleId(parsed.imageId, moduleName);

  return deepFreeze({...parsed,moduleId,moduleName,module:defs.module||null,modules:defs.module?[defs.module]:(parsed.modules||[]),mvid:defs.module?.mvid||parsed.mvid||null,mvidBytes:defs.module?.mvidBytes||parsed.mvidBytes||null,runtimeVersion:meta.runtimeVersion,vmSpecEdition:meta.runtimeVersion,types:defs.types,fields:defs.fields,params:defs.params,properties,events:defs.events,methodSemantics:defs.methodSemantics,constants:defs.constants,methods,methodBodies,manifestResources,typeSpecs:defs.typeSpecs,assembly:defs.assembly,typeRefs:defs.typeRefs,memberRefs:defs.memberRefs,assemblyRefs:defs.assemblyRefs,fieldMarshals:defs.fieldMarshals,customAttributes:defs.customAttributes,userStrings,...(genericMetadata.genericParams.length?{genericParams:genericMetadata.genericParams}:{}),...(genericMetadata.genericParamConstraints.length?{genericParamConstraints:genericMetadata.genericParamConstraints}:{})});
}
