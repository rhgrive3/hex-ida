import { buildSemanticModel } from '../../../js/blocks.js';
import { buildIR } from '../../../js/ir-core.js';
import { projectedRegisterStateContext } from '../../../js/semantics/compat/index.js';
import { fixture } from './ir-fixtures.mjs';
import { identity } from './proof-fixtures.mjs';
import { decompileSemantic, readSemanticConditionalRegions } from '../../../js/decompiler/semantic-core.js';
import { prepareConditionalRegionStructure } from '../../../js/decompiler/phase8/conditional-region-structure.js';
import { prepareConditionalRegionReachability } from '../../../js/decompiler/phase8/conditional-region-reachability.js';

export function conditionalRegionFixture({ kind = 'cbz', predicate = 'xor', after = null, mutate = () => {}, armEffect = () => {} } = {}) {
  const f = fixture('reachability'); f.block(0);
  const input = f.opaque(8); input.reg = 'x0'; input.index = 0;
  const value = typeof predicate === 'function' ? predicate(f, input)
    : predicate === 'xor' ? f.binary('xor', input, input, 8) : input;
  f.conditionalBranch(value, 1, 2);
  f.block(1); const yes = f.constant(1n, 8); armEffect(f, yes); f.branch(3);
  f.block(2); const no = f.constant(2n, 8); armEffect(f, no); f.branch(3);
  f.block(3); const merged = f.phi([[1, yes], [2, no]], 8);
  if (after === 'branch' || after === 'loop') {
    f.conditionalBranch(input, 4, 5);
    f.block(4); if (after === 'loop') f.branch(3); else f.branch(6);
    f.block(5); if (after === 'loop') f.ret(); else { f.branch(6); f.block(6); f.ret(); }
  } else { if (after === 'call') f.call(8); f.ret(); }
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => { inst.id = `reach_${index}`; inst.row = index; inst.address = 0x1000n + BigInt(index * 4); });
  for (const block of ir.blocks) {
    block.startRow = block.insts[0].row; block.endRow = block.insts.at(-1).row;
    const term = block.insts.at(-1);
    if (term.op === 'br' || term.op === 'cbr') {
      term.extra = { kind:block.index === 0 ? kind : 'cbnz', targetBlock:block.succ[0], target:ir.blocks[block.succ[0]].insts[0].address };
    }
    if (term.op === 'ret') term.args = [{ value:merged }];
  }
  // The loop re-enters the PHI join, so give its backedge the exact incoming value.
  if (after === 'loop') merged.def.incoming.push({ from:4, value:merged });
  mutate(ir);
  const seed = decompileSemantic({ name:'reachability', instructions:ir.instructions, calls:[] },
    { ir, deterministicTransforms:true, phase8PrepareRegionProof:true });
  const region = readSemanticConditionalRegions(seed)?.regions.find(item => item.selection.header === 0);
  const structure = prepareConditionalRegionStructure(region?.record, ir, { identity, timeoutMs:5000 });
  return { ir, seed, region, structure, run:extra => prepareConditionalRegionReachability(structure, ir,
    { identity, addressBits:8, timeoutMs:5000, backendTier:'exhaustive', ...extra }) };
}

export function textRowConditionalRegionFixture({ returnSetup = null } = {}) {
  // Exercise the normal model/SSA/compat producer, not a fabricated legacy CFG.
  // These are parsed instruction rows, not compiler or binary-decoder evidence.
  const lines = returnSetup
    ? [returnSetup, 'eor w1, w0, w0', 'cbnz w1, #0x100000014', 'mov w0, #1',
      'b #0x100000018', 'mov w0, #2', 'ret']
    : ['eor w1, w0, w0', 'cbnz w1, #0x100000010', 'mov w0, #1',
      'b #0x100000014', 'mov w0, #2', 'ret'];
  const rows = lines.map((text, row) => {
    const [mn, ...ops] = text.split(' ');
    return { mn, ops:ops.join(' '), row, address:0x100000000n + BigInt(row * 4) };
  });
  const options = { startRow:0, endRow:rows.length - 1, semanticMigrationMode:'semantic-v2-compat',
    rowOfAddress:address => rows.find(row => row.address === BigInt(address))?.row ?? null,
    addrOfRow:row => rows[row]?.address ?? null };
  const model = buildSemanticModel(rows, options), ir = buildIR(model, options);
  return { model, ir, options, identity:{ ...identity, ...projectedRegisterStateContext(ir) } };
}
