import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');
const requirements = fs.readFileSync('tests/oracle-requirements.txt', 'utf8');
const measure = workflow.slice(workflow.indexOf('\n  measure:'), workflow.indexOf('\n  accuracy:'));
const aggregate = workflow.slice(workflow.indexOf('\n  accuracy:'));

assert.ok(measure.length > 0, 'fixture measurement matrix must exist');
assert.ok(aggregate.length > 0, 'final fail-closed accuracy aggregate must exist');

const detect = measure.indexOf('name: Detect real fixture configuration');
const requireAll = measure.indexOf('name: Require all real fixture URLs');
assert.ok(detect >= 0, 'fixture detection step must exist in each target runner');
assert.ok(requireAll > detect, 'fail-closed requirement must run after detection');
const failClosedGate = measure.slice(requireAll, measure.indexOf('\n\n      - name: Build exact oracle cache key', requireAll));
assert.match(failClosedGate, /if:\s*steps\.fixtures\.outputs\.enabled\s*!=\s*'true'/);
assert.match(failClosedGate, /exit 1/);
assert.doesNotMatch(failClosedGate, /continue-on-error:\s*true/);

for (const variable of [
  'HEX_FIXTURE_BATTLECATS_URL',
  'HEX_FIXTURE_TSUMTSUM_URL',
  'HEX_FIXTURE_YWP_URL',
]) assert.ok(workflow.includes(variable), `${variable} must participate in the required gate`);

for (const fixture of ['battlecats', 'YWP', 'TsumTsum']) {
  assert.ok(measure.includes(`fixture: ${fixture}`), `${fixture} must participate in cross-binary accuracy`);
}
assert.match(measure, /max-parallel:\s*3/, 'the three real fixtures must be the only GitHub-job fanout');
assert.doesNotMatch(workflow, /max-parallel:\s*(?:[4-9]|[1-9]\d+)/,
  'cross-binary accuracy must never consume more than three concurrent matrix runners');
assert.doesNotMatch(measure, /matrix\.partition|partition:\s*\n/,
  'feature partitions must stay inside each fixture runner instead of consuming GitHub jobs');
assert.doesNotMatch(workflow, /\n  oracle:\s*\n/,
  'oracle generation must share the fixture runner rather than consume a separate matrix');
assert.match(measure, /fail-fast:\s*false/,
  'fixture runners must keep collecting diagnostics after one target fails');

assert.match(requirements, /^lief==1\.0\.0$/m, 'LIEF oracle version must remain pinned');
assert.match(requirements, /^capstone==5\.0\.9$/m, 'Capstone oracle version must remain pinned');
assert.match(workflow, /ORACLE_PYTHON_VERSION:\s*'3\.12\.13'/,
  'Python oracle runtime must be exact, not a floating minor version');

const oracleKey = measure.slice(
  measure.indexOf('name: Build exact oracle cache key'),
  measure.indexOf('name: Restore exact oracle cache'),
);
for (const input of [
  'tests/fixtures/real-binaries.json',
  'tests/oracle.py',
  'tests/oracle-cfg-normalize.py',
  'tests/oracle-requirements.txt',
]) assert.ok(oracleKey.includes(input), `oracle cache key must include ${input}`);
assert.match(oracleKey, /runner\.os/);
assert.match(oracleKey, /runner\.arch/);
assert.match(oracleKey, /ORACLE_PYTHON_VERSION/);
assert.match(oracleKey, /matrix\.target\.fixture/,
  'the oracle cache must stay target-specific inside the shared fixture job');

const restore = measure.slice(
  measure.indexOf('name: Restore exact oracle cache'),
  measure.indexOf('name: Validate cached oracle'),
);
assert.match(restore, /actions\/cache\/restore@v4/);
assert.match(restore, /steps\.oracle-key\.outputs\.key/);

const generate = measure.slice(
  measure.indexOf('name: Generate oracle on cache miss'),
  measure.indexOf('name: Save exact oracle cache'),
);
assert.match(generate, /if:\s*steps\.oracle-cache\.outputs\.cache-hit\s*!=\s*'true'/,
  'oracle generation must run only on an exact cache miss');
assert.match(generate, /python tests\/oracle\.py/);
assert.match(generate, /python tests\/oracle-cfg-normalize\.py/);
assert.match(measure, /name:\s*Publish oracle for this run[\s\S]*actions\/upload-artifact@v4/,
  'each fixture runner must still publish the exact oracle as evidence');
assert.doesNotMatch(measure, /Download required oracle/,
  'the fixture runner must consume its local oracle directly without an artifact round trip');

for (const partition of ['core', 'pinpoint', 'pseudoc']) {
  assert.match(measure, new RegExp(`Restore exact ${partition} result cache`),
    `${partition} result must retain an independent exact cache`);
}
assert.match(measure, /accuracy-result-v7-/,
  'runner-local layout must use a fresh validated cache generation');
assert.match(workflow, /LOCAL_PSEUDOC_WORKERS:\s*2/,
  'pseudocode must use the remaining two local CPU lanes');
assert.match(measure, /accuracy-local-nonpseudoc-0\.json/);
assert.match(measure, /accuracy-local-nonpseudoc-1\.json/);
assert.match(measure, /node tests\/accuracy-pseudoc-parallel\.mjs/,
  'pseudoc must retain persistent runner-local workers');
assert.match(measure, /--workers="\$LOCAL_PSEUDOC_WORKERS"/,
  'the persistent pseudoc pool size must remain explicitly bounded');

const measureScript = measure.slice(
  measure.indexOf('name: Measure missing accuracy partitions runner-locally'),
  measure.indexOf('name: Save exact core result cache'),
);
const firstNonPseudoc = measureScript.indexOf("--only='sections,funcs,funcs-guess,disasm,kinds,calls,refs,imports,objc,selstub,pinpoint'");
const secondNonPseudoc = measureScript.indexOf("--only='strings,xrefs,funcname,selffield,role,apimeaning,summary,expr,formula,pinpoint-partial'");
const pseudoc = measureScript.indexOf('node tests/accuracy-pseudoc-parallel.mjs');
assert.ok(firstNonPseudoc >= 0 && secondNonPseudoc > firstNonPseudoc,
  'both non-pseudocode feature partitions must remain present in their original order');
assert.ok(pseudoc > secondNonPseudoc,
  'pseudocode workers must start only after both memory-heavy non-pseudocode partitions finish');
assert.equal(
  (measureScript.match(/if ! node --max-old-space-size=4096 tests\/accuracy\.mjs/g) || []).length,
  2,
  'each non-pseudocode partition must run as a directly joined fail-closed process',
);
assert.doesNotMatch(measureScript, /accuracy-local-nonpseudoc-[01]\.log\s*&/,
  'two 4 GiB non-pseudocode processes must never run concurrently on one hosted runner');
assert.doesNotMatch(measureScript, /pids\+=\("\$!"\)|wait "\$\{pids/,
  'non-pseudocode memory safety must not depend on background-process joining');
assert.match(measureScript, /cat accuracy-local-nonpseudoc-0\.log[\s\S]*cat accuracy-local-nonpseudoc-1\.log/,
  'both sequential partitions must retain failure diagnostics');

for (const partition of ['core', 'pinpoint']) {
  assert.match(measure, new RegExp(`accuracy-part-\\$\\{\\{ matrix\\.target\\.name \\}\\}-${partition}\\.json\\.tmp`),
    `${partition} must build into a temporary result before publication`);
}
assert.match(measure, /pseudoc_output="accuracy-part-\$\{\{ matrix\.target\.name \}\}-pseudoc\.json"/);
assert.match(measure, /> "\$\{pseudoc_output\}\.tmp"/,
  'pseudoc must build into a temporary result before publication');
assert.match(measure, /accuracy-result-validate\.mjs "\$\{core_output\}\.tmp"/,
  'new core output must be validated before publication');
assert.match(measure, /accuracy-result-validate\.mjs "\$\{pinpoint_output\}\.tmp"/,
  'new pinpoint output must be validated before publication');
assert.match(measure, /accuracy-result-validate\.mjs "\$\{pseudoc_output\}\.tmp"/,
  'new pseudoc output must be validated before publication');
assert.match(measure, /mv "\$\{core_output\}\.tmp" "\$core_output"/);
assert.match(measure, /mv "\$\{pinpoint_output\}\.tmp" "\$pinpoint_output"/);
assert.match(measure, /mv "\$\{pseudoc_output\}\.tmp" "\$pseudoc_output"/);

const targetUpload = measure.slice(measure.indexOf('name: Upload target accuracy partitions'));
assert.match(targetUpload, /if:\s*success\(\)/,
  'failed fixture measurements must never upload partial accuracy artifacts');
assert.match(targetUpload, /accuracy-part-\$\{\{ matrix\.target\.name \}\}-\*\.json/,
  'one target artifact must contain all three validated partition files');
assert.match(targetUpload, /if-no-files-found:\s*error/,
  'a missing target artifact must fail closed');

assert.match(aggregate, /needs:\s*measure/,
  'the final required gate must wait for the three fixture runners');
assert.match(aggregate, /MEASURE_RESULT:\s*\$\{\{ needs\.measure\.result \}\}/,
  'the final gate must inspect the complete fixture matrix result');
assert.match(aggregate, /name:\s*Workflow contract regression[\s\S]*issue-497-cross-binary-workflow\.mjs/,
  'workflow contract validation must still run in the required final job');
assert.match(aggregate, /name:\s*Syntax lint[\s\S]*npm run lint/,
  'repository syntax lint must remain in the required final job');
assert.match(aggregate, /name:\s*Core tests for standalone manual validation[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*npm test/,
  'manual release validation must still include the broad core test suite');
assert.match(aggregate, /name:\s*Validate downloaded accuracy partitions[\s\S]*accuracy-result-validate\.mjs/,
  'the final merge must validate every downloaded partition first');
assert.match(aggregate, /node tests\/accuracy-merge\.mjs accuracy-BattleCats\.json/);
assert.match(aggregate, /node tests\/accuracy-merge\.mjs accuracy-YWP\.json/);
assert.match(aggregate, /node tests\/accuracy-merge\.mjs accuracy-TsumTsum\.json/);
assert.match(aggregate, /node tests\/accuracy-gate\.mjs/,
  'the existing cross-binary score floors must remain the final accuracy gate');
assert.match(aggregate, /name:\s*accuracy\s*\n\s*if:\s*always\(\)/,
  'the final required accuracy job must remain a fail-closed aggregate');

assert.match(workflow, /push:\s*\n\s*branches:\s*\[[^\]]*\bmain\b[^\]]*\]/,
  'main must seed exact oracle/result caches for later pull requests');
assert.match(workflow, /cancel-in-progress:\s*true/,
  'stale accuracy runs should be cancelled when a newer revision supersedes them');

console.log('issue #497/#2484 cross-binary workflow gate regression passed');
