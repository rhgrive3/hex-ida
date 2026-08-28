import assert from 'node:assert/strict';
import { parseGhidraOutput } from '../tools/decompiler/ghidra-diff.mjs';

function parsed(payload) {
  return parseGhidraOutput(`GHIDRA_FUNCTION 1000 ${payload}`).get('1000');
}

assert.equal(parsed('plain ascii'), 'plain ascii');
assert.equal(parsed('line1\\nline2'), 'line1\nline2');
assert.equal(parsed('path\\\\to\\\\file'), 'path\\to\\file');
assert.equal(parsed('literal\\\\n'), 'literal\\n');
assert.equal(parsed('literal\\\\\\\\n'), 'literal\\\\n');
assert.equal(parsed('a\\n\\\\b\\n\\\\n'), 'a\n\\b\n\\n');

console.log('issue-2320 ghidra output escape regression: ok');
