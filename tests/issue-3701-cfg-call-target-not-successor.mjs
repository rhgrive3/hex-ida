import assert from 'node:assert/strict';
import { buildCfg, EDGE } from '../js/cfg.js';

const model = {
  basicBlocks:[
    { startRow:0, endRow:0, rows:[0] },
    { startRow:1, endRow:1, rows:[1] },
    { startRow:2, endRow:2, rows:[2] },
  ],
  instructions:[
    { row:0, address:0n, mnemonic:'bl', data:false, isBranch:true, isCall:true, isConditional:false, isReturn:false, branchTarget:0x100n },
    { row:1, address:4n, mnemonic:'ret', data:false, isBranch:true, isCall:false, isConditional:false, isReturn:true, branchTarget:null },
    { row:2, address:0x100n, mnemonic:'ret', data:false, isBranch:true, isCall:false, isConditional:false, isReturn:true, branchTarget:null },
  ],
  semantic:[],
};

{
  const cfg = buildCfg(model, { rowOfAddress(addr) { return addr === 0x100n ? 2 : null; } });
  assert.deepEqual(cfg.nodes[0].succ, [{ to:1, kind:EDGE.FALL }]);
  assert.equal(cfg.nodes[2].pred.length, 0, 'callee block must not become an intraprocedural predecessor target');
  assert.equal(cfg.shapes.some((shape) => shape.at === 0 && (shape.kind === 'if' || shape.kind === 'if-else')), false);
}
{
  const cfg = buildCfg(model, { rowOfAddress() { return null; } });
  assert.deepEqual(cfg.nodes[0].succ, [{ to:1, kind:EDGE.FALL }], 'external direct call target must not produce an outside TAKEN edge');
}

{
  const tailCallModel = {
    ...model,
    instructions: [
      { row:0, address:0n, mnemonic:'b', data:false, isBranch:true, isCall:true, isTailCall:true, isConditional:false, isReturn:false, branchTarget:0x100n },
      ...model.instructions.slice(1),
    ],
  };
  const cfg = buildCfg(tailCallModel, { rowOfAddress() { return null; } });
  assert.deepEqual(cfg.nodes[0].succ, [{ to:-1, kind:EDGE.JUMP, target:0x100n, outside:true }], 'tail call to outside target must have no local FALL and emit outside JUMP');
  assert.equal(cfg.nodes[0].isExit, true, 'tail call node must be marked as an exit');
}

for (const [insn, expected] of [
  [{ mnemonic:'b.eq', isBranch:true, isCall:false, isConditional:true }, [EDGE.TAKEN, EDGE.FALL]],
  [{ mnemonic:'b', isBranch:true, isCall:false, isConditional:false }, [EDGE.JUMP]],
]) {
  const branchModel = {
    ...model,
    instructions:[
      { row:0, address:0n, data:false, isReturn:false, branchTarget:0x100n, ...insn },
      ...model.instructions.slice(1),
    ],
  };
  const cfg = buildCfg(branchModel, { rowOfAddress(addr) { return addr === 0x100n ? 2 : null; } });
  assert.deepEqual(cfg.nodes[0].succ.map((edge) => edge.kind), expected);
}

console.log('issue-3701 CFG direct call target regression: PASS');
