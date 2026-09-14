import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { numberPattern } from '../../js/ui/numeric-pattern.js';

test('hex prefix case never changes the byte pattern', () => {
  assert.equal(numberPattern('0x1'), numberPattern('0X1'));
  assert.equal(numberPattern('-0x1'), numberPattern('-0X1'));
  assert.equal(numberPattern('-0x1'), 'ff ff ff ff');
});

test('established numeric forms keep working', () => {
  assert.equal(numberPattern('0x1'), '01 00 00 00');
  assert.equal(numberPattern('255'), 'ff 00 00 00');
  assert.equal(numberPattern('-1'), 'ff ff ff ff');
  assert.equal(numberPattern('0xFFFFFFFF'), 'ff ff ff ff');
  assert.equal(numberPattern('0x100000000'), '00 00 00 00 01 00 00 00');
  assert.equal(numberPattern('nope'), null);
  assert.equal(numberPattern(''), null);
  assert.equal(numberPattern('0x'), null);
});

test('both search panels share the single helper instead of drifting', async () => {
  for (const file of ['js/ui/panels/search.js', 'js/ui/panels/navigation.js']) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(src, /from ['"]\.\.\/numeric-pattern\.js['"]/, `${file} must import the shared helper`);
    assert.doesNotMatch(src, /function numberPattern\(/, `${file} must not keep a local duplicate`);
  }
});
