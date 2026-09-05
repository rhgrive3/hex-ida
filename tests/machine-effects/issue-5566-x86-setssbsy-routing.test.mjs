import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { canonicalX86ConditionCode } from '../../js/targets/architecture/x86_64/effects/flags.js';

const indexSource = readFileSync(new URL('../../js/targets/architecture/x86_64/effects/index.js', import.meta.url), 'utf8');

// SETcc is a finite ISA family.  SETSSBSY and arbitrary set* spellings must
// never acquire integer/condition-code authority from the mnemonic prefix.
for (const condition of ['o','no','b','ae','e','ne','be','a','s','ns','p','np','l','ge','le','g']) {
  assert.ok(canonicalX86ConditionCode(condition), `SET${condition.toUpperCase()} condition must remain recognized`);
}
assert.equal(canonicalX86ConditionCode('ssbsy'), null);
assert.equal(canonicalX86ConditionCode('definitely-not-a-condition'), null);

assert.match(indexSource, /instructionFamily\.startsWith\('set'\)\s*&&\s*!isCanonicalSetccFamily\(instructionFamily\)/);
assert.match(indexSource, /const systemSet = liftX86SystemEffects\(instruction, context\)/);
assert.match(indexSource, /ownerId:'system', result:terminalize\(instruction, 'system', systemSet, context\)/);
assert.match(indexSource, /x86-extended-system-family-requires-dedicated-semantics/);
