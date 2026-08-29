import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');
const requirements = fs.readFileSync('tests/oracle-requirements.txt', 'utf8');
const measure = workflow.slice(workflow.indexOf('\n  measure:'), workflow.indexOf('\n  accuracy:'));
const aggregate = workflow.slice(workflow.indexOf('\n  accuracy:'));

assert.ok(measure.length > 0, 'measurement matrix must exist');
assert.ok(aggregate.length > 0, 'final fail-closed aggregate must exist');
for (const variable of ['HEX_FIXTURE_BATTLECATS_URL', 'HEX_FIXTURE_TSUMTSUM_URL', 'HEX_FIXTURE_YWP_URL']) {
  assert.ok(workflow.includes(variable), `${variable} must remain required`);
}
for (const fixture of ['battlecats', 'YWP', 'TsumTsum']) {
  assert.ok(measure.includes(`fixture: ${fixture}`), `${fixture} must participate`);
}
for (const lane of ['core-a', 'core-b', 'pseudoc-0', 'pseudoc-1', 'pseudoc-2', 'pseudoc-3']) {
  assert.ok(measure.includes(`name: ${lane}\n`), `${lane} lane must exist`);
}
assert.match(measure, /max-parallel:\s*18/, 'all 18 isolated proof lanes must be eligible to start immediately');
assert.match(measure, /fail-fast:\s*false/, 'one lane failure must not hide diagnostics from other targets');
assert.match(workflow, /LOCAL_PSEUDOC_WORKERS:\s*2/, 'each pseudoc shard must remain below hosted-runner memory pressure');
assert.match(measure, /--shard-count=4/, 'all canonical pseudoc samples must be split across four shards');
for (const shard of [0, 1, 2, 3]) assert.ok(measure.includes(`shard: ${shard}`), `pseudoc shard ${shard} missing`);
assert.match(aggregate, /accuracy-pseudoc-shard-merge\.mjs[\s\S]*pseudoc-0[\s\S]*pseudoc-1[\s\S]*pseudoc-2[\s\S]*pseudoc-3/,
  'all four pseudoc shards must be reassembled before scoring');

const expectedFeatures = [
  'sections','funcs','funcs-guess','disasm','kinds','calls','refs','imports','objc','selstub',
  'pinpoint','strings','xrefs','funcname','selffield','role','apimeaning','summary','expr','formula','pinpoint-partial',
];
for (const feature of expectedFeatures) assert.ok(measure.includes(feature), `feature denominator shrank: ${feature}`);
assert.match(aggregate, /accuracy-merge\.mjs[\s\S]*core-a[\s\S]*core-b[\s\S]*pseudoc/,
  'all non-pseudoc and pseudoc lanes must feed the complete target result');
assert.match(aggregate, /node tests\/accuracy-gate\.mjs/, 'existing score floors remain authoritative');
assert.match(aggregate, /needs:\s*\[preflight, measure\]/, 'aggregate must fail closed on all proof lanes');
assert.match(aggregate, /test "\$MEASURE_RESULT" = success/, 'failed or cancelled measurement must block publication');

assert.match(requirements, /^lief==1\.0\.0$/m, 'LIEF oracle version must remain pinned');
assert.match(requirements, /^capstone==5\.0\.9$/m, 'Capstone oracle version must remain pinned');
assert.match(workflow, /ORACLE_PYTHON_VERSION:\s*'3\.12\.13'/, 'oracle Python runtime must remain exact');
const oracleKey = measure.slice(measure.indexOf('name: Build exact oracle cache key'), measure.indexOf('name: Restore exact oracle cache'));
for (const input of ['tests/fixtures/real-binaries.json','tests/oracle.py','tests/oracle-cfg-normalize.py','tests/oracle-requirements.txt']) {
  assert.ok(oracleKey.includes(input), `oracle key missing ${input}`);
}
assert.match(measure, /actions\/cache\/restore@v4/, 'exact caches must be restored before recomputation');
assert.match(measure, /accuracy-result-v8-/, 'lane result cache generation must be fresh');
assert.match(measure, /temporary="\$\{output\}\.tmp"/, 'lane results must be built atomically');
assert.match(measure, /accuracy-result-validate\.mjs "\$temporary"/, 'lane results must be structurally validated before publication');
assert.match(measure, /mv "\$temporary" "\$output"/, 'only validated lane output may be published');
assert.match(measure, /name:\s*Upload validated lane result[\s\S]*if:\s*success\(\)[\s\S]*if-no-files-found:\s*error/,
  'partial or missing proof artifacts must fail closed');
assert.match(workflow, /cancel-in-progress:\s*true/, 'stale accuracy runs must release runner capacity');

console.log('issue #497 cross-binary workflow gate regression passed');
