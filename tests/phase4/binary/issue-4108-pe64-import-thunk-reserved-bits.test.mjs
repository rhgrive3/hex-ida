import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDelayImports, parseImports } from '../../../js/binary/pe-loader.js';
import { ByteView } from '../../../js/binary/reader.js';

const BASE=0x140000000n, DIRECTORY_RVA=0x1000, THUNK_RVA=0x1040, IAT_RVA=0x1050, LIBRARY_RVA=0x1060, HMOD_RVA=0x1070;
function ascii(bytes,off,s){bytes.set(Buffer.from(`${s}\0`,'ascii'),off);}
function fixture({delay=false, raw, highRva=null}){
  const bytes=new Uint8Array(0x240), view=new DataView(bytes.buffer);
  const sections=[{name:'.idata',address:BASE+0x1000n,size:0x1000n,fileOffset:0n,fileSize:0x100n,perms:{read:true,write:true,execute:false}}];
  if(highRva!=null){const page=Math.floor(highRva/0x1000)*0x1000;sections.push({name:'.high',address:BASE+BigInt(page),size:0x1000n,fileOffset:0x100n,fileSize:0x100n,perms:{read:true,write:false,execute:false}});}
  const image={bits:64,imageBase:BASE,sections,segments:[],metadata:{},warnings:[],libraries:[],imports:[],functions:[]};
  if(delay){view.setUint32(0,1,true);view.setUint32(4,LIBRARY_RVA,true);view.setUint32(8,HMOD_RVA,true);view.setUint32(12,IAT_RVA,true);view.setUint32(16,THUNK_RVA,true);}else{view.setUint32(0,THUNK_RVA,true);view.setUint32(12,LIBRARY_RVA,true);view.setUint32(16,IAT_RVA,true);}
  ascii(bytes,0x60,'reserved.dll'); view.setBigUint64(0x40,BigInt(raw),true); view.setBigUint64(0x48,0n,true); view.setBigUint64(0x50,0n,true); view.setBigUint64(0x58,0n,true);
  if(highRva!=null){const off=0x100+(highRva&0xfff);view.setUint16(off,7,true);ascii(bytes,off+2,'NamedApi');}
  const reader=new ByteView(bytes,{littleEndian:true}); if(delay)parseDelayImports(reader,{rva:DIRECTORY_RVA,size:64},image);else parseImports(reader,{rva:DIRECTORY_RVA,size:40},image); return image;
}
function rejected(image,reason){assert.equal(image.imports.length,0);assert.equal(image.metadata.peMetadata.complete,false);assert.ok(image.metadata.peMetadata.reasons.includes(reason),image.metadata.peMetadata.reasons.join(','));}
test('PE32+ name import rejects reserved bit31 even when mapped (#4108)',()=>{const r=0x80001020;rejected(fixture({raw:BigInt(r),highRva:r}),'imports-partial');});
test('PE32+ name import preserves bit30 as top valid RVA bit (#4108)',()=>{const r=0x40001020,i=fixture({raw:BigInt(r),highRva:r});assert.equal(i.imports.length,1);assert.equal(i.imports[0].name,'NamedApi');});
test('PE32+ ordinal import rejects reserved bit16 (#4108)',()=>rejected(fixture({raw:0x800000000001002an}),'imports-partial'));
test('PE32+ canonical ordinal remains valid (#4108)',()=>{const i=fixture({raw:0x800000000000002an});assert.equal(i.imports.length,1);assert.equal(i.imports[0].ordinal,42);});
test('PE32+ RVA delay import rejects reserved bit31 (#4108)',()=>{const r=0x80001020;rejected(fixture({delay:true,raw:BigInt(r),highRva:r}),'delay-imports:malformed-thunk');});
test('PE32+ RVA delay import preserves bit30 (#4108)',()=>{const r=0x40001020,i=fixture({delay:true,raw:BigInt(r),highRva:r});assert.equal(i.imports.length,1);assert.equal(i.imports[0].name,'NamedApi');});
test('PE32+ delay ordinal rejects reserved bit16 (#4108)',()=>rejected(fixture({delay:true,raw:0x800000000001002an}),'delay-imports:malformed-thunk'));

test('all PE32+ ordinal reserved bits 16..62 fail closed in import and delay-import paths (#4108)', () => {
  for (let bit = 16n; bit <= 62n; bit++) {
    const raw = 0x800000000000002an | (1n << bit);
    rejected(fixture({ raw }), 'imports-partial');
    rejected(fixture({ delay: true, raw }), 'delay-imports:malformed-thunk');
  }
});
