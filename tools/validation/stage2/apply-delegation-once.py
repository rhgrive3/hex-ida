from pathlib import Path
import subprocess

verify = Path('tools/validation/stage2/verify.mjs')
expected_blob = '351f9005d2fdc48d25a1716be427e456ef587545'
actual_blob = subprocess.check_output(['git', 'hash-object', str(verify)], text=True).strip()
if actual_blob != expected_blob:
    raise SystemExit(f'stage2-verifier-base-mismatch:{actual_blob}')
text = verify.read_text()
anchor = """function commandPassed(results, fragment) {
  return results.some((result) => result.command.includes(fragment) && result.status === 'passed');
}

"""
if text.count(anchor) != 1:
    raise SystemExit('stage2-delegation-anchor-mismatch')
block = r"""const STAGE1_DELEGATED_COMMANDS = Object.freeze([
  Object.freeze({ gateId: 'A7', fragment: 'phase11:test', command: 'npm run phase11:test' }),
  Object.freeze({ gateId: 'A9', fragment: 'benchmark:baseline', command: 'npm run benchmark:baseline' }),
]);

export function validateStage1DelegationReport(report, headSha) {
  const expectedHead = String(headSha || '').toLowerCase();
  const errors = [];
  if (!report || typeof report !== 'object') errors.push('stage1-delegation-report-invalid');
  if (report?.schemaVersion !== 'stage1-verdict/v1') errors.push('stage1-delegation-schema-invalid');
  if (String(report?.gitSha || '').toLowerCase() !== expectedHead) errors.push('stage1-delegation-head-mismatch');
  if (String(report?.expectedSha || '').toLowerCase() !== expectedHead) errors.push('stage1-delegation-expected-head-mismatch');
  if (report?.verdict !== 'READY') errors.push('stage1-delegation-verdict-not-ready');

  const gates = Array.isArray(report?.gates) ? report.gates : [];
  for (const requirement of STAGE1_DELEGATED_COMMANDS) {
    const gate = gates.find((item) => item?.id === requirement.gateId);
    if (!gate || gate.status !== 'passed') {
      errors.push(`stage1-delegation-gate-not-passed:${requirement.gateId}`);
      continue;
    }
    const commands = Array.isArray(gate.commands) ? gate.commands : [];
    if (!commands.some((result) => result?.status === 'passed' && String(result?.command || '').includes(requirement.fragment))) {
      errors.push(`stage1-delegation-command-not-passed:${requirement.gateId}:${requirement.fragment}`);
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    commands: errors.length === 0
      ? Object.freeze(STAGE1_DELEGATED_COMMANDS.map((requirement) => Object.freeze({
          command: requirement.command,
          status: 'passed',
          exitCode: 0,
          signal: null,
          durationMs: 0,
          stdoutTail: `delegated from same-head Stage 1 ${requirement.gateId}`,
          stderrTail: '',
          delegatedFrom: Object.freeze({ stage: 1, gateId: requirement.gateId, headSha: expectedHead }),
        })))
      : Object.freeze([]),
  });
}

function loadStage1DelegatedResults(headSha) {
  const reportPath = path.join(ROOT, 'reports/stage1/stage1-verdict.json');
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const checked = validateStage1DelegationReport(report, headSha);
    if (checked.ok) return checked.commands;
    return [Object.freeze({
      command: 'stage1 delegated proof: phase11:test + benchmark:baseline',
      status: 'failed',
      exitCode: 1,
      signal: null,
      durationMs: 0,
      stdoutTail: '',
      stderrTail: checked.errors.join(', '),
    })];
  } catch (error) {
    return [Object.freeze({
      command: 'stage1 delegated proof: phase11:test + benchmark:baseline',
      status: 'failed',
      exitCode: 1,
      signal: null,
      durationMs: 0,
      stdoutTail: '',
      stderrTail: `stage1-delegation-report-unreadable:${String(error?.message || error)}`,
    })];
  }
}

"""
text = text.replace(anchor, anchor + block, 1)
old = """  const commands = [
    node('tools/validation/stage1/verify.mjs', '--expect-sha', headSha),
    node('tests/stage2/run.mjs'),
    npm('runtime:test'),
    npm('phase11:test'),
    npm('phase12:test'),
    npm('benchmark:baseline'),
  ];
  if (finalMode) commands.push(npm('userscript:build'));
  if (full) commands.push(npm('check'));
  const commandResults = preflightBlocked ? [] : commands.map(run);
"""
new = """  const stage1Command = node('tools/validation/stage1/verify.mjs', '--expect-sha', headSha);
  const commands = [
    node('tests/stage2/run.mjs'),
    npm('runtime:test'),
    npm('phase12:test'),
  ];
  if (finalMode) commands.push(npm('userscript:build'));
  if (full) commands.push(npm('check'));
  const commandResults = [];
  if (!preflightBlocked) {
    const stage1Result = run(stage1Command);
    commandResults.push(stage1Result);
    if (stage1Result.status === 'passed') commandResults.push(...loadStage1DelegatedResults(headSha));
    commandResults.push(...commands.map(run));
  }
"""
if text.count(old) != 1:
    raise SystemExit('stage2-command-block-mismatch')
text = text.replace(old, new, 1)
verify.write_text(text)

test = Path('tests/stage2/stage1-delegation-contract.test.mjs')
if test.exists():
    raise SystemExit('stage2-delegation-test-already-exists')
test.write_text(r"""import assert from 'node:assert/strict';
import { validateStage1DelegationReport } from '../../tools/validation/stage2/verify.mjs';

const head = 'a'.repeat(40);
const report = {
  schemaVersion: 'stage1-verdict/v1',
  gitSha: head,
  expectedSha: head,
  verdict: 'READY',
  gates: [
    { id: 'A7', status: 'passed', commands: [{ command: 'npm run phase11:test', status: 'passed' }] },
    { id: 'A9', status: 'passed', commands: [{ command: 'npm run binary:test', status: 'passed' }, { command: 'npm run benchmark:baseline', status: 'passed' }] },
  ],
};

const delegated = validateStage1DelegationReport(report, head);
assert.equal(delegated.ok, true, 'same-head READY Stage 1 A7/A9 proof may be delegated');
assert.deepEqual(delegated.commands.map((result) => result.command), ['npm run phase11:test', 'npm run benchmark:baseline']);
assert.equal(delegated.commands.every((result) => result.delegatedFrom?.headSha === head), true);

for (const [name, changed, expectedError] of [
  ['stale gitSha', { ...report, gitSha: 'b'.repeat(40) }, 'stage1-delegation-head-mismatch'],
  ['wrong expectedSha', { ...report, expectedSha: 'b'.repeat(40) }, 'stage1-delegation-expected-head-mismatch'],
  ['non-READY verdict', { ...report, verdict: 'BLOCKED' }, 'stage1-delegation-verdict-not-ready'],
  ['wrong schema', { ...report, schemaVersion: 'stage1-verdict/v0' }, 'stage1-delegation-schema-invalid'],
]) {
  const checked = validateStage1DelegationReport(changed, head);
  assert.equal(checked.ok, false, `${name} must fail closed`);
  assert.ok(checked.errors.includes(expectedError), `${name} must expose ${expectedError}`);
}

const missingBenchmark = structuredClone(report);
missingBenchmark.gates.find((gate) => gate.id === 'A9').commands = [{ command: 'npm run binary:test', status: 'passed' }];
const missingBenchmarkResult = validateStage1DelegationReport(missingBenchmark, head);
assert.equal(missingBenchmarkResult.ok, false);
assert.ok(missingBenchmarkResult.errors.includes('stage1-delegation-command-not-passed:A9:benchmark:baseline'));

const failedPhase11 = structuredClone(report);
failedPhase11.gates.find((gate) => gate.id === 'A7').status = 'failed';
assert.equal(validateStage1DelegationReport(failedPhase11, head).ok, false, 'failed A7 cannot be delegated');

console.log('[stage2] same-head Stage 1 delegation contract: PASS');
""")
