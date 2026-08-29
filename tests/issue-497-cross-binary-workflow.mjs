import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');
const requirements = fs.readFileSync('tests/oracle-requirements.txt', 'utf8');
const measure = workflow.slice(workflow.indexOf('\n  measure:'), workflow.indexOf('\n  accuracy:'));
const aggregate = workflow.slice(workflow.indexOf('\n  accuracy:'));

assert.ok(measure.length > 0, 'bounded measurement matrix must exist');
assert.ok(aggregate.length > 0, 'final fail-closed aggregate must exist');
for (const variable of ['HEX_FIXTURE_BATTLECATS_URL', 'HEX_FIXTURE_TSUMTSUM_URL', 'HEX_FIXTURE_YWP_URL']) {
  assert.ok(workflow.includes(variable), `${variable} must remain required`);
}
for (const fixture of ['battlecats', 'YWP', 'TsumTsum']) {
  assert.ok(measure.includes(`fixture: ${fixture}`), `${fixture} must participate`);
}

assert.match(measure, /lane:\s*\[features, pseudoc\]/, 'each target must retain complete feature and pseudoc lanes');
assert.match(measure, /max-parallel:\s*6/, 'hosted fanout must remain bounded to six measurement jobs');
assert.doesNotMatch(measure, /max-parallel:\s*(?:1[0-9]|[2-9][0-9])/, 'high hosted-runner fanout must not return');
assert.match(measure, /fail-fast:\s*false/, 'one target failure must not hide diagnostics from the others');
assert.match(workflow, /LOCAL_PSEUDOC_WORKERS:\s*2/, 'pseudoc must stay within hosted-runner memory pressure');
assert.match(measure, /--shard-index=0 --shard-count=1/, 'the pseudoc lane must evaluate the full canonical sample denominator');
assert.match(measure, /--max-old-space-size=2800/, 'feature subprocesses must have an explicit bounded heap');
assert.match(measure, /run_feature 0[\s\S]*run_feature 1[\s\S]*wait "\$p0"[\s\S]*wait "\$p1"/,
  'feature work must use bounded runner-local parallelism instead of hosted-job fanout');

const expectedFeatures = [
  'sections','funcs','funcs-guess','disasm','kinds','calls','refs','imports','objc','selstub',
  'pinpoint','strings','xrefs','funcname','selffield','role','apimeaning','summary','expr','formula','pinpoint-partial',
];
for (const feature of expectedFeatures) assert.ok(measure.includes(feature), `feature denominator shrank: ${feature}`);
assert.match(aggregate, /accuracy-merge\.mjs[\s\S]*features\.json[\s\S]*pseudoc\.json/,
  'complete features and pseudoc results must feed every target result');
assert.match(aggregate, /node tests\/accuracy-gate\.mjs/, 'existing score floors remain authoritative');
assert.match(aggregate, /needs:\s*\[measure\]/, 'aggregate must fail closed on every measurement lane');
assert.match(aggregate, /test "\$MEASURE_RESULT" = success/, 'failed or cancelled measurement must block publication');

assert.match(requirements, /^lief==1\.0\.0$/m, 'LIEF oracle version must remain pinned');
assert.match(requirements, /^capstone==5\.0\.9$/m, 'Capstone oracle version must remain pinned');
assert.match(workflow, /ORACLE_PYTHON_VERSION:\s*'3\.12\.13'/, 'oracle Python runtime must remain exact');
for (const input of ['tests/fixtures/real-binaries.json','tests/oracle.py','tests/oracle-cfg-normalize.py','tests/oracle-requirements.txt']) {
  assert.ok(measure.includes(input), `oracle cache identity missing ${input}`);
}
assert.match(measure, /actions\/cache\/restore@v4/, 'exact caches must be restored before recomputation');
assert.match(measure, /accuracy-result-v9-/, 'lane result cache generation must match this layout');
assert.match(measure, /accuracy-result-validate\.mjs "\$output\.tmp"/, 'lane results must be structurally validated before publication');
assert.match(measure, /mv "\$output\.tmp" "\$output"/, 'only validated atomic lane output may be published');
assert.match(measure, /name:\s*Upload validated exact lane[\s\S]*if:\s*success\(\)[\s\S]*if-no-files-found:\s*error/,
  'partial or missing proof artifacts must fail closed');
assert.match(workflow, /cancel-in-progress:\s*true/, 'stale accuracy runs must release runner capacity');

console.log('issue #497 cross-binary workflow gate regression passed');
