import assert from 'node:assert/strict';
import { buildCfg, EDGE } from '../js/cfg.js';

function model() {
  return {
    basicBlocks: [
      { startRow:0, endRow:0, rows:[0] },
      { startRow:1, endRow:1, rows:[1] },
    ],
    instructions: [
      {
        row:0,
        address:0n,
        mnemonic:'b',
        data:false,
        isBranch:true,
        isCall:false,
        isConditional:false,
        isReturn:false,
        branchTarget:4n,
      },
      {
        row:1,
        address:4n,
        mnemonic:'ret',
        data:false,
        isBranch:true,
        isCall:false,
        isConditional:false,
        isReturn:true,
        branchTarget:null,
      },
    ],
    semantic:[],
  };
}

for (const rowOfAddress of [undefined, null, true, false, {}, [], 1, 'row']) {
  assert.doesNotThrow(() => buildCfg(model(), { rowOfAddress }));
  const cfg = buildCfg(model(), { rowOfAddress });
  assert.deepEqual(cfg.nodes[0].succ, [
    { to:-1, kind:EDGE.JUMP, target:4n, outside:true },
  ]);
}

let calls = 0;
const cfg = buildCfg(model(), {
  rowOfAddress(addr) {
    calls++;
    assert.equal(addr, 4n);
    return 1;
  },
});
assert.equal(calls, 1);
assert.deepEqual(cfg.nodes[0].succ, [
  { to:1, kind:EDGE.JUMP, target:4n },
]);

console.log('issue 3704 cfg rowOfAddress callback regression: ok');
