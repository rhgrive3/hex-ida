import assert from 'node:assert/strict';
import { analyzeLocalPointsTo } from '../../js/analysis/pointsto/local.js';
import { MEMORY_SSA_BUILD_VERSION } from '../../js/semantics/memoryssa/build.js';
import { MEMORY_SSA_CONTRACT_VERSION } from '../../js/semantics/memoryssa/contract.js';
import { buildFixture } from './corpus/fixtures.mjs';

const ir={ functionId:'func-A', contractVersion:'semantic-ir-test', values:[], nodes:[] };
const ssa={ definitions:[], uses:[] };
function validMemory(){ return { functionId:'func-A', snapshotId:'snap-A', contractVersion:MEMORY_SSA_CONTRACT_VERSION, buildVersion:MEMORY_SSA_BUILD_VERSION, definitions:[], uses:[], regions:[], accessMetadata:[] }; }
function run(memorySsa, extra={}) { return analyzeLocalPointsTo(ir, null, ssa, { snapshotId:'snap-A', memorySsa, ...extra }); }

// #3032: MemorySSA binding identity is strict string identity, never String coercion.
assert.equal(run({ ...validMemory(), functionId:['func-A'] }).recovery.bindingState, 'stale');
assert.equal(run({ ...validMemory(), snapshotId:['snap-A'] }).recovery.bindingState, 'stale');
assert.equal(run(validMemory(), { memorySsaBinding:{ memorySsa:validMemory(), functionId:['func-A'] } }).recovery.bindingState, 'stale');
assert.equal(run(validMemory(), { memorySsaBinding:{ memorySsa:validMemory(), memorySsaBuildVersion:[MEMORY_SSA_BUILD_VERSION] } }).recovery.bindingState, 'stale');
assert.equal(run(validMemory(), { memorySsaBinding:{ memorySsa:validMemory(), semanticIrVersion:['semantic-ir-test'] } }).recovery.bindingState, 'stale');
assert.equal(run(validMemory()).recovery.bindingState, 'current');

function analyzeStackDisjointWithConstant(candidate) {
  const built = buildFixture('stack-disjoint');
  const mutatedIr = structuredClone(built.ir);
  const value = mutatedIr.values.find((item) => item.id === 'c8');
  const node = mutatedIr.nodes.find((item) => item.id === 'node_c8');
  value.metadata.constant = candidate;
  node.attributes.constant = candidate;
  return analyzeLocalPointsTo(mutatedIr, built.cfg, built.ssa);
}

function assertExactOffset(set, offset) {
  assert.equal(set.top, false, `expected finite points-to set at offset ${offset}`);
  assert.ok(set.targets.some((target) => target.offsetRange?.exact === true
    && target.offsetRange.min === offset && target.offsetRange.max === offset),
  `missing exact offset ${offset}`);
}

function assertNoExactOffset(set, offset) {
  assert.ok(set.top || !set.targets.some((target) => target.offsetRange?.exact === true
    && target.offsetRange.min === offset && target.offsetRange.max === offset),
  `malformed constant minted exact offset ${offset}`);
}

// #3031: approved primitive constants preserve the existing exact-offset semantics.
assertExactOffset(analyzeStackDisjointWithConstant(8).pointsTo.get('p8'), 8n);
assertExactOffset(analyzeStackDisjointWithConstant(8n).pointsTo.get('p8'), 8n);
assertExactOffset(analyzeStackDisjointWithConstant({ value:'8', widthBits:64 }).pointsTo.get('p8'), 8n);

// #3031: structured/coercible values must never be laundered into exact integer evidence.
for (const malformed of [
  ['8'],
  [8],
  true,
  false,
  { value:['8'] },
  { value:{ toString(){ return '8'; } } },
  { value:{ valueOf(){ return 8; } } },
]) {
  assertNoExactOffset(analyzeStackDisjointWithConstant(malformed).pointsTo.get('p8'), 8n);
}

console.log('phase7 pointsto local strict boundaries: PASS');
