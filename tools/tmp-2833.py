from pathlib import Path
p=Path('js/analyze.js')
s=p.read_text()
old="""      if (/^stp?$/.test(b) || b === 'stp' || b === 'str') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem && mem.base && mem.base.cls === 'sp') {
          res.stackAccess++;
          if (mem.mode === 'pre' && mem.disp && mem.disp.value != null && mem.disp.value < 0n) res.frameBytes += Number(-mem.disp.value);
        }
      }
      if (b === 'ldr' || b === 'ldp' || b === 'ldur') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem && mem.base && mem.base.cls === 'sp') res.stackAccess++;
      }"""
new="""      if (catg === 'load' || catg === 'store') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem && mem.base && mem.base.cls === 'sp') {
          res.stackAccess++;
          if (catg === 'store' && mem.mode === 'pre' && mem.disp && mem.disp.value != null && mem.disp.value < 0n) {
            res.frameBytes += Number(-mem.disp.value);
          }
        }
      }"""
if old not in s: raise SystemExit('analyze stack anchor drift')
p.write_text(s.replace(old,new,1))
Path('tests/issue-2833-stack-access-family.mjs').write_text(r'''import assert from 'node:assert/strict';
import { analyzeFunction } from '../js/analyze.js';

async function run(mn,ops){
  const backend={fetchChunk:async()=>({mn:[mn],ops:[ops],bytes:new Uint8Array(4)})};
  const region={id:'r',vmAddr:0n,size:4n};
  return analyzeFunction(backend,region,0,0,null,null,{maxRows:1});
}
for (const [mn,ops,kind] of [
  ['strb','w0, [sp]','store'],['strh','w0, [sp]','store'],['stur','x0, [sp]','store'],['stnp','x0, x1, [sp]','store'],
  ['ldrb','w0, [sp]','load'],['ldrh','w0, [sp]','load'],['ldur','x0, [sp]','load'],['ldnp','x0, x1, [sp]','load'],
]){
  const r=await run(mn,ops);
  assert.equal(r.stackAccess,1,mn);
  assert.equal(r[kind==='store'?'stores':'loads'],1,mn);
}
assert.equal((await run('strb','w0, [x1]')).stackAccess,0);
const pre=await run('str','x0, [sp, #-16]!');
assert.equal(pre.stackAccess,1);
assert.equal(pre.frameBytes,16);
console.log('issue-2833-stack-access-family: PASS');
''')
