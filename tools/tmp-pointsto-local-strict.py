from pathlib import Path
p=Path('js/analysis/pointsto/local.js')
s=p.read_text()
old="""    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? BigInt(raw) : null;
    const text = String(raw).trim();
    if (!/^[+-]?(0x[0-9a-fA-F]+|\d+)$/.test(text)) return null;
    return BigInt(text);"""
new="""    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? BigInt(raw) : null;
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!/^[+-]?(0x[0-9a-fA-F]+|\d+)$/.test(text)) return null;
    return BigInt(text);"""
if old not in s: raise SystemExit('parseInteger anchor drift')
s=s.replace(old,new,1)
old="""function widthOf(value, node) {
  const fromValue = Number(value?.machineType?.widthBits);
  if (Number.isSafeInteger(fromValue) && fromValue > 0) return fromValue;
  const fromNode = Number(node?.attributes?.widthBits);
  return Number.isSafeInteger(fromNode) && fromNode > 0 ? fromNode : null;
}"""
new="""function widthOf(value, node) {
  const fromValue = value?.machineType?.widthBits;
  if (typeof fromValue === 'number' && Number.isSafeInteger(fromValue) && fromValue > 0) return fromValue;
  const fromNode = node?.attributes?.widthBits;
  return typeof fromNode === 'number' && Number.isSafeInteger(fromNode) && fromNode > 0 ? fromNode : null;
}"""
if old not in s: raise SystemExit('widthOf anchor drift')
s=s.replace(old,new,1)
old="""function finiteWidth(widthBits) {
  const width = Number(widthBits);
  return Number.isSafeInteger(width) && width > 0 && width % 8 === 0 ? width : null;
}"""
new="""function finiteWidth(widthBits) {
  return typeof widthBits === 'number' && Number.isSafeInteger(widthBits) && widthBits > 0 && widthBits % 8 === 0 ? widthBits : null;
}"""
if old not in s: raise SystemExit('finiteWidth anchor drift')
s=s.replace(old,new,1)
repls={
"if (String(memorySsa.functionId ?? '') !== String(ir.functionId)) {":"if (typeof memorySsa.functionId !== 'string' || typeof ir.functionId !== 'string' || memorySsa.functionId !== ir.functionId) {",
"if (binding.functionId != null && String(binding.functionId) !== String(ir.functionId)) {":"if (binding.functionId != null && (typeof binding.functionId !== 'string' || typeof ir.functionId !== 'string' || binding.functionId !== ir.functionId)) {",
"if (memorySsa.snapshotId != null && String(memorySsa.snapshotId) !== String(options.snapshotId ?? 'snapshot-unbound')) {":"if (memorySsa.snapshotId != null && (typeof memorySsa.snapshotId !== 'string' || typeof (options.snapshotId ?? 'snapshot-unbound') !== 'string' || memorySsa.snapshotId !== (options.snapshotId ?? 'snapshot-unbound'))) {",
"if (binding.memorySsaBuildVersion != null && String(binding.memorySsaBuildVersion) !== String(memorySsa.buildVersion)) {":"if (binding.memorySsaBuildVersion != null && (typeof binding.memorySsaBuildVersion !== 'string' || typeof memorySsa.buildVersion !== 'string' || binding.memorySsaBuildVersion !== memorySsa.buildVersion)) {",
"if (binding.semanticIrVersion != null && String(binding.semanticIrVersion) !== String(ir.contractVersion)) {":"if (binding.semanticIrVersion != null && (typeof binding.semanticIrVersion !== 'string' || typeof ir.contractVersion !== 'string' || binding.semanticIrVersion !== ir.contractVersion)) {",
}
for old,new in repls.items():
    if old not in s: raise SystemExit('identity anchor drift: '+old[:60])
    s=s.replace(old,new,1)
p.write_text(s)

Path('tests/phase7/pointsto-local-strict-boundaries-3031-3032.test.mjs').write_text(r'''import assert from 'node:assert/strict';
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
''')
