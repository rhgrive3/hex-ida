import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { buildSemanticSsa, validateSemanticSsa } from '../../js/semantics/ssa/index.js';
import { projectLegacyAddress } from '../../js/semantics/compat/semantic-ir-v2-to-v1-address.js';
import {
  finalizeLegacyProjection,
  propagateScalarConstants,
} from '../../js/semantics/compat/semantic-ir-v2-to-v1-finalize.js';
import {
  addScalarSsaPhis,
  assignInstructionIds,
} from '../../js/semantics/compat/semantic-ir-v2-to-v1-memory.js';
import { V1_OP, V1_VK } from '../../js/semantics/compat/semantic-ir-v2-to-v1-core.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const origin = (id, address = 0x1000n) => ({
  instructionIds: [`ins_${id}`],
  virtualRanges: [{ start: address, end: address + 4n }],
});
const bit32 = { kind: 'bitvector', widthBits: 32 };
const bit64 = { kind: 'bitvector', widthBits: 64 };
const addr64 = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const regVar = (name) => ({
  key: `phys.${name}`,
  kind: 'physical-state',
  scope: 'function',
  physicalIdentity: { kind: 'register', registerId: name },
});
const memory = (addressValueId, widthBits = 32) => ({
  addressSpace: 'memory',
  addressExpr: { valueId: addressValueId },
  widthBits,
  endian: 'little',
  alignment: Math.max(1, widthBits / 8),
  volatility: false,
  atomic: false,
  ordering: 'unknown',
  faults: [],
});

test('1. buildMemorySsa worklist dataflow & inline byteCoverage scale deterministically on multi-block/multi-region CFG', () => {
  const numStages = 30; // 30 diamonds = 91 blocks
  const numRegions = 40;
  const regions = [];
  for (let r = 0; r < numRegions; r += 1) {
    regions.push(createMemoryRegionRef({
      id: `reg_stack_${String(r).padStart(3, '0')}`,
      kind: 'stack-fixed',
      functionId: 'fn_scale_mssa',
      offset: -(r + 1) * 8,
      widthBits: 32,
    }));
  }

  const values = [
    { id: 'v_cond', kind: 'definition', definitionNodeId: 'n_cond', machineType: bit32, origin: origin('cond') },
    { id: 'v_val', kind: 'definition', definitionNodeId: 'n_val', machineType: bit32, origin: origin('val') },
    { id: 'v_addr', kind: 'definition', definitionNodeId: 'n_addr', machineType: addr64, origin: origin('addr') },
  ];
  const nodes = [];
  const cfgBlocks = [];
  const irBlocks = [];
  let addrCounter = 0x1000n;
  const nextOrigin = (tag) => {
    const o = origin(tag, addrCounter);
    addrCounter += 4n;
    return o;
  };

  // Entry block b_000 initializes v_val and v_addr and branches to first diamond
  nodes.push(
    { id: 'n_val', kind: 'const', operator: 'const', blockId: 'b_000', inputs: [], outputs: ['v_val'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 32, value: 42n } }, origin: nextOrigin('n_val') },
    { id: 'n_addr', kind: 'state-read', blockId: 'b_000', inputs: [], outputs: ['v_addr'], variable: regVar('sp', 64), origin: nextOrigin('n_addr') },
    { id: 'n_cond', kind: 'const', operator: 'const', blockId: 'b_000', inputs: [], outputs: ['v_cond'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 32, value: 1n } }, origin: nextOrigin('n_cond') },
    { id: 'n_br_0', kind: 'conditional-branch', blockId: 'b_000', inputs: ['v_cond'], outputs: [], targets: ['b_L_000', 'b_R_000'], origin: nextOrigin('n_br_0') },
  );
  irBlocks.push({ id: 'b_000', nodeIds: ['n_val', 'n_addr', 'n_cond', 'n_br_0'], origin: nextOrigin('b_000') });
  cfgBlocks.push({
    id: 'b_000',
    predecessors: [],
    successors: [
      { to: 'b_L_000', kind: 'conditional-true' },
      { to: 'b_R_000', kind: 'conditional-false' },
    ],
  });

  const regionByNodeId = new Map();
  for (let s = 0; s < numStages; s += 1) {
    const pad = String(s).padStart(3, '0');
    const prevJoin = s === 0 ? 'b_000' : `b_J_${String(s - 1).padStart(3, '0')}`;
    const leftId = `b_L_${pad}`;
    const rightId = `b_R_${pad}`;
    const joinId = `b_J_${pad}`;
    const nextLeft = `b_L_${String(s + 1).padStart(3, '0')}`;
    const nextRight = `b_R_${String(s + 1).padStart(3, '0')}`;
    const targetRegion = regions[s % numRegions];

    const stL = `n_st_L_${pad}`;
    const brL = `n_br_L_${pad}`;
    const ldR = `n_ld_R_${pad}`;
    const vLdR = `v_ld_R_${pad}`;
    const brR = `n_br_R_${pad}`;
    const ldJ = `n_ld_J_${pad}`;
    const vLdJ = `v_ld_J_${pad}`;
    const termJ = s + 1 < numStages ? `n_br_J_${pad}` : `n_ret_${pad}`;

    values.push(
      { id: vLdR, kind: 'definition', definitionNodeId: ldR, machineType: bit32, origin: nextOrigin(vLdR) },
      { id: vLdJ, kind: 'definition', definitionNodeId: ldJ, machineType: bit32, origin: nextOrigin(vLdJ) },
    );
    regionByNodeId.set(stL, targetRegion);
    regionByNodeId.set(ldR, targetRegion);
    regionByNodeId.set(ldJ, targetRegion);

    nodes.push(
      { id: stL, kind: 'store', blockId: leftId, inputs: ['v_addr', 'v_val'], outputs: [], memory: memory('v_addr', 32), origin: nextOrigin(stL) },
      { id: brL, kind: 'branch', blockId: leftId, inputs: [], outputs: [], targets: [joinId], origin: nextOrigin(brL) },
      { id: ldR, kind: 'load', blockId: rightId, inputs: ['v_addr'], outputs: [vLdR], memory: memory('v_addr', 32), origin: nextOrigin(ldR) },
      { id: brR, kind: 'branch', blockId: rightId, inputs: [], outputs: [], targets: [joinId], origin: nextOrigin(brR) },
      { id: ldJ, kind: 'load', blockId: joinId, inputs: ['v_addr'], outputs: [vLdJ], memory: memory('v_addr', 32), origin: nextOrigin(ldJ) },
    );
    if (s + 1 < numStages) {
      nodes.push({ id: termJ, kind: 'conditional-branch', blockId: joinId, inputs: ['v_cond'], outputs: [], targets: [nextLeft, nextRight], origin: nextOrigin(termJ) });
    } else {
      nodes.push({ id: termJ, kind: 'return', blockId: joinId, inputs: [], outputs: [], origin: nextOrigin(termJ) });
    }

    irBlocks.push(
      { id: leftId, nodeIds: [stL, brL], origin: nextOrigin(`ir_${leftId}`) },
      { id: rightId, nodeIds: [ldR, brR], origin: nextOrigin(`ir_${rightId}`) },
      { id: joinId, nodeIds: [ldJ, termJ], origin: nextOrigin(`ir_${joinId}`) },
    );
    cfgBlocks.push(
      { id: leftId, predecessors: [prevJoin], successors: [{ to: joinId, kind: 'branch' }] },
      { id: rightId, predecessors: [prevJoin], successors: [{ to: joinId, kind: 'branch' }] },
      {
        id: joinId,
        predecessors: [leftId, rightId],
        successors: s + 1 < numStages
          ? [{ to: nextLeft, kind: 'conditional-true' }, { to: nextRight, kind: 'conditional-false' }]
          : [],
      },
    );
  }

  const cfg = createSemanticCfg({ functionId: 'fn_scale_mssa', entryBlockId: 'b_000', blocks: cfgBlocks });
  const ir = createSemanticIrFunction({
    functionId: 'fn_scale_mssa',
    entryBlockId: 'b_000',
    values,
    nodes,
    blocks: irBlocks,
    origin: origin('fn_scale_mssa'),
  });

  const opts = {
    regions,
    resolveRegion: (node) => regionByNodeId.get(node.id) ?? null,
    queryAlias: (left, right) => (left.id === right.id ? 'must' : 'no'),
  };

  const t0 = performance.now();
  const mssa1 = buildMemorySsa(ir, cfg, opts);
  const elapsedMs = performance.now() - t0;
  const mssa2 = buildMemorySsa(ir, cfg, opts);

  assert.equal(mssa1.canonicalDigest, mssa2.canonicalDigest, 'buildMemorySsa must be 100% deterministic');
  assert.equal(mssa1.byteCoverage.length, numStages * 2, 'every load must have a byteCoverage entry');
  for (const cov of mssa1.byteCoverage) {
    assert.equal(cov.regionAliasStates.length, mssa1.regions.length, 'regionAliasStates must cover all regions');
    assert.equal(cov.regionStates.length, 1, 'disjoint stack load should have exactly 1 aliasing regionState');
  }
  const phis = mssa1.definitions.filter((d) => d.kind === 'memory-phi');
  assert.equal(phis.length, numStages, 'each diamond join must emit a memory-phi for its written region');
  assert.ok(elapsedMs < 5000, `expected fast worklist MemorySSA build, took ${elapsedMs.toFixed(1)}ms`);
});

test('2. validateSemanticSsa computeExpectedPhiBlocks scales with min-heap and catches missing phis', () => {
  const numDiamonds = 40; // 121 blocks
  const values = [
    { id: 'v_cond', kind: 'definition', definitionNodeId: 'n_c', machineType: bit32, origin: origin('v_cond') },
    { id: 'v_0', kind: 'definition', definitionNodeId: 'n_0', machineType: bit64, origin: origin('v_0') },
    { id: 'v_1', kind: 'definition', definitionNodeId: 'n_1', machineType: bit64, origin: origin('v_1') },
  ];
  const nodes = [
    { id: 'n_c', kind: 'const', operator: 'const', blockId: 'b_000', inputs: [], outputs: ['v_cond'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 32, value: 1n } }, origin: origin('n_c') },
    { id: 'n_0', kind: 'const', operator: 'const', blockId: 'b_000', inputs: [], outputs: ['v_0'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 0n } }, origin: origin('n_0') },
    { id: 'n_1', kind: 'const', operator: 'const', blockId: 'b_000', inputs: [], outputs: ['v_1'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 1n } }, origin: origin('n_1') },
    { id: 'n_w0', kind: 'state-write', blockId: 'b_000', inputs: ['v_0'], outputs: [], variable: regVar('x0', 64), origin: origin('n_w0') },
    { id: 'n_br0', kind: 'conditional-branch', blockId: 'b_000', inputs: ['v_cond'], outputs: [], targets: ['b_L_000', 'b_R_000'], origin: origin('n_br0') },
  ];
  const irBlocks = [{ id: 'b_000', nodeIds: ['n_c', 'n_0', 'n_1', 'n_w0', 'n_br0'], origin: origin('b_000') }];
  const cfgBlocks = [{
    id: 'b_000',
    predecessors: [],
    successors: [
      { to: 'b_L_000', kind: 'conditional-true' },
      { to: 'b_R_000', kind: 'conditional-false' },
    ],
  }];

  for (let d = 0; d < numDiamonds; d += 1) {
    const pad = String(d).padStart(3, '0');
    const prevJoin = d === 0 ? 'b_000' : `b_J_${String(d - 1).padStart(3, '0')}`;
    const leftId = `b_L_${pad}`;
    const rightId = `b_R_${pad}`;
    const joinId = `b_J_${pad}`;
    const nextL = `b_L_${String(d + 1).padStart(3, '0')}`;
    const nextR = `b_R_${String(d + 1).padStart(3, '0')}`;
    const wL = `n_wL_${pad}`;
    const brL = `n_brL_${pad}`;
    const brR = `n_brR_${pad}`;
    const rJ = `n_rJ_${pad}`;
    const vRJ = `v_rJ_${pad}`;
    const termJ = d + 1 < numDiamonds ? `n_brJ_${pad}` : `n_ret_${pad}`;

    values.push({ id: vRJ, kind: 'definition', definitionNodeId: rJ, machineType: bit64, origin: origin(vRJ) });
    nodes.push(
      { id: wL, kind: 'state-write', blockId: leftId, inputs: ['v_1'], outputs: [], variable: regVar('x0', 64), origin: origin(wL) },
      { id: brL, kind: 'branch', blockId: leftId, inputs: [], outputs: [], targets: [joinId], origin: origin(brL) },
      { id: brR, kind: 'branch', blockId: rightId, inputs: [], outputs: [], targets: [joinId], origin: origin(brR) },
      { id: rJ, kind: 'state-read', blockId: joinId, inputs: [], outputs: [vRJ], variable: regVar('x0', 64), origin: origin(rJ) },
    );
    if (d + 1 < numDiamonds) {
      nodes.push({ id: termJ, kind: 'conditional-branch', blockId: joinId, inputs: ['v_cond'], outputs: [], targets: [nextL, nextR], origin: origin(termJ) });
    } else {
      nodes.push({ id: termJ, kind: 'return', blockId: joinId, inputs: [vRJ], outputs: [], origin: origin(termJ) });
    }
    irBlocks.push(
      { id: leftId, nodeIds: [wL, brL], origin: origin(`ir_${leftId}`) },
      { id: rightId, nodeIds: [brR], origin: origin(`ir_${rightId}`) },
      { id: joinId, nodeIds: [rJ, termJ], origin: origin(`ir_${joinId}`) },
    );
    cfgBlocks.push(
      { id: leftId, predecessors: [prevJoin], successors: [{ to: joinId, kind: 'branch' }] },
      { id: rightId, predecessors: [prevJoin], successors: [{ to: joinId, kind: 'branch' }] },
      {
        id: joinId,
        predecessors: [leftId, rightId],
        successors: d + 1 < numDiamonds
          ? [{ to: nextL, kind: 'conditional-true' }, { to: nextR, kind: 'conditional-false' }]
          : [],
      },
    );
  }

  const cfg = createSemanticCfg({ functionId: 'fn_ssa_heap', entryBlockId: 'b_000', blocks: cfgBlocks });
  const ir = createSemanticIrFunction({
    functionId: 'fn_ssa_heap',
    entryBlockId: 'b_000',
    values,
    nodes,
    blocks: irBlocks,
    origin: origin('fn_ssa_heap'),
  });
  const ssa = buildSemanticSsa(ir, cfg);
  const t0 = performance.now();
  const validated = validateSemanticSsa(ssa, ir, cfg);
  const elapsedMs = performance.now() - t0;
  assert.ok(validated, 'validateSemanticSsa should succeed');
  assert.ok(elapsedMs < 3000, `expected fast min-heap SSA validation, took ${elapsedMs.toFixed(1)}ms`);

  // Removing a required phi must still be caught
  const missingPhiSsa = {
    ...ssa,
    definitions: ssa.definitions.filter((d) => !(d.kind === 'phi' && d.blockId === 'b_J_000')),
  };
  assert.throws(() => validateSemanticSsa(missingPhiSsa, ir, cfg), /semantic-ssa/);
});

test('3. compat addScalarSsaPhis, assignInstructionIds, and worklist propagateScalarConstants preserve exact order & scale linearly', () => {
  // 3a. addScalarSsaPhis preserves reversed prepend order (matching original unshift) and assignInstructionIds avoids O(I^2)
  const blockCount = 1;
  const instCount = 300;
  const phiCount = 150;
  const baseInsts = [];
  for (let i = 0; i < instCount; i += 1) {
    baseInsts.push({ id: -1, op: V1_OP.CONST, sub: null, block: 0, row: i, args: [], dst: null });
  }
  const projected = {
    blocks: [{ index: 0, startRow: 0, endRow: instCount, phis: [], insts: baseInsts.slice(0, 10) }],
    instructions: baseInsts.slice(),
    byRow: new Map(),
  };
  const valuesById = new Map();
  const phiDefs = [];
  for (let p = 0; p < phiCount; p += 1) {
    const valueId = `phi_v_${p}`;
    valuesById.set(valueId, { id: p, kind: V1_VK.TEMP, reg: `x${p % 8}`, bits: 64, uses: [], def: null });
    phiDefs.push({
      definitionId: `def_${p}`,
      kind: 'phi',
      valueId,
      blockId: 'b0',
      variableKey: `reg:x${p % 8}`,
      sourceEntityId: `phi_src_${p}`,
      incoming: [],
      origin: origin(`phi_${p}`),
      proof: { variableIdentity: { kind: 'register', name: `x${p % 8}` } },
    });
  }
  addScalarSsaPhis(
    projected,
    { definitions: phiDefs, uses: [] },
    valuesById,
    new Map([['b0', 0]]),
    new Map(),
  );
  assert.equal(projected.instructions.length, phiCount + instCount);
  assert.equal(projected.instructions[0].semanticSsaValueId, `phi_v_${phiCount - 1}`);
  assert.equal(projected.instructions[phiCount - 1].semanticSsaValueId, 'phi_v_0');
  assert.equal(projected.blocks[0].phis.length, phiCount);
  assert.equal(projected.blocks[0].phis[0].semanticSsaValueId, 'phi_v_0');

  assignInstructionIds(projected);
  assert.equal(projected.blocks[0].insts.length, instCount, 'all non-PHI instructions must be in block.insts without duplicates');
  assert.equal(projected.instructions[0].id, 0);
  assert.equal(projected.instructions[projected.instructions.length - 1].id, phiCount + instCount - 1);

  // 3b. Reverse-ordered constant folding chain (worst case for naive O(N^2) propagateScalarConstants)
  const chainLen = 400;
  const vals = Array.from({ length: chainLen }, (_, i) => ({
    id: i,
    kind: V1_VK.TEMP,
    bits: 64,
    const: null,
    uses: [],
    def: null,
  }));
  const oneVal = { id: chainLen, kind: V1_VK.CONST, bits: 64, const: 1n, uses: [], def: null };
  // Build instructions in reverse dependency order: inst[0] depends on inst[1], ..., inst[chainLen-1] is CONST 0
  const chainInsts = [];
  for (let i = 0; i < chainLen - 1; i += 1) {
    const inst = {
      id: i,
      op: V1_OP.BIN,
      sub: 'add',
      dst: vals[i],
      args: [{ value: vals[i + 1] }, { value: oneVal }],
      extra: {},
    };
    vals[i].def = inst;
    chainInsts.push(inst);
  }
  const seedInst = {
    id: chainLen - 1,
    op: V1_OP.CONST,
    sub: null,
    dst: vals[chainLen - 1],
    args: [],
    extra: { value: 10n },
  };
  vals[chainLen - 1].def = seedInst;
  chainInsts.push(seedInst);

  const observer = { expected: new Set(), unavailable: new Set(), records: [] };
  const t0 = performance.now();
  propagateScalarConstants({ instructions: chainInsts }, observer);
  const elapsedMs = performance.now() - t0;

  assert.equal(vals[chainLen - 1].const, 10n);
  assert.equal(vals[0].const, 10n + BigInt(chainLen - 1));
  assert.equal(observer.records[0].round, 0);
  assert.equal(observer.records[1].round, 1);
  assert.ok(elapsedMs < 1000, `worklist constant propagation should be fast, took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(blockCount, 1);
});

test('4. compat foldInstruction and semanticIndexTerm support normalized machine opcodes (orr, eor, lsl, lsr, asr)', () => {
  const mkConst = (id, value, bits = 32) => ({
    id,
    kind: V1_VK.CONST,
    bits,
    const: BigInt.asUintN(bits, value),
    uses: [],
    def: null,
  });
  const mkTemp = (id, bits = 32) => ({
    id,
    kind: V1_VK.TEMP,
    bits,
    const: null,
    uses: [],
    def: null,
  });

  const aOr = mkConst(1, 0x1200n, 32);
  const bOr = mkConst(2, 0x0034n, 32);
  const dOr = mkTemp(3, 32);

  const aEor = mkConst(4, 0xff0fn, 32);
  const bEor = mkConst(5, 0x0f0fn, 32);
  const dEor = mkTemp(6, 32);

  const aLsl = mkConst(7, 3n, 32);
  const bLsl = mkConst(8, 4n, 32);
  const dLsl = mkTemp(9, 32);

  const aLsr = mkConst(10, 0x80000000n, 32);
  const bLsr = mkConst(11, 4n, 32);
  const dLsr = mkTemp(12, 32);

  const aAsr = mkConst(13, 0x80000000n, 32);
  const bAsr = mkConst(14, 4n, 32);
  const dAsr = mkTemp(15, 32);

  // Out-of-range shift guard for lsl must still return null (not fold)
  const bBadShift = mkConst(16, 32n, 32);
  const dBadLsl = mkTemp(17, 32);

  const instructions = [
    { id: 0, op: V1_OP.BIN, sub: 'orr', dst: dOr, args: [{ value: aOr }, { value: bOr }], extra: {} },
    { id: 1, op: V1_OP.BIN, sub: 'eor', dst: dEor, args: [{ value: aEor }, { value: bEor }], extra: {} },
    { id: 2, op: V1_OP.BIN, sub: 'lsl', dst: dLsl, args: [{ value: aLsl }, { value: bLsl }], extra: {} },
    { id: 3, op: V1_OP.BIN, sub: 'lsr', dst: dLsr, args: [{ value: aLsr }, { value: bLsr }], extra: {} },
    { id: 4, op: V1_OP.BIN, sub: 'asr', dst: dAsr, args: [{ value: aAsr }, { value: bAsr }], extra: {} },
    { id: 5, op: V1_OP.BIN, sub: 'lsl', dst: dBadLsl, args: [{ value: aLsl }, { value: bBadShift }], extra: {} },
  ];

  propagateScalarConstants({ instructions });
  assert.equal(dOr.const, 0x1234n, 'orr must fold bitwise OR');
  assert.equal(dEor.const, 0xf000n, 'eor must fold bitwise XOR');
  assert.equal(dLsl.const, 48n, 'lsl must fold logical shift left');
  assert.equal(dLsr.const, 0x08000000n, 'lsr must fold logical shift right');
  assert.equal(dAsr.const, 0xf8000000n, 'asr must fold arithmetic shift right with sign extension');
  assert.equal(dBadLsl.const, null, 'lsl with shift >= width must remain un-folded');

  // Verify finalizeLegacyProjection also folds normalized opcodes
  const dOr2 = mkTemp(18, 32);
  const proj = {
    blocks: [{ index: 0, startRow: 0, endRow: 1, phis: [], insts: [] }],
    instructions: [{ id: 0, op: V1_OP.BIN, sub: 'orr', block: 0, row: 0, dst: dOr2, args: [{ value: aOr }, { value: bOr }], extra: {} }],
    values: [aOr, bOr, dOr2],
    args: new Map(),
    byRow: new Map(),
    locations: new Map(),
  };
  finalizeLegacyProjection(proj);
  assert.equal(dOr2.const, 0x1234n);

  // Verify projectLegacyAddress / semanticIndexTerm recognizes `lsl` scaled index
  const baseVal = { id: 1, reg: 'x0', bits: 64, unknown: false, undefined: false };
  const idxVal32 = { id: 2, reg: 'w1', bits: 32, unknown: false, undefined: false };
  const extVal64 = { id: 3, reg: null, bits: 64, unknown: false, undefined: false };
  const shiftConst = { id: 4, reg: null, bits: 64, const: 3n, unknown: false, undefined: false };
  const scaledVal = { id: 5, reg: null, bits: 64, unknown: false, undefined: false };
  const addrVal = { id: 6, reg: null, bits: 64, unknown: false, undefined: false };

  const context = {
    producerByValueId: new Map([
      ['v_base', { id: 'n_base', kind: 'state-read', inputs: [], outputs: ['v_base'], origin: origin('base') }],
      ['v_idx', { id: 'n_idx', kind: 'state-read', inputs: [], outputs: ['v_idx'], origin: origin('idx') }],
      ['v_ext', { id: 'n_ext', kind: 'sext', inputs: ['v_idx'], outputs: ['v_ext'], attributes: { fromBits: 32, toBits: 64 }, origin: origin('ext') }],
      ['v_sh', { id: 'n_sh', kind: 'const', inputs: [], outputs: ['v_sh'], attributes: { value: '3' }, origin: origin('sh') }],
      ['v_scaled', { id: 'n_scaled', kind: 'binary', operator: 'lsl', inputs: ['v_ext', 'v_sh'], outputs: ['v_scaled'], origin: origin('scaled') }],
      ['v_addr', { id: 'n_addr', kind: 'binary', operator: 'add', inputs: ['v_base', 'v_scaled'], outputs: ['v_addr'], origin: origin('addr') }],
    ]),
    valuesById: new Map([
      ['v_base', baseVal],
      ['v_idx', idxVal32],
      ['v_ext', extVal64],
      ['v_sh', shiftConst],
      ['v_scaled', scaledVal],
      ['v_addr', addrVal],
    ]),
    semanticValueById: new Map(),
  };

  const legacyAddr = projectLegacyAddress('v_addr', { widthBits: 64, addressSpace: 'memory' }, context);
  assert.equal(legacyAddr.precise, true, 'lsl-scaled address must lower precisely');
  assert.equal(legacyAddr.base, baseVal);
  assert.equal(legacyAddr.index, idxVal32);
  assert.equal(legacyAddr.scale, 3);
  assert.equal(legacyAddr.extend, 'sxtw');
  assert.equal(legacyAddr.indexSignedness, 'signed');
});

test('5. compat attachAbiProjectedArguments indexes values by register cleanly across many calls', () => {
  const BASE = 0x100000000n;
  const numCalls = 40;
  const lines = [];
  for (let i = 0; i < numCalls; i += 1) {
    lines.push(`mov x0, #0x${(i + 1).toString(16)}`);
    lines.push('bl #0x100001000');
  }
  lines.push('ret');
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    const t0 = performance.now();
    const projected = buildIR(model, { rowOfAddress });
    const elapsedMs = performance.now() - t0;
    assert.ok(projected, 'v2 compat IR must build');
    const calls = projected.instructions.filter((inst) => inst.op === OP.CALL);
    assert.equal(calls.length, numCalls);
    for (const call of calls) {
      assert.equal(call.extra?.abiAdapterStatus, 'used');
      assert.ok(call.args.some((arg) => arg?.value?.reg === 'x0'), 'each call must bind dominating x0 ABI argument');
    }
    assert.ok(elapsedMs < 3000, `indexed ABI call argument projection should be fast, took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.AUTO);
  }
});
