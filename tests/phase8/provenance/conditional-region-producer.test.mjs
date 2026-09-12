import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { decompileSemantic, readSemanticConditionalRegions, readSemanticConditionalRegion,
  readSemanticControlLineHistory } from '../../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer,
  readCopiedConditionalRegions } from '../../../js/decompiler/pipeline-core.js';

function render(kind = 'diamond', options = {}) {
  const f = fixture('region'); f.block(0);
  const condition = f.opaque(1); condition.reg = 'x0';
  let merged = null;
  if (kind === 'plain') {
    f.ret();
  } else if (kind === 'one-sided') {
    f.conditionalBranch(condition, 2, 1); f.block(1); f.store(f.constant(1n, 32)); f.branch(2); f.block(2); f.ret();
  } else if (kind === 'nested') {
    f.conditionalBranch(condition, 1, 4); f.block(1); f.conditionalBranch(condition, 2, 3);
    f.block(2); f.store(f.constant(2n, 32)); f.branch(5);
    f.block(3); f.store(f.constant(3n, 32)); f.branch(5);
    f.block(4); f.store(f.constant(4n, 32)); f.branch(5); f.block(5); f.ret();
  } else if (kind === 'fallback') {
    f.conditionalBranch(condition, 1, 2); f.block(1); f.branch(3); f.block(2); f.ret(); f.block(3); f.ret();
  } else {
    f.conditionalBranch(condition, 1, 2);
    f.block(1); const yes = f.constant(1n, 32); f.store(yes); f.branch(3);
    f.block(2); const no = f.constant(2n, 32); f.store(no); f.branch(3);
    f.block(3); merged = f.phi([[1, yes], [2, no]], 32); f.ret();
  }
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => {
    inst.id = `region_${index}`; inst.row = index; inst.address = 0x1000n + BigInt(index * 4);
    if (inst.op === 'cbr' && kind !== 'fallback') inst.extra = { ...inst.extra, targetBlock:ir.blocks[inst.block].succ[0] };
  });
  for (const block of ir.blocks) { block.startRow = block.insts[0].row; block.endRow = block.insts.at(-1).row; }
  if (merged) ir.instructions.at(-1).args = [{ value:merged }];
  const model = { name:'region', instructions:ir.instructions, calls:[] };
  const opts = { ir, deterministicTransforms:true, phase8PrepareRegionProof:true, ...options };
  return { ir, model, opts, seed:decompileSemantic(model, opts) };
}

test('capturing region identity preserves the emitted program and coverage', () => {
  for (const kind of ['plain', 'diamond', 'one-sided', 'nested', 'fallback']) {
    const { seed, model, opts } = render(kind);
    const ordinary = decompileSemantic(model, { ...opts, phase8PrepareRegionProof:false });
    assert.equal(ordinary.pseudocode, seed.pseudocode, kind);
    assert.deepEqual(ordinary.coverage, seed.coverage, kind);
    assert.deepEqual(ordinary.summary, seed.summary, kind);
  }
});

test('conditional emitter issues both exact arm spans, boundary nodes and join PHI identities', () => {
  const { seed, ir } = render(), history = readSemanticConditionalRegions(seed);
  assert.equal(history.completeness, 'complete'); assert.equal(history.transformAuthorization, false);
  assert.equal(history.scope, 'initial-emitter-spans-only-not-cfg-proof');
  assert.equal(history.regions.length, 1);
  const region = history.regions[0];
  assert.equal(readSemanticConditionalRegion(region.record, ir), region);
  assert.equal(readSemanticControlLineHistory(region.header, ir).records[0], region.record);
  assert.deepEqual(region.selection, { header:0, yes:1, no:2, join:3, invert:false, form:'if-else' });
  assert.equal(region.branch, ir.blocks[0].insts.at(-1));
  assert.equal(region.joinBlock, ir.blocks[3]); assert.deepEqual(region.joinPhis, ir.blocks[3].phis);
  assert.ok(region.joinPhis.length > 0);
  assert.deepEqual(region.arms.map(arm => arm.emittedBlocks.map(block => block.index)), [[1], [2]]);
  assert.deepEqual(region.nodes, [region.header, ...region.arms[0].nodes, region.separator,
    ...region.arms[1].nodes, region.close]);
  const start = seed.lines.indexOf(region.header);
  assert.ok(region.nodes.every((node, index) => node === seed.lines[start + index]));
  assert.ok(Object.isFrozen(region) && Object.isFrozen(region.nodes) && Object.isFrozen(region.arms));
  assert.equal(readSemanticConditionalRegion({ ...region.record }, ir), null);
  assert.equal(readSemanticConditionalRegion(region.record, { ...ir }), null);
  assert.equal(readSemanticConditionalRegions({ ...seed }), null);
});

test('one-sided and nested regions preserve producer polarity and explicit empty arms', () => {
  const one = readSemanticConditionalRegions(render('one-sided').seed).regions[0];
  assert.equal(one.selection.invert, true);
  assert.equal(one.selection.yes, one.selection.join);
  assert.equal(one.separator, null);
  assert.deepEqual(one.arms.map(arm => arm.emittedBlocks.map(block => block.index)), [[], [1]]);
  assert.deepEqual(one.arms[0].nodes, []);
  const nested = readSemanticConditionalRegions(render('nested').seed);
  assert.equal(nested.completeness, 'complete'); assert.equal(nested.regions.length, 2);
  const parent = nested.regions.find(region => region.selection.header === 0);
  const child = nested.regions.find(region => region.selection.header === 1);
  assert.notEqual(parent.record, child.record);
  assert.ok(child.nodes.every(node => parent.arms[0].nodes.includes(node)));
  assert.deepEqual(parent.arms[0].emittedBlocks.map(block => block.index), [1, 2, 3]);
});

test('any original line, CFG edge or PHI edit revokes region identity, including equal-text copies', () => {
  for (const mutate of [
    (seed, region) => { region.close.text = '// changed'; },
    (seed, region) => { const index = seed.lines.indexOf(region.close); seed.lines[index] = { ...region.close }; },
    (seed, region) => { const index = seed.lines.indexOf(region.separator); [seed.lines[index], seed.lines[index + 1]] = [seed.lines[index + 1], seed.lines[index]]; },
    (seed, region) => { region.joinPhis[0].incoming[0].from = 2; },
    seed => { seed.ir.blocks[1].insts.find(inst => inst.op === 'store').extra.memoryAccess.ordering = 'acquire'; },
    seed => { seed.ir.blocks[0].succ.reverse(); },
    seed => { seed.lines = [...seed.lines]; },
  ]) {
    const { seed, ir } = render(), region = readSemanticConditionalRegions(seed).regions[0];
    mutate(seed, region);
    assert.equal(readSemanticConditionalRegions(seed), null);
    assert.equal(readSemanticConditionalRegion(region.record, ir), null);
  }
});

test('complete empty region histories are revoked when their input or output changes', () => {
  for (const mutate of [
    seed => { seed.lines.at(-1).text = '// changed'; },
    seed => { seed.ir.blocks[0].insts[0].op = 'nop'; },
    seed => { seed.lines[0] = { ...seed.lines[0] }; },
  ]) {
    const { seed } = render('plain');
    const history = readSemanticConditionalRegions(seed);
    assert.equal(history.completeness, 'complete');
    assert.deepEqual(history.regions, []);
    mutate(seed);
    assert.equal(readSemanticConditionalRegions(seed), null);
  }
});

test('opt-in, budgets, fallback and cancellation never leave a usable partial region', () => {
  assert.equal(readSemanticConditionalRegions(render('diamond', { phase8PrepareRegionProof:false }).seed), null);
  for (const options of [{ renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:1 } }, { renderProvenanceBindingBudget:{ maxConsumers:8 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } }, { renderProvenanceBudget:{ maxTransformRecords:0 } }]) {
    const history = readSemanticConditionalRegions(render('diamond', options).seed);
    assert.equal(history.completeness, 'incomplete'); assert.deepEqual(history.regions, []);
  }
  const fallback = render('fallback').seed;
  assert.equal(fallback.coverage.mode, 'linear');
  const history = readSemanticConditionalRegions(fallback);
  assert.equal(history.completeness, 'incomplete'); assert.deepEqual(history.regions, []);
  let cancelled = false;
  const { seed, ir } = render('diamond', { shouldAbort:() => cancelled });
  const region = readSemanticConditionalRegions(seed).regions[0]; cancelled = true;
  assert.equal(readSemanticConditionalRegions(seed), null);
  assert.equal(readSemanticConditionalRegion(region.record, ir), null);
});

test('a nested partial capture cannot retain an earlier issued-looking region', () => {
  const seed = render('nested', { renderProvenanceBindingBudget:{ maxConsumers:32 } }).seed;
  const history = readSemanticConditionalRegions(seed);
  assert.equal(history.completeness, 'incomplete');
  assert.ok(history.reasons.includes('conditional-region-budget'));
  assert.deepEqual(history.regions, []);
});

test('existing copied control header carries the record, but cannot authorize a copied whole span', () => {
  const { seed, ir, model, opts } = render();
  const region = readSemanticConditionalRegions(seed).regions[0];
  const output = enhanceSemanticDecompilation(seed, model, opts);
  const consumers = output.cAst.body.map(node => readExpressionHistoryConsumer(node.semantic, ir)).filter(Boolean);
  assert.ok(consumers.some(consumer => consumer.records.includes(region.record)));
  assert.equal(readSemanticConditionalRegion(region.record, ir), region);
  assert.equal(readSemanticConditionalRegions(output), null);
  assert.ok(region.nodes.every(node => !output.cAst.body.includes(node)));
});

function copiedRegion(kind = 'diamond', options = {}) {
  const input = render(kind);
  const output = enhanceSemanticDecompilation(input.seed, input.model, {
    ...input.opts, decompilerTimeBudgetMs:5000, ...options,
  });
  return { ...input, output, history:readCopiedConditionalRegions(output.cAst, input.ir) };
}

test('the actual copy producer binds complete ordered spans, nested nodes and empty arms', () => {
  for (const kind of ['plain', 'diamond', 'nested', 'one-sided']) {
    const { seed, ir, output, history } = copiedRegion(kind);
    assert.equal(history?.completeness, 'complete', kind);
    assert.equal(history.transformAuthorization, false);
    assert.equal(history.conditionValidation, 'required');
    const original = readSemanticConditionalRegions(seed);
    assert.equal(history.regions.length, original.regions.length);
    const expected = line => output.cAst.body[seed.lines.indexOf(line)];
    for (const region of history.regions) {
      assert.ok(original.regions.includes(region.original));
      assert.equal(region.record, region.original.record);
      assert.equal(region.header, expected(region.original.header));
      assert.equal(region.close, expected(region.original.close));
      assert.equal(region.separator, region.original.separator === null ? null : expected(region.original.separator));
      assert.deepEqual(region.nodes, region.original.nodes.map(expected));
      for (const arm of region.arms) {
        assert.ok(region.original.arms.includes(arm.original));
        assert.deepEqual(arm.nodes, arm.original.nodes.map(expected));
      }
      assert.ok(Object.isFrozen(region) && Object.isFrozen(region.nodes) && Object.isFrozen(region.arms));
    }
    assert.equal(readCopiedConditionalRegions({ ...output.cAst }, ir), null);
    assert.equal(readCopiedConditionalRegions(output.cAst, { ...ir }), null);
    if (kind === 'nested') {
      const parent = history.regions.find(region => region.original.selection.header === 0);
      const child = history.regions.find(region => region.original.selection.header === 1);
      assert.ok(child.nodes.every(node => parent.arms[0].nodes.includes(node)));
    }
  }
});

test('copied carrier observes all output fields, identities and ordering including outside the region', () => {
  for (const mutate of [
    program => { program.body = [...program.body]; },
    program => { program.body.reverse(); },
    program => { program.body[0] = { ...program.body[0] }; },
    program => { program.body[0].text += ' '; },
    program => { program.body.at(-1).indent++; },
    program => { program.body.find(node => node.semantic).semantic.op = 'forged'; },
    program => { program.body[0].source = { ...program.body[0].source }; },
    program => { program.source = { ...program.source }; },
    program => { program.kind = 'OtherProgram'; },
  ]) {
    const { ir, output, history } = copiedRegion();
    assert.ok(history); mutate(output.cAst);
    assert.equal(readCopiedConditionalRegions(output.cAst, ir), null);
  }
});

test('original emitter and canonical mutations also revoke the actual copied carrier', () => {
  for (const mutate of [
    ({ seed }) => { seed.lines[0] = { ...seed.lines[0] }; },
    ({ seed }) => { seed.lines.at(-1).text += ' '; },
    ({ ir }) => { ir.blocks[0].succ.reverse(); },
    ({ ir }) => { ir.blocks[3].phis[0].incoming.reverse(); },
  ]) {
    const input = copiedRegion(); assert.ok(input.history);
    mutate(input);
    assert.equal(readCopiedConditionalRegions(input.output.cAst, input.ir), null);
  }
});

test('copy budgets withhold the whole carrier without changing ordinary output', () => {
  for (const limits of [{ maxRegions:0 }, { maxNodes:0 }, { maxReferences:0 }, { maxReferences:8 }, { maxEdges:0 }, { maxEdges:1 }]) {
    const input = copiedRegion('nested', { phase8RegionCarrierBudget:limits });
    const ordinary = enhanceSemanticDecompilation(input.seed, input.model, { ...input.opts, decompilerTimeBudgetMs:5000 });
    assert.equal(readCopiedConditionalRegions(input.output.cAst, input.ir), null);
    assert.equal(input.output.pseudocode, ordinary.pseudocode);
    assert.deepEqual(input.output.cAst, ordinary.cAst);
  }
  for (const options of [{ phase8PrepareRegionProof:false }, { renderProvenanceBindingBudget:{ maxEdges:0 } }]) {
    const input = render('diamond', options);
    const output = enhanceSemanticDecompilation(input.seed, input.model, input.opts);
    assert.equal(readCopiedConditionalRegions(output.cAst, input.ir), null);
  }
  const fallback = copiedRegion('fallback');
  assert.equal(fallback.history, null);
});

test('late cancellation or throwing callback revokes the copied carrier', () => {
  for (const mode of ['cancel', 'throw', 'mutate']) {
    let active = false, program;
    const input = copiedRegion('diamond', { shouldAbort:() => {
      if (!active) return false;
      if (mode === 'throw') throw new Error('cancel observer');
      if (mode === 'mutate') { program.body[0].text += ' '; return false; }
      return true;
    } });
    assert.ok(input.history); program = input.output.cAst; active = true;
    assert.equal(readCopiedConditionalRegions(program, input.ir), null);
  }
});

test('an empty copied history remains bound to the whole original and copied program', () => {
  const input = copiedRegion('plain');
  assert.deepEqual(input.history.regions, []);
  input.output.cAst.body.push({ kind:'raw', text:'injected();' });
  assert.equal(readCopiedConditionalRegions(input.output.cAst, input.ir), null);
});

test('canonical entry and region metadata mutations revoke originals before or after copying', () => {
  for (const [key, value] of [['entry', 1], ['architecture', 'other'], ['addressBits', 16],
    ['origin', { changed:true }], ['extra', { changed:true }], ['truncated', true]]) {
    const input = copiedRegion(); assert.ok(input.history);
    input.ir[key] = value;
    assert.equal(readSemanticConditionalRegions(input.seed), null, key);
    assert.equal(readCopiedConditionalRegions(input.output.cAst, input.ir), null, key);
    const recopy = enhanceSemanticDecompilation(input.seed, input.model, input.opts);
    assert.equal(readCopiedConditionalRegions(recopy.cAst, input.ir), null, key);
  }
});

test('nested canonical metadata cannot mutate through an unchanged envelope', () => {
  const input = render(); input.ir.extra = { nested:{ value:1 } };
  input.seed = decompileSemantic(input.model, input.opts);
  const output = enhanceSemanticDecompilation(input.seed, input.model, input.opts);
  assert.ok(readCopiedConditionalRegions(output.cAst, input.ir));
  input.ir.extra.nested.value = 2;
  assert.equal(readSemanticConditionalRegions(input.seed), null);
  assert.equal(readCopiedConditionalRegions(output.cAst, input.ir), null);
});

test('throwing carrier budget access withholds optional observation and preserves rendering', () => {
  const input = render();
  const options = { ...input.opts, phase8RegionCarrierBudget:{ get maxNodes() { throw new Error('budget getter'); } } };
  const output = enhanceSemanticDecompilation(input.seed, input.model, options);
  assert.equal(readCopiedConditionalRegions(output.cAst, input.ir), null);
  const ordinary = enhanceSemanticDecompilation(input.seed, input.model, input.opts);
  assert.equal(output.pseudocode, ordinary.pseudocode);
});
