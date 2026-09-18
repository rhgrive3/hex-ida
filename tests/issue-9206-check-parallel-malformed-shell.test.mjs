import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCheckSteps, tokenizeCommand, splitCommand, runCheckParallel } from '../scripts/run-check-parallel.mjs';

test('#9206 parseCheckSteps rejects unclosed quotes and dangling escapes', () => {
  // Unclosed double quote
  assert.throws(
    () => parseCheckSteps('node -e "console.log(\'ran\')'),
    /run-check-parallel: malformed shell syntax in check script \(unclosed quote or dangling escape\)/,
  );

  // Unclosed single quote
  assert.throws(
    () => parseCheckSteps("npm run test && node -e 'console.log(1)"),
    /run-check-parallel: malformed shell syntax in check script \(unclosed quote or dangling escape\)/,
  );

  // Unclosed backtick
  assert.throws(
    () => parseCheckSteps('node -e `console.log(1)'),
    /run-check-parallel: malformed shell syntax in check script \(unclosed quote or dangling escape\)/,
  );

  // Dangling escape at EOF
  assert.throws(
    () => parseCheckSteps('npm run lint && npm run test \\'),
    /run-check-parallel: malformed shell syntax in check script \(unclosed quote or dangling escape\)/,
  );

  // Valid commands still work
  assert.deepEqual(
    parseCheckSteps('npm run lint && npm run test'),
    ['npm run lint', 'npm run test'],
  );
  assert.deepEqual(
    parseCheckSteps('node -e "console.log(\'ran\')" && npm test'),
    ['node -e "console.log(\'ran\')"', 'npm test'],
  );
});

test('#9206 tokenizeCommand and splitCommand reject unclosed quotes and dangling escapes', () => {
  // Unterminated double quote
  assert.throws(
    () => tokenizeCommand('node -e "console.log(\'ran\')'),
    /run-check-parallel: malformed shell syntax in command .* \(unclosed quote or dangling escape\)/,
  );

  // Unterminated single quote
  assert.throws(
    () => splitCommand("node script.js 'unterminated"),
    /run-check-parallel: malformed shell syntax in command .* \(unclosed quote or dangling escape\)/,
  );

  // Dangling escape
  assert.throws(
    () => splitCommand('node script.js foo\\'),
    /run-check-parallel: malformed shell syntax in command .* \(unclosed quote or dangling escape\)/,
  );

  // Valid escaped space and quotes still work
  assert.deepEqual(
    splitCommand('node script.js foo\\ bar "baz qux" \'one two\''),
    { command: 'node', args: ['script.js', 'foo bar', 'baz qux', 'one two'] },
  );
});

test('#9206 runCheckParallel fails closed on malformed scripts.check without launching jobs', async () => {
  await assert.rejects(
    async () => {
      await runCheckParallel({
        checkScript: 'node -e "console.log(\'ran\')',
      });
    },
    /run-check-parallel: malformed shell syntax/,
  );
});
