// One bounded metadata-layout authority for every CIL reader.
import { metadataRowSize, validateMetadataTableValidMask } from './metadata-layout.js';
import { readCilMetadataStreams } from './metadata-streams.js';
import { readCilDefinitions, bindCilMetadataTables } from './metadata-definitions.js';
import { createCilMetadataAdmission, admitCilMetadataTables } from './metadata-budget.js';
import { CLI_HEADER_SIZE, validateCliHeaderSize } from './cli-header.js';
export const CIL_METADATA_CONTEXT_VERSION = 'hex-cil-metadata-context-v1';
const CLI_DIRECTORY_INDEX = 14;
function fail(code){throw new TypeError(code)}
function range(bytes,off,size,code){if(!Number.isSafeInteger(off)||!Number.isSafeInteger(size)||off<0||size<0||off>bytes.length-size)fail(code)}
function u16(v,o,c){if(o<0||o+2>v.byteLength)fail(c);return v.getUint16(o,true)}
function u32(v,o,c){if(o<0||o+4>v.byteLength)fail(c);return v.getUint32(o,true)}
export function asUint8Array(bytes){return bytes instanceof Uint8Array?bytes:new Uint8Array(bytes)}
export function readCilPeLayout(bytes,view){
 if(bytes.length<64||bytes[0]!==0x4d||bytes[1]!==0x5a)return null;
 const pe=u32(view,0x3c,'cil-truncated-pe-header');if(pe+24>bytes.length||bytes[pe]!==0x50||bytes[pe+1]!==0x45||bytes[pe+2]!==0||bytes[pe+3]!==0)return null;
 const count=u16(view,pe+6,'cil-truncated-pe-coff-header'),optSize=u16(view,pe+20,'cil-truncated-pe-coff-header'),opt=pe+24;if(optSize<2||opt+optSize>bytes.length)return null;
 const end=opt+optSize,magic=u16(view,opt,'cil-truncated-pe-optional-header');let nOff,dOff;
 if(magic===0x10b){nOff=opt+92;dOff=opt+96}else if(magic===0x20b){nOff=opt+108;dOff=opt+112}else return null;
 if(nOff+4>end)return null;const n=u32(view,nOff);if(n<=CLI_DIRECTORY_INDEX||dOff+(CLI_DIRECTORY_INDEX+1)*8>end)return{cliPresent:false};
 const sections=[];for(let i=0;i<count;i++){const p=end+i*40;range(bytes,p,40,'cil-truncated-pe-section-table');const rawSize=u32(view,p+16),rawOffset=u32(view,p+20);if(rawSize)range(bytes,rawOffset,rawSize,'cil-pe-section-out-of-bounds');sections.push({virtualSize:u32(view,p+8),virtualAddress:u32(view,p+12),rawSize,rawOffset})}
 const mapRva=(rva,size=1,code='cil-rva-unmapped')=>{if(!Number.isSafeInteger(rva)||!Number.isSafeInteger(size)||rva<0||size<0)fail(code);for(const s of sections){const span=Math.max(s.virtualSize,s.rawSize);if(rva<s.virtualAddress||rva>=s.virtualAddress+span)continue;const delta=rva-s.virtualAddress;if(delta>s.rawSize||size>s.rawSize-delta)fail(code);const out=s.rawOffset+delta;range(bytes,out,size,code);return out}fail(code)};
 const dir=dOff+CLI_DIRECTORY_INDEX*8,rva=u32(view,dir,'cil-truncated-cli-directory'),size=u32(view,dir+4,'cil-truncated-cli-directory');if(!rva||size<CLI_HEADER_SIZE)return{cliPresent:false};
 const cli=mapRva(rva,CLI_HEADER_SIZE,'cil-cli-header-unmapped'),cb=validateCliHeaderSize(u32(view,cli,'cil-truncated-cli-header'),size);mapRva(rva,cb,'cil-cli-header-unmapped');const metaRva=u32(view,cli+8,'cil-truncated-cli-header'),metaSize=u32(view,cli+12,'cil-truncated-cli-header');if(!metaRva||metaSize<20)fail('cil-cli-metadata-directory-invalid');
 const resRva=u32(view,cli+24,'cil-truncated-cli-header'),resSize=u32(view,cli+28,'cil-truncated-cli-header');const resources=resRva===0||resSize===0?null:{offset:mapRva(resRva,resSize,'cil-resources-directory-unmapped'),size:resSize};
 return{cliPresent:true,mapRva,metadataOffset:mapRva(metaRva,metaSize,'cil-cli-metadata-unmapped'),metadataSize:metaSize,resources};
}
export function readCilTableLayout(bytes,view,stream){range(bytes,stream.offset,stream.size,'cil-metadata-tables-out-of-bounds');if(stream.size<24)fail('cil-metadata-tables-truncated');const start=stream.offset,end=start+stream.size,heapSizes=bytes[start+6];const valid=BigInt(u32(view,start+8,'cil-metadata-tables-truncated'))|(BigInt(u32(view,start+12,'cil-metadata-tables-truncated'))<<32n);validateMetadataTableValidMask(valid);let pos=start+24;const rowCounts=new Array(64).fill(0),tableOffsets=new Array(64).fill(null),rowSizes=new Array(64).fill(0);for(let t=0;t<64;t++){if((valid&(1n<<BigInt(t)))===0n)continue;if(pos+4>end)fail('cil-metadata-row-counts-truncated');rowCounts[t]=u32(view,pos,'cil-metadata-row-counts-truncated');pos+=4}for(let t=0;t<64;t++){const rows=rowCounts[t];if(!rows)continue;const size=metadataRowSize(t,rowCounts,heapSizes);if(!Number.isSafeInteger(size)||size<1||rows>Math.floor((end-pos)/size))fail('cil-metadata-table-data-truncated');tableOffsets[t]=pos;rowSizes[t]=size;pos+=rows*size}return{rowCounts,tableOffsets,rowSizes,heapSizes,valid}}
export function readCilMetadataContext(bytes,options={}){const u8=asUint8Array(bytes),view=new DataView(u8.buffer,u8.byteOffset,u8.byteLength),pe=readCilPeLayout(u8,view);if(!pe?.cliPresent)return null;const meta=readCilMetadataStreams(u8,pe.metadataOffset,pe.metadataSize),find=name=>meta.streams.find(s=>s.name===name),tablesStream=meta.streams.find(s=>s.name==='#~'||s.name==='#-'),stringsStream=find('#Strings'),blobStream=find('#Blob'),guidStream=find('#GUID'),usStream=find('#US');if(!tablesStream)fail('cil-metadata-tables-missing');const layout=readCilTableLayout(u8,view,tablesStream),admission=options.metadataAdmission??createCilMetadataAdmission(options.metadataBudget??{});admitCilMetadataTables(admission,layout);const blobHeap=blobStream?u8.subarray(blobStream.offset,blobStream.offset+blobStream.size):null;const defs=bindCilMetadataTables(readCilDefinitions(u8,view,layout,stringsStream,blobStream,guidStream,admission),blobHeap,admission);return{version:CIL_METADATA_CONTEXT_VERSION,bytes:u8,view,pe,meta,layout,admission,stringsStream,blobStream,guidStream,usStream,blobHeap,defs};}
