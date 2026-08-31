import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeLocalPointsTo } from '../../js/analysis/pointsto/local.js';
import { MEMORY_SSA_BUILD_VERSION } from '../../js/semantics/memoryssa/build.js';
import { MEMORY_SSA_CONTRACT_VERSION } from '../../js/semantics/memoryssa/contract.js';

const ir={ functionId:'func-A', contractVersion:'semantic-ir-test', values:[], nodes:[] };
const ssa={ definitions:[], uses:[] };
function validMemory(){ return { functionId:'func-A', snapshotId:'snap-A', contractVersion:MEMORY_SSA_CONTRACT_VERSION, buildVersion:MEMORY_SSA_BUILD_VERSION, definitions:[], uses:[], regions:[], accessMetadata:[] }; }
function run(memorySsa, extra={}) { return analyzeLocalPointsTo(ir, null, ssa, { snapshotId:'snap-A', memorySsa, ...extra }); }

assert.equal(run({ ...validMemory(), functionId:['func-A'] }).recovery.bindingState, 'stale');
assert.equal(run({ ...validMemory(), snapshotId:['snap-A'] }).recovery.bindingState, 'stale');
assert.equal(run(validMemory(), { memorySsaBinding:{ memorySsa:validMemory(), functionId:['func-A'] } }).recovery.bindingState, 'stale');
assert.equal(run(validMemory(), { memorySsaBinding:{ memorySsa:validMemory(), memorySsaBuildVersion:[MEMORY_SSA_BUILD_VERSION] } }).recovery.bindingState, 'stale');
assert.equal(run(validMemory(), { memorySsaBinding:{ memorySsa:validMemory(), semanticIrVersion:['semantic-ir-test'] } }).recovery.bindingState, 'stale');
assert.equal(run(validMemory()).recovery.bindingState, 'current');

const source=fs.readFileSync(new URL('../../js/analysis/pointsto/local.js', import.meta.url),'utf8');
assert.ok(source.includes("if (typeof raw !== 'string') return null;"));
assert.ok(!source.includes('const text = String(raw).trim()'));
assert.ok(!source.includes('Number(value?.machineType?.widthBits)'));
assert.ok(!source.includes('const width = Number(widthBits)'));
console.log('phase7 pointsto local strict boundaries: PASS');
