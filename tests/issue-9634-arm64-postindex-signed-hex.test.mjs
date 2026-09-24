import assert from 'node:assert/strict';
import { parseOperands } from '../js/ui/explain/arm64-operands.js';

const parsed = parseOperands('x7, [x19], #0xffffffffffffff07');
assert.equal(parsed.length, 2);
assert.equal(parsed[1].k, 'mem');
assert.equal(parsed[1].mode, 'post');
assert.equal(parsed[1].writebackDisp?.value, -249n);

const ordinary = parseOperands('x0, #0xffffffffffffff07');
assert.equal(ordinary[1].value, 0xffffffffffffff07n, 'non-memory immediates keep their unsigned literal value');
console.log('issue #9634 signed post-index hex: PASS');
