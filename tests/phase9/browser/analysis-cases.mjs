/** Shared browser/Node contract cases. No Node-only import, alternate semantics,
 * dependency stubs or changed browser runner. Chromium execution is additional
 * evidence, not a substitute for the project's pinned browser verification. */
import * as S from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity, integrationFixture, scalarFixture } from '../taint/fixtures.mjs';
const assert = (truth, message) => { if (!truth) throw new Error(message); };
const makeModels = () => S.createTaintModels({ id:'browser-contract',version:'1',provenance:'owned:browser',
  sources:[{id:'pointer',valueId:'ptr'},{id:'new',valueId:'byte'},{id:'old',valueId:'word'}],
  memorySinks:[{id:'memory-out',observationId:'word'}] });
export async function runAnalysisBrowserCases() {
  const results = [];
  const record = async (name, fn) => {
    const start = performance.now(); const metrics = await fn();
    results.push({ name, status:'PASS', milliseconds:performance.now()-start, metrics });
  };
  await record('source-symbolic-address-partial-store-memory-sink-evidence', () => {
    const r=S.queryTaint(integrationFixture(),{identity,models:makeModels(),memory:{addressBits:8,wrapping:'modular'},
      memoryObservations:[{id:'word',addressValueId:'ptr',size:2}]});
    assert(r.status==='complete',r.reason);
    assert(r.sinks[0].taint.sources.join(',')==='new,old,pointer','memory sources lost');
    assert(r.execution.paths.length===2 && r.evidence && r.graph,'missing paths or evidence');
    assert(S.isTaintQueryResult(r),'unissued taint');
    return r.metrics;
  });
  await record('pure-opcode-preserving-existing-backend-proof', async () => {
    const ir=scalarFixture(),inst=ir.blocks[0].insts[0];inst.op=OP.BIN;inst.sub='xor';inst.args.push(inst.args[0]);
    const r=await S.querySymbolicAnalysis(ir,{identity,models:S.createTaintModels({id:'pure',version:'1',provenance:'owned:browser'}),
      memory:{addressBits:8},targets:[inst.dst]});
    assert(r.status==='complete',r.reason);
    const c=r.targets[0].candidates.find(c=>c.rule==='xor-self');
    assert(c?.eligible && S.isAdoptableCandidate(c.verification),'no genuine proof');
    inst.sub='or';assert(!S.isSymbolicAnalysisResult(r),'stale IR result');
    assert(!S.isAdoptableCandidate(c.verification),'stale proof');
    return r.metrics;
  });
  await record('cancel-no-publication', () => {
    const controller=new AbortController();controller.abort();
    const r=S.queryTaint(integrationFixture(),{identity,models:makeModels(),signal:controller.signal,memory:{addressBits:8,wrapping:'modular'}});
    assert(r.status==='partial' && r.reason==='cancelled' && !r.evidence && r.sinks.length===0,'cancel published results');
    return r.metrics;
  });
  await record('observation-budget-no-publication', () => {
    const r=S.queryTaint(integrationFixture(),{identity,models:makeModels(),memory:{addressBits:8,wrapping:'modular',limits:{memoryObservationRecords:0}},
      memoryObservations:[{id:'word',addressValueId:'ptr',size:2}]});
    assert(r.status==='partial' && r.reason==='budget:memoryObservationRecords' && !r.evidence && r.sinks.length===0,'budget published results');
    return r.metrics;
  });
  return results;
}
