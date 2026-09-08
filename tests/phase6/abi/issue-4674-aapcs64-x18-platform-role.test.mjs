import test from 'node:test';
import assert from 'node:assert/strict';

import { registerRole } from '../../../js/abi/aapcs64/presentation.js';

/* Issue #4674: AAPCS64 leaves r18's role to the platform ABI — platforms that
 * assign it a dedicated use reserve it, every other platform may use it as an
 * additional caller-saved register.  The platform-independent presentation
 * helper pinned x18 to "platform-reserved" unconditionally, which misdescribes
 * generic AAPCS64/Linux targets. */

test('#4674: generic AAPCS64 x18 is not presented as unconditionally reserved', () => {
  const role = registerRole(18);
  assert.equal(role.id, 'x18');
  assert.match(role.en, /platform-specific/i);
  assert.match(role.en, /caller-saved/i);
  assert.doesNotMatch(role.en, /^platform-reserved register$/);
});

test('#4674: the description keeps both platform possibilities', () => {
  const role = registerRole(18);
  assert.match(role.en, /reserved/i, 'reserved-by-some-platforms stays documented');
  assert.match(role.ja, /プラットフォーム依存/);
});

test('#4674: surrounding register roles are unchanged', () => {
  assert.equal(registerRole(0).id, 'arg');
  assert.equal(registerRole(8).id, 'x8');
  assert.equal(registerRole(16).id, 'ip');
  assert.equal(registerRole(17).id, 'ip');
  assert.equal(registerRole(19).id, 'saved');
  assert.equal(registerRole(28).id, 'saved');
  assert.equal(registerRole(29).id, 'fp');
  assert.equal(registerRole(30).id, 'lr');
});
