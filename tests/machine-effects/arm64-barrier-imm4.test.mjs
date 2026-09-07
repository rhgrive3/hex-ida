import assert from 'node:assert/strict';

import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';

// Structured-input coverage complements the finite denominator's real decoder/encoding-word proof.
// Keep malformed structured shapes separate from the finite valid-encoding denominator.
let sequence = 0;
const imm = (value) => ({ k:'imm', text:`#${value}`, value:BigInt(value) });
const other = (text) => ({ k:'other', text });
function lift(mnemonic, ops = []) {
  const instructionId = `arm64-barrier-imm4-${sequence++}`;
  return liftArm64AtomicEffects({ mnemonic, ops }, { instructionId, origin:{ instructionIds:[instructionId] } });
}

for (const [crm, option, domain, access] of [
  [1, 'oshld', 'outer-shareable', 'loads'],
  [15, 'sy', 'full-system', 'all'],
]) {
  const b = lift('dsb', [imm(crm)]);
  assert.equal(b.completeness, 'exact');
  assert.deepEqual(
    { option:b.metadata.option, crm:b.metadata.crm, domain:b.metadata.domain, access:b.metadata.access },
    { option, crm, domain, access },
  );
}

for (const [crm, alias] of [[0, 'ssbb'], [4, 'pssbb']]) {
  const structured = lift('dsb', [imm(crm)]);
  assert.equal(structured.completeness, 'exact');
  assert.equal(structured.operations[0].kind, 'barrier');
  assert.equal(structured.metadata.option, alias);
  assert.equal(structured.metadata.alias, alias);
  assert.equal(structured.metadata.crm, crm);
  assert.equal(structured.metadata.domain, 'speculation');
  assert.equal(structured.metadata.access, 'store-bypass');

  const decodedAlias = lift(alias);
  assert.equal(decodedAlias.completeness, 'exact');
  assert.equal(decodedAlias.operations[0].kind, 'barrier');
  assert.equal(decodedAlias.metadata.option, alias);
  assert.equal(decodedAlias.metadata.alias, alias);
  assert.equal(decodedAlias.metadata.crm, crm);
  assert.equal(decodedAlias.metadata.domain, 'speculation');
  assert.equal(decodedAlias.metadata.access, 'store-bypass');
  assert.equal(lift(alias, [imm(crm)]).completeness, 'partial');
}

for (const crm of [8, 12]) {
  const b = lift('dsb', [imm(crm)]);
  assert.equal(b.completeness, 'exact');
  assert.equal(b.metadata.option, 'sy');
  assert.equal(b.metadata.crm, crm);
  assert.equal(b.metadata.reservedEncoding, true);
  assert.equal(b.operations[0].metadata.reservedEncoding, true);
  assert.equal(b.metadata.domain, 'full-system');
  assert.equal(b.metadata.access, 'all');
}

for (const b of [lift('dsb', [imm(-1)]), lift('dsb', [imm(16)])]) {
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.categories.includes('memory'));
}
assert.equal(lift('dsb', [other('sy')]).completeness, 'exact');
assert.equal(lift('dsb').metadata.option, 'sy');

for (const crm of [0, 14]) {
  const b = lift('isb', [imm(crm)]);
  assert.equal(b.completeness, 'exact');
  assert.equal(b.metadata.option, 'sy');
  assert.equal(b.metadata.crm, crm);
  assert.equal(b.metadata.reservedEncoding, true);
  assert.equal(b.operations[0].metadata.reservedEncoding, true);
  assert.deepEqual(
    { domain:b.operations[0].scope.domain, access:b.operations[0].scope.access },
    { domain:'instruction-stream', access:'instruction-fetch' },
  );
}
const isb15 = lift('isb', [imm(15)]);
assert.equal(isb15.completeness, 'exact');
assert.equal(isb15.metadata.crm, 15);
assert.equal('reservedEncoding' in isb15.metadata, false);
assert.equal(lift('isb').completeness, 'exact');
assert.equal(lift('isb', [other('sy')]).completeness, 'exact');
for (const b of [lift('isb', [imm(-1)]), lift('isb', [imm(16)]), lift('isb', [other('bad-option')])]) {
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.categories.includes('other'));
}

assert.equal(lift('dsb', [imm(1), imm(2)]).completeness, 'partial');
assert.equal(lift('isb', [imm(1), imm(2)]).completeness, 'partial');

console.log('arm64 barrier imm4 effects: PASS');
