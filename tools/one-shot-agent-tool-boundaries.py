from pathlib import Path

p=Path('js/agent/tools.js')
s=p.read_text()
old="""  const reportedRaw = meta.offset ?? meta.pageOffset ?? meta.pagination?.offset;
  const reported = Number.isSafeInteger(Number(reportedRaw)) ? Number(reportedRaw) : null;"""
new="""  const reportedRaw = meta.offset ?? meta.pageOffset ?? meta.pagination?.offset;
  const reported = typeof reportedRaw === 'number' && Number.isSafeInteger(reportedRaw) && reportedRaw >= 0 ? reportedRaw : null;"""
if old not in s: raise SystemExit('pageRows reported offset anchor drift')
s=s.replace(old,new,1)
old="""  let coverage = Number(meta.coverage ?? meta.completeness?.coverage);
  if (!Number.isFinite(coverage)) coverage = total ? Math.min(1, (start + returned) / total) : (complete ? 1 : null);"""
new="""  const coverageRaw = meta.coverage ?? meta.completeness?.coverage;
  let coverage = typeof coverageRaw === 'number' && Number.isFinite(coverageRaw) ? coverageRaw : NaN;
  if (!Number.isFinite(coverage)) coverage = total ? Math.min(1, (start + returned) / total) : (complete ? 1 : null);"""
if old not in s: raise SystemExit('pageRows coverage anchor drift')
s=s.replace(old,new,1)
old="""  if (spec && spec.instructionId != null) {
    const id = Number(spec.instructionId);
    if (!Number.isSafeInteger(id) || id < 0) throw new AgentToolError('invalid-argument', 'instructionId must be a non-negative safe integer');"""
new="""  if (spec && spec.instructionId != null) {
    const id = spec.instructionId;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) throw new AgentToolError('invalid-argument', 'instructionId must be a non-negative safe integer');"""
if old not in s: raise SystemExit('seed instructionId anchor drift')
s=s.replace(old,new,1)
old="""  if (spec && spec.row != null) {
    const row = Number(spec.row);
    if (!Number.isSafeInteger(row) || row < 0) throw new AgentToolError('invalid-argument', 'row must be a non-negative safe integer');"""
new="""  if (spec && spec.row != null) {
    const row = spec.row;
    if (typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0) throw new AgentToolError('invalid-argument', 'row must be a non-negative safe integer');"""
if old not in s: raise SystemExit('seed row anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('tests/agent-capability-plane.mjs')
s=p.read_text()
if "import fs from 'node:fs';" not in s:
    s=s.replace("import assert from 'node:assert/strict';\n", "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { pageRows } from '../js/agent/tools.js';\n",1)
marker="const app = fakeApp();\n"
block="""// #2956/#2957: malformed tool IDs and upstream page metadata must not be coerced.
const malformedPageOffset = pageRows({ offset:['10'], results:['r10','r11','r12'] }, 1, 11);
assert.deepEqual(malformedPageOffset.results, []);
const malformedCoverage = pageRows({ results:[], total:10, complete:false, coverage:['1'] }, 10, 0);
assert.equal(malformedCoverage.coverage, 0);
const agentToolsSource = fs.readFileSync(new URL('../js/agent/tools.js', import.meta.url), 'utf8');
assert.doesNotMatch(agentToolsSource, /Number\\(spec\\.instructionId\\)/);
assert.doesNotMatch(agentToolsSource, /Number\\(spec\\.row\\)/);
assert.match(agentToolsSource, /typeof id !== 'number'/);
assert.match(agentToolsSource, /typeof row !== 'number'/);

"""
if block not in s:
    if marker not in s: raise SystemExit('agent test marker drift')
    s=s.replace(marker,block+marker,1)
p.write_text(s)
