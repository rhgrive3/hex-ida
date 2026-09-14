import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function runPrepass(edgeKind) {
  const words = new Uint32Array([1,2,3,4]);
  const bytes = new Uint8Array(words.buffer);
  const K = { OTHER:0, BRANCH:1, CONDBR:2, RET:3, TRAP:4 };
  const context = {
    BigInt, Number, Map, Set, Array, Math, DataView, console,
    functionStartsForRegion:()=>[],
    cancelled:()=>false,
    readRange:async(offset,length)=>bytes.slice(Number(offset),Number(offset)+length),
    yieldToQueue:async()=>{},
    Words:{
      KIND:K,
      classifyWord:(word)=>word===4 ? edgeKind : K.OTHER,
      condBranchTarget:(word)=>word===4 && edgeKind===K.CONDBR ? 0x1004n : null,
      wordTarget:(word)=>word===4 && edgeKind===K.BRANCH ? 0x1004n : null,
    },
    __noteLoopProvenanceState:(word,_kind,pc,lastWrite,values)=>{
      if (word===1) { values[0]=0x5000n; lastWrite[0]=pc; }
      if (word===3) { values[0]=null; lastWrite[0]=pc; }
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(new URL('../js/worker-loop-unconditional-fix.js', import.meta.url),'utf8');
  vm.runInContext(source,context);
  return await context.__backwardLoopEntryKills({size:16n,fileOffset:0n,vmAddr:0x1000n},'r');
}

for (const kind of [1,2]) {
  const result = await runPrepass(kind);
  assert.equal(result.cancelled,false);
  assert.deepEqual([...result.entries.get(0x1004n)],[0], kind===1 ? 'unconditional B back-edge must seed x0 kill' : 'conditional back-edge regressed');
}

const wired = fs.readFileSync(new URL('../js/worker.js',import.meta.url),'utf8');
assert.match(wired,/worker-loop-provenance-fix\.js[\s\S]*worker-loop-unconditional-fix\.js/,'#2117 overlay must load after the #1900 base prepass');
console.log('issue #2117 regression: PASS');
