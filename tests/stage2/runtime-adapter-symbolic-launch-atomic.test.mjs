import assert from 'node:assert/strict';
import { SymbolicAdapter } from '../../js/adapters/index.js';

const adapter = new SymbolicAdapter();
await adapter.connect();
const validIr = { entry:0, blocks:[{ phis:[], insts:[], succ:[] }] };
const first = await adapter.launch({ ir:validIr });
assert.equal(first.engine, 'semantic-ir-symbolic');
assert.equal(await adapter.evaluate(), first);

await assert.rejects(
  adapter.launch({}),
  (error) => error?.code === 'missing-ir',
);
assert.equal(adapter.ir, null);
assert.equal(adapter.result, null);
await assert.rejects(
  adapter.evaluate(),
  (error) => error?.code === 'not-launched',
  'failed launch must not expose the previous symbolic result',
);
await adapter.disconnect();
