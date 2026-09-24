import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
vm.runInThisContext(fs.readFileSync(new URL('../js/words.js', import.meta.url), 'utf8'), { filename:'js/words.js' });
const { KIND, classifyWord } = globalThis.Words;
for (const [word, label] of [
  [0x1e02fc00, 'scvtf s0, w0, #1'],
  [0x9e42c020, 'scvtf d0, x1, #16'],
]) assert.equal(classifyWord(word >>> 0), KIND.FCONV, label);
console.log('issue #9629 fixed-point conversion scale classification: PASS');
