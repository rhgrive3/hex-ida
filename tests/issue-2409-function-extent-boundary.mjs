import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SymbolIndex } from '../js/symbols.js';
import { ProgramIndex } from '../js/program.js';
import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';

const region = { id:'text', vmAddr:0x1000n, size:0x1000n, exec:true };
const unknown = new SymbolIndex({ funcs:new BigUint64Array([0x1000n,0x1100n]), regions:[region] });
assert.deepEqual(unknown.functionAt(0x1000n), { start:0x1000n, end:null, index:0 });
assert.equal(unknown.functionAt(0x1080n), null, 'padding before the next start must not acquire exact function ownership');

const program = new ProgramIndex({
  vmAddr:region.vmAddr, words:Number(region.size/4n), kindsCovered:0,
  kinds:new Uint8Array(0), callFrom:new BigUint64Array(0), callTo:new BigUint64Array(0),
}, unknown, region);
assert.deepEqual(program.functionRange(0x1000n), { start:0x1000n, end:null, region }, 'ProgramIndex must preserve unknown extent');

const image = {
  format:'elf', symbols:[], exports:[], imports:[], metadata:{ functionDiscovery:{ complete:true } },
  functions:[
    { address:0x1000n, source:'function_starts', confidence:0.99, exactFunctionStart:true, extentSource:'next-function-start', extentConfidence:0.35, extentInferred:true, size:0x100n, end:0x1100n },
    { address:0x1100n, source:'function_starts', confidence:0.99, exactFunctionStart:true },
    { address:0x1200n, source:'unwind', confidence:0.999, exactFunctionStart:true, extentSource:'unwind', extentConfidence:0.999, size:0x40n, end:0x1240n },
  ],
};
const transported = analysisFromBinaryImage(image);
assert.equal(transported.funcEnds[0], 0n, 'heuristic next-start extent must not cross the platform transport boundary');
assert.equal(transported.funcEnds[1], 0n);
assert.equal(transported.funcEnds[2], 0x1240n, 'validated unwind extent should remain available');
const transportedIndex = new SymbolIndex({ ...transported, regions:[region] });
assert.equal(transportedIndex.functionAt(0x1080n), null);
assert.deepEqual(transportedIndex.functionAt(0x1230n), { start:0x1200n, end:0x1240n, index:2 });

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
assert.match(appSource, /if\(fn\.end==null\)return \{ok:false,reason:'function-end-unproven'/);
assert.doesNotMatch(appSource, /fn\.end!=null\?BigInt\(fn\.end\):regionEnd/);
const adapterSource = await readFile(new URL('../js/analysis/query/app-adapter.js', import.meta.url), 'utf8');
assert.match(adapterSource, /if \(fn\.end == null\) return \{ ok:false, reason:'function-end-unproven'/);
assert.doesNotMatch(adapterSource, /fn\.end == null \? regionEnd : BigInt\(fn\.end\)/);

console.log('issue #2409 function extent boundary: PASS');
