import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');
const requirements = fs.readFileSync('tests/oracle-requirements.txt', 'utf8');

function section(start, end) {
  const a = workflow.indexOf(start);
  assert.ok(a >= 0, `missing workflow section: ${start}`);
  const b = end ? workflow.indexOf(end, a + start.length) : workflow.length;
  assert.ok(!end || b > a, `missing workflow section terminator: ${end}`);
  return workflow.slice(a, b);
}

const preflight = section('\n  preflight:', '\n  prepare:');
const prepare = section('\n  prepare:', '\n  measure:');
const measure = section('\n  measure:', '\n  accuracy:');
const aggregate = section('\n  accuracy:');

// The gate remains required, pinned, and fail-closed.
for (const fixture of ['battlecats', 'YWP', 'TsumTsum']) {
  assert.ok(prepare.includes(`fixture: ${fixture}`), `${fixture} must participate in oracle/fixture preparation`);
}
for (const variable of [
  'HEX_FIXTURE_BATTLECATS_URL',
  'HEX_FIXTURE_TSUMTSUM_URL',
  'HEX_FIXTURE_YWP_URL',
]) assert.ok(workflow.includes(variable), `${variable} must participate in the required gate`);
assert.match(preflight, /name:\s*Require all real fixture URLs[\s\S]*test -n "\$HEX_FIXTURE_BATTLECATS_URL"[\s\S]*test -n "\$HEX_FIXTURE_TSUMTSUM_URL"[\s\S]*test -n "\$HEX_FIXTURE_YWP_URL"/);
assert.doesNotMatch(workflow, /continue-on-error:\s*true/,
  'required real-binary validation must never be made advisory');
assert.match(workflow, /push:\s*\n\s*branches:\s*\[[^\]]*\bmain\b[^\]]*\]/,
  'main must continue seeding exact caches');
assert.match(workflow, /cancel-in-progress:\s*true/,
  'superseded PR revisions should stop wasting runners');

// Pinned oracle authority remains unchanged.
assert.match(requirements, /^lief==1\.0\.0$/m, 'LIEF oracle version must remain pinned');
assert.match(requirements, /^capstone==5\.0\.9$/m, 'Capstone oracle version must remain pinned');
assert.match(workflow, /ORACLE_PYTHON_VERSION:\s*'3\.12\.13'/,
  'Python oracle runtime must remain exact');
assert.match(workflow, /FIXTURE_SOURCE_REV:\s*bd7bd61d093592d07fdd9e9b14a859e19dd4c3a9/,
  'real fixture source revision must remain pinned');
assert.match(prepare, /max-parallel:\s*3/,
  'fixture/oracle preparation should remain bounded to the three real fixtures');
for (const input of [
  'tests/fixtures/real-binaries.json',
  'tests/oracle.py',
  'tests/oracle-cfg-normalize.py',
  'tests/oracle-requirements.txt',
]) assert.ok(prepare.includes(input), `oracle cache key must include ${input}`);
assert.match(prepare, /cross-binary-oracle-v3-/);
assert.match(prepare, /actions\/cache\/restore@v4/);
assert.match(prepare, /actions\/cache\/save@v4/);
assert.match(prepare, /python tests\/oracle\.py/);
assert.match(prepare, /python tests\/oracle-cfg-normalize\.py/);
assert.match(prepare, /name:\s*Publish exact oracle for this run[\s\S]*if-no-files-found:\s*error/,
  'each target must publish a validated exact oracle');

// Fixture downloads are exact and reusable across independent measurement runners.
assert.match(prepare, /cross-binary-fixture-v1-/);
assert.match(prepare, /FIXTURE_SOURCE_REV/);
assert.match(prepare, /node scripts\/fetch-real-fixtures\.mjs "\$\{\{ matrix\.target\.fixture \}\}" --check/);
assert.match(measure, /name:\s*Restore prepared fixture cache/);
assert.match(measure, /name:\s*Fetch pinned fixture if prepared cache is unavailable/,
  'measurement must fail safely back to the pinned source if the prepared cache is unexpectedly absent');
assert.doesNotMatch(measure, /restore-keys:/,
  'approximate fixture/result cache fallback must not launder stale evidence');

// Scheduling topology: the two historical 4 GiB commands and canonical pseudoc
// set are preserved, but independent work gets independent hosted runners.
assert.match(measure, /max-parallel:\s*12/,
  'measurement fanout must be bounded to twelve hosted runners');
assert.doesNotMatch(measure, /max-parallel:\s*(?:1[3-9]|[2-9]\d|[1-9]\d{2,})/,
  'cross-binary measurement must not starve the rest of repository CI');
const targetOccurrences = (measure.match(/\n\s+- name:\s*(?:BattleCats|YWP|TsumTsum)\n\s+fixture:/g) || []).length;
assert.equal(targetOccurrences, 3, 'measurement matrix must contain exactly three real targets');

const nonPseudoc0 = 'sections,funcs,funcs-guess,disasm,kinds,calls,refs,imports,objc,selstub,pinpoint';
const nonPseudoc1 = 'strings,xrefs,funcname,selffield,role,apimeaning,summary,expr,formula,pinpoint-partial';
for (const [name, only] of [['nonpseudoc-0', nonPseudoc0], ['nonpseudoc-1', nonPseudoc1]]) {
  assert.match(measure, new RegExp(`name: ${name}[\\s\\S]*?only: ${only}`),
    `${name} must preserve the current feature set`);
}
for (let shard = 0; shard < 4; shard++) {
  assert.match(measure, new RegExp(`name: pseudoc-${shard}[\\s\\S]*?shardIndex: ${shard}[\\s\\S]*?shardCount: 4`),
    `pseudoc-${shard} must be one exact quarter of the canonical pseudoc sample set`);
}
assert.equal((measure.match(/\n\s+- name:\s+(?:nonpseudoc-[01]|pseudoc-[0-3])\n/g) || []).length, 6,
  'each fixture must have exactly six raw measurement partitions');
assert.match(workflow, /LOCAL_PSEUDOC_WORKERS:\s*2/,
  'each pseudocode shard must keep the audited two-worker memory envelope');
assert.match(workflow, /PSEUDOC_SHARD_COUNT:\s*4/);
assert.equal(
  (measure.match(/node --max-old-space-size=4096 tests\/accuracy\.mjs/g) || []).length,
  1,
  'one matrix step must launch exactly one 4 GiB non-pseudocode process per partition runner',
);
assert.doesNotMatch(measure, /tests\/accuracy\.mjs[^\n]*&|pids\+=\("\$!"\)/,
  '4 GiB accuracy processes must never overlap inside one runner');
assert.match(measure, /node tests\/accuracy-pseudoc-parallel\.mjs/);
assert.match(measure, /--workers="\$LOCAL_PSEUDOC_WORKERS"/);
assert.match(measure, /--shard-index="\$\{\{ matrix\.partition\.shardIndex \}\}"/);
assert.match(measure, /--shard-count="\$\{\{ matrix\.partition\.shardCount \}\}"/);

// Exact caches are partition-scoped. Production changes are still conservatively
// hashed across the real analysis graph; only proven scheduling/scorer domains
// are separated. No broad restore key may reuse stale output.
assert.match(measure, /accuracy-result-v8-/,
  'optimized topology must use a fresh result-cache generation');
assert.match(measure, /COMMON_HASH:\s*\$\{\{ hashFiles\('js\/\*\*'/,
  'production JS changes must conservatively invalidate measured results');
assert.match(measure, /NONPSEUDOC_HASH:/);
assert.match(measure, /PSEUDOC_HASH:/);
assert.match(measure, /CONTRACT="\$\{PARTITION_KIND\}:\$\{PARTITION_ONLY\}:heap=4096"/);
assert.match(measure, /CONTRACT="\$\{PARTITION_KIND\}:\$\{SHARD_INDEX\}:\$\{SHARD_COUNT\}:workers=\$\{LOCAL_PSEUDOC_WORKERS\}"/);
assert.match(measure, /matrix\.target\.name \}\}-\$\{\{ matrix\.partition\.name \}\}-\$\{DIGEST\}/,
  'cache identity must include both target and raw partition');
assert.doesNotMatch(measure, /\.github\/workflows\/cross-binary-accuracy\.yml[^\n]*\}\}/,
  'pure workflow topology edits must not invalidate otherwise exact measurement results');
assert.doesNotMatch(measure, /restore-keys:/,
  'result caches must remain exact-only');

// Every newly measured output is staged, validated, then atomically published.
assert.match(measure, /tmp="\$\{output\}\.tmp"/);
assert.match(measure, /accuracy-result-validate\.mjs "\$tmp" --expect=/);
assert.match(measure, /mv "\$tmp" "\$output"/);
assert.match(measure, /name:\s*Validate restored partition result[\s\S]*accuracy-result-validate\.mjs/,
  'cache hits must be structurally revalidated before reuse');
assert.match(measure, /name:\s*Save exact partition result cache[\s\S]*if:\s*success\(\)/,
  'failed/partial output must never enter the exact cache');
assert.match(measure, /name:\s*Upload validated partition result[\s\S]*if:\s*success\(\)[\s\S]*if-no-files-found:\s*error/,
  'only validated complete partitions may be published');

// The aggregate remains fail-closed and proves that sharding did not remove or
// duplicate any feature before applying the exact same score/baseline gates.
assert.match(aggregate, /if:\s*always\(\)/);
assert.match(aggregate, /needs:\s*\[preflight, prepare, measure\]/);
for (const dep of ['PREFLIGHT_RESULT', 'PREPARE_RESULT', 'MEASURE_RESULT']) {
  assert.ok(aggregate.includes(dep), `${dep} must be inspected by the final fail-closed gate`);
}
assert.match(aggregate, /exit 1/);
assert.match(aggregate, /pattern:\s*accuracy-part-\*/);
assert.match(aggregate, /for target in BattleCats YWP TsumTsum/);
assert.match(aggregate, /for shard in 0 1 2 3/);
assert.equal((aggregate.match(/node tests\/accuracy-pseudoc-shard-merge\.mjs/g) || []).length, 3,
  'one exact pseudoc reconstruction is required for each real target');
assert.equal((aggregate.match(/node tests\/accuracy-merge\.mjs accuracy-(?:BattleCats|YWP|TsumTsum)\.json/g) || []).length, 3,
  'each target must merge to the canonical complete feature ordering');
assert.match(aggregate, /node tests\/accuracy-gate\.mjs/,
  'existing cross-binary score floors must remain authoritative');
assert.match(aggregate, /node tools\/benchmark\/accuracy-report\.mjs --output=accuracy-baseline-report\.json/);
assert.match(aggregate, /node tools\/benchmark\/compare\.mjs --accuracy=accuracy-baseline-report\.json/);
assert.match(aggregate, /github\.event_name == 'workflow_dispatch'[\s\S]*npm test/,
  'manual release validation must retain the broad core suite');

// Contract/self-tests run before expensive hosted-runner fanout.
assert.match(preflight, /issue-497-cross-binary-workflow\.mjs/);
assert.match(preflight, /accuracy-merge\.mjs --self-test/);
assert.match(preflight, /accuracy-pseudoc-shard-merge\.mjs --self-test/);
assert.match(preflight, /accuracy-pseudoc-shard\.test\.mjs/);
assert.match(preflight, /accuracy-result-validate\.mjs --self-test/);
assert.match(preflight, /npm run lint/);

console.log('issue #497/#2484/#3123 cross-binary workflow gate regression passed');
