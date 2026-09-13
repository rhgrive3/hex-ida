import assert from 'node:assert/strict';
import { Emulator, EmulatorFault } from '../js/emu.js';

const PAUTH_CODE = 'pointer-authentication-unsupported';
const PAUTH_MNEMONICS = [
  'pacia', 'pacib', 'paciaz', 'pacibz', 'paciasp', 'pacibsp',
  'autia', 'autib', 'autiaz', 'autibz', 'autiasp', 'autibsp',
  'xpaclri', 'retaa', 'retab',
];

async function expectUnsupported(mn, ops) {
  const emu = new Emulator();
  let threw = null;
  try {
    await emu.execute(mn, ops, 0x400000n);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, `${mn} must not execute silently as a no-op`);
  assert.ok(threw instanceof EmulatorFault, `${mn} must stop with a structured EmulatorFault, got ${threw && threw.name}`);
  assert.equal(threw.code, PAUTH_CODE, `${mn} must report a dedicated unsupported stop code`);
}

// 1-5: every PAuth mnemonic the emulator cannot architecturally model stops
// fail-closed as unsupported instead of a fabricated NOP success.
for (const mn of PAUTH_MNEMONICS) {
  await expectUnsupported(mn, mn === 'retaa' || mn === 'retab' ? 'x30' : mn.endsWith('sp') ? '' : 'x0, x1');
}

// state is untouched at the stop: pacia x0,x1 must not rewrite x0 silently
{
  const emu = new Emulator();
  emu.set('x0', 0x1000n);
  emu.set('x1', 0x2000n);
  await assert.rejects(() => emu.execute('pacia', 'x0, x1', 0x400000n), EmulatorFault);
  assert.equal(emu.get('x0'), 0x1000n, 'a stopped pacia must not fake any register result');
}

// the ret family keeps plain RET semantics; RETAA/RETAB must not ride along
{
  const emu = new Emulator();
  emu.set('x30', 0x9000n);
  emu.callStack.push({ addr: 0x400000n, ret: 0x9000n });
  const jumped = await emu.execute('ret', 'x30', 0x400000n);
  assert.equal(jumped, 0x9000n, 'plain ret must still return through x30');
  await expectUnsupported('retaa', 'x30');
}

// step() surfaces the dedicated code so the run halts fail-closed in the UI.
for (const mn of ['paciasp', 'autiasp', 'retaa']) {
  const emu = new Emulator({ fetch: async () => ({ mn, ops: '' }) });
  emu.pc = 0x400000n;
  const r = await emu.step();
  assert.equal(r.ok, false, `${mn} must not report a successful step`);
  assert.equal(r.code, PAUTH_CODE, `${mn} stop must classify as pointer-authentication unsupported`);
  assert.ok(emu.stopped, `${mn} must leave the emulator stopped`);
  assert.equal(emu.pc, 0x400000n, `${mn} must not silently advance PC past the fault`);
}

// 7: architectural no-op/HINT-space instructions keep their existing behavior
for (const [mn, ops] of [['nop', ''], ['dmb', '#0'], ['dsb', '#0'], ['isb', '#0'], ['bti', '#0'], ['prfm', 'x0, [x1]']]) {
  const emu = new Emulator();
  emu.set('x0', 0x1n);
  const before = emu.get('x0');
  const jumped = await emu.execute(mn, ops, 0x400000n);
  assert.equal(jumped, null, `${mn} must stay a fall-through no-op`);
  assert.equal(emu.get('x0'), before, `${mn} must not touch x0`);
}

console.log('issue #4099 emulator pointer authentication fail-closed: ok');
