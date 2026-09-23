// usage: node dec.mjs <root> <binary> <addr|all|first:N> [out.json]
import path from 'node:path'; import fs from 'node:fs'; import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';
const [root, bin, sel, out] = process.argv.slice(2);
const { openProduct } = await import(pathToFileURL(path.join(path.resolve(root),'tools/validation/public-benchmark/product-host.mjs')).href);
const product = await openProduct(path.resolve(bin));
const snapshot = await product.query.snapshot();
let addrs=[];
if (/^\d+$/.test(sel) || /^0x/.test(sel)) addrs=sel.split(',').map(Number);
else { const fns=[]; let offset=0; for(;;){const page=await product.query.functions(snapshot,{}, {offset,limit:1000}); fns.push(...(page.value??[])); if(page.page?.next==null) break; offset=page.page.next;}
  addrs=fns.map(f=>Number(f.address)); if(sel.startsWith('first:')) addrs=addrs.slice(0,Number(sel.slice(6))); }
const rows=[];
for (const a of addrs) {
  globalThis.__idStats=[];
  const t=performance.now(); let r=null, err=null;
  try { r=await product.query.decompile(snapshot,a,{profile:'fast'}); } catch(e){ err=String(e?.message||e).slice(0,200); }
  const ms=performance.now()-t; const code=typeof r?.value==='string'?r.value:(typeof r?.value?.pseudocode==='string'?r.value.pseudocode:typeof r?.value?.code==='string'?r.value.code:(typeof r?.value?.text==='string'?r.value.text:JSON.stringify(r?.value??null,(k,v)=>typeof v==='bigint'?String(v):v)));
  if(process.env.SHOWKEYS) console.log('keys', r&&Object.keys(r), r?.value&&typeof r.value==='object'&&Object.keys(r.value));
  const st=globalThis.__idStats; const idLen=st.reduce((x,y)=>x+y.len,0), idEnc=st.reduce((x,y)=>x+y.encMs,0), idHash=st.reduce((x,y)=>x+y.hashMs,0);
  if(process.env.DUMPID){const big=st.filter(x=>x.len>1e5).sort((a,b)=>b.len-a.len); console.log("big",big.length, JSON.stringify(big.slice(0,6))); const h={}; for(const x of st){const b=10**Math.floor(Math.log10(x.len+1)); h[b]=(h[b]||0)+x.len;} console.log(JSON.stringify(h));}
  rows.push({a, ms:Math.round(ms), sha:createHash('sha256').update(code).digest('hex').slice(0,16), completeness:r?.status?.completeness??null, err, id:{n:st.length,len:idLen,enc:Math.round(idEnc),hash:Math.round(idHash)}});
  console.log(JSON.stringify(rows.at(-1)));
}
if (out) fs.writeFileSync(out, JSON.stringify(rows,null,1));
await product.close();
