from pathlib import Path
p=Path('js/core/scheduler/analysis-scheduler.js')
s=p.read_text()
anchor="function abortError(signal) { return signal?.reason ?? new DOMException('Aborted', 'AbortError'); }\n"
helper=anchor+"function requireArtifactId(value, code = 'artifact-id-required') {\n  if (typeof value !== 'string' || !value) throw new TypeError(code);\n  return value;\n}\n"
if 'function requireArtifactId(value' not in s:
    if anchor not in s: raise SystemExit('scheduler helper anchor drift')
    s=s.replace(anchor,helper,1)
s=s.replace("const id = String(dependency?.descriptor?.artifactId || '');\n    if (!id) throw new SchedulerDependencyIdentityError(artifactId, request.descriptor?.upstreamArtifactIds || [], ['<missing-artifact-id>']);", "const rawId = dependency?.descriptor?.artifactId;\n    if (typeof rawId !== 'string' || !rawId) throw new SchedulerDependencyIdentityError(artifactId, request.descriptor?.upstreamArtifactIds || [], ['<missing-artifact-id>']);\n    const id = rawId;")
s=s.replace("const actual = dependencies.map((dependency) => String(dependency.descriptor.artifactId));", "const actual = dependencies.map((dependency) => requireArtifactId(dependency.descriptor.artifactId, 'artifact-dependency-id-invalid'));")
s=s.replace("if (upstream != null && !Array.isArray(upstream)) throw new SchedulerDependencyIdentityError(artifactId, [String(upstream)], actual);\n  const expected = (upstream || []).map(String).sort();", "if (upstream != null && !Array.isArray(upstream)) throw new SchedulerDependencyIdentityError(artifactId, ['<invalid-upstream-list>'], actual);\n  const expected = (upstream || []).map((id) => requireArtifactId(id, 'artifact-dependency-id-invalid')).sort();")
s=s.replace("remove(artifactId) { const index=this.indices.get(String(artifactId));", "remove(artifactId) { const index=this.indices.get(requireArtifactId(artifactId));")
s=s.replace("const artifactId=String(descriptor?.artifactId||'');\n    if (!artifactId) return Promise.reject(new TypeError('artifact-request-descriptor-required'));", "let artifactId;\n    try { artifactId=requireArtifactId(descriptor?.artifactId,'artifact-request-descriptor-required'); }\n    catch (error) { return Promise.reject(error); }")
s=s.replace("this.#registerDag(task.artifactId,dependencies.map((dependency)=>String(dependency.descriptor.artifactId)));", "this.#registerDag(task.artifactId,dependencies.map((dependency)=>requireArtifactId(dependency.descriptor.artifactId,'artifact-dependency-id-invalid')));")
old="""      for (const signal of active) {
        const listener=()=>finish(reject,abortError(signal),true);
        listeners.push([signal,listener]); signal.addEventListener('abort',listener,{once:true});
      }
      task.promise.then((value)=>finish(resolve,value),(error)=>finish(reject,error));"""
new="""      for (const signal of active) {
        const listener=()=>finish(reject,abortError(signal),true);
        listeners.push([signal,listener]); signal.addEventListener('abort',listener,{once:true});
      }
      const abortedAfterRegistration=active.find((signal)=>signal.aborted);
      if (abortedAfterRegistration) {
        finish(reject,abortError(abortedAfterRegistration),true);
        return;
      }
      task.promise.then((value)=>finish(resolve,value),(error)=>finish(reject,error));"""
if old in s: s=s.replace(old,new,1)
elif new not in s: raise SystemExit('scheduler abort anchor drift')
for needle in ["String(descriptor?.artifactId", "String(dependency.descriptor.artifactId)", "indices.get(String(artifactId))"]:
    if needle in s: raise SystemExit(f'scheduler coercion remains: {needle}')
p.write_text(s)

Path('tests/phase4/scheduler/strict-authority-boundaries.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { ArtifactStore, MemoryArtifactBackend, createArtifactDescriptor } from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';

function descriptor(name) {
  return createArtifactDescriptor({
    binaryId:'bin_scheduler_strict', artifactKind:`fixture-${name}`, producerId:`fixture-${name}`, producerVersion:'1',
    versions:{ loader:'fixture-1' }, relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false }, config:{name},
  });
}
function scheduler() { return new AnalysisScheduler({ store:new ArtifactStore({ backend:new MemoryArtifactBackend() }), maxConcurrency:1 }); }
async function waitFor(predicate, message) {
  for (let i=0;i<200;i++) { if (predicate()) return; await Promise.resolve(); }
  throw new Error(message);
}

// #2947: malformed artifactId must fail before inflight coalescing.
{
  const s=scheduler();
  const good=descriptor('good');
  let release;
  const p=s.request({descriptor:good,produce:()=>new Promise((resolve)=>{release=()=>resolve({ok:true});})});
  await waitFor(() => typeof release === 'function', 'producer did not start');
  const malformed={...good, artifactId:[good.artifactId]};
  await assert.rejects(s.request({descriptor:malformed,produce:async()=>({bad:true})}), /artifact-request-descriptor-required/);
  release();
  await p;
}

// #2948: if abort happens in the check->listen window, post-registration recheck rejects.
{
  const s=scheduler();
  const item=descriptor('abort-race');
  let checks=0;
  const signal={
    reason:new DOMException('cancelled','AbortError'),
    get aborted(){ checks++; return checks >= 3; },
    addEventListener(){},
    removeEventListener(){},
  };
  await assert.rejects(
    s.request({descriptor:item,signal,produce:async()=>({ok:true})}),
    (error)=>error?.name==='AbortError',
  );
  assert.ok(checks >= 3);
}

console.log('phase4 scheduler strict authority boundaries: PASS');
''')
