import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';
import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';

let seq = 0;
const gp = (num) => ({ k:'reg', cls:'gp', num, bits:64, text:`x${num}` });
function lift(mnemonic, ops = [], extra = {}) {
  const instructionId = `arm64-selector-authority:${++seq}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, mode:'a64', ops, origin:{instructionIds:[instructionId]}, ...extra });
}
function liftSystem(mnemonic, ops = [], extra = {}) {
  const instructionId = `arm64-system-selector-authority:${++seq}`;
  return liftArm64SystemEffects({ instructionId, mnemonic, mode:'a64', ops, origin:{instructionIds:[instructionId]}, ...extra }, { instructionId });
}
function assertFailClosed(bundle, label, forbiddenKinds = ['barrier','intrinsic']) {
  assert.ok(bundle, `${label}: owner returns a bundle`);
  assert.equal(bundle.completeness, 'partial', `${label}: malformed authority is partial`);
  for (const kind of forbiddenKinds) assert.equal(bundle.operations.some((op) => op.kind === kind), false, `${label}: no definite ${kind}`);
}

// Valid architectural evidence remains semantic.
for (const option of ['sy','ish','ishst']) {
  const b = lift('dmb', [{k:'other', text:option}]);
  assert.equal(b.completeness, 'exact', `DMB ${option}`);
  assert.equal(b.operations.some((op)=>op.kind==='barrier'), true);
}
for (const crm of [0n, 15n]) {
  const b = lift('dsb', [{k:'imm', value:crm, text:`#${crm}`}]);
  assert.equal(b.completeness, 'exact', `DSB #${crm}`);
}
const clrex = lift('clrex', [{k:'imm', value:15n, text:'#15'}]);
assert.notEqual(clrex.completeness, 'partial');
assert.equal(clrex.operations.some((op)=>op.kind==='intrinsic'), true);

// Structured selector text cannot acquire authority by coercion.
for (const [label, text] of [
  ['array', ['sy']],
  ['object', {toString(){ return 'ish'; }}],
  ['boolean', true],
  ['number', 15],
]) {
  assertFailClosed(lift('dmb', [{k:'other', text}]), `DMB ${label}`, ['barrier']);
  assertFailClosed(lift('isb', [{k:'other', text}]), `ISB ${label}`, ['barrier']);
}

// CRM/CLREX immediates are typed bigint evidence; strings/numbers/arrays/objects do not become imm4.
for (const [label, value, text] of [
  ['numeric string', '15', '#15'],
  ['number', 15, '#15'],
  ['boolean', true, '#1'],
  ['array', [15], '#15'],
  ['object', {valueOf(){return 15;}}, '#15'],
]) {
  assertFailClosed(lift('dsb', [{k:'imm', value, text}]), `DSB ${label}`, ['barrier']);
  assertFailClosed(lift('clrex', [{k:'imm', value, text}]), `CLREX ${label}`, ['intrinsic']);
}

// System-owner maintenance selector shares the same string-only authority boundary.
const validDc = liftSystem('dc', [{k:'other', text:'ivac'}, gp(0)]);
assert.notEqual(validDc.completeness, 'partial');
assert.equal(validDc.operations.some((op)=>op.kind==='intrinsic'), true);
for (const [label, text] of [
  ['array', ['ivac']],
  ['object', {toString(){return 'ivac';}}],
  ['boolean', true],
  ['number', 1],
]) assertFailClosed(liftSystem('dc', [{k:'other', text}, gp(0)]), `DC ${label}`, ['intrinsic']);

// Explicit malformed fallback metadata must not override missing typed operands.
assertFailClosed(liftArm64AtomicEffects({mnemonic:'dmb', ops:[{k:'other', text:null}], barrierOption:'sy'}, {instructionId:'arm64-conflicting-barrier-fallback'}), 'DMB structured/fallback conflict', ['barrier']);

console.log('arm64-system-selector-authority: PASS');
