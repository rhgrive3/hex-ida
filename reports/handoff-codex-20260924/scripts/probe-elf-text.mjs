import { readFile } from 'node:fs/promises';
import { parseSourceRanges } from '/mnt/workspace/hex-ida/js/binary/source-reader.js';
import { parseELF } from '/mnt/workspace/hex-ida/js/binary/index.js';
const bytes = new Uint8Array(await readFile(process.argv[2]));
const src={ size:BigInt(bytes.length), maxReadLength: 64*1024*1024,
  async read(o,l){ return bytes.subarray(Number(o),Number(o)+l); },
  async readExactly(o,l){ return bytes.slice(Number(o),Number(o)+l); } };
const TEXT0=0x568640, TEXT1=0x568640+0xd00b84;
let shown=0;
const wrapped=(sp,opts)=>{ try { return parseELF(sp,opts);} catch(e){ if(e.code==='BINARY_SOURCE_RANGE_MISSING'){ const o=Number(e.offset); if(o>=TEXT0&&o<TEXT1&&shown<3){shown++; console.log('TEXT MISS @0x'+o.toString(16),'len',Number(e.length)); console.log(e.stack.split('\n').slice(1,14).join('\n'));} } throw e; } };
try { await parseSourceRanges(src, wrapped, {}, { pageSize:64*1024, maxPageSize:2*1024*1024, maxCachedBytes: 64*1024*1024, maxReads:4096 }); console.log('ok'); } catch(e){ console.log('ERR',e.message); }
