from pathlib import Path


def read(p): return Path(p).read_text()
def write(p,t): Path(p).write_text(t)
def rep(p,a,b,n=1):
    t=read(p)
    if a not in t: raise SystemExit(f'missing pattern in {p}: {a[:160]!r}')
    write(p,t.replace(a,b,n))

# #2617 producer: Mach-O is a container, not an ISA. Program relation scans are
# routed by the active slice architecture so x86_64/riscv64 can never enter the
# ARM64 legacy word scanner.
rep('js/backend.js',
"""  scanProgram(regionId, onProgress, limits = {}) { return this.call('scanProgram', { regionId, ...limits }, null, onProgress); }""",
"""  scanProgram(regionId, onProgress, limits = {}) {
    const architecture = String(limits?.architecture || '').toLowerCase();
    const payload = { regionId, ...limits };
    if (this.formatId === 'macho' && architecture) {
      const legacyAarch64 = architecture === 'arm64' || architecture === 'arm64e' || architecture === 'arm64_32';
      return this._callTo(legacyAarch64 ? 'legacy' : 'platform', 'scanProgram', payload, null, onProgress);
    }
    return this.call('scanProgram', payload, null, onProgress);
  }""")

# Consumer supplies the active slice ISA explicitly. No first-slice or format
# default is allowed to decide Program relation semantics.
rep('js/app.js',
"""          const scan=await this.backend.scanProgram(r.id,progressFn&&((p)=>progressFn({phase:'scan',done:i+(p.all?Math.min(1,p.done/p.all):0),all:regions.length,region:r.id})),{
            callLimit:share(calls,size,remainingBytes),refLimit:share(refs,size,remainingBytes),kindLimit:share(kinds,size,remainingBytes),
          });""",
"""          const scan=await this.backend.scanProgram(r.id,progressFn&&((p)=>progressFn({phase:'scan',done:i+(p.all?Math.min(1,p.done/p.all):0),all:regions.length,region:r.id})),{
            architecture:this.store.get('architecture') || this.currentSlice?.()?.capability?.architecture || 'unknown',
            callLimit:share(calls,size,remainingBytes),refLimit:share(refs,size,remainingBytes),kindLimit:share(kinds,size,remainingBytes),
          });""")

# ProgramIndex existence is not relation support. Named globals remain useful
# without relation coverage; reference counts are exact only when the individual
# query is complete. Partial counts are lower bounds.
rep('js/linkage.js',
"""export function findGlobals(symbols, program, regions, opts) {
  const o = opts || {};
  const limit = finiteOr(o.limit || 300, 300);
  const minRefs = finiteOr(o.minRefs || 2, 2);""",
"""export function findGlobals(symbols, program, regions, opts) {
  const o = opts || {};
  const limit = finiteOr(o.limit || 300, 300);
  const minRefs = finiteOr(o.minRefs || 2, 2);
  const graph = program?.graphCompleteness || null;
  const relationSupported = !!program && program.unsupported !== true && graph?.supported !== false;
  const relationComplete = relationSupported && (graph ? graph.refsComplete === true : program?.completeness?.complete !== false && !program?.refsCapped);
  const relationReason = relationSupported
    ? (relationComplete ? null : program?.queryIncompleteReason || graph?.reasons?.[0] || 'program-relations-partial')
    : (program ? 'unsupported-program-analysis' : 'program-relations-unavailable');""")

rep('js/linkage.js',
"""        out.push({
          addr: s.addr, name: s.name, readable: readableName(s.name),
          region: r.name, refs: program ? program.refSitesTo(s.addr, 8n, 200).length : 0,
          named: true,
        });""",
"""        const refSites = relationSupported ? program.refSitesTo(s.addr, 8n, 200) : null;
        out.push({
          addr: s.addr, name: s.name, readable: readableName(s.name),
          region: r.name,
          refs: refSites ? refSites.length : null,
          refsComplete: refSites ? refSites.complete === true : false,
          relationSupported, relationComplete: refSites ? refSites.complete === true : false, relationReason,
          named: true,
        });""")

rep('js/linkage.js',
"""  if (program && out.length < limit) {
    const hot = hotDataAddresses(program, dataRegions, limit - out.length, minRefs);""",
"""  if (relationSupported && out.length < limit) {
    const hot = hotDataAddresses(program, dataRegions, limit - out.length, minRefs);""")

rep('js/linkage.js',
"""      out.push({
        addr: h.addr, name: null,
        readable: 'off_' + h.addr.toString(16).toUpperCase(),
        region: h.region, refs: h.refs, named: false,
      });""",
"""      out.push({
        addr: h.addr, name: null,
        readable: 'off_' + h.addr.toString(16).toUpperCase(),
        region: h.region, refs: h.refs, refsComplete:relationComplete,
        relationSupported:true, relationComplete, relationReason,
        named: false,
      });""")

rep('js/linkage.js',
"""  out.sort((a, b) => b.refs - a.refs);
  return out;""",
"""  out.sort((a, b) => Number(b.refs ?? -1) - Number(a.refs ?? -1));
  Object.defineProperties(out, {
    relationSupported:{value:relationSupported,enumerable:false,configurable:true},
    relationComplete:{value:relationComplete,enumerable:false,configurable:true},
    relationReason:{value:relationReason,enumerable:false,configurable:true},
  });
  return out;""",1)

# Canonical Product Data distinguishes unknown, lower-bound and exact reference
# evidence. Partial/unsupported relation state can never render as an exact zero.
rep('js/ui/product.js',
"""        if (g.refs != null) metaParts.push(text(`${g.refs} か所から参照`, `${g.refs} refs`));""",
"""        if (g.refs != null && g.refsComplete !== false) metaParts.push(text(`${g.refs} か所から参照`, `${g.refs} refs`));
        else if (g.refs != null && g.refs > 0) metaParts.push(text(`少なくとも ${g.refs} か所から参照`, `at least ${g.refs} refs`));
        else if (g.relationSupported === false || g.relationComplete === false) metaParts.push(text('参照範囲は未確定', 'reference coverage unknown'));""")

Path('tests/reopened-program-capability-contract.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Backend } from '../js/backend.js';
import { ProgramIndex } from '../js/program.js';
import { findGlobals } from '../js/linkage.js';

// Architecture, never the Mach-O container, chooses the relation producer.
const backend=new Backend();
backend.formatId='macho';
const routes=[];
backend._callTo=(worker,t,payload)=>{routes.push([worker,t,payload]);return Promise.resolve({});};
await backend.scanProgram('text',null,{architecture:'x86_64'});assert.equal(routes.at(-1)[0],'platform');
await backend.scanProgram('text',null,{architecture:'riscv64'});assert.equal(routes.at(-1)[0],'platform');
await backend.scanProgram('text',null,{architecture:'arm64'});assert.equal(routes.at(-1)[0],'legacy');
await backend.scanProgram('text',null,{architecture:'arm64e'});assert.equal(routes.at(-1)[0],'legacy');
backend.dispose();

const dataRegion={id:'data',name:'__data',section:'__data',exec:false,read:true,write:true,vmAddr:0x2000n,size:0x100n};
const symbols={
  symbolCount:1,
  symbolList(){return [{addr:0x2000n,name:'global_value'}];},
  functionCount:0,
};

// Unsupported relation producer: named global survives, refs are unknown, not 0.
const unsupported=new ProgramIndex({unsupported:true,architecture:'x86_64',completeness:{complete:false,reasons:['unsupported-program-analysis']},refFrom:new BigUint64Array(),refTo:new BigUint64Array(),refKind:new Uint8Array()},symbols,null);
const unknown=findGlobals(symbols,unsupported,[dataRegion],{limit:20});
assert.equal(unknown.length,1);assert.equal(unknown[0].refs,null);assert.equal(unknown[0].relationSupported,false);assert.equal(unknown.relationComplete,false);

// Supported exact empty: zero is a valid absence proof.
const complete=new ProgramIndex({unsupported:false,architecture:'arm64',completeness:{complete:true,reasons:[]},refFrom:new BigUint64Array(),refTo:new BigUint64Array(),refKind:new Uint8Array()},symbols,null);
const exact=findGlobals(symbols,complete,[dataRegion],{limit:20});
assert.equal(exact[0].refs,0);assert.equal(exact[0].refsComplete,true);assert.equal(exact.relationComplete,true);

// Partial with one observed reference is a lower bound, never exact.
const partial=new ProgramIndex({unsupported:false,architecture:'arm64',completeness:{complete:false,reasons:['global-reference-budget']},refFrom:new BigUint64Array([0x1000n]),refTo:new BigUint64Array([0x2000n]),refKind:new Uint8Array([1])},symbols,null);
const lower=findGlobals(symbols,partial,[dataRegion],{limit:20,minRefs:1});
assert.equal(lower[0].refs,1);assert.equal(lower[0].refsComplete,false);assert.equal(lower.relationComplete,false);

const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
const product=fs.readFileSync(new URL('../js/ui/product.js',import.meta.url),'utf8');
assert.match(app,/architecture:this\.store\.get\('architecture'\)/);
assert.match(product,/reference coverage unknown/);
console.log('reopened program capability contract: ok');
''')
