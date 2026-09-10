import assert from 'node:assert/strict';
import test from 'node:test';
import { decompileSemantic, readSemanticStoreLineHistory } from '../../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation, isProducerProjection } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { normalizeCompatibilityLine } from '../../../js/decompiler/switch.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';
import { identity } from '../helpers/proof-fixtures.mjs';

const records = map => map.ledger.filter(record => record.rule === 'render-initial-compound-store');

function fixture({ bits = 32, op = 'add', one = false, reversed = false, different = false, stack = false, select = false, memoryOperand = false, mbaOperand = false, fork = false, proofMemory = false, options = {} } = {}) {
  const f = irFixture('initial_store_history'); f.block(0);
  const location = stack ? { locKind:'stack', locKey:'stack:16', disp:16 } : { locKind:'global', locKey:'global:32768' };
  const load = f.load(bits, location);
  let operand;
  if (mbaOperand) {
    const left = f.opaque(bits), right = f.opaque(bits); left.reg = 'x1'; right.reg = 'x2';
    operand = f.binary('xor', f.binary('xor', left, right, bits), f.binary('xor', right, left, bits), bits);
  } else operand = one ? f.constant(1n, bits) : memoryOperand ? f.load(bits, { locKind:'global', locKey:'global:32792' }) : f.opaque(bits);
  operand.reg = 'x0';
  const sum = f.binary(op, reversed ? operand : load, reversed ? load : operand, bits);
  const value = select ? f.select(f.opaque(1), sum, operand, bits) : sum;
  const store = f.store(value, different ? { locKind:'global', locKey:'global:32776' } : location);
  const unrelated = f.store(value, { locKind:'global', locKey:'global:32784' });
  if (fork) { f.conditionalBranch(f.opaque(1), 1, 2); f.block(1); f.ret(); f.block(2); }
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = index + 300; inst.row = index; inst.address = 0x9000n + BigInt(index * 4); });
  for (const inst of ir.instructions) if (inst.loc?.kind === 'global') inst.loc.address = BigInt(inst.loc.key.split(':')[1]);
  if (proofMemory) for (const inst of ir.instructions) if (['load', 'store'].includes(inst.op)) {
    // This clone-path fixture declares a concrete ordinary-memory program.
    // The default display fixtures deliberately retain unknown qualifiers.
    inst.extra.addressPrecise = true;
    inst.extra.memoryAccess = { ...inst.extra.memoryAccess, volatility:false, atomic:false, ordering:'none', endian:'little' };
  }
  for (const block of ir.blocks) block.startRow = block.insts[0].row;
  if (stack) ir.stackSlots = [{ key:location.locKey, offset:16n, name:'local_10' }];
  const ret = ir.instructions.at(-1); ret.args = [{ value }]; value.uses.push(ret);
  const model = { name:ir.name, instructions:ir.instructions, calls:[] };
  const opts = { deterministicTransforms:true, ...options, ir };
  const seed = decompileSemantic(model, opts);
  const canonical = structuredClone(ir), roots = Object.entries(ir);
  const line = seed.lines.find(line => line.kind === 'stmt' && line.row === store.row);
  return { seed, line, model, opts, ir, canonical, roots, load, operand, sum, value, store, unrelated, ret };
}

function assertCanonical(f) {
  assert.deepEqual(structuredClone(f.ir), f.canonical);
  for (const [key, value] of f.roots) assert.equal(f.ir[key], value);
}

test('seven actual initial RMW spellings retain canonical inputs across eight widths and the public pipeline', () => {
  let cells = 0;
  for (const bits of [1, 2, 3, 4, 8, 16, 32, 64]) for (const [op, one, form, spelling] of [
    ['add', true, 'post-increment', /\+\+;$/], ['sub', true, 'post-decrement', /--;$/],
    ['add', false, 'add-assignment', / \+= /], ['sub', false, 'sub-assignment', / -= /],
    ['mul', false, 'mul-assignment', / \*= /], ['sdiv', false, 'sdiv-assignment', / \/= /],
    ['udiv', false, 'udiv-assignment', / \/= /],
  ]) {
    const f = fixture({ bits, op, one }); assert.match(f.line.text, spelling, `${bits}/${form}`);
    const initialMap = buildRenderProvenance({ result:f.seed, snapshotId:'initial-store' });
    const [initial] = records(initialMap);
    assert.equal(records(initialMap).length, 1);
    assert.equal(initial.after, `store:${form}`);
    assert.equal(initial.proof, 'observed-store-spelling-not-memory-equivalence');
    assert.equal(initial.renderedBinding, 'producer-bound');
    assert.deepEqual(initial.originHistory.elidedRefs, []);
    for (const inst of [f.load.def, f.sum.def, f.store]) assert.ok(initial.originHistory.consumedRefs.includes(`ir:${inst.id}`));
    const enhanced = enhanceSemanticDecompilation(f.seed, f.model, f.opts);
    const result = applyPhase8Projection(enhanced, analysis()), map = result.renderProvenance;
    const [retained] = records(map);
    assert.equal(records(map).length, 1);
    assert.equal(retained.renderedBinding, 'producer-bound');
    const index = result.lines.findIndex(line => line.kind === 'stmt' && line.source.ir.includes(f.store.id));
    assert.deepEqual(retained.producedRefs, [`L${index}:stmt`]);
    assert.match(result.lines[index].text, / = /);
    const initialExpansions = map.ledger.filter(record => record.rule === 'expand-initial-store-spelling');
    const projectedExpansions = map.ledger.filter(record => record.rule === 'expand-projected-store-spelling');
    const division = ['sdiv', 'udiv'].includes(op);
    assert.equal(initialExpansions.length, division ? 1 : 0);
    assert.equal(projectedExpansions.length, division ? 0 : 1);
    const expansion = [...initialExpansions, ...projectedExpansions][0];
    assert.equal(expansion.before, `store:${form}`); assert.equal(expansion.after, 'store:assignment');
    assert.deepEqual(expansion.producedRefs, [`L${index}:stmt`]);
    assert.deepEqual(expansion.originHistory.elidedRefs, []);
    for (const inst of [f.load.def, f.sum.def, f.store]) assert.ok(expansion.originHistory.consumedRefs.includes(`ir:${inst.id}`));
    assert.equal(validateRenderProvenance(map).state, 'complete');
    assertCanonical(f); cells++;
  }
  assert.equal(cells, 56, 'initial display-source cells, not RMW/alias/memory equivalence proofs');
});

test('actual initial history and the later C AST event remain distinct and stable under replay', () => {
  const f = fixture({ one:true });
  let result = applyPhase8Projection(enhanceSemanticDecompilation(f.seed, f.model, f.opts), analysis());
  assert.equal(records(result.renderProvenance).length, 1);
  assert.equal(result.renderProvenance.ledger.filter(record => record.rule === 'render-compound-store').length, 1);
  const ledger = result.renderProvenance.ledger;
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger, ledger);
  assertCanonical(f);
});

test('the public proof path carries the spelling event through its owned clone without modifying the original producer', async () => {
  const f = fixture({ one:true, proofMemory:true });
  const original = enhanceSemanticDecompilation(f.seed, f.model, { ...f.opts, phase8PrepareProof:true });
  assert.ok(isProducerProjection(original));
  const originalText = original.pseudocode, originalNode = original.cAst.body.find(node => /\+\+;$/.test(node.text));
  assert.ok(originalNode);
  const result = await optimizeSemanticDecompilation(original, { identity:{ ...identity, addressSpace:'memory' },
    abiId:'generic-v1', targets:[], memory:{ addressBits:32, endian:'little', initialBytes:[[32768n, 7], [32769n, 0], [32770n, 0], [32771n, 0]] }, timeoutMs:1000 });
  assert.equal(result.proofOptimization.status, 'complete', result.proofOptimization.reason);
  assert.equal(result.proofOptimization.adopted, 0, 'this test does not request or prove a memory rewrite');
  assert.ok(isProducerProjection(result)); assert.ok(isProducerProjection(original));
  assert.equal(original.pseudocode, originalText); assert.match(originalNode.text, /\+\+;$/);
  const [expanded] = result.renderProvenance.ledger.filter(record => record.rule === 'expand-projected-store-spelling');
  assert.ok(expanded); assert.equal(expanded.renderedBinding, 'producer-bound');
  assert.equal(expanded.proof, 'observed-store-spelling-not-memory-equivalence');
  assertCanonical(f);
});

test('a genuine proved scalar replacement inside a store retains its owned spelling transition', async () => {
  const f = fixture({ bits:8, mbaOperand:true, proofMemory:true });
  const original = enhanceSemanticDecompilation(f.seed, f.model, { ...f.opts, phase8PrepareProof:true });
  const originalText = original.pseudocode; assert.match(originalText, /\^/);
  const result = await optimizeSemanticDecompilation(original, { identity:{ ...identity, addressSpace:'memory' },
    abiId:'generic-v1', targets:[f.operand], candidateStrategy:'equality-saturation', backendTier:'tiered',
    memory:{ addressBits:32, endian:'little', initialBytes:[[32768n, 7]] }, timeoutMs:1000 });
  assert.equal(result.proofOptimization.status, 'complete', result.proofOptimization.reason);
  assert.equal(result.proofOptimization.adopted, 1, 'only the pure scalar operand is independently proved');
  assert.ok(result.phase8Projection.transforms.some(record => record.valueId === `legacy-number:${f.operand.id}` && record.queryHash));
  assert.equal(original.pseudocode, originalText); assert.ok(isProducerProjection(original));
  const [expanded] = result.renderProvenance.ledger.filter(record => record.rule === 'expand-projected-store-spelling');
  assert.ok(expanded); assert.equal(expanded.renderedBinding, 'producer-bound');
  assert.equal(expanded.proof, 'observed-store-spelling-not-memory-equivalence');
  assert.ok(expanded.originHistory.consumedRefs.includes(`ir:${f.operand.def.id}`));
  const lineRef = instruction => {
    const index = result.lines.findIndex(line => line.kind === 'stmt' && line.source.ir.includes(instruction.id));
    assert.ok(index >= 0); return `L${index}:stmt`;
  };
  assert.deepEqual(expanded.producedRefs, [lineRef(f.store)], 'only the actual compound-store emitter owns the spelling change');
  const queryHash = result.phase8Projection.transforms.find(record => record.queryHash)?.queryHash;
  const proved = result.renderProvenance.ledger.find(record => record.queryHash === queryHash);
  assert.ok(proved);
  assert.deepEqual(new Set(proved.producedRefs), new Set([f.store,f.unrelated,f.ret].map(lineRef)),
    'all actual scalar consumers retain proof edges, independently of store spelling');
  assert.ok(!result.phase8Projection.history.reasons.includes('stale-store-spelling-producer'));
  const replay = await optimizeSemanticDecompilation(result, { identity:{ ...identity, addressSpace:'memory' },
    abiId:'generic-v1', targets:[f.operand], candidateStrategy:'equality-saturation', backendTier:'tiered',
    memory:{ addressBits:32, endian:'little', initialBytes:[[32768n, 7]] }, timeoutMs:1000 });
  assert.equal(replay.proofOptimization.status, 'complete', replay.proofOptimization.reason);
  assert.equal(replay.proofOptimization.adopted, 0);
  assert.equal(replay.pseudocode, result.pseudocode);
  assert.deepEqual(replay.renderProvenance.ledger, result.renderProvenance.ledger);
  assertCanonical(f);
});

test('display history does not admit unresolved or mismatched memory into the public proof path', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture({ one:true, proofMemory:mismatch });
    const original = enhanceSemanticDecompilation(f.seed, f.model, { ...f.opts, phase8PrepareProof:true });
    const result = await optimizeSemanticDecompilation(original, { identity:{ ...identity, addressSpace:mismatch ? 'data' : 'memory' },
      abiId:'generic-v1', targets:[], memory:{ addressBits:32 }, timeoutMs:1000 });
    assert.equal(result.proofOptimization.status, 'partial'); assert.equal(result.proofOptimization.adopted, 0);
    assert.equal(result.proofOptimization.reason, mismatch ? 'address-space-mismatch' : 'unresolved-memory-address');
    assert.equal(result.pseudocode, original.pseudocode); assert.ok(isProducerProjection(original));
    assertCanonical(f);
  }
});

test('RMW analysis without an actual eligible display branch does not issue a store-render record', () => {
  for (const options of [{ op:'sub', reversed:true }, { different:true }, { op:'xor' }, { select:true }]) {
    const f = fixture(options); assert.match(f.line.text, / = /);
    assert.deepEqual(records(buildRenderProvenance({ result:f.seed })), []);
    assertCanonical(f);
  }
});

test('the existing compatibility normalization carries an actual stack store, not an edited or copied line', () => {
  const f = fixture({ one:true, stack:true });
  assert.match(f.line.text, /local_/);
  normalizeCompatibilityLine(f.line, f.ir);
  assert.match(f.line.text, /var_/);
  assert.ok(readSemanticStoreLineHistory(f.line, f.ir));
  const map = buildRenderProvenance({ result:f.seed });
  assert.equal(records(map)[0].renderedBinding, 'producer-bound');
  const result = applyPhase8Projection(enhanceSemanticDecompilation(f.seed, f.model, f.opts), analysis());
  assert.equal(records(result.renderProvenance)[0].renderedBinding, 'producer-bound');
  const copied = { ...f.line }; normalizeCompatibilityLine(copied, f.ir);
  assert.equal(readSemanticStoreLineHistory(copied, f.ir), null);
  f.line.text = 'local_bad++;'; normalizeCompatibilityLine(f.line, f.ir);
  assert.equal(readSemanticStoreLineHistory(f.line, f.ir), null);
});

test('stale instructions, replaced roots and copied initial lines retain only unbound historical events', () => {
  for (const mutate of [
    f => { f.store.args[0].value = f.load; },
    f => { f.sum.def.sub = 'xor'; },
    f => { f.load.def.loc.key = 'global:999'; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.instructions[f.ir.instructions.indexOf(f.store)] = { ...f.store }; },
    f => { f.line.text = 'forged();'; },
    f => { f.seed.lines[f.seed.lines.indexOf(f.line)] = { ...f.line }; },
  ]) {
    const f = fixture(); mutate(f);
    const [record] = records(buildRenderProvenance({ result:f.seed }));
    assert.ok(record); assert.equal(record.renderedBinding, 'unresolved'); assert.deepEqual(record.producedRefs, []);
  }
});

test('copied result disposition and copied downstream records cannot issue an initial producer binding', () => {
  for (const mutate of [
    f => { f.seed = { ...f.seed }; },
    f => { f.seed.semanticStoreRenderHistory = { ...f.seed.semanticStoreRenderHistory }; },
  ]) {
    const f = fixture(); mutate(f);
    const map = buildRenderProvenance({ result:f.seed });
    assert.deepEqual(records(map), []); assert.ok(map.reasons.includes('unavailable-initial-store-history'));
  }
  const f = fixture(), enhanced = enhanceSemanticDecompilation(f.seed, f.model, f.opts);
  enhanced.rewriteProof = enhanced.rewriteProof.map(record => ({ ...record }));
  const [record] = records(applyPhase8Projection(enhanced, analysis()).renderProvenance);
  assert.equal(record.renderedBinding, 'unresolved'); assert.deepEqual(record.producedRefs, []);
});

test('a public history reader cannot replace the observed selection validator', () => {
  const f = fixture(), entry = readSemanticStoreLineHistory(f.line, f.ir);
  assert.ok(entry); assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(entry.canonical));
  assert.equal(Reflect.set(entry.canonical, 'isCurrent', () => true), false);
  f.sum.def.sub = 'xor';
  assert.equal(readSemanticStoreLineHistory(f.line, f.ir), null);
});

test('copied initial lines cannot issue an initial-to-C-AST expansion record', () => {
  const f = fixture({ op:'udiv' });
  f.seed.lines[f.seed.lines.indexOf(f.line)] = { ...f.line };
  const result = applyPhase8Projection(enhanceSemanticDecompilation(f.seed, f.model, f.opts), analysis());
  assert.deepEqual(result.renderProvenance.ledger.filter(record => record.rule === 'expand-initial-store-spelling'), []);
});

test('initial history caps and cancellation preserve output and make the missing binding explicit', () => {
  const baseline = fixture({ one:true }).seed.pseudocode;
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = fixture({ one:true, options });
    assert.equal(f.seed.pseudocode, baseline);
    assert.equal(f.seed.semanticStoreRenderHistory.completeness, 'incomplete');
    const map = buildRenderProvenance({ result:f.seed, snapshotId:'initial-store-budget' });
    assert.equal(map.completeness, 'incomplete');
    assert.ok(map.reasons.includes('incomplete-initial-store-history'));
    assert.ok(records(map).every(record => record.renderedBinding === 'unresolved'));
  }
});

test('symbol callbacks during and after emission cannot rebind a past initial spelling to changed inputs', () => {
  for (const duringOperand of [false, true]) {
    const f = fixture({ one:!duringOperand, memoryOperand:duringOperand });
    let mutations = 0;
    const seed = decompileSemantic(f.model, { ...f.opts, symbolFor:address => {
      if (address === (duringOperand ? 32792n : 32784n)) { mutations++; f.sum.def.sub = 'xor'; }
      return null;
    } });
    assert.ok(mutations > 0);
    assert.ok(seed.lines.some(line => /\+\+;| \+= /.test(line.text)), 'actual earlier spelling is unchanged');
    const [record] = records(buildRenderProvenance({ result:seed }));
    assert.ok(record, 'historical event is retained without a current canonical binding');
    assert.equal(record.renderedBinding, 'unresolved'); assert.deepEqual(record.producedRefs, []);
    assert.ok(record.originHistory.consumedRefs.includes(`ir:${f.sum.def.id}`));
  }
});

test('faithful CFG fallback retains only the selected final store emission', () => {
  const f = fixture({ one:true, fork:true });
  assert.equal(f.seed.coverage.mode, 'linear');
  assert.equal(f.seed.lines.filter(line => /\+\+;$/.test(line.text)).length, 1);
  const history = records(buildRenderProvenance({ result:f.seed }));
  assert.equal(history.length, 1);
  assert.equal(history[0].renderedBinding, 'producer-bound');
  assert.equal(history[0].producedRefs.length, 1);
  assertCanonical(f);
});

test('a mutation after line binding during map construction cannot publish complete provenance', () => {
  const f = fixture({ one:true }); let checks = 0, totalChecks = 0;
  // Additional genuine history records add cancellation checkpoints. Measure
  // the actual unmodified map's last checkpoint instead of assuming ordinal7
  // is still after this store's binding when the ledger grows.
  buildRenderProvenance({ result:f.seed, snapshotId:'initial-store-map-race', shouldAbort:() => { totalChecks++; return false; } });
  const map = buildRenderProvenance({ result:f.seed, snapshotId:'initial-store-map-race', shouldAbort:() => {
    if (++checks === totalChecks) f.store.row = 99;
    return false;
  } });
  assert.ok(checks >= 7);
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.reasons.includes('stale-expression-binding'));
});

test('division spelling remains navigable through the public pipeline and rejects a stale query snapshot', async () => {
  const f = fixture({ op:'udiv' }), enhanced = enhanceSemanticDecompilation(f.seed, f.model, f.opts);
  const result = applyPhase8Projection(enhanced, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'initial-store-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  for (const inst of [f.load.def, f.sum.def, f.store]) {
    const selected = await navigation.selectOrigin('addr', inst.address);
    assert.equal(selected.state, 'ready');
    assert.ok(selected.transforms.some(record => record.rule === 'render-initial-compound-store' && record.after === 'store:udiv-assignment'));
    assert.ok(selected.transforms.some(record => record.rule === 'expand-initial-store-spelling' && record.after === 'store:assignment'));
  }
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.store.address)).reason, 'stale-query-snapshot');
});
