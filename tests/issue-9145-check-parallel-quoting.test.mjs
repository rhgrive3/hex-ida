import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCheckSteps, tokenizeCommand, splitCommand } from '../scripts/run-check-parallel.mjs';

test('#9145 parseCheckSteps respects quotes and backslashes around &&', () => {
  // Simple steps without quotes
  assert.deepEqual(
    parseCheckSteps('npm run lint && npm run test'),
    ['npm run lint', 'npm run test'],
  );

  // Steps with && inside double quotes
  assert.deepEqual(
    parseCheckSteps('node -e "if (a && b) run()" && npm test'),
    ['node -e "if (a && b) run()"', 'npm test'],
  );

  // Steps with && inside single quotes
  assert.deepEqual(
    parseCheckSteps("node -e 'if (x && y) exit(0)' && npm run check:fast"),
    ["node -e 'if (x && y) exit(0)'", 'npm run check:fast'],
  );

  // Steps with && inside backticks
  assert.deepEqual(
    parseCheckSteps('node -e `if (x && y) exit(0)` && npm run check:fast'),
    ['node -e `if (x && y) exit(0)`', 'npm run check:fast'],
  );

  // Escaped ampersand
  assert.deepEqual(
    parseCheckSteps('echo foo \\&& bar && npm test'),
    ['echo foo \\&& bar', 'npm test'],
  );
});

test('#9145 tokenizeCommand and splitCommand handle quotes, spaces, and escapes', () => {
  // Standard simple command
  assert.deepEqual(
    splitCommand('npm run test'),
    { command: 'npm', args: ['run', 'test'] },
  );

  // Command with double quotes preserving spaces
  assert.deepEqual(
    splitCommand('npm run test -- --grep "apple knowledge"'),
    { command: 'npm', args: ['run', 'test', '--', '--grep', 'apple knowledge'] },
  );

  // Command with single quotes preserving spaces
  assert.deepEqual(
    splitCommand("node scripts/tool.mjs 'first arg' 'second arg'"),
    { command: 'node', args: ['scripts/tool.mjs', 'first arg', 'second arg'] },
  );

  // Command with empty string arguments
  assert.deepEqual(
    splitCommand('node script.js "" "hello world"'),
    { command: 'node', args: ['script.js', '', 'hello world'] },
  );

  // Escaped spaces outside quotes
  assert.deepEqual(
    splitCommand('node script.js hello\\ world'),
    { command: 'node', args: ['script.js', 'hello world'] },
  );

  // Escaped quotes inside quotes
  assert.deepEqual(
    splitCommand('node -e "console.log(\\"ok\\")"'),
    { command: 'node', args: ['-e', 'console.log("ok")'] },
  );

  // Irregular spacing
  assert.deepEqual(
    splitCommand('   npm    run    check:test   '),
    { command: 'npm', args: ['run', 'check:test'] },
  );
});
