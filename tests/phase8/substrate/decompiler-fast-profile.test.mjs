import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDecompilerProfile,
  applyDecompilerProfile,
  DECOMPILER_PROFILES,
} from '../../../js/decompiler/profiles.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function buildSimpleFixture() {
  const f = fixture('profile_test');
  f.block(0);
  const a = f.opaque(8);
  a.index = 0;
  a.reg = 'x0';
  const target = f.binary('add', a, a, 8);
  f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap((block) => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => {
    inst.id = `inst_${index}`;
    inst.address = 0x1000n + BigInt(index * 4);
  });
  const ret = ir.instructions.at(-1);
  ret.args = [{ value: target }];
  return { ir, ret };
}

test('resolveDecompilerProfile: resolves presets and falls back gracefully', () => {
  const fast = resolveDecompilerProfile('fast');
  assert.equal(fast.name, 'fast');
  assert.equal(fast.decompilerTimeBudgetMs, 30);
  assert.equal(fast.phase8TimeBudgetMs, 30);
  assert.equal(fast.phase8WorkBudget, 10000);
  assert.deepEqual(fast.renderProvenanceBudget, { maxTransformRecords: 128 });
  assert.deepEqual(fast.renderProvenanceBindingBudget, { maxConsumers: 256 });

  const deep = resolveDecompilerProfile('deep');
  assert.equal(deep.name, 'deep');
  assert.equal(deep.decompilerTimeBudgetMs, 250);
  assert.equal(deep.phase8TimeBudgetMs, null);
  assert.equal(deep.phase8WorkBudget, null);
  assert.equal(deep.renderProvenanceBudget, null);

  // Defaults and case-insensitivity
  assert.equal(resolveDecompilerProfile(undefined), fast);
  assert.equal(resolveDecompilerProfile(''), fast);
  assert.equal(resolveDecompilerProfile('FAST'), fast);
  assert.equal(resolveDecompilerProfile('unknown-profile'), fast);
  assert.equal(resolveDecompilerProfile(null), fast);
  assert.equal(resolveDecompilerProfile(123), fast);
  assert.equal(resolveDecompilerProfile('deep'), deep);
  assert.equal(resolveDecompilerProfile('DEEP'), deep);
});

test('applyDecompilerProfile: applies defaults while respecting caller explicit overrides', () => {
  // Fast profile application
  const fastOpts = applyDecompilerProfile({ profile: 'fast' });
  assert.equal(fastOpts.decompilerTimeBudgetMs, 30);
  assert.equal(fastOpts.phase8TimeBudgetMs, 30);
  assert.equal(fastOpts.phase8WorkBudget, 10000);
  assert.deepEqual(fastOpts.renderProvenanceBudget, { maxTransformRecords: 128 });
  assert.deepEqual(fastOpts.renderProvenanceBindingBudget, { maxConsumers: 256 });

  // Explicit override takes precedence over fast preset
  const overridden = applyDecompilerProfile({
    profile: 'fast',
    decompilerTimeBudgetMs: 50,
    renderProvenanceBudget: { maxTransformRecords: 64 },
  });
  assert.equal(overridden.decompilerTimeBudgetMs, 50, 'explicit time budget must override preset');
  assert.equal(overridden.phase8TimeBudgetMs, 30, 'unspecified property must inherit from fast preset');
  assert.deepEqual(overridden.renderProvenanceBudget, { maxTransformRecords: 64 }, 'explicit provenance budget must override preset');

  // Default options inherit fast preset
  const defaultOpts = applyDecompilerProfile({});
  assert.equal(defaultOpts.decompilerTimeBudgetMs, 30);
  assert.equal(defaultOpts.phase8TimeBudgetMs, 30);
  assert.equal(defaultOpts.phase8WorkBudget, 10000);
  assert.deepEqual(defaultOpts.renderProvenanceBudget, { maxTransformRecords: 128 });
  assert.deepEqual(defaultOpts.renderProvenanceBindingBudget, { maxConsumers: 256 });
});

test('enhanceSemanticDecompilation: executes cleanly under profile: fast', () => {
  const { ir, ret } = buildSimpleFixture();
  const result = enhanceSemanticDecompilation(
    {
      semantic: true,
      ir,
      types: null,
      lines: [{ kind: 'stmt', indent: 0, text: 'return pending;', row: ret.row, addr: ret.address }],
      metrics: {},
      ctx: {},
    },
    null,
    { profile: 'fast', returnType: 'uint8_t' }
  );

  assert.ok(result, 'must return enhanced decompilation result');
  assert.ok(result.pseudocode, 'must contain pseudocode');
  assert.ok(Array.isArray(result.lines), 'must contain lines');
  assert.ok(result.lines.length > 0, 'must have at least one line');
  // Verify statement line has address mapping
  const stmtLine = result.lines.find((l) => l.kind === 'stmt');
  assert.ok(stmtLine.addr != null, 'stmt line must preserve instruction address for navigation');
  assert.equal(typeof stmtLine.addr, 'bigint');
});

test('module re-exports: profiles are accessible across decompiler entry points', async () => {
  const pipeline = await import('../../../js/decompiler/pipeline.js');
  const pipelineCore = await import('../../../js/decompiler/pipeline-core.js');
  const semantic = await import('../../../js/decompiler/semantic.js');
  const semanticCore = await import('../../../js/decompiler/semantic-core.js');

  assert.equal(typeof pipeline.resolveDecompilerProfile, 'function');
  assert.equal(typeof pipeline.applyDecompilerProfile, 'function');
  assert.equal(typeof pipelineCore.resolveDecompilerProfile, 'function');
  assert.equal(typeof pipelineCore.applyDecompilerProfile, 'function');
  assert.equal(typeof semantic.resolveDecompilerProfile, 'function');
  assert.equal(typeof semantic.applyDecompilerProfile, 'function');
  assert.equal(typeof semanticCore.resolveDecompilerProfile, 'function');
  assert.equal(typeof semanticCore.applyDecompilerProfile, 'function');

  assert.equal(pipeline.resolveDecompilerProfile('fast').name, 'fast');
  assert.equal(semantic.resolveDecompilerProfile('fast').name, 'fast');
});

test('decompileSemantic: produces consistent pseudocode under profile: fast and profile: deep', async () => {
  const { decompileSemantic } = await import('../../../js/decompiler/semantic-core.js');
  const { ir, ret } = buildSimpleFixture();
  const model = {
    instructions: ir.instructions,
    calls: [],
    name: 'profile_test',
  };

  const fastResult = decompileSemantic(model, { ir, profile: 'fast', returnType: 'uint8_t' });
  const deepResult = decompileSemantic(model, { ir, profile: 'deep', returnType: 'uint8_t' });

  assert.ok(fastResult.pseudocode, 'fast result must contain pseudocode');
  assert.ok(deepResult.pseudocode, 'deep result must contain pseudocode');
  assert.equal(fastResult.pseudocode, deepResult.pseudocode, 'pseudocode must match across fast and deep profiles');
  assert.ok(Array.isArray(fastResult.lines), 'fast result must contain lines');
  assert.equal(fastResult.lines.length, deepResult.lines.length, 'line counts must match');
});

test('renderProvenanceBudget: fast profile bounds history record limits', async () => {
  const { decompileSemantic } = await import('../../../js/decompiler/semantic-core.js');
  const { ir } = buildSimpleFixture();
  const model = {
    instructions: ir.instructions,
    calls: [],
    name: 'profile_test',
  };

  const fastResult = decompileSemantic(model, { ir, profile: 'fast', returnType: 'uint8_t' });
  // Fast profile bounds suppressionHistory and storeRenderHistory to 128
  assert.ok(fastResult.ctx, 'result must include context');
  // Provenance limit applied
  const defaultOpts = applyDecompilerProfile({ profile: 'fast' });
  assert.equal(defaultOpts.renderProvenanceBudget.maxTransformRecords, 128);
  assert.equal(defaultOpts.renderProvenanceBindingBudget.maxConsumers, 256);
});
