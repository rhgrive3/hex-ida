import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator, EmulatorFault } from '../js/emu.js';

const STRUCTURED_SELECTORS = [
  ['array wrapping x0', ['x0']],
  ['array wrapping pc', ['pc']],
  ['array wrapping sp', ['sp']],
  ['object toString to pc', { toString() { return 'pc'; } }],
  ['object toString to x0', { toString() { return 'x0'; } }],
];

const PRIMITIVE_NON_STRINGS = [
  ['number', 42],
  ['boolean true', true],
  ['boolean false', false],
  ['zero', 0],
  ['bigint', 0n],
  ['null', null],
  ['undefined', undefined],
];

function rejection(emu, selector, value) {
  const before = { x0: emu.get('x0'), pc: emu.get('pc'), sp: emu.get('sp'), x29: emu.get('x29'), x30: emu.get('x30') };
  let thrown = null;
  try {
    emu.set(selector, value);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof EmulatorFault, `set(${JSON.stringify(String(selector))}) must throw an EmulatorFault`);
  assert.equal(thrown.code, 'invalid-register');
  const after = { x0: emu.get('x0'), pc: emu.get('pc'), sp: emu.get('sp'), x29: emu.get('x29'), x30: emu.get('x30') };
  assert.deepEqual(after, before, 'a rejected selector must not mutate any register');
  let readThrown = null;
  try {
    emu.get(selector);
  } catch (error) {
    readThrown = error;
  }
  assert.ok(readThrown instanceof EmulatorFault, 'get() must enforce the same selector contract as set()');
  assert.equal(readThrown.code, 'invalid-register');
}

test('#4699 structured register selectors are rejected instead of String() coerced', () => {
  const emu = new Emulator({});
  for (const [label, selector] of STRUCTURED_SELECTORS) {
    rejection(emu, selector, 0x1234n);
  }
});

test('#4699 non-string primitive register selectors are rejected on get and set', () => {
  const emu = new Emulator({});
  for (const [label, selector] of PRIMITIVE_NON_STRINGS) {
    rejection(emu, selector, 0x1234n);
  }
});

test('#4699 a rejected structured selector cannot write pc or fp/lr aliases', () => {
  const emu = new Emulator({});
  emu.set('pc', 0x400n);
  emu.set('fp', 0x500n);
  emu.set('lr', 0x600n);
  assert.throws(() => emu.set(['pc'], 0x1234n), (error) => error instanceof EmulatorFault && error.code === 'invalid-register');
  assert.throws(() => emu.set({ toString() { return 'fp'; } }, 0x1234n), (error) => error instanceof EmulatorFault && error.code === 'invalid-register');
  assert.throws(() => emu.set({ toString() { return 'lr'; } }, 0x1234n), (error) => error instanceof EmulatorFault && error.code === 'invalid-register');
  assert.equal(emu.get('pc'), 0x400n);
  assert.equal(emu.get('x29'), 0x500n);
  assert.equal(emu.get('x30'), 0x600n);
});

test('#4699 canonical string selectors keep their existing contract', () => {
  const emu = new Emulator({});
  emu.set('x0', 0x11n);
  assert.equal(emu.get('x0'), 0x11n);
  emu.set('w1', 0xdeadbeefn);
  assert.equal(emu.get('w1'), 0xdeadbeefn);
  assert.equal(emu.get('x1'), 0xdeadbeefn);
  emu.set('sp', 0x2000n);
  assert.equal(emu.get('sp'), 0x2000n);
  emu.set('pc', 0x400n);
  assert.equal(emu.get('pc'), 0x400n);
  emu.set('fp', 0x500n);
  assert.equal(emu.get('x29'), 0x500n);
  assert.equal(emu.get('fp'), 0x500n);
  emu.set('lr', 0x600n);
  assert.equal(emu.get('x30'), 0x600n);
  assert.equal(emu.get('lr'), 0x600n);
  assert.equal(emu.get('xzr'), 0n);
  assert.equal(emu.get('wzr'), 0n);
  emu.set('x2', 0x77n);
  assert.equal(emu.get('x2'), 0x77n);
});

test('#4699 case-insensitive string selectors keep working', () => {
  const emu = new Emulator({});
  emu.set('X0', 0x11n);
  assert.equal(emu.get('x0'), 0x11n);
  emu.set('PC', 0x400n);
  assert.equal(emu.get('pc'), 0x400n);
  emu.set('FP', 0x500n);
  assert.equal(emu.get('x29'), 0x500n);
  emu.set('LR', 0x600n);
  assert.equal(emu.get('x30'), 0x600n);
  emu.set('Sp', 0x2000n);
  assert.equal(emu.get('sp'), 0x2000n);
  emu.set('W0', 0x22n);
  assert.equal(emu.get('w0'), 0x22n);
});

test('#4699 unknown and padded string selectors stay rejected', () => {
  const emu = new Emulator({});
  for (const selector of ['', ' x0', 'x0 ', 'x31', 'q0', 'notareg']) {
    assert.throws(() => emu.get(selector), (error) => error instanceof EmulatorFault && error.code === 'invalid-register', `${JSON.stringify(selector)} must be rejected`);
    assert.throws(() => emu.set(selector, 1n), (error) => error instanceof EmulatorFault && error.code === 'invalid-register', `${JSON.stringify(selector)} must be rejected`);
  }
});

test('#4699 register identity in the rejection details is the original selector', () => {
  const emu = new Emulator({});
  const selector = ['x0'];
  let thrown = null;
  try {
    emu.set(selector, 1n);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof EmulatorFault);
  assert.equal(thrown.code, 'invalid-register');
  assert.equal(thrown.details.register, selector);
});
