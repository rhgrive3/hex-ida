import assert from 'node:assert/strict';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

// #5716: the argument classifiers place FP/SIMD/HFA/HVA arguments in v0-v7,
// but the entry-register classifiers only recognized x0-x7 as arguments — a
// self-contradiction inside the same plugin. AAPCS64 (and its Darwin
// derivative) define v0-v7 as the FP/SIMD argument/result bank, with
// b/h/s/d/q as narrow views of the same registers.

for (const platform of ['ios', 'darwin', 'linux']) {
  const plugin = resolveABIPlugin({ architecture: 'arm64', platform });
  const v0 = plugin.classifyEntryRegister('v0');
  assert.deepEqual(v0, { kind: 'argument', reg: 'v0', index: 8, view: 'vector' });
  for (const [view, index] of [['d', 8], ['s', 8], ['h', 8], ['q', 8], ['b', 8]]) {
    const entry = plugin.classifyEntryRegister(`${view}0`);
    assert.equal(entry.kind, 'argument', `${view}0: kind`);
    assert.equal(entry.reg, 'v0', `${view}0: canonical v-register`);
    assert.equal(entry.view, view, `${view}0: view recorded`);
    assert.equal(entry.index, index, `${view}0: argument index`);
  }
  // x0-x7 integer arguments unchanged.
  assert.deepEqual(plugin.classifyEntryRegister('x3'), { kind: 'argument', reg: 'x3', index: 3 });
  // Non-argument registers stay incoming-state.
  assert.deepEqual(plugin.classifyEntryRegister('x30'), { kind: 'incoming-register-state', reg: 'x30' });
  assert.equal(plugin.classifyEntryRegister('v12').kind, 'incoming-register-state');
  assert.equal(plugin.classifyEntryRegister('x9').kind, 'incoming-register-state');
}

console.log('AAPCS64/Darwin entry-register v0-v7 argument classification (#5716): PASS');
