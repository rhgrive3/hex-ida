import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseCheckSteps, requiresSerialShellFallback } from '../scripts/run-check-parallel.mjs';

const complexCases = [
  ['#9318 parameter expansion', "printf '<%s>\\n' ${X:-a&&b} && printf done"],
  ['#9326 brace group', '{ printf a && printf b; } && printf c'],
  ['#9328 case compound', 'case x in x) printf a && printf b ;; esac && printf c'],
  ['#9330 if compound', 'if true; then printf a && printf b; fi && printf done'],
  ['#9333 for loop', 'for x in a; do printf a && printf b; done && printf done'],
  ['#9333 while loop', 'while false && true; do printf nope; done && printf done'],
  ['#9334 heredoc', 'cat <<EOF && printf done\npayload && literal\nEOF'],
  ['#9337 shell comment', 'printf a && # comment && definitely-not-a-command\nprintf b'],
  ['review standalone ! reserved word', '! true && printf unexpected'],
];

for (const [label, script] of complexCases) {
  test(`${label} is preserved as one shell-owned step`, () => {
    assert.equal(requiresSerialShellFallback(script), true);
    assert.deepEqual(parseCheckSteps(script), [script]);
  });
}

test('#9334 heredoc fallback preserves deferred body bytes and shell semantics', () => {
  const script = 'cat <<EOF && printf done\npayload && literal\nEOF';
  const result = spawnSync('/bin/sh', ['-c', parseCheckSteps(script)[0]], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'payload && literal\ndone');
});

test('#9337 comment fallback never promotes comment bytes into a command', () => {
  const script = 'printf a && # comment && definitely-not-a-command\nprintf b';
  const result = spawnSync('/bin/sh', ['-c', parseCheckSteps(script)[0]], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ab');
});

test('quoted or embedded literal # does not force serial fallback', () => {
  assert.equal(requiresSerialShellFallback("printf '# && literal' && printf next"), false);
  assert.equal(requiresSerialShellFallback('printf foo#bar && printf next'), false);
  assert.deepEqual(parseCheckSteps('printf foo#bar && printf next'), ['printf foo#bar', 'printf next']);
});

test('simple canonical conjunction chains remain split for parallel execution', () => {
  assert.equal(requiresSerialShellFallback('npm run a && npm run b && npm run c'), false);
  assert.deepEqual(parseCheckSteps('npm run a && npm run b && npm run c'), ['npm run a', 'npm run b', 'npm run c']);
});
