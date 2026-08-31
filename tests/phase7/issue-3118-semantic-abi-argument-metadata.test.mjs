import assert from 'node:assert/strict';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function-base.js';
import { ABIPlugin, registerABIPlugin } from '../../js/targets/abi/index.js';

let arguments_ = [];
const plugin = registerABIPlugin(new ABIPlugin({
  id:'test-3118-strict-argument-metadata', architectureId:'test-3118', semanticVersion:'1',
  classifyArguments:() => ({ arguments:arguments_, stackArguments:[] }),
}));
const adapter = semanticAbiAdapter(plugin);

arguments_ = [{ location:'register', reg:'x0', index:0 }, { location:'register', regs:['x1','x2'] }];
assert.deepEqual(adapter.argumentLocations().map(({ index, reg }) => ({ index, reg })), [
  { index:0, reg:'x0' }, { index:1, reg:'x1' }, { index:1, reg:'x2' },
]);
for (const reg of [['x0'], { toString(){ return 'x0'; } }, true, 1]) {
  arguments_ = [{ location:'registers', regs:[reg], index:0 }];
  assert.deepEqual(adapter.argumentLocations(), []);
}
for (const index of [['0'], '0', { valueOf(){ return 0; } }, true, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  arguments_ = [{ location:'register', reg:'x0', index }];
  assert.deepEqual(adapter.argumentLocations(), []);
}
arguments_ = [{ location:'register', reg:'x0' }];
assert.equal(adapter.argumentLocations()[0]?.index, 0);
console.log('issue-3118-semantic-abi-argument-metadata: PASS');
