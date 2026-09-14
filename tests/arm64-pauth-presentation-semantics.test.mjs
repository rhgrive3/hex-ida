import assert from 'node:assert/strict';
import { brief, categoryOf } from '../js/arm64.js';
import { arm64ePointerAuthenticationMnemonics } from '../js/targets/architecture/arm64e/effects.js';

const control = new Set(['braa','brab','braaz','brabz','blraa','blrab','blraaz','blrabz','retaa','retab']);
for (const mnemonic of arm64ePointerAuthenticationMnemonics()) {
  assert.equal(categoryOf(mnemonic), control.has(mnemonic) ? 'flow' : 'system', mnemonic + ': presentation category must cover canonical PAuth inventory');
}
assert.equal(brief('paciasp', '', 'pseudo'), 'lr = sign(lr, sp)');
assert.equal(brief('pacia', 'x0, x1', 'pseudo'), 'x0 = sign(x0, x1)');
assert.equal(brief('pacda', 'x2, sp', 'pseudo'), 'x2 = sign(x2, sp)');
assert.equal(brief('paciza', 'x3', 'pseudo'), 'x3 = sign(x3, 0)');
assert.equal(brief('pacia1716', '', 'pseudo'), 'x17 = sign(x17, x16)');
assert.equal(brief('autiasp', '', 'pseudo'), 'lr = authenticate(lr, sp)');
assert.equal(brief('autia', 'x4, x5', 'pseudo'), 'x4 = authenticate(x4, x5)');
assert.equal(brief('autdza', 'x6', 'pseudo'), 'x6 = authenticate(x6, 0)');
assert.equal(brief('autib1716', '', 'pseudo'), 'x17 = authenticate(x17, x16)');
assert.equal(brief('xpaci', 'x7', 'pseudo'), 'x7 = strip_pac(x7)');
assert.equal(brief('xpaclri', '', 'pseudo'), 'lr = strip_pac(lr)');
assert.equal(brief('pacga', 'x8, x9, sp', 'pseudo'), 'x8 = pacga(x9, sp)');
assert.notEqual(brief('pacia', 'x0, x1', 'pseudo'), 'lr = sign(lr)');
assert.notEqual(brief('autia', 'x0, x1', 'pseudo'), 'lr = verify(lr)');
console.log('ARM64 PAuth presentation semantics: PASS');
