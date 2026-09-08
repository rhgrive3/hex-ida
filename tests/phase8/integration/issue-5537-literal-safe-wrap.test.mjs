import assert from 'node:assert/strict';
import test from 'node:test';

import { printProgram } from '../../../js/decompiler/pretty/c.js';

function print(text, source = 'literal') {
  return printProgram({ body: [{ kind: 'stmt', indent: 0, text, source }] }, { columnWidth: 48 });
}

test('#5537 ignores every candidate separator inside literals and line comments', () => {
  const cases = [
    'print("aaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbb + cccccccccccccccc - dddddddddddddddd && eeeeeeeeeeeeee || ffffffffffffff");',
    'print("aaaaaaaaaaaaaaaa \\"quoted, + - && || piece\\" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");',
    "const marker = 'aaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbb + cccccccccccccccc - dddddddddddddddd && eeeeeeeeeeeeee || ffffffffffffff';",
    'log(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa); // comment, + - && ||',
  ];

  for (const text of cases) {
    const printed = print(text);
    assert.deepEqual(printed.lines, [text]);
    assert.equal(printed.text, text);
    assert.deepEqual(printed.mapping, [{
      outputStartLine: 1,
      outputEndLine: 1,
      source: 'literal',
      kind: 'stmt',
    }]);
  }
});

test('#5537 keeps block-comment separators out of the break point scan', () => {
  const text = 'call(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /* comment, + - && || */;';
  const printed = print(text, 'comment');

  assert.deepEqual(printed.lines, [
    'call(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,',
    '    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /* comment, + - && || */;',
  ]);
  assert.deepEqual(printed.mapping, [{
    outputStartLine: 1,
    outputEndLine: 2,
    source: 'comment',
    kind: 'stmt',
  }]);
});

test('#5537 preserves an ordinary operator break and its output mapping', () => {
  const text = 'return aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa + bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;';
  const printed = print(text, 'operator');

  assert.deepEqual(printed.lines, [
    'return aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa +',
    '    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;',
  ]);
  assert.deepEqual(printed.mapping, [{
    outputStartLine: 1,
    outputEndLine: 2,
    source: 'operator',
    kind: 'stmt',
  }]);
});

console.log('issue-5537 literal-safe C wrapping PASS');
