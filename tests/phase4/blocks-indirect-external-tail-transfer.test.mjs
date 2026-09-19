import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel, indirectExternalTailTransferProof } from '../../js/blocks-base.js';
import { buildCfg, EDGE } from '../../js/cfg.js';
import { decompile } from '../../js/decompile.js';

const rawExternalTail = () => [
  { row:0, address:0x1000n, mn:'adrp', ops:'x1, #0x13000' },
  { row:1, address:0x1004n, mn:'ldr', ops:'x1, [x1, #0xfc0]' },
  { row:2, address:0x1008n, mn:'mov', ops:'x16, x1' },
  { row:3, address:0x100cn, mn:'br', ops:'x16' },
];
const rowOfAddress = (address) => {
  const value = BigInt(address);
  if (value < 0x1000n || value > 0x100cn || (value - 0x1000n) % 4n !== 0n) return null;
  return Number((value - 0x1000n) / 4n);
};

test('relocation-backed external pointer flow proves an indirect BR tail transfer', () => {
  const model = buildSemanticModel(rawExternalTail(), {
    startRow:0, endRow:3, name:'tail', rowOfAddress,
    externalPointerSymbolFor:(address) => address === 0x13fc0n ? '_ITM_deregisterTMCloneTable' : null,
  });
  const branch = model.instructions.at(-1);
  const proof = indirectExternalTailTransferProof(branch);

  assert.equal(branch.isCall, true);
  assert.equal(branch.isTailCall, true);
  assert.deepEqual(proof, {
    kind:'external-symbol-pointer-tail-transfer',
    targetName:'_ITM_deregisterTMCloneTable',
    pointerAddress:0x13fc0n,
    targetRegister:'x16',
    sourceRow:2,
    branchRow:3,
  });
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].name, '_ITM_deregisterTMCloneTable');
  assert.equal(model.calls[0].tailTransfer, true);

  const cfg = buildCfg(model, { rowOfAddress });
  assert.equal(cfg.nodes.at(-1).isExit, true);
  assert.deepEqual(cfg.nodes.at(-1).succ, []);

  const result = decompile(model, { name:'tail', addr:0x1000n });
  assert.match(result.pseudocode, /ITM_deregisterTMCloneTable/);
  assert.doesNotMatch(result.pseudocode, /unresolved-indirect-control-flow/);
});

test('ordinary unresolved BR remains unknown without external-pointer authority', () => {
  const model = buildSemanticModel(rawExternalTail(), { startRow:0, endRow:3, name:'dispatch', rowOfAddress });
  const branch = model.instructions.at(-1);

  assert.equal(branch.isCall, false);
  assert.notEqual(branch.isTailCall, true);
  assert.equal(indirectExternalTailTransferProof(branch), null);
  const cfg = buildCfg(model, { rowOfAddress });
  assert.deepEqual(cfg.nodes.at(-1).succ, [{ to:-1, kind:EDGE.UNKNOWN }]);
  assert.equal(cfg.nodes.at(-1).isExit, false);
});

test('a named non-pointer address cannot authorize an indirect BR tail transfer', () => {
  const model = buildSemanticModel(rawExternalTail(), {
    startRow:0, endRow:3, name:'dispatch', rowOfAddress,
    externalPointerSymbolFor:() => null,
  });
  const branch = model.instructions.at(-1);
  assert.equal(branch.isCall, false);
  assert.equal(indirectExternalTailTransferProof(branch), null);
});
