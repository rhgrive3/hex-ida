import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');
const requirements = fs.readFileSync('tests/oracle-requirements.txt', 'utf8');
const pseudocRunner = fs.readFileSync('tests/accuracy-pseudoc-parallel.mjs', 'utf8');
const measure = workflow.slice(workflow.indexOf('\n  measure:'), workflow.indexOf('\n  accuracy:'));
const aggregate = workflow.slice(workflow.indexOf('\n  accuracy:'));

assert.ok(measure.length > 0, 'fixture measurement matrix must exist');
assert.ok(aggregate.length > 0, 'final fail-closed accuracy aggregate must exist');

const detect = measure.indexOf('name: Detect real fixture configuration');
const requireAll = measure.indexOf('name: Require all real fixture URLs');
assert.ok(detect >= 0, 'fixture detection step must exist in each target runner');
assert.ok(requireAll > detect, 'fail-closed requirement must run after detection');
const failClosedGate = measure.slice(
  requireAll,
  measure.indexOf('\n\n      - name: Build exact oracle cache key', requireAll),
);
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
assert.doesNotMatch(restore, /restore-keys:/, 'oracle cache reuse must remain exact-only');

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

const resultCacheKeys = [];
for (const partition of ['core', 'pinpoint', 'pseudoc']) {
  assert.match(measure, new RegExp(`Restore exact ${partition} result cache`),
    `${partition} result must retain an independent exact cache`);
  assert.match(measure, new RegExp(`Validate restored ${partition} result`),
    `${partition} cached result must be validated before reuse`);
  assert.match(measure, new RegExp(`Save exact ${partition} result cache`),
    `${partition} result cache must only publish validated output`);

  for (const operation of ['Restore', 'Save']) {
    const stepName = `name: ${operation} exact ${partition} result cache`;
    const start = measure.indexOf(stepName);
    assert.ok(start >= 0, `${operation.toLowerCase()} ${partition} cache step must exist`);
    const nextStep = measure.indexOf('\n      - name:', start + stepName.length);
    const block = measure.slice(start, nextStep >= 0 ? nextStep : measure.length);
    const keyMatch = block.match(/\n\s+key:\s*([^\n]+)/);
    assert.ok(keyMatch, `${operation.toLowerCase()} ${partition} cache must declare an exact key`);
    assert.doesNotMatch(block, /restore-keys:/,
      `${operation.toLowerCase()} ${partition} result cache must remain exact-only`);
    resultCacheKeys.push({ operation, partition, key: keyMatch[1].trim() });
  }
}
assert.equal(resultCacheKeys.length, 6,
  'core, pinpoint, and pseudoc must each have restore and save result-cache keys');
for (const { operation, partition, key } of resultCacheKeys) {
  assert.match(key, /^accuracy-result-v9-/,
    `${operation.toLowerCase()} ${partition} cache must use the v9 bounded-local generation`);
}
assert.doesNotMatch(measure, /accuracy-result-v8-/,
  'stale single-world result-cache generations must not remain active');

const measureStart = measure.indexOf(
  'name: Measure missing accuracy partitions with bounded local parallelism',
);
assert.ok(measureStart >= 0, 'bounded runner-local measurement step must exist');
const measureScript = measure.slice(
  measureStart,
  measure.indexOf('name: Save exact core result cache', measureStart),
);

for (const cacheEnv of ['CORE_CACHE_HIT', 'PINPOINT_CACHE_HIT', 'PSEUDOC_CACHE_HIT']) {
  assert.ok(measureScript.includes(cacheEnv), `${cacheEnv} must control missing-partition measurement`);
}
assert.ok(
  measureScript.includes("core_ids='sections,funcs,funcs-guess,disasm,kinds,calls,refs,imports,objc,selstub,strings,xrefs,funcname,selffield,role,apimeaning,summary,expr,formula'"),
  'core denominator must remain exact',
);
assert.ok(
  measureScript.includes("pinpoint_ids='pinpoint,pinpoint-partial'"),
  'pinpoint denominator must remain exact',
);
assert.ok(measureScript.includes("pseudoc_ids='pseudoc'"),
  'pseudoc denominator must remain exact');
for (const conditional of [
  'if [[ "$CORE_CACHE_HIT" != "true" ]]; then append_nonpseudoc_features "$core_ids"; fi',
  'if [[ "$PINPOINT_CACHE_HIT" != "true" ]]; then append_nonpseudoc_features "$pinpoint_ids"; fi',
]) assert.ok(measureScript.includes(conditional),
  'every cache-missing non-pseudoc partition must join the exact non-pseudoc denominator');
assert.match(measureScript,
  /if \[\[ -z "\$nonpseudoc_features" && "\$PSEUDOC_CACHE_HIT" == "true" \]\][\s\S]*exit 1/,
  'bounded measurement must fail closed if invoked without a missing partition');

assert.equal((measureScript.match(/\btests\/accuracy\.mjs\b/g) || []).length, 1,
  'all cache-missing non-pseudoc features must share exactly one accuracy.mjs world');
assert.equal((measureScript.match(/\btests\/accuracy-pseudoc-parallel\.mjs\b/g) || []).length, 1,
  'the canonical pseudoc denominator must use exactly one runner-local scheduler');
assert.ok(measureScript.includes('--only="$nonpseudoc_features"'),
  'the non-pseudoc world must receive the complete dynamic denominator');
assert.ok(measureScript.includes('--max-old-space-size=2600 tests/accuracy.mjs'),
  'the concurrent non-pseudoc world must stay inside the proven 2600 MiB heap envelope');
assert.ok(measureScript.includes('--workers=3'),
  'pseudoc must start with exactly three worlds while non-pseudoc is active');
assert.ok(measureScript.includes('--max-workers=4'),
  'pseudoc may use the fourth CPU only after non-pseudoc exits');
assert.ok(measureScript.includes('--scale-file="$nonpseudoc_done"'),
  'pseudoc scaling must be gated by the exact non-pseudoc completion marker');

const commandStatus = measureScript.indexOf('command_status=$?');
const statusPublish = measureScript.indexOf(
  'printf \'%s\\n\' "$command_status" > "$nonpseudoc_status"',
);
const donePublish = measureScript.indexOf('touch "$nonpseudoc_done"');
assert.ok(commandStatus >= 0 && statusPublish > commandStatus && donePublish > statusPublish,
  'the scale marker must publish only after the non-pseudoc command exits and its status is recorded');
const pseudocStart = measureScript.indexOf('node tests/accuracy-pseudoc-parallel.mjs');
const waitForNonpseudoc = measureScript.indexOf('wait "$nonpseudoc_pid"');
assert.ok(pseudocStart >= 0 && waitForNonpseudoc > pseudocStart,
  'pseudoc and non-pseudoc work must overlap before fail-closed aggregation');
for (const statusEvidence of [
  'nonpseudoc_wrapper_status=$?',
  'nonpseudoc_status_value=$(<"$nonpseudoc_status")',
  'pseudoc_status_value=$?',
  'nonpseudoc=$nonpseudoc_status_value pseudoc=$pseudoc_status_value',
]) assert.ok(measureScript.includes(statusEvidence),
  'both local lanes must publish and aggregate explicit outcomes');
assert.doesNotMatch(measureScript, /continue-on-error:\s*true/,
  'no local lane failure may be converted into success');

assert.ok(measureScript.includes(
  'node tests/accuracy-result-validate.mjs "$nonpseudoc_output" \\\n              --expect="$nonpseudoc_features"',
), 'the complete dynamic non-pseudoc union must be validated before partitioning');
assert.ok(measureScript.includes(
  "const rows = JSON.parse(fs.readFileSync('accuracy-local-nonpseudoc.json', 'utf8'));",
), 'non-pseudoc output must be parsed exactly once for deterministic partition publication');
assert.ok(measureScript.includes(
  "const coreIds = new Set(['sections','funcs','funcs-guess','disasm','kinds','calls','refs','imports','objc','selstub','strings','xrefs','funcname','selffield','role','apimeaning','summary','expr','formula']);",
), 'core publication denominator must match the measured core denominator');
assert.ok(measureScript.includes(
  "const pinpointIds = new Set(['pinpoint', 'pinpoint-partial']);",
), 'pinpoint publication denominator must match the measured pinpoint denominator');
assert.ok(measureScript.includes(
  "fs.writeFileSync(path + '.tmp', JSON.stringify(selected, null, 2) + '\\n');",
), 'new partition results must stage through temporary files');

for (const [cacheEnv, partition] of [
  ['CORE_CACHE_HIT', 'core'],
  ['PINPOINT_CACHE_HIT', 'pinpoint'],
]) {
  const expected = "if (process.env." + cacheEnv + " !== 'true') write('accuracy-part-${{ matrix.target.name }}-" + partition + ".json',";
  assert.ok(measureScript.includes(expected),
    `${partition} must be split only when its exact cache missed`);
}
for (const [variable, partition] of [
  ['core_output', 'core'],
  ['pinpoint_output', 'pinpoint'],
  ['pseudoc_output', 'pseudoc'],
]) {
  const staged = '"${' + variable + '}.tmp"';
  const validateCommand = 'accuracy-result-validate.mjs ' + staged;
  const publishCommand = 'mv ' + staged + ' "$' + variable + '"';
  const validationIndex = measureScript.indexOf(validateCommand);
  const publicationIndex = measureScript.indexOf(publishCommand);
  assert.ok(validationIndex >= 0, `${partition} output must be validated before publication`);
  assert.ok(publicationIndex >= 0, `${partition} output must publish atomically after validation`);
  assert.ok(validationIndex < publicationIndex,
    `${partition} validation must precede atomic publication`);
}

assert.match(pseudocRunner, /value < 1 \|\| value > 4/,
  'the runner-local pseudoc scheduler must hard-cap worker count at four');
assert.match(pseudocRunner, /maxWorkers > initialWorkers && !scaleFile/,
  'elastic scaling must require an explicit completion authority');
assert.match(pseudocRunner, /!scaleFile \|\| !fs\.existsSync\(scaleFile\)/,
  'the fourth pseudoc world must not start before the completion marker exists');
assert.match(pseudocRunner, /while \(children\.size < maxWorkers && next < samples\.length\)/,
  'elastic scaling must remain bounded by maxWorkers and remaining exact samples');
assert.match(pseudocRunner, /execArgv:\s*\['--max-old-space-size=2600'\]/,
  'each pseudoc world must retain the proven 2600 MiB heap envelope');
assert.match(pseudocRunner, /expected the canonical 120 pseudoc samples/,
  'the scheduler must retain the canonical 120-function denominator');
assert.match(pseudocRunner, /out-of-range pseudoc result index/,
  'unexpected pseudoc sample identities must fail closed');
assert.match(pseudocRunner, /pseudoc sample identity mismatch/,
  'each worker result must bind to its assigned canonical sample');
assert.match(pseudocRunner, /pseudoc coverage missing sample/,
  'the scheduler must prove every canonical sample completed exactly once');

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
assert.match(aggregate,
  /name:\s*Workflow contract regression[\s\S]*issue-497-cross-binary-workflow\.mjs/,
  'workflow contract validation must still run in the required final job');
assert.match(aggregate,
  /name:\s*Accuracy merge regression[\s\S]*accuracy-pseudoc-parallel\.mjs --self-test/,
  'the elastic worker configuration self-test must run in the final required job');
assert.match(aggregate, /name:\s*Syntax lint[\s\S]*npm run lint/,
  'repository syntax lint must remain in the required final job');
assert.match(aggregate,
  /name:\s*Core tests for standalone manual validation[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*npm test/,
  'manual release validation must still include the broad core test suite');
assert.match(aggregate,
  /name:\s*Validate downloaded accuracy partitions[\s\S]*accuracy-result-validate\.mjs/,
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
  'the pre-existing workflow-local stale-run cancellation contract must remain unchanged');

console.log('issue #497 bounded-local cross-binary workflow gate regression passed');
