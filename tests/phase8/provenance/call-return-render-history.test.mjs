import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIR } from '../../../js/ir-core.js';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompileSemantic, readSemanticStatementLineHistory, readSemanticStatementRenderHistory } from '../../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation as enhanceCore, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { normalizeCompatibilityLine } from '../../../js/decompiler/switch.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { BRANCH, loadRoadmapManifest, validateRoadmapManifest, validateRoadmapInventory } from '../../../tools/validation/analysis-roadmap/ownership.mjs';
import { analyzeGraph, readDominanceViewInputs } from '../../../js/controlflow.js';
import { captureRecoveryIrData } from '../../../js/decompiler/phase8/projection-origin.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';

const rule = op => `render-initial-${op}`;
const records = map => map.ledger.filter(record => ['render-initial-call', 'render-initial-return'].includes(record.rule));
const clone = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));
function fixture({ lines = ['mov w0, #7', 'bl #0x100001000', 'ret'], returnType = 'int32', name = 'callee', options = {}, beforeRender = null } = {}) {
  const rows = lines.map((text, row) => { const split = text.indexOf(' '); return { row, address:0x100000000n + BigInt(row * 4),
    mn:split < 0 ? text : text.slice(0, split), ops:split < 0 ? '' : text.slice(split + 1) }; });
  const rowOfAddress = address => rows.find(row => row.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow:0, endRow:rows.length - 1 });
  const prototype = { returnType, returnBits:returnType === 'int64' || returnType === 'double' ? 64 : 32,
    returnsValue:!['void', null, 'struct Pair'].includes(returnType), args:[{ type:'int32', bits:32 }] };
  const ir = buildIR(model, { rowOfAddress, returnType, callPrototypeFor:() => prototype, semanticMigrationMode:'semantic-v2-compat' });
  const opts = { ir, deterministicTransforms:true, returnType, defaultCallArgs:1, symbolFor:() => name, ...options };
  beforeRender?.(ir, model, opts);
  const seed = decompileSemantic(model, opts);
  const call = ir.instructions.find(inst => inst.op === 'call'), ret = ir.instructions.findLast(inst => inst.op === 'ret');
  const callLine = seed.lines.find(line => line.kind === 'stmt' && line.row === call?.row);
  const retLine = seed.lines.find(line => line.kind === 'stmt' && line.row === ret?.row);
  return { ir, model, opts, seed, call, ret, callLine, retLine, canonical:clone(ir) };
}

test('normal decoded calls and scalar/void/unknown/aggregate returns have actual initial line owners', () => {
  for (const returnType of ['int32', 'int64', 'float', 'double', 'void', null, 'struct Pair']) {
    const f = fixture({ returnType }), history = readSemanticStatementRenderHistory(f.seed);
    assert.ok(history); assert.deepEqual(history.reasons, []);
    for (const [inst, line] of [[f.call, f.callLine], [f.ret, f.retLine]]) {
      const entry = readSemanticStatementLineHistory(line, f.ir);
      assert.ok(entry, String(returnType) + '/' + inst.op);
      assert.equal(entry.instruction, inst); assert.equal(entry.records[0].rule, rule(inst.op === 'ret' ? 'return' : inst.op));
    }
    const map = buildRenderProvenance({ result:f.seed, snapshotId:'statement' });
    assert.equal(records(map).length, 2);
    for (const record of records(map)) {
      assert.equal(record.renderedBinding, 'producer-bound'); assert.equal(record.producedRefs.length, 1);
      assert.equal(record.proof, 'observed-call-return-render-not-abi-equivalence');
      assert.deepEqual(record.originHistory.elidedRefs, []);
    }
    assert.deepEqual(validateRenderProvenance(map).reasons, []);
    assert.deepEqual(clone(f.ir), f.canonical);
  }
});

test('raw call and void-return consumers retain actual initial and ABI histories through core/public projections', () => {
  for (const enhance of [enhanceCore, enhancePublic]) for (const returnType of ['int32', 'void', null]) {
    const f = fixture({ returnType });
    const enhanced = enhance(f.seed, f.model, f.opts);
    let result = applyPhase8Projection(enhanced, analysis());
    assert.equal(result.renderProvenance.completeness, 'complete', JSON.stringify({ returnType, reasons:result.renderProvenance.reasons, binding:enhanced.expressionHistoryBinding }));
    assert.equal(records(result.renderProvenance).length, 2);
    assert.ok(records(result.renderProvenance).every(record => record.producedRefs.length > 0));
    for (const abiRule of ['attach-canonical-call-arguments', 'attach-canonical-function-return']) {
      assert.ok(result.renderProvenance.ledger.some(record => record.kind === 'expression-rewrite' && record.rule === abiRule && record.producedRefs.length), abiRule);
    }
    const ledger = result.renderProvenance.ledger;
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
    assert.deepEqual(clone(f.ir), f.canonical);
  }
});

test('copied lines, text matches and copied result metadata cannot issue producer bindings', () => {
  const f = fixture(), copy = { ...f.callLine };
  assert.ok(readSemanticStatementLineHistory(copy, f.ir) === null);
  assert.ok(readSemanticStatementLineHistory(f.callLine, { ...f.ir }) === null);
  assert.ok(readSemanticStatementRenderHistory({ ...f.seed }) === null);
  const copied = { ...f.seed, lines:f.seed.lines.map(line => ({ ...line })) };
  const map = buildRenderProvenance({ result:copied, snapshotId:'statement' });
  assert.ok(map.reasons.includes('unavailable-initial-statement-history'));
  assert.equal(records(map).length, 0);
});

test('changed canonical inputs, scanned candidates, roots and getter replacements revoke the original producer', () => {
  for (const mutate of [
    f => { f.call.args = [...f.call.args]; }, f => { f.ir.values[0].reg = 'x28'; },
    f => { f.callLine.text += ' changed'; }, f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.model.calls = [...f.model.calls]; },
    f => { const value = f.ir.values; Object.defineProperty(f.ir, 'values', { enumerable:true, get:() => value }); },
    f => { f.ir.dominators[0].add(99); },
    f => { f.call.dst.uses.push(f.call); },
    f => { f.ir.args.set('x0', f.call.dst); },
  ]) {
    const f = fixture(); assert.ok(readSemanticStatementLineHistory(f.callLine, f.ir));
    mutate(f); assert.ok(readSemanticStatementLineHistory(f.callLine, f.ir) === null);
  }
});

test('ownership manifest owns the exact new regression path', () => {
  const files = ['tests/phase8/provenance/call-return-render-history.test.mjs'];
  assert.deepEqual(validateRoadmapInventory(BRANCH, 'phase8', files), files);
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', ['tests/phase8/provenance/unowned-statement-history.test.mjs']));
  const manifest = loadRoadmapManifest();
  assert.equal(validateRoadmapManifest(manifest).get('js/controlflow.js'), 'integration');
  manifest.owners.integration.splice(manifest.owners.integration.indexOf('js/controlflow.js'), 1);
  manifest.owners.phase8.push('js/controlflow.js');
  assert.throws(() => validateRoadmapManifest(manifest), /phase8 contract violations/);
});

test('materialized calls and standalone calls retain separate actual statements', () => {
  const scalar = fixture(), empty = fixture({ returnType:'void' });
  assert.match(scalar.callLine.text, /^call_\d+ = /);
  assert.doesNotMatch(empty.callLine.text, /^call_\d+ = /);
  for (const f of [scalar, empty]) {
    const map = buildRenderProvenance({ result:f.seed, snapshotId:'statement' });
    const call = records(map).find(record => record.rule === rule('call'));
    assert.deepEqual(call.producedRefs, [`L${f.seed.lines.indexOf(f.callLine)}:stmt`]);
    assert.ok(call.originHistory.consumedRefs.includes(`ir:${f.call.id}`));
  }
});

test('folded runtime calls are not attributed to an emitted call statement', () => {
  const f = fixture({ name:'objc_release', returnType:'void' });
  assert.equal(f.callLine, undefined);
  const history = readSemanticStatementRenderHistory(f.seed);
  assert.ok(history.records.every(record => record.rule !== rule('call')));
  const map = buildRenderProvenance({ result:f.seed, snapshotId:'statement' });
  assert.equal(records(map).filter(record => record.rule === rule('call')).length, 0);
  assert.ok(map.ledger.some(record => record.rule === 'omit-runtime-noise-call'));
});

test('an actual symbol callback changing a prior canonical input cannot bind the old rendering', () => {
  let changed = false;
  const f = fixture({ beforeRender(ir, model, opts) {
    opts.symbolFor = () => { if (!changed) { ir.values[0].reg = 'x28'; changed = true; } return 'callee'; };
  } });
  assert.equal(changed, true);
  assert.ok(readSemanticStatementLineHistory(f.callLine, f.ir) === null);
  assert.ok(f.seed.semanticStatementRenderHistory.reasons.includes('initial-statement-binding-unavailable'));
});

test('an actual prototype callback changing scanned candidates invalidates the whole initial producer preimage', () => {
  let changed = false;
  const f = fixture({ beforeRender(ir, model, opts) {
    opts.callPrototypeFor = () => { if (!changed) { ir.values[0].reg = 'x28'; changed = true; } return { args:['int'] }; };
  } });
  assert.equal(changed, true);
  assert.ok(readSemanticStatementLineHistory(f.callLine, f.ir) === null);
  assert.ok(readSemanticStatementLineHistory(f.retLine, f.ir) === null);
});

test('owned compatibility spelling follows the original producer but arbitrary same-text copies do not', () => {
  const f = fixture({ name:'local_ab' });
  assert.match(f.callLine.text, /local_ab/);
  const original = readSemanticStatementLineHistory(f.callLine, f.ir);
  normalizeCompatibilityLine(f.callLine, f.ir);
  assert.match(f.callLine.text, /var_AB/);
  const normalized = readSemanticStatementLineHistory(f.callLine, f.ir);
  assert.ok(normalized); assert.equal(normalized.records, original.records);
  normalizeCompatibilityLine(f.callLine, f.ir);
  assert.equal(readSemanticStatementLineHistory(f.callLine, f.ir), normalized);
  assert.ok(readSemanticStatementLineHistory({ ...f.callLine }, f.ir) === null);
  f.ir.values[0].reg = 'x28';
  assert.ok(readSemanticStatementLineHistory(f.callLine, f.ir) === null);
});

test('raw C AST consumer observes its actual node and still checks the initial emitter after handoff', () => {
  for (const mutate of [f => { f.callLine.text += ' changed'; }, f => { f.node.text += ' changed'; },
    f => { f.ir.values[0].reg = 'x28'; }, f => { f.node.semantic.ir = f.ret.id; }]) {
    const f = fixture({ returnType:'void' }), enhanced = enhanceCore(f.seed, f.model, f.opts);
    f.node = enhanced.cAst.body.find(node => node.semantic?.op === 'call-render');
    assert.ok(f.node);
    assert.ok(readExpressionHistoryConsumer(f.node.semantic, f.ir));
    mutate(f);
    assert.ok(readExpressionHistoryConsumer(f.node.semantic, f.ir) === null);
  }
});

test('history limits and cancellation withhold bindings without dropping emitted statements', () => {
  const baseline = fixture();
  for (const options of [{ renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } }, { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { shouldAbort:() => true }]) {
    const f = fixture({ options });
    assert.deepEqual(f.seed.lines.map(line => line.text), baseline.seed.lines.map(line => line.text));
    assert.ok(readSemanticStatementLineHistory(f.callLine, f.ir) === null);
    assert.equal(f.seed.semanticStatementRenderHistory.completeness, 'incomplete');
    assert.equal(buildRenderProvenance({ result:f.seed, snapshotId:'statement' }).completeness, 'incomplete');
  }
});

test('late map cancellation does not publish partially bound call/return history', () => {
  const f = fixture(); let calls = 0;
  const map = buildRenderProvenance({ result:f.seed, snapshotId:'statement', shouldAbort:() => ++calls > 3 });
  assert.equal(map.completeness, 'incomplete'); assert.deepEqual(map.reasons, ['cancelled']); assert.deepEqual(map.ledger, []);
});

test('query navigation reaches the actual call line and rejects stale snapshots', async () => {
  const f = fixture({ returnType:'void' });
  const result = applyPhase8Projection(enhancePublic(f.seed, f.model, f.opts), analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({ currentIdentity:async () => ({ binaryId:'statement', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }) });
  const query = await api.decompile(await api.snapshot(), 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('ir', String(f.call.id));
  assert.equal(selected.state, 'ready');
  assert.ok(selected.transforms.some(record => record.rule === rule('call')));
  assert.ok(selected.entities.length > 0);
  epoch++;
  assert.equal((await navigation.selectOrigin('ir', String(f.call.id))).reason, 'stale-query-snapshot');
});

test('faithful CFG fallback retains only final call/return emissions from the actual renderer', () => {
  // Explicit canonical CFG fixture, not decoded compiler corpus coverage.
  const f = irFixture('statement_fallback'); f.block(0);
  const output = f.call(32); output.reg = 'x0';
  f.conditionalBranch(f.opaque(1), 1, 2); f.block(1); f.ret(); f.block(2); f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = index + 700; inst.row = index; inst.address = 0x9000n + BigInt(index * 4); });
  for (const block of ir.blocks) block.startRow = block.insts[0].row;
  const model = { name:'statement_fallback', instructions:ir.instructions, calls:[] };
  const seed = decompileSemantic(model, { ir });
  assert.equal(seed.coverage.mode, 'linear');
  const history = readSemanticStatementRenderHistory(seed);
  assert.equal(history.records.length, 3);
  assert.deepEqual(history.reasons, []);
  const map = buildRenderProvenance({ result:seed, snapshotId:'statement' });
  assert.equal(records(map).length, 3);
  assert.ok(records(map).every(record => record.producedRefs.length === 1));
});

test('actual lazy dominance views retain backing data and reject copied or replaced capabilities', () => {
  for (const mutate of [
    ir => { ir.dominators[2].index.tin[2]++; },
    ir => { ir.dominators[2].reachable.delete(1); },
    ir => { ir.dominators[2].idom[2] = -1; },
    ir => { ir.dominators[2].node = 1; },
    ir => { ir.dominators[2].has = () => true; },
    ir => { ir.dominators[2] = Object.assign(Object.create(Object.getPrototypeOf(ir.dominators[2])), ir.dominators[2]); },
  ]) {
    const graph = analyzeGraph([[1], [2], []], 0);
    const ir = { instructions:[], values:[], blocks:[], idom:graph.immediateDominators, dominators:graph.dominators };
    assert.ok(readDominanceViewInputs(ir.dominators[2]));
    assert.ok(readDominanceViewInputs({ ...ir.dominators[2] }) === null);
    const copiedView = Object.assign(Object.create(Object.getPrototypeOf(ir.dominators[2])), ir.dominators[2]);
    assert.ok(readDominanceViewInputs(copiedView) === null);
    const observation = captureRecoveryIrData(ir, []);
    assert.equal(observation.matches(), true);
    mutate(ir); assert.equal(observation.matches(), false);
  }
});

test('initial observation never evaluates a uses getter to collect reverse-index roots', () => {
  let observerReads = 0;
  const f = fixture({ beforeRender(ir) {
    const value = ir.values[0], uses = value.uses;
    Object.defineProperty(value, 'uses', { enumerable:true, configurable:true, get() {
      if (new Error().stack.includes('beginStatementRenderHistory')) observerReads++;
      return uses;
    } });
  } });
  assert.equal(observerReads, 0);
  assert.ok(readSemanticStatementLineHistory(f.callLine, f.ir) === null);
});
