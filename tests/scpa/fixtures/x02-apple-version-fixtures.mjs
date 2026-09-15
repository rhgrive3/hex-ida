/** X-02 input builders. Layout bytes are owned synthetic records, NOT an Apple
 * compiler, OS, authentication or signing oracle. The native fixture's pinned
 * layout references and independent scalar offsets remain the input authority.
 * Public openBinary parses every section/range consumed below.
 */
import { createHash } from 'node:crypto';
import { openBinary, openBinarySource, MemoryByteSource } from '../../../js/binary/index.js';
import { appleFixture } from '../native-apple-fixture.mjs';
import { SwiftMetadataProvider } from '../../../js/metadata/swift.js';
import { resolveMachOPointer } from '../../../js/binary/macho-dyld.js';
import { ObjcMetadataProvider } from '../../../js/metadata/objc.js';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const APPLE_MATRIX_SECTIONS = Object.freeze([
  ['__swift5_types',0x200,12], ['__swift5_protos',0x210,4], ['__swift5_proto',0x218,4],
  ['__objc_classlist',0x220,8], ['__objc_catlist',0x228,8], ['__objc_protolist',0x230,8],
  ['__swift5_capture',0x5500,24], ['__text',0x6000,8],
].map(Object.freeze));

/** One 64-bit Mach-O segment with explicit section records. fileOffset != VA
 * deliberately exercises production mapping instead of indexing the input by VA.
 */
export function wrapMachO(memory, { sections=APPLE_MATRIX_SECTIONS, arm64e=false, signed=false, chained=null } = {}) {
  const fileBase=0x1000, signatureBytes=signed?16:0;
  const bytes=new Uint8Array(fileBase+memory.length+signatureBytes), view=new DataView(bytes.buffer);
  const u32=(at,value)=>view.setUint32(at,value>>>0,true), u64=(at,value)=>view.setBigUint64(at,BigInt(value),true);
  const text=(at,value)=>bytes.set(new TextEncoder().encode(value),at);
  const segmentBytes=72+80*sections.length, commandBytes=segmentBytes+(signed?32:0)+(chained?16:0);
  if(32+commandBytes>fileBase)throw new RangeError('x02-fixture-header-overflow');
  bytes.set(memory,fileBase);
  u32(0,0xfeedfacf);u32(4,0x0100000c);u32(8,arm64e?2:0);u32(12,6);
  u32(16,1+2*Number(signed)+Number(Boolean(chained)));u32(20,commandBytes);
  u32(32,0x19);u32(36,segmentBytes);text(40,'__TEXT');u64(56,0);u64(64,memory.length);
  u64(72,fileBase);u64(80,memory.length);u32(88,7);u32(92,5);u32(96,sections.length);
  for(const [i,[name,address,size]] of sections.entries()) {
    const at=104+80*i;text(at,name);text(at+16,'__TEXT');u64(at+32,address);u64(at+40,size);
    u32(at+48,fileBase+address);u32(at+52,name==='__text'?2:0);
    u32(at+64,name==='__text'?0x80000400:0);
  }
  let command=32+segmentBytes;
  if(chained) {u32(command,0x80000034);u32(command+4,16);u32(command+8,fileBase+chained.offset);u32(command+12,chained.size);command+=16;}
  if(signed) {u32(command,0x24);u32(command+4,16);u32(command+8,0x000a0f00);u32(command+12,0x000a0f00);command+=16;u32(command,0x1d);u32(command+4,16);u32(command+8,fileBase+memory.length);u32(command+12,signatureBytes);}
  return bytes;
}

export async function appleMatrixInput(options={}) {
  const fixture=await appleFixture(),memory=fixture.memory.slice(),view=new DataView(memory.buffer);
  const p32=(at,value)=>view.setUint32(at,value>>>0,true),p64=(at,value)=>view.setBigUint64(at,BigInt(value),true);
  const string=(at,value)=>memory.set(new TextEncoder().encode(value+'\0'),at);
  p64(0x228,0x9000);p64(0x230,0x9100);
  // category_t: name, class, instance-methods, class-methods, protocols, properties.
  p64(0x9000,0x9200);string(0x9200,'Extra');p64(0x9008,0x8000);p64(0x9010,0x9300);
  p32(0x9300,24);p32(0x9304,1);p64(0x9308,0x8320);p64(0x9310,0x8340);p64(0x9318,0x6004);
  p32(0x6004,0xd65f03c0);
  // protocol_t, fixed 72-byte prefix, required instance-method declaration.
  p64(0x9108,0x9220);string(0x9220,'Savable');p64(0x9118,0x9380);p32(0x9140,72);
  p32(0x9380,24);p32(0x9384,1);p64(0x9388,0x8320);p64(0x9390,0x8340);
  p64(0x9010+16,0x9400);p64(0x9400,1);p64(0x9408,0x9100);
  if(options.mutateMemory)options.mutateMemory(memory,view);
  const bytes=wrapMachO(memory,options);
  return {bytes,memory,inputSha256:sha256(bytes),provenance:'owned-synthetic-layout',osVersion:null,compilerVersion:null,runtimeVersion:null};
}

export function loadedMetadataContext(image,bytes) {
  const sections=image.sections.map(s=>({...s,section:s.name,vmAddr:s.address,addr:s.address}));
  const readAt=async(address,size)=>{
    const offset=image.addressToOffset(address);
    if(offset==null||offset<0n||offset>BigInt(Number.MAX_SAFE_INTEGER))return null;
    const start=Number(offset);return bytes.subarray(start,Math.min(bytes.length,start+size));
  };
  const resolvePointer=(raw,context)=>resolveMachOPointer(image,raw,context);
  const options={imageBase:image.imageBase,resolvePointer,runtimeSections:{binaryImage:image,resolvePointer}};
  const common={sections,readAt,binaryIdentity:`sha256:${sha256(bytes)}`,architecture:image.arch,platform:'darwin',options};
  return {image,sections,readAt,options,swift:new SwiftMetadataProvider(common),objc:new ObjcMetadataProvider(common)};
}

export async function loadAppleMatrixInput(input,{source=false}={}) {
  const image=source?await openBinarySource(new MemoryByteSource(input.bytes)):openBinary(input.bytes);
  return loadedMetadataContext(image,input.bytes);
}

export function chainedMatrixInput({format=12,bind=false,key=2,diversity=0xa55a,addressDiversity=true,version=0}={}) {
  const memory=new Uint8Array(65536),v=new DataView(memory.buffer),base=0xf000;
  const raw=(1n<<63n)|(BigInt(bind)<<62n)|(BigInt(key)<<49n)|(BigInt(addressDiversity)<<48n)|(BigInt(diversity)<<32n)|(bind?0n:0x1234n);
  v.setBigUint64(0x100,raw,true);v.setUint32(base,version,true);v.setUint32(base+4,28,true);
  v.setUint32(base+8,0x60,true);v.setUint32(base+12,0x64,true);v.setUint32(base+20,1,true);
  v.setUint32(base+28,1,true);v.setUint32(base+32,8,true);v.setUint32(base+36,24,true);
  v.setUint16(base+40,0x1000,true);v.setUint16(base+42,format,true);v.setUint16(base+56,1,true);v.setUint16(base+58,0x100,true);
  // No import table: bind cases deliberately remain incomplete. Rebase cases
  // have a fully byte-bound entry; this never attests PAC authentication.
  const bytes=wrapMachO(memory,{sections:[['__text',0x100,8]],arm64e:true,chained:{offset:base,size:0x80}});
  return {bytes,raw,storageAddress:0x100n,inputSha256:sha256(bytes),provenance:'owned-synthetic-layout'};
}

/** Recreate one declared synthetic input. Unknown IDs fail instead of silently
 * substituting the base fixture. Compiler artifacts remain checked-in inputs. */
export async function regenerateMatrixInput(row) {
  const p = row.parameters ?? {};
  if (row.id === 'apple-layout') return (await appleMatrixInput()).bytes;
  if (row.id.startsWith('truncated-')) return (await appleMatrixInput({ sections: [
    ['__objc_classlist', 0x220, 8], ['__objc_catlist', 0x228, 8],
    ['__objc_protolist', 0x230, 8], ['__text', 0x6000, 8],
  ].map(([name, address, size]) => [name, address, name === p.section ? p.declaredSize : size]) })).bytes;
  if (row.id === 'signed-marker') return (await appleMatrixInput({ signed: true })).bytes;
  if (row.id === 'unknown-swift-kind') return (await appleMatrixInput({
    mutateMemory: (_bytes, view) => view.setUint32(0x1300, 31, true),
  })).bytes;
  if (row.id.startsWith('pac-') || row.id === 'unsupported-pointer-format'
      || row.id === 'unsupported-fixups-version') return chainedMatrixInput(p).bytes;
  if (row.id === 'cache-header-only') {
    const bytes = new Uint8Array(512);
    bytes.set(new TextEncoder().encode('dyld_v1  arm64e\0'));
    return bytes;
  }
  throw new Error(`x02-input-regeneration-unsupported:${row.id}`);
}
