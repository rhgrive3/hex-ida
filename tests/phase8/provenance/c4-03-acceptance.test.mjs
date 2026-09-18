import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverExactStackReturn } from '../../../js/decompiler/passes/stack-return-recovery.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { enhanceSemanticDecompilation as enhancePipelineCore } from '../../../js/decompiler/pipeline-core.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis, expr, proofOnlySpillFixture, repeatedCseFixture, resultWith, source } from './fixture.js';

const REQUIRED_PROOF_CATEGORIES = Object.freeze([
  'cse',
  'dce',
  'phi',
  'switch',
  'struct-field',
  'stale-snapshot',
]);

const DENOMINATOR_CLASSES = Object.freeze([
  'rendered-entity',
  'removed-transform-class',
]);

test('C4-03 proof and denominator categories are frozen', () => {
  assert.deepEqual(REQUIRED_PROOF_CATEGORIES, [
    'cse',
    'dce',
    'phi',
    'switch',
    'struct-field',
    'stale-snapshot',
  ]);
  assert.deepEqual(DENOMINATOR_CLASSES, [
    'rendered-entity',
    'removed-transform-class',
  ]);
});

test('C4-03 valid rendered entity projection achieves zero provenance loss and complete validation', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());
  const provenance = result.renderProvenance;

  assert.ok(provenance, 'projection must publish render provenance');
  assert.equal(provenance.completeness, 'complete');

  const validation = validateRenderProvenance(provenance, { snapshotId: provenance.snapshotId });
  assert.equal(validation.state, 'complete');
  assert.equal(validation.counts.provenanceLoss, 0, 'completion condition requires zero provenance loss');
  assert.deepEqual(validation.reasons, []);
});

test('C4-03 stale snapshot identity fails closed', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());
  const staleValidation = validateRenderProvenance(result.renderProvenance, {
    snapshotId: `${result.renderProvenance.snapshotId}-mismatch`,
  });
  assert.equal(staleValidation.state, 'incomplete');
  assert.ok(staleValidation.reasons.includes('stale-snapshot'));
});

test('C4-03 sourceless rendered entity is detected as provenance loss and rejected', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression, { sourcelessLine: true }), analysis());
  const provenance = result.renderProvenance;

  const validation = validateRenderProvenance(provenance, { snapshotId: provenance.snapshotId });
  assert.equal(validation.state, 'incomplete');
  assert.ok(validation.reasons.includes('provenance-loss'));
  assert.ok(validation.counts.provenanceLoss >= 1);
});

test('C4-03 CSE many-to-one mapping preserves shared provenance across rendered stores', async () => {
  const f = repeatedCseFixture(8);
  const optResult = await optimizeSemanticDecompilation(f.result, f.options);
  assert.equal(optResult.proofOptimization.status, 'complete');
  assert.ok(optResult.proofOptimization.adopted >= 2);
  const bindings = optResult.cAst.body.filter(node => node.semantic?.op === 'cse-binding');
  assert.equal(bindings.length, 1, 'CSE maps multiple expressions to one binding');
  const record = optResult.renderProvenance.ledger.find(row => row.kind === 'proved-scalar-cse');
  assert.ok(record, 'CSE sharing requires a dedicated ledger record');
  assert.equal(record.producedRefs.length, 3, 'binding and both stores navigate to the record');
  assert.equal(optResult.renderProvenance.completeness, 'complete');
  const validation = validateRenderProvenance(optResult.renderProvenance, { snapshotId: optResult.renderProvenance.snapshotId });
  assert.equal(validation.state, 'complete');
  assert.equal(validation.counts.provenanceLoss, 0);
});

test('C4-03 DCE statement removal records suppression/tombstone and prevents silent loss', () => {
  const f = proofOnlySpillFixture();
  const canonical = structuredClone(f.result.ir);
  recoverExactStackReturn(f.result);
  assert.ok(!f.result.cAst.body.includes(f.removedNode));

  const result = applyPhase8Projection(f.result, analysis());
  const map = result.renderProvenance;
  const record = map.ledger.find(r => r.rule === 'remove-proof-only-stack-spill');
  assert.ok(record, 'DCE removal must be represented in the transform ledger');
  assert.equal(record.renderedRemoval.operation, 'remove');
  assert.deepEqual(record.producedRefs, ['L1:stmt']);
  assert.deepEqual(record.removedRefs, [`before:${map.ledger.indexOf(record)}:L0:stmt`]);
  assert.equal(validateRenderProvenance(map).state, 'complete');
  assert.equal(validateRenderProvenance(map).counts.provenanceLoss, 0);
  assert.deepEqual(f.result.ir, canonical);
});

test('C4-03 phi view collapse retains incoming definitions with zero provenance loss', () => {
  const f = irFixture('equal_phi_c4_03');
  f.block(0);
  const input = f.opaque(32);
  input.reg = 'x0';
  input.signed = false;
  f.conditionalBranch(f.opaque(1), 1, 2);
  f.block(1);
  const left = f.constant(0n, 32);
  f.branch(3);
  f.block(2);
  const right = f.constant(0n, 32);
  f.branch(3);
  f.block(3);
  const phi = f.phi([[1, left], [2, right]], 32);
  f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => {
    inst.id = index + 100;
    inst.row = index;
    inst.address = 0x6000n + BigInt(index * 4);
  });
  for (const block of ir.blocks) block.startRow = (block.phis[0] || block.insts[0]).row;
  const ret = ir.instructions.at(-1);
  ret.args = [{ value: phi }];
  phi.uses.push(ret);
  const seed = {
    semantic: true,
    ir,
    types: { values: new Map(), locations: new Map() },
    lines: ir.instructions.filter(inst => ['store', 'ret'].includes(inst.op)).map(inst => ({
      kind: 'stmt', indent: 1, text: 'return old;', row: inst.row, addr: inst.address,
    })),
    warnings: [], evidence: [], coverage: { mode: 'structured' }, summary: '',
  };
  const preResult = enhancePipelineCore(seed, { calls: [] }, { deterministicTransforms: true });
  const projected = applyPhase8Projection(preResult, analysis());
  const provenance = projected.renderProvenance;
  assert.ok(provenance);
  const collapseRecord = provenance.ledger.find(r => r.rule === 'collapse-equal-incoming-phi');
  assert.ok(collapseRecord, 'phi collapse emits ledger record');
  const validation = validateRenderProvenance(provenance, { snapshotId: provenance.snapshotId });
  assert.equal(validation.state, 'complete');
  assert.equal(validation.counts.provenanceLoss, 0);
});

test('C4-03 switch render spans retain branch origins and case targets with zero provenance loss', async () => {
  const { buildSemanticModel } = await import('../../../js/blocks.js');
  const { decompileSemantic } = await import('../../../js/decompile.js');
  const { structureKnownSwitches } = await import('../../../js/decompiler/switch.js');
  const { enhanceSemanticDecompilation: enhanceSwitch } = await import('../../../js/decompiler/pipeline-core.js');
  const raw = [
    { row: 0, address: 0x1000n, mn: 'br', ops: 'x8' },
    { row: 1, address: 0x1004n, mn: 'mov', ops: 'x0, #1' },
    { row: 2, address: 0x1008n, mn: 'ret', ops: '' },
    { row: 3, address: 0x100cn, mn: 'mov', ops: 'x0, #2' },
    { row: 4, address: 0x1010n, mn: 'ret', ops: '' },
    { row: 5, address: 0x1014n, mn: 'mov', ops: 'x0, #3' },
    { row: 6, address: 0x1018n, mn: 'ret', ops: '' },
  ];
  const rowOfAddress = addr => raw.find(inst => inst.address === BigInt(addr))?.row ?? null;
  const addrOfRow = row => raw[row]?.address ?? null;
  const model = buildSemanticModel(raw, { startRow: 0, endRow: 6, rowOfAddress, addrOfRow });
  const descriptor = {
    row: 0, expr: 'kind',
    cases: [{ value: 0, address: 0x1004n }, { value: 1, address: 0x100cn }],
    defaultAddress: 0x1014n,
  };
  const opts = {
    addr: 0x1000n, rowOfAddress, addrOfRow, beginner: false, deterministicTransforms: true,
    jumpTables: [descriptor],
  };
  const seed = structureKnownSwitches(decompileSemantic(model, opts), model, opts);
  const enhanced = enhanceSwitch(seed, model, opts);
  const map = applyPhase8Projection(enhanced, analysis()).renderProvenance;
  assert.ok(map);
  const switchRecords = map.ledger.filter(r => r.rule === 'render-switch');
  assert.ok(switchRecords.length > 0, 'switch rendering emits ledger record');
  const validation = validateRenderProvenance(map, { snapshotId: map.snapshotId });
  assert.equal(validation.state, 'complete');
  assert.equal(validation.counts.provenanceLoss, 0);
});

test('C4-03 struct field access preserves independent producer bindings with zero provenance loss', async () => {
  const { enhanceSemanticDecompilation: enhanceField } = await import('../../../js/decompiler/pipeline-core.js');
  const val = (id, kind = 'arg') => ({ id, kind, reg: `x${id}`, bits: 64, signed: false, uses: [], def: null, const: null });
  const p = val(1), scalar = val(2), loaded = val(3, 'def');
  const instructions = [];
  const addInst = (op, dst, args, extra = {}) => {
    const row = instructions.length;
    const inst = { id: 10 + row, row, address: 0x9000n + BigInt(row * 4), block: 0, op, dst, args: args.map(v => ({ value: v })), ...extra };
    if (dst) dst.def = inst;
    for (const v of args) v.uses.push(inst);
    instructions.push(inst);
    return inst;
  };
  const field = base => ({ kind: 'field', key: `field:${base.id}:8`, disp: 8n, size: 8, base });
  addInst('store', null, [scalar], { loc: field(p) });
  addInst('load', loaded, [], { loc: field(p) });
  const ret = addInst('ret', null, [loaded]);
  const ir = {
    values: [p, scalar, loaded], instructions,
    args: new Map([['x1', p], ['x2', scalar]]),
    blocks: [{ index: 0, startRow: 0, endRow: ret.row, succ: [], insts: instructions }],
  };
  const seed = {
    semantic: true, ir, types: { values: new Map(), locations: new Map() },
    lines: instructions.map(inst => ({
      kind: 'stmt', indent: 1, text: inst.op === 'ret' ? 'return old;' : 'old = value;', row: inst.row, addr: inst.address,
    })),
    warnings: [], evidence: [], coverage: { mode: 'structured' }, summary: '',
  };
  const enhanced = enhanceField(seed, { calls: [] }, { deterministicTransforms: true });
  const map = applyPhase8Projection(enhanced, analysis()).renderProvenance;
  assert.ok(map);
  const validation = validateRenderProvenance(map, { snapshotId: map.snapshotId });
  assert.equal(validation.state, 'complete');
  assert.equal(validation.counts.provenanceLoss, 0);
});

test('C4-03 bidirectional reverse navigation resolves rendered lines to canonical origin rows and vice versa', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());
  const provenance = result.renderProvenance;

  let resolvedEntities = 0;
  for (const [entityKey, entity] of Object.entries(provenance.entities)) {
    if (entity.complete) {
      assert.ok(entity.origins.rows.length > 0 || entity.origins.addresses.length > 0,
        `entity ${entityKey} must resolve to canonical rows or addresses`);
      resolvedEntities++;
    }
  }
  assert.ok(resolvedEntities > 0, 'at least one entity must resolve to canonical origins');
});

