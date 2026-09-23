import { readFile } from 'node:fs/promises';
import { parseSourceRanges } from '/mnt/workspace/wt-openmw/js/binary/source-reader.js';
import { parseELF } from '/mnt/workspace/wt-openmw/js/binary/index.js';
const bytes = new Uint8Array(await readFile(process.argv[2]));
const reads=[];
const src={ size:BigInt(bytes.length), maxReadLength: 64*1024*1024,
  async read(o,l){ return bytes.subarray(Number(o),Number(o)+l); },
  async readExactly(o,l){ reads.push([Number(o),l]); return bytes.slice(Number(o),Number(o)+l); } };
let passes=0;
const t=performance.now();
const wrapped=(sp,opts)=>{passes++; const t0=performance.now(); try { return parseELF(sp,opts);} finally { if(passes%50===0) console.log('pass',passes,'ms',(performance.now()-t0).toFixed(0)); } };
try {
 const img = await parseSourceRanges(src, wrapped, {}, { pageSize:64*1024, maxPageSize:2*1024*1024, maxCachedBytes: Number(process.argv[3]||16*1024*1024), maxReads:4096 });
 console.log("ok", img.metadata.aarch64PltResolver, img.metadata.sourceReads, 'syms', img.symbols.length, 'fns', img.functions.length);
} catch(e){ console.log('ERR', e.message); }
console.log('ms', (performance.now()-t).toFixed(0), 'passes', passes, 'reads', reads.length);
// summarize reads by section
const secs=[['dynsym',0x4b718,0xe0ef8],['dynstr',0x12c610,0x2a7166],['rela.dyn',0x3e6650,0x16e498],['text',0x568640,0xd00b84],['rodata',0x12691e0,0xa62bb],['eh_frame_hdr',0x130f49c,0x42024],['eh_frame',0x13514c0,0x1e8c74],['gcc_except',0x153a134,0xa56e8],['data.rel.ro',0x15eb550,0x9f718],['gnu.hash',0x2d0,0x4b448],['version',0x3d3776,0x12bea]];
const agg={};
for(const [o,l] of reads){ const s=secs.find(([n,so,sl])=>o>=so&&o<so+sl); const k=s?s[0]:('0x'+o.toString(16)); agg[k]=(agg[k]||0)+l; }
console.log(Object.fromEntries(Object.entries(agg).map(([k,v])=>[k,(v/1048576).toFixed(2)+'MB'])));
