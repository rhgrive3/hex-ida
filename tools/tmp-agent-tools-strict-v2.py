from pathlib import Path
p=Path('js/agent/tools.js')
s=p.read_text()
old="const reported = Number.isSafeInteger(Number(reportedRaw)) ? Number(reportedRaw) : null;"
new="const reported = typeof reportedRaw === 'number' && Number.isSafeInteger(reportedRaw) && reportedRaw >= 0 ? reportedRaw : null;"
if old not in s: raise SystemExit('reported offset anchor drift')
s=s.replace(old,new,1)
old="let coverage = Number(meta.coverage ?? meta.completeness?.coverage);\n  if (!Number.isFinite(coverage)) coverage = total ? Math.min(1, (start + returned) / total) : (complete ? 1 : null);"
new="const coverageRaw = meta.coverage ?? meta.completeness?.coverage;\n  let coverage = typeof coverageRaw === 'number' && Number.isFinite(coverageRaw) ? coverageRaw : NaN;\n  if (!Number.isFinite(coverage)) coverage = total ? Math.min(1, (start + returned) / total) : (complete ? 1 : null);"
if old not in s: raise SystemExit('coverage anchor drift')
s=s.replace(old,new,1)
old="""  if (spec && spec.instructionId != null) {
    const id = Number(spec.instructionId);
    if (!Number.isSafeInteger(id) || id < 0) throw new AgentToolError('invalid-argument', 'instructionId must be a non-negative safe integer');
    return ir.instructions.find((i) => i.id === id) || null;
  }
  if (spec && spec.row != null) {
    const row = Number(spec.row);
    if (!Number.isSafeInteger(row) || row < 0) throw new AgentToolError('invalid-argument', 'row must be a non-negative safe integer');
    return ir.instructions.find((i) => i.row === row && (!spec.op || i.op === spec.op)) || null;
  }"""
new="""  if (spec && spec.instructionId != null) {
    const id = spec.instructionId;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) throw new AgentToolError('invalid-argument', 'instructionId must be a non-negative safe integer');
    return ir.instructions.find((i) => i.id === id) || null;
  }
  if (spec && spec.row != null) {
    const row = spec.row;
    if (typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0) throw new AgentToolError('invalid-argument', 'row must be a non-negative safe integer');
    return ir.instructions.find((i) => i.row === row && (!spec.op || i.op === spec.op)) || null;
  }"""
if old not in s: raise SystemExit('seed anchor drift')
s=s.replace(old,new,1)
p.write_text(s)
Path('tests/phase10/agent-tools-strict-boundaries.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pageRows } from '../../js/agent/tools.js';
const rows=['r10','r11','r12'];
assert.deepEqual(pageRows({ offset:['10'], results:rows },1,11).results,['r10']);
assert.deepEqual(pageRows({ offset:10, results:rows },1,11).results,['r11']);
assert.notEqual(pageRows({ results:[], coverage:['1'], complete:false },10,0).coverage,1);
assert.notEqual(pageRows({ results:[], coverage:'1', complete:false },10,0).coverage,1);
assert.equal(pageRows({ results:[], coverage:0.75, complete:false },10,0).coverage,0.75);
const source=fs.readFileSync(new URL('../../js/agent/tools.js', import.meta.url),'utf8');
assert.ok(source.includes("typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0"));
assert.ok(source.includes("typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0"));
assert.ok(!source.includes('Number(spec.instructionId)'));
assert.ok(!source.includes('Number(spec.row)'));
console.log('phase10 agent tools strict boundaries: PASS');
''')
