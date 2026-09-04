import assert from 'node:assert/strict';
import test from 'node:test';

import { createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/contract.js';
import {
  INTERACTIVE_STAGES, PASS_STAGES, SCCP_PASS, createAnalysisState, passRegistryDigest,
  phase8Passes, runPassTransaction, runPhase8Stage, runPhase8Vertical,
  runSccpPass, seedAnalysisState, semanticSnapshotForAnalysis,
} from '../../../js/decompiler/phase8/index.js';
import { capturePhase8SemanticSnapshot } from '../../../js/decompiler/phase8/analysis-identity.js';

/**
 * A minimal IR carrying exactly the canonical facts the identity pass declares
 * it consumes: blocks (cfg), values (ssa) and origins. Anything less and the
 * transaction correctly refuses to run the pass, which is a different case and
 * is covered separately below.
 */
const CONTEXT = Object.freeze({
  ir: {
    values: [{ id: 1, origin: { instructionIds: ['instruction_1'] } }, { id: 2, origin: { instructionIds: ['instruction_2'] } }],
    blocks: [{ id: 'entry' }],
    entry: 'entry',
    origin: { instructionIds: ['instruction_1'] },
  },
  types: null,
  opts: {},
});

function noOpPass(id, run = null) {
  const descriptor = createPassDescriptor({
    id, version:'1.0.0', stage:'scalar-optimization', consumes:['ssa'], produces:[],
  });
  return {
    descriptor,
    run:run ?? (() => createPassResult({
      descriptor, status:'unchanged', changed:false, completeness:'complete',
    })),
  };
}

test('seeded transactions expose only the captured graph to passes', () => {
  const ir = {
    values:[{ id:1, bits:8, origin:{ instructionIds:['instruction_snapshot_value'] } }],
    blocks:[{ id:'entry' }], entry:'entry',
    origin:{ instructionIds:['instruction_snapshot_function'] },
  };
  const state = seedAnalysisState(ir);
  const snapshot = semanticSnapshotForAnalysis(state);
  let observed = null;
  const pass = noOpPass('phase8.snapshot-observer', (context) => {
    observed = context.ir;
    return createPassResult({
      descriptor:pass.descriptor, status:'unchanged', changed:false, completeness:'complete',
    });
  });
  const outcome = runPassTransaction(state, pass, { analysis:state, ir }, {});
  assert.equal(outcome.committed, true);
  assert.equal(observed, snapshot);
  assert.notEqual(observed, ir);
  assert.equal(state.get('ssa').values, snapshot.values);
});

test('direct scalar entry refuses an analysis state without a snapshot binding', () => {
  const state = createAnalysisState({
    cfg:{ blocks:[{ id:'entry' }], entry:'entry' },
    ssa:{ values:[{ id:1, bits:8 }] },
  });
  const outcome = runSccpPass({
    analysis:state,
    resolvedAnalysisIdentity:{ valid:true, identity:{ arbitrary:true } },
  });
  assert.equal(outcome.status, 'unsupported');
  assert.match(outcome.stopReason, /not bound to an immutable Semantic IR snapshot/);
});

test('transaction publication rejects authority changes outside the captured graph', () => {
  const ir = {
    values:[{ id:1, bits:8, origin:{ instructionIds:['instruction_authority_value'] } }],
    blocks:[{ id:'entry' }], entry:'entry',
    origin:{ instructionIds:['instruction_authority_function'] },
  };
  const state = seedAnalysisState(ir);
  const pass = noOpPass('phase8.authority-mutator', () => {
    ir.analysisIdentity = Object.freeze({
      binaryId:'binary:changed', functionId:'function:changed', snapshotId:'snapshot:changed',
      semanticIrId:'semantic-ir:changed', ssaId:'ssa:changed', analyzerVersion:'changed',
      shapeDigest:'shape:changed',
    });
    return createPassResult({
      descriptor:pass.descriptor, status:'unchanged', changed:false, completeness:'complete',
    });
  });
  const outcome = runPassTransaction(state, pass, { analysis:state, ir }, {});
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, 'semantic-snapshot-changed-before-commit');
});

test('snapshot Map and Set views expose no mutator or private target', () => {
  const ir = {
    values:[{ id:1, bits:8, origin:{ instructionIds:['instruction_map_value'] } }],
    blocks:[{ id:'entry' }], entry:'entry',
    semanticMetadata:new Map([['mode', 'raw']]), semanticSet:new Set(['raw']),
    origin:{ instructionIds:['instruction_map_function'] },
  };
  const state = seedAnalysisState(ir);
  const pass = noOpPass('phase8.snapshot-map-mutator', (context) => {
    const map = context.ir.semanticMetadata;
    const set = context.ir.semanticSet;
    assert.equal(map instanceof Map, true);
    assert.equal(set instanceof Set, true);
    assert.equal(Object.isFrozen(map), true);
    assert.equal(Object.isFrozen(set), true);
    assert.equal(map.get('mode'), 'raw');
    assert.equal(set.has('raw'), true);
    for (const operation of [
      () => map.set('mode', 'changed'), () => map.delete('mode'), () => map.clear(),
      () => Map.prototype.set.call(map, 'mode', 'changed'),
      () => set.add('changed'), () => set.delete('raw'), () => set.clear(),
      () => Set.prototype.add.call(set, 'changed'),
      () => Object.defineProperty(map, 'extra', { value:1 }),
      () => Object.setPrototypeOf(set, null),
    ]) assert.throws(operation);
    let mapOwner = null;
    let setOwner = null;
    map.forEach((_value, _key, owner) => { mapOwner = owner; });
    set.forEach((_value, _sameValue, owner) => { setOwner = owner; });
    assert.equal(mapOwner, map, 'Map.forEach must not leak its private target');
    assert.equal(setOwner, set, 'Set.forEach must not leak its private target');
    assert.equal(map.valueOf(), map);
    assert.equal(set.valueOf(), set);
    return createPassResult({
      descriptor:pass.descriptor, status:'unchanged', changed:false, completeness:'complete',
    });
  });
  const outcome = runPassTransaction(state, pass, { analysis:state, ir }, {});
  assert.equal(outcome.committed, true);
  assert.equal(ir.semanticMetadata.get('mode'), 'raw');
  assert.deepEqual([...ir.semanticSet], ['raw']);
});

test('snapshot collection domains are fixed before child capture can mutate their sources', () => {
  const map = new Map();
  const set = new Set();
  let mapTriggered = false;
  let setTriggered = false;
  const mapKey = new Proxy({}, {
    getPrototypeOf(target) {
      if (!mapTriggered) {
        mapTriggered = true;
        for (let index = 0; index < 64; index += 1) map.set(`late-map-${index}`, index);
      }
      return Reflect.getPrototypeOf(target);
    },
  });
  const setValue = new Proxy({}, {
    getPrototypeOf(target) {
      if (!setTriggered) {
        setTriggered = true;
        for (let index = 0; index < 64; index += 1) set.add(`late-set-${index}`);
      }
      return Reflect.getPrototypeOf(target);
    },
  });
  map.set(mapKey, 'first');
  set.add(setValue);

  const snapshot = capturePhase8SemanticSnapshot({ map, set });
  assert.equal(mapTriggered, true);
  assert.equal(setTriggered, true);
  assert.equal(map.size, 65);
  assert.equal(set.size, 65);
  assert.equal(snapshot.map.size, 1,
    'a live Map iterator must not absorb entries appended by a child trap');
  assert.equal(snapshot.set.size, 1,
    'a live Set iterator must not absorb values appended by a child trap');
});

test('direct transaction pins its pre-pass identity before a post-pass raw mutation', () => {
  const ir = {
    values:[{
      id:1, kind:'arg', bits:8, signed:null, const:null, def:null, uses:[],
      origin:{ instructionIds:['instruction_direct_identity_value'] },
    }],
    blocks:[{ id:'entry', index:0, insts:[], phis:[], succ:[], pred:[] }],
    entry:0, semanticMetadata:new Map([['mode', 'old']]),
    origin:{ instructionIds:['instruction_direct_identity_function'] },
  };
  const state = seedAnalysisState(ir);
  let checks = 0;
  let pinnedIdentity = null;
  const outcome = runPassTransaction(
    state,
    {
      descriptor:SCCP_PASS,
      run(context, budget, area) {
        pinnedIdentity = context.resolvedAnalysisIdentity;
        return runSccpPass(context, budget, area);
      },
    },
    { analysis:state, ir },
    {
      shouldAbort() {
        checks += 1;
        if (checks === 2) {
          ir.semanticMetadata.set('mode', 'new');
        }
        return false;
      },
    },
  );
  assert.equal(pinnedIdentity?.valid, true);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, 'semantic-snapshot-changed-before-commit');
  assert.equal(state.get('ranges'), null);
});

test('the vertical publishes a frozen deterministic ledger', () => {
  const first = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  const second = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  assert.equal(first.ledger.status, 'published');
  assert.equal(first.ledger.published, true);
  assert.equal(first.ledger.transformCount, 0, 'the identity pass must not transform anything');
  assert.deepEqual(first.ledger.invalidated, []);
  assert.ok(Object.isFrozen(first.ledger));
  // Same input, same registry, same digest. Timings are excluded on purpose.
  assert.equal(first.ledger.publicationDigest, second.ledger.publicationDigest);
});

test('the enabled stage set is part of the ledger and of its registry digest', () => {
  // A ledger produced without the optimizer stages must never be servable for a
  // request that wanted them, so the two must be distinguishable.
  const interactive = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  const everything = runPhase8Vertical({ ...CONTEXT, enabledStages: PASS_STAGES }, {});
  assert.deepEqual([...interactive.ledger.enabledStages], [...INTERACTIVE_STAGES]);
  assert.notEqual(interactive.ledger.registryDigest, everything.ledger.registryDigest);
  assert.ok(everything.ledger.passes.length > interactive.ledger.passes.length);
});

test('cancellation before the first pass publishes nothing', () => {
  const { ledger } = runPhase8Vertical(CONTEXT, { shouldAbort: () => true });
  assert.equal(ledger.published, false);
  assert.equal(ledger.status, 'cancelled');
  assert.deepEqual(ledger.passes, []);
  assert.equal(ledger.completeness, 'unknown', 'a cancelled run knows nothing, it does not know that nothing was needed');
  assert.equal(ledger.stopReason, 'cancelled-before-start');
  assert.ok(ledger.diagnostics.length > 0, 'a withheld ledger must say why');
});

test('cancellation observed after a pass still withholds the whole ledger', () => {
  // The predicate returns false on the pre-flight check and true afterwards,
  // which is exactly the case where a partial optimizer set could be published.
  let calls = 0;
  const { ledger } = runPhase8Vertical(CONTEXT, { shouldAbort: () => (calls += 1) > 1 });
  assert.equal(ledger.published, false);
  assert.equal(ledger.status, 'cancelled');
  assert.deepEqual(ledger.passes, []);
});

test('an incomplete optimizer run cannot overwrite a prior complete result', () => {
  const ir = { ...CONTEXT.ir, blocks: [{ id: 'entry', index: 0 }] };
  const state = seedAnalysisState(ir);
  const priorRanges = Object.freeze({ completeness: 'complete', marker: 'authoritative' });
  state.__write('ranges', priorRanges);
  const before = state.snapshot();
  const { ledger, analysis } = runPhase8Vertical({
    ...CONTEXT,
    ir,
    analysis: state,
    enabledStages: ['scalar-optimization'],
    sccpLimits: { maxWorkItems: 0 },
  }, {});
  assert.equal(ledger.published, false, 'a budget-truncated optimizer set is withheld');
  assert.equal(ledger.status, 'failed');
  assert.equal(analysis, state);
  assert.deepEqual(state.snapshot(), before, 'the authoritative versions stay untouched');
  assert.equal(state.get('ranges'), priorRanges, 'the complete artifact remains authoritative');
});

test('a cancellation predicate that throws is treated as cancelled', () => {
  const { ledger } = runPhase8Vertical(CONTEXT, { shouldAbort() { throw new Error('gone'); } });
  assert.equal(ledger.published, false);
});

test('a failure while reading upstream facts withholds the ledger', () => {
  // Exercised through the public runner by making the context hostile, so the
  // failure path is the real one rather than a private test-only registry.
  const hostile = { get ir() { throw new Error('boom'); } };
  const { ledger, analysis } = runPhase8Vertical(hostile, {});
  assert.equal(ledger.published, false);
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.stopReason, 'analysis-seed-failed');
  assert.equal(ledger.diagnostics[0].severity, 'error');
  assert.equal(analysis, null, 'no state may be handed on when the facts could not be read');
});

test('a pass that throws is not committed and withholds the ledger', () => {
  const throwing = {
    descriptor: createPassDescriptor({ id: 'phase8.throwing', version: '1.0.0', stage: 'scalar-optimization', consumes: ['ssa'], produces: ['ranges'] }),
    run() { throw new Error('boom'); },
  };
  const state = seedAnalysisState(CONTEXT.ir);
  const before = state.snapshot();
  const outcome = runPassTransaction(state, throwing, { analysis: state }, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^failed:/);
  assert.deepEqual(state.snapshot(), before, 'a thrown pass must leave no residue');
});

test('a pass whose declared inputs are absent does not run and is not complete', () => {
  // The transaction refuses rather than letting the pass improvise a substitute
  // for a missing upstream fact. The ledger still publishes, because "this pass
  // could not run and here is which fact was missing" is real information.
  const { ledger } = runPhase8Vertical({ ir: { values: [] }, enabledStages: INTERACTIVE_STAGES }, {});
  assert.equal(ledger.published, true);
  assert.equal(ledger.completeness, 'unknown');
  assert.equal(ledger.passes[0].status, 'unsupported');
  assert.match(ledger.passes[0].stopReason, /^missing-input:/);
  assert.equal(ledger.transformCount, 0);
  assert.equal(ledger.diagnostics[0].code, 'phase8.pass.missing-input');
});

test('the analysis state is seeded from upstream facts, never approximated', () => {
  const { analysis } = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  assert.deepEqual([...analysis.available()], ['cfg', 'ssa', 'origins']);
  // MemorySSA, alias, types and the rest were not supplied and stay absent at
  // version 0 rather than being invented.
  assert.equal(analysis.version('memorySsa'), 0);
  assert.equal(analysis.version('alias'), 0);
});

test('a committed no-op moves no analysis version', () => {
  const { ledger } = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  assert.deepEqual(ledger.analysisVersions.before, ledger.analysisVersions.after);
  assert.deepEqual(ledger.invalidated, []);
});

test('a withheld ledger reports the state as untouched', () => {
  const { ledger } = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, { shouldAbort: () => true });
  assert.equal(ledger.published, false);
  assert.deepEqual(ledger.analysisVersions.before, ledger.analysisVersions.after);
});

test('the registry digest changes with the pass set and is stable otherwise', () => {
  const passes = phase8Passes();
  assert.equal(passRegistryDigest(passes), passRegistryDigest(phase8Passes()));
  const bumped = passes.map(({ descriptor }) => ({ descriptor: { ...descriptor, version: '9.9.9' } }));
  assert.notEqual(passRegistryDigest(passes), passRegistryDigest(bumped),
    'a version bump must change the registry digest, or a stale result stays servable');
});

test('passes are ordered by declared stage, not by registration order', () => {
  const stages = phase8Passes().map(({ descriptor }) => descriptor.stageIndex);
  assert.deepEqual(stages, [...stages].sort((left, right) => left - right));
});

test('the stage honours its own budget and reports its cost', () => {
  const outcome = runPhase8Stage(CONTEXT, { timeBudgetMs: 15 });
  assert.deepEqual([...outcome.ledger.enabledStages], [...INTERACTIVE_STAGES], 'the stage defaults to the interactive set, not the whole middle end');
  assert.equal(outcome.ledger.published, true);
  assert.ok(Number.isFinite(outcome.elapsedMs));
  const cancelled = runPhase8Stage(CONTEXT, { timeBudgetMs: 15, shouldAbort: () => true });
  assert.equal(cancelled.ledger.published, false);
});

test('a zero budget cancels rather than running unbounded', () => {
  assert.equal(runPhase8Stage(CONTEXT, { timeBudgetMs: 0 }).ledger.published, false);
});
