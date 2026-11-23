import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP, VK } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { resolveABIPlugin } from '../../js/targets/abi/index.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function-base.js';

const BASE = 0x100000000n;

function buildV2Ir(lines, extraOpts = {}) {
  const rows = lines.map((line, row) => {
    const trimmed = String(line).trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    return buildIR(model, { rowOfAddress, ...extraOpts });
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }
}

test('Fix 1: 32-bit W index register reads 64-bit physical GP with truncate, no fake 32-bit LIVE_IN arg', () => {
  const ir = buildV2Ir([
    'ldr w8, [x0, w1, sxtw #2]',
    'str w8, [x2, w1, uxtw #2]',
    'mov w0, w8',
    'ret',
  ]);
  const x1Args = ir.values.filter((v) => v.kind === VK.ARG && v.reg === 'x1');
  assert.ok(x1Args.length >= 1, 'x1 entry arg must exist');
  assert.equal(x1Args.some((v) => v.bits === 32), false, 'must not mint a fake 32-bit LIVE_IN x1:32 arg');
  assert.ok(x1Args.every((v) => v.bits === 64), 'physical GP index read must be 64-bit');

  const load = ir.instructions.find((i) => i.op === OP.LOAD);
  assert.ok(load, 'indexed load must lift');
  assert.equal(load.addr.precise, true);
  assert.equal(load.addr.extend, 'sxtw');
  assert.equal(Number(load.addr.scale), 2);

  const store = ir.instructions.find((i) => i.op === OP.STORE);
  assert.ok(store, 'indexed store must lift');
  assert.equal(store.addr.precise, true);
  assert.equal(store.addr.extend, 'uxtw');
  assert.equal(Number(store.addr.scale), 2);
});

test('Fix 1: 64-bit X index register remains 64-bit without truncation', () => {
  const ir = buildV2Ir([
    'ldr x0, [x0, x1, lsl #3]',
    'ret',
  ]);
  const load = ir.instructions.find((i) => i.op === OP.LOAD);
  assert.ok(load);
  assert.equal(load.addr.precise, true);
  assert.equal(load.addr.extend, null);
  assert.equal(Number(load.addr.scale), 3);
  const x1Args = ir.values.filter((v) => v.kind === VK.ARG && v.reg === 'x1');
  assert.ok(x1Args.length >= 1 && x1Args.every((v) => v.bits === 64));
});

test('Fix 2a: projectedAbiArgumentValue prefers same-block non-PHI def over PHI and deeper dominator over ARG', () => {
  const origin = (id, addr) => ({ instructionIds: [id], virtualRanges: [{ start: addr, end: addr + 4n }] });
  const bit64 = { kind: 'bitvector', widthBits: 64 };
  const x0Var = { key: 'reg:x0', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x0' } };

  const ir = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'fn_dom_select',
    entryBlockId: 'b0',
    blocks: [
      { id: 'b0', nodeIds: ['n_c0', 'n_w0', 'n_br0'], origin: origin('blk0', 0x1000n) },
      { id: 'b1', nodeIds: ['n_c1', 'n_w1', 'n_call', 'n_ret'], origin: origin('blk1', 0x1010n) },
    ],
    values: [
      { id: 'v_c0', kind: 'definition', machineType: bit64, definitionNodeId: 'n_c0', sourceEntityId: 'n_c0', origin: origin('i0', 0x1000n) },
      { id: 'v_c1', kind: 'definition', machineType: bit64, definitionNodeId: 'n_c1', sourceEntityId: 'n_c1', origin: origin('i1', 0x1010n) },
    ],
    nodes: [
      { id: 'n_c0', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v_c0'], attributes: { value: 11n }, completeness: 'complete', origin: origin('i0', 0x1000n) },
      { id: 'n_w0', kind: 'state-write', blockId: 'b0', inputs: ['v_c0'], outputs: [], variable: x0Var, completeness: 'complete', origin: origin('i0', 0x1000n) },
      { id: 'n_br0', kind: 'branch', blockId: 'b0', inputs: [], outputs: [], targets: ['b1'], completeness: 'complete', origin: origin('i0b', 0x1004n) },
      { id: 'n_c1', kind: 'const', blockId: 'b1', inputs: [], outputs: ['v_c1'], attributes: { value: 22n }, completeness: 'complete', origin: origin('i1', 0x1010n) },
      { id: 'n_w1', kind: 'state-write', blockId: 'b1', inputs: ['v_c1'], outputs: [], variable: x0Var, completeness: 'complete', origin: origin('i1', 0x1010n) },
      {
        id: 'n_call', kind: 'call', blockId: 'b1', inputs: [], outputs: [],
        call: {
          targetValueIds: [], targetEntityIds: [], arguments: [], returns: [],
          stateReads: [], stateWrites: [],
          memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
          noreturn: false, mayThrow: false, determinism: 'deterministic', summarySource: 'test', completeness: 'complete',
        },
        completeness: 'complete',
        origin: origin('i2', 0x1014n),
      },
      { id: 'n_ret', kind: 'return', blockId: 'b1', inputs: [], outputs: [], completeness: 'complete', origin: origin('i3', 0x1018n) },
    ],
    completeness: 'complete',
    unknowns: [],
    origin: origin('fn', 0x1000n),
  };

  // Craft SSA where b0 def has a HIGHER version/definitionId than b1 def, plus a PHI at the same row as n_w1 in b1.
  const ssa = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'fn_dom_select',
    definitions: [
      {
        definitionId: 'def_0_entry', valueId: 'ssa_x0_entry', kind: 'entry', blockId: 'b0',
        variableKey: 'reg:x0', sourceEntityId: 'fn_dom_select',
        proof: { kind: 'entry', variableIdentity: x0Var }, origin: origin('fn', 0x1000n),
      },
      {
        definitionId: 'def_9_b0_higher_version', valueId: 'ssa_x0_b0', kind: 'definition', blockId: 'b0',
        variableKey: 'reg:x0', sourceEntityId: 'n_w0',
        proof: { kind: 'state-write', variableIdentity: x0Var, sourceSemanticValueId: 'v_c0' },
        origin: origin('i0', 0x1000n),
      },
      {
        definitionId: 'def_8_b1_phi', valueId: 'ssa_x0_phi', kind: 'phi', blockId: 'b1',
        variableKey: 'reg:x0', sourceEntityId: 'phi_b1',
        incoming: [{ predecessorBlockId: 'b0', valueId: 'ssa_x0_b0' }],
        proof: { kind: 'phi', variableIdentity: x0Var },
        origin: origin('i1', 0x1010n),
      },
      {
        definitionId: 'def_1_b1_lower_version', valueId: 'ssa_x0_b1', kind: 'definition', blockId: 'b1',
        variableKey: 'reg:x0', sourceEntityId: 'n_w1',
        proof: { kind: 'state-write', variableIdentity: x0Var, sourceSemanticValueId: 'v_c1' },
        origin: origin('i1', 0x1010n),
      },
    ],
    uses: [],
    completeness: 'complete',
    unknowns: [],
    origin: origin('fn', 0x1000n),
  };

  const projected = projectSemanticIrV2ToLegacyV1(ir, {
    ssa,
    rowOfNode: (node) => {
      const a = node?.origin?.virtualRanges?.[0]?.start;
      return a == null ? 0 : Number((BigInt(a) - 0x1000n) / 4n);
    },
    abiAdapter: semanticAbiAdapter(resolveABIPlugin({ architecture: 'arm64' }, { legacyDefault: true }), { architecture: 'arm64' }),
  });

  const call = projected.instructions.find((inst) => inst.op === OP.CALL);
  assert.ok(call, 'call instruction must exist');
  assert.equal(call.args.length, 1, 'call must receive x0 argument');
  assert.equal(call.args[0].value.semanticSsaValueId, 'ssa_x0_b1',
    'must pick same-block non-PHI definition over same-row PHI and over higher-versioned earlier-block def');
});

test('Fix 2b: external tail-call BR resolves symbol name and attaches ABI arguments', () => {
  const ir = buildV2Ir([
    'mov x0, x3',
    'b #0x100004000',
  ], {
    symbolFor: (addr) => (addr === 0x100004000n ? 'sprintf@plt' : null),
  });

  const br = ir.instructions.find((i) => i.op === OP.BR);
  assert.ok(br, 'tail-call BR must exist');
  assert.equal(br.extra?.name, 'sprintf@plt', 'tail-call BR must populate extra.name from symbolFor');
  assert.equal(br.extra?.target, 0x100004000n, 'tail-call BR must preserve target address');
  assert.ok(br.args.length >= 1, 'tail-call BR must attach ABI-projected arguments');

  const x0Arg = br.args.find((a) => a.value?.reg === 'x0');
  assert.ok(x0Arg, 'tail-call BR must consume reaching x0');
  assert.ok(x0Arg.value.uses.includes(br), 'reaching x0 must record BR as a real use');
});

test('Fix 2b: internal intra-function BR is not misclassified as an external tail call', () => {
  const ir = buildV2Ir([
    'b #0x100000008',
    'mov x0, #1',
    'ret',
  ], {
    symbolFor: (addr) => (addr === 0x100000008n ? 'internal_label' : null),
  });
  const br = ir.instructions.find((i) => i.op === OP.BR);
  assert.ok(br);
  assert.equal(br.extra?.name, undefined, 'internal branch must not be turned into a tail call');
  assert.equal(br.args.length, 0, 'internal branch must not attach ABI arguments');
});

test('Fix 3a: pair stp/ldp preserves distinct element displacements', () => {
  const ir = buildV2Ir([
    'stp x29, x30, [sp, #-16]!',
    'stp w4, w3, [x2]',
    'ldp x29, x30, [sp], #16',
    'ret',
  ]);
  const row0Stores = ir.instructions.filter((i) => i.row === 0 && i.op === OP.STORE);
  assert.equal(row0Stores.length, 2, 'stp x29, x30 must produce 2 stores');
  assert.deepEqual(row0Stores.map((s) => s.addr.disp), [-16n, -8n]);

  const row1Stores = ir.instructions.filter((i) => i.row === 1 && i.op === OP.STORE);
  assert.equal(row1Stores.length, 2, 'stp w4, w3, [x2] must produce 2 stores');
  assert.deepEqual(row1Stores.map((s) => s.addr.disp), [0n, 4n]);

  const row2Loads = ir.instructions.filter((i) => i.row === 2 && i.op === OP.LOAD);
  assert.equal(row2Loads.length, 2, 'ldp x29, x30, [sp], #16 must produce 2 loads');
  assert.deepEqual(row2Loads.map((l) => l.addr.disp), [0n, 8n]);
});

test('Fix 3b: sbfiz and ubfiz project to OP.BFX with toward="left" instead of CLOBBER', () => {
  const ir = buildV2Ir([
    'sbfiz x19, x1, #2, #32',
    'ubfiz w0, w2, #4, #12',
    'ret',
  ]);
  const bfxList = ir.instructions.filter((i) => i.op === OP.BFX);
  assert.equal(bfxList.length, 2, 'both sbfiz and ubfiz must project to OP.BFX');

  const sbfiz = bfxList.find((i) => i.row === 0);
  assert.ok(sbfiz);
  assert.equal(sbfiz.extra?.toward, 'left');
  assert.equal(sbfiz.extra?.signed, true);
  assert.equal(sbfiz.extra?.lsb, 2);
  assert.equal(sbfiz.extra?.width, 32);
  assert.equal(sbfiz.extra?.bitfieldKind, 'sbfiz');

  const ubfiz = bfxList.find((i) => i.row === 1);
  assert.ok(ubfiz);
  assert.equal(ubfiz.extra?.toward, 'left');
  assert.equal(ubfiz.extra?.signed, false);
  assert.equal(ubfiz.extra?.lsb, 4);
  assert.equal(ubfiz.extra?.width, 12);
  assert.equal(ubfiz.extra?.bitfieldKind, 'ubfiz');

  assert.equal(ir.instructions.some((i) => (i.row === 0 || i.row === 1) && i.op === OP.CLOBBER), false);
});

test('Fix 3c: scalar IEEE-754 FP instructions project to BIN / UN / CMP cleanly', () => {
  const ir = buildV2Ir([
    'fadd d0, d0, d1',
    'fsub d0, d0, d1',
    'fmul d0, d0, d1',
    'fdiv d0, d0, d1',
    'scvtf d2, w0',
    'ucvtf d3, w1',
    'fcvtzs w2, d0',
    'fcvtzu w3, d1',
    'fabs d4, d0',
    'fneg d5, d1',
    'fcmp d0, d1',
    'fcmpe d2, d3',
    'ret',
  ]);

  const byRow = (row, op) => ir.instructions.find((i) => i.row === row && i.op === op);

  for (const [row, sub] of [[0, 'fadd'], [1, 'fsub'], [2, 'fmul'], [3, 'fdiv']]) {
    const inst = byRow(row, OP.BIN);
    assert.ok(inst, `row ${row} (${sub}) must project to OP.BIN`);
    assert.equal(inst.sub, sub);
    assert.equal(inst.extra?.float, true);
    assert.equal(inst.args.length, 2);
  }

  for (const [row, sub] of [[4, 'scvtf'], [5, 'ucvtf'], [6, 'fcvtzs'], [7, 'fcvtzu'], [8, 'fabs'], [9, 'fneg']]) {
    const inst = byRow(row, OP.UN);
    assert.ok(inst, `row ${row} (${sub}) must project to OP.UN`);
    assert.equal(inst.sub, sub);
    assert.equal(inst.extra?.float, true);
    assert.equal(inst.args.length, 1);
  }

  const fcmp = byRow(10, OP.CMP);
  assert.ok(fcmp, 'fcmp must project to OP.CMP');
  assert.equal(fcmp.sub, 'fsub');
  assert.equal(fcmp.extra?.float, true);
  assert.equal(fcmp.extra?.signalingNaN, false);
  assert.equal(fcmp.args.length, 2);

  const fcmpe = byRow(11, OP.CMP);
  assert.ok(fcmpe, 'fcmpe must project to OP.CMP');
  assert.equal(fcmpe.sub, 'fsub');
  assert.equal(fcmpe.extra?.float, true);
  assert.equal(fcmpe.extra?.signalingNaN, true);
  assert.equal(fcmpe.args.length, 2);

  const fpClobbers = ir.instructions.filter((i) => i.row <= 11 && i.op === OP.CLOBBER);
  assert.equal(fpClobbers.length, 0, 'scalar IEEE-754 FP ops must not degrade to OP.CLOBBER');
});

test('Fix 4: callee-saved registers are restored on PHI incoming edges and direct uses after CALL', () => {
  // Loop that saves x0 into x19 and x1 into x26, calls an external function,
  // loops back (creating PHIs for x19/x26), and reads [x26] after the call.
  const ir = buildV2Ir([
    'mov x19, x0',
    'mov x26, x1',
    'cmp x19, #0',
    'b.eq #0x100000020',
    'bl #0x100004000',
    'sub x19, x19, #1',
    'ldr w2, [x26]',
    'b #0x100000008',
    'mov x0, x26',
    'ret',
  ], {
    symbolFor: (addr) => (addr === 0x100004000n ? 'strlen@plt' : null),
  });

  // 1. No PHI for callee-saved x19 or x26 may have a call-clobbered UNDEF incoming edge.
  const calleeSavedPhis = ir.instructions.filter(
    (i) => i.op === OP.PHI && (i.dst?.reg === 'x19' || i.dst?.reg === 'x26' || i.reg === 'x19' || i.reg === 'x26'),
  );
  assert.ok(calleeSavedPhis.length >= 1, 'expected at least one PHI for callee-saved loop registers');
  for (const phi of calleeSavedPhis) {
    for (const edge of phi.incoming || []) {
      const isCallUndef = edge?.value?.kind === VK.UNDEF && edge.value.def?.op === OP.CALL;
      assert.equal(isCallUndef, false, `PHI for ${phi.dst?.reg || phi.reg} must not have a call-clobbered UNDEF incoming edge`);
    }
  }

  // 2. Direct uses after CALL (ldr w2, [x26] and mov x0, x26) must not reference call-clobbered UNDEF for x26.
  const load = ir.instructions.find((i) => i.row === 6 && i.op === OP.LOAD);
  assert.ok(load, 'post-call load from x26 must exist');
  assert.notEqual(load.addr?.base?.kind, VK.UNDEF, 'post-call load base x26 must be restored from pre-call definition');

  // 3. The pre-call definition of x26 (`mov x26, x1`) must have live uses.
  const x26Def = ir.values.find((v) => v.reg === 'x26' && v.def?.row === 1);
  assert.ok(x26Def, 'pre-call x26 definition must exist');
  assert.ok((x26Def.uses?.length ?? 0) > 0, 'pre-call x26 definition must have at least one live use after call restoration');
});
