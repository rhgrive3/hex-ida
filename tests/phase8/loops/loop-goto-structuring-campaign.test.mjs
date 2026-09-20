import assert from 'node:assert/strict';
import test from 'node:test';

import { decompileSemantic, readSemanticControlRenderHistory } from '../../../js/decompiler/semantic-core.js';
import { PASS_STAGES, edgeAccountingFailures, runPhase8Stage } from '../../../js/decompiler/phase8/index.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function condition(f, reg = 'x0') {
  const value = f.opaque(1);
  value.reg = reg;
  return value;
}

function materialize(f) {
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap((block) => [...block.phis, ...block.insts]);
  let row = 0;
  for (const block of ir.blocks) {
    const instructions = [...block.phis, ...block.insts];
    for (const instruction of instructions) {
      instruction.id = `campaign_${row}`;
      instruction.row = row;
      instruction.address = 0x1000n + BigInt(row * 4);
      row += 1;
    }
    block.startRow = instructions[0]?.row ?? row;
    block.endRow = instructions.at(-1)?.row ?? block.startRow;
  }
  for (const block of ir.blocks) {
    const term = block.insts.at(-1);
    if (term?.op === 'cbr') {
    const target = block.succ[0];
      term.extra = { ...(term.extra ?? {}), kind:'cbnz', targetBlock:target,
        target:ir.blocks[target]?.insts?.[0]?.address ?? null };
    }
  }
  return ir;
}

function decompileIr(ir, semanticOpts = {}) {
  const result = decompileSemantic({ name:ir.name, instructions:ir.instructions, calls:[] }, {
    ir, name:ir.name, returnType:'void', returnsValue:false, ...semanticOpts,
  });
  assert.ok(result, 'fixture must produce semantic output');
  return { ir, result };
}

function decompile(f, semanticOpts = {}) {
  const ir = materialize(f);
  return decompileIr(ir, semanticOpts);
}

function phase8(ir) {
  const run = runPhase8Stage({ ir }, { stages:PASS_STAGES, timeBudgetMs:2000, maxWorkItems:100000 });
  assert.equal(run.ledger.published, true);
  const facts = run.analysis.get('structuredRegions');
  assert.equal(facts.completeness, 'complete');
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  return { facts, analysis:run.analysis };
}

function assertControlProvenance(result, expectedRules) {
  const history = readSemanticControlRenderHistory(result);
  assert.ok(history, 'initial control history must bind this output');
  assert.deepEqual(history.reasons, []);
  const provenance = buildRenderProvenance({ result, snapshotId:'loop-goto-campaign' });
  assert.equal(provenance.completeness, 'complete');
  assert.deepEqual(validateRenderProvenance(provenance).reasons, []);
  for (const rule of expectedRules) {
    assert.ok(provenance.ledger.some((record) => record.rule === rule), rule);
  }
}

function selfLatchAfterTerminalReturn({ malformedPhi = false, sideEntry = false } = {}) {
  const f = fixture('self_latch_after_terminal_return');
  f.block(0);
  f.conditionalBranch(condition(f), 2, 1);
  f.block(1).branch(3);
  f.block(2).ret();
  f.block(3);
  const seed = f.constant(0, 32);
  const phi = f.phi([[1, seed], [3, seed]], 32);
  if (malformedPhi) phi.def.incoming.push({ from:1, value:seed });
  f.conditionalBranch(condition(f, 'x1'), 3, 4);
  f.block(4).ret();
  if (sideEntry) {
    // Keep the original entry reachable and add a distinct reachable side entry.
    f.block(5);
    f.conditionalBranch(condition(f, 'x2'), 1, 3);
    f.blocks[0].succ = [2, 5];
    f.blocks[0].successorEdges = [{ to:2, kind:'conditional-true' }, { to:5, kind:'conditional-false' }];
    phi.def.incoming.push({ from:5, value:seed });
  }
  return f;
}

function singleExitBreakLoop() {
  const f = fixture('single_exit_break');
  f.block(0).branch(1);
  f.block(1);
  f.conditionalBranch(condition(f), 2, 3);
  f.block(2);
  f.conditionalBranch(condition(f, 'x1'), 3, 1);
  f.block(3).ret();
  return f;
}

function terminalReturnLoop({ unknown = false, secondEarlyExit = false, sharedEarlyTarget = false } = {}) {
  const f = fixture('terminal_return_loop');
  f.block(0).branch(1);
  f.block(1);
  f.conditionalBranch(condition(f), 2, 4);
  f.block(2);
  if (unknown) f.unknown(64);
  f.conditionalBranch(condition(f, 'x1'), 3, secondEarlyExit || sharedEarlyTarget ? 5 : 1);
  f.block(3);
  const stored = f.constant(1, 32);
  f.store(stored, { locKind:'field', locKey:'out' });
  f.call(64);
  f.ret();
  f.block(4).ret();
  if (secondEarlyExit) {
    f.block(5);
    f.conditionalBranch(condition(f, 'x2'), 1, 6);
    f.block(6).ret();
  } else if (sharedEarlyTarget) {
    f.block(5);
    f.conditionalBranch(condition(f, 'x2'), 3, 1);
  }
  return f;
}

function continueLoop() {
  const f = fixture('continue_loop');
  f.block(0).branch(1);
  f.block(1);
  f.conditionalBranch(condition(f), 2, 3);
  f.block(2).branch(1);
  f.block(3).ret();
  return f;
}

function nestedLoop() {
  const f = fixture('nested_loop');
  f.block(0).branch(1);
  f.block(1);
  f.conditionalBranch(condition(f), 2, 6);
  f.block(2).branch(3);
  f.block(3);
  f.conditionalBranch(condition(f, 'x1'), 4, 5);
  f.block(4).branch(3);
  f.block(5).branch(1);
  f.block(6).ret();
  return f;
}

function sharedCleanupLoop() {
  const f = fixture('shared_cleanup_loop');
  f.block(0).branch(1);
  f.block(1);
  f.conditionalBranch(condition(f), 2, 3);
  f.block(2).branch(1);
  f.block(3);
  const cleanup = f.constant(7, 32);
  f.store(cleanup, { locKind:'field', locKey:'cleanup' });
  f.ret();
  return f;
}

function externalEntryBreakLoop() {
  const f = fixture('external_entry_break');
  f.block(0); f.conditionalBranch(condition(f), 1, 4);
  f.block(1); f.conditionalBranch(condition(f, 'x1'), 2, 3);
  f.block(2); f.conditionalBranch(condition(f, 'x2'), 3, 1);
  f.block(3).ret();
  f.block(4).branch(1);
  return f;
}

function childEscapesParentLoop() {
  const f = fixture('child_escapes_parent');
  f.block(0).branch(1);
  f.block(1); f.conditionalBranch(condition(f), 2, 6);
  f.block(2).branch(3);
  f.block(3); f.conditionalBranch(condition(f, 'x1'), 4, 5);
  f.block(4); f.conditionalBranch(condition(f, 'x2'), 7, 3);
  f.block(5).branch(1);
  f.block(6).ret();
  f.block(7).ret();
  return f;
}

test('terminal early return followed by a canonical self-latch loop keeps PHI edges and becomes structured', () => {
  const { ir, result } = decompile(selfLatchAfterTerminalReturn());
  const { facts } = phase8(ir);
  assert.equal(facts.edgesByConstruct['loop-back-edge'], 1);
  assert.match(result.pseudocode, /if \(.+\) \{/);
  assert.match(result.pseudocode, /while \(/);
  assert.equal(result.coverage.mode, 'structured');
  assert.equal((result.pseudocode.match(/\bgoto\b/g) ?? []).length, 0);
  assertControlProvenance(result, ['render-initial-one-sided-if', 'render-initial-while-loop']);
});

test('single natural loop conditional exit becomes break only for its own proven exit', () => {
  const { ir, result } = decompile(singleExitBreakLoop());
  const { facts } = phase8(ir);
  assert.equal(facts.edgesByConstruct['loop-break'], 1);
  assert.match(result.pseudocode, /while \(/);
  assert.match(result.pseudocode, /break;/);
  assert.equal((result.pseudocode.match(/\bgoto\b/g) ?? []).length, 0);
  assertControlProvenance(result, ['render-initial-loop-break']);
});

test('loop early return retains its store and call exactly once and bypasses the normal cleanup', () => {
  const { ir, result } = decompile(terminalReturnLoop());
  phase8(ir);
  assert.match(result.pseudocode, /while \(/);
  assert.match(result.pseudocode, /if \(.+\) \{/);
  assert.equal((result.pseudocode.match(/field_0\s*=\s*1;/g) ?? []).length, 1, result.pseudocode);
  assert.equal((result.pseudocode.match(/unknown_call\(/g) ?? []).length, 1, result.pseudocode);
  assert.equal((result.pseudocode.match(/\breturn\b/g) ?? []).length, 2, result.pseudocode);
  assert.equal((result.pseudocode.match(/\bgoto\b/g) ?? []).length, 0);
  assertControlProvenance(result, ['render-initial-one-sided-if', 'render-initial-while-loop']);
});

test('natural loop, continue, nested loop, and shared cleanup retain their established source forms', () => {
  const continued = decompile(continueLoop()).result;
  assert.match(continued.pseudocode, /while \(/);
  assert.match(continued.pseudocode, /continue;/);
  assert.equal((continued.pseudocode.match(/\bgoto\b/g) ?? []).length, 0);

  const nested = decompile(nestedLoop()).result;
  assert.equal((nested.pseudocode.match(/while \(/g) ?? []).length, 2, nested.pseudocode);
  assert.equal((nested.pseudocode.match(/continue;/g) ?? []).length, 2, nested.pseudocode);
  assert.equal((nested.pseudocode.match(/\bgoto\b/g) ?? []).length, 0);

  const cleanup = decompile(sharedCleanupLoop()).result;
  const loop = cleanup.pseudocode.indexOf('while (');
  const store = cleanup.pseudocode.indexOf('= 7;');
  assert.ok(loop >= 0 && store > loop, cleanup.pseudocode);
  assert.equal((cleanup.pseudocode.match(/= 7;/g) ?? []).length, 1);
});

test('irreducible, side-entry, malformed-PHI, unknown-control, and multi-exit candidates fail closed', () => {
  const irreducible = fixture('irreducible');
  irreducible.block(0); irreducible.conditionalBranch(condition(irreducible), 1, 2);
  irreducible.block(1).branch(2);
  irreducible.block(2); irreducible.conditionalBranch(condition(irreducible, 'x1'), 1, 3);
  irreducible.block(3).ret();
  assert.ok(decompile(irreducible).result.pseudocode.includes('goto'), 'two-entry SCC must remain explicit');

  const sideEntryIr = materialize(selfLatchAfterTerminalReturn({ sideEntry:true }));
  const sideEntryPreds = sideEntryIr.blocks.flatMap((block, index) => block.succ.includes(3) ? [index] : []);
  const sideEntryPhiPreds = sideEntryIr.blocks[3].phis[0].def.incoming.map(({ from }) => from).sort((a, b) => a - b);
  assert.deepEqual(sideEntryPreds, [1, 3, 5], 'side-entry fixture must keep both external predecessors reachable');
  assert.deepEqual(sideEntryPhiPreds, sideEntryPreds, 'side-entry PHI must exactly match loop-header predecessors');
  assert.ok(decompileIr(sideEntryIr).result.pseudocode.includes('goto'),
    'external side entry must not become a loop continuation');
  assert.ok(decompile(selfLatchAfterTerminalReturn({ malformedPhi:true })).result.pseudocode.includes('goto'),
    'PHI-sensitive malformed incoming edges must reject the early-return continuation');
  assert.ok(decompile(terminalReturnLoop({ unknown:true })).result.pseudocode.includes('goto'),
    'unknown control inside a multi-exit loop must remain faithful');
  assert.ok(decompile(terminalReturnLoop({ secondEarlyExit:true })).result.pseudocode.includes('goto'),
    'two unrelated exits must not be coerced to break or return');
  assert.ok(decompile(terminalReturnLoop({ sharedEarlyTarget:true })).result.pseudocode.includes('goto'),
    'a shared early-return target must not have its store/call region claimed by one loop arm');
});

test('multiple-latch, fake-header, and nonterminating-SCC shapes remain outside this campaign proof', () => {
  const multipleLatch = fixture('multiple_latch');
  multipleLatch.block(0).branch(1);
  multipleLatch.block(1); multipleLatch.conditionalBranch(condition(multipleLatch), 2, 3);
  multipleLatch.block(2).branch(1);
  multipleLatch.block(3).branch(1);
  const multiple = decompile(multipleLatch).result;
  assert.ok(multiple.pseudocode.includes('goto') || !multiple.pseudocode.includes('while ('), multiple.pseudocode);

  const fakeHeader = fixture('fake_header');
  fakeHeader.block(0); fakeHeader.conditionalBranch(condition(fakeHeader), 1, 2);
  fakeHeader.block(1).ret(); fakeHeader.block(2).ret();
  assert.doesNotMatch(decompile(fakeHeader).result.pseudocode, /while \(/);

  const nonterminating = fixture('nonterminating');
  nonterminating.block(0).branch(1); nonterminating.block(1).branch(1);
  const output = decompile(nonterminating).result.pseudocode;
  assert.ok(output.includes('goto') || !output.includes('while ('), output);
});

test('external entries, malformed branch evidence, and exhausted proof budget do not synthesize loop control', () => {
  const external = decompile(externalEntryBreakLoop()).result.pseudocode;
  assert.doesNotMatch(external, /break;/, external);
  assert.ok(external.includes('goto') || !external.includes('while ('), external);

  const malformedBodyIr = materialize(singleExitBreakLoop());
  malformedBodyIr.blocks[2].insts.at(-1).extra = { targetBlock:null, target:null };
  const malformedBody = decompileIr(malformedBodyIr).result.pseudocode;
  assert.doesNotMatch(malformedBody, /break;/, malformedBody);

  const malformedHeaderIr = materialize(singleExitBreakLoop());
  malformedHeaderIr.blocks[1].insts.at(-1).extra = { targetBlock:null, target:null };
  const malformedHeader = decompileIr(malformedHeaderIr).result.pseudocode;
  assert.ok(malformedHeader.includes('goto') || !malformedHeader.includes('while ('), malformedHeader);

  const exhausted = decompile(selfLatchAfterTerminalReturn(), {
    controlFlowProofBudget:{ maxTerminalProofSteps:0 },
  }).result.pseudocode;
  assert.ok(exhausted.includes('goto'), exhausted);
});

test('child ownership stays local: inner and parent continues remain distinct, and a child cannot break outside its parent', () => {
  const { ir, result } = decompile(nestedLoop());
  const { facts } = phase8(ir);
  assert.equal(facts.edgesByConstruct['loop-back-edge'], 2);
  assert.equal((result.pseudocode.match(/continue;/g) ?? []).length, 2, result.pseudocode);

  const escaping = decompile(childEscapesParentLoop()).result.pseudocode;
  assert.ok(escaping.includes('goto') || !escaping.includes('while ('), escaping);
  assert.doesNotMatch(escaping, /break;/, escaping);
});
