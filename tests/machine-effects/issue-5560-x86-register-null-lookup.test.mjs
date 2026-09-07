import assert from 'node:assert/strict';
import { x86RegisterDescriptor } from '../../js/targets/architecture/x86_64/registers.js';

const core = globalThis.HexX86Registers;
assert.ok(core, 'x86 core register contract should be installed');

assert.equal(core.registerDescriptor(null), null);
assert.equal(core.registerDescriptor(undefined), null);
assert.equal(core.registerDescriptor('rax')?.id, 'rax');
assert.equal(core.registerDescriptor({ registerId:'rax' })?.id, 'rax');
assert.equal(core.registerDescriptor({ name:'RAX' })?.id, 'rax');
assert.equal(core.registerDescriptor({ registerId:'definitely-not-a-register' }), null);

assert.equal(x86RegisterDescriptor(null), null);
assert.equal(x86RegisterDescriptor(undefined), null);
assert.equal(x86RegisterDescriptor('rax')?.id, 'rax');

console.log('issue-5560 x86 register null lookup regression: ok');
