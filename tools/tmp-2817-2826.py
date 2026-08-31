from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'anchor drift: {path}')
    p.write_text(s.replace(old,new,1))

replace('js/semantics/memoryssa/build.js', """function normalizeAliasResult(raw) {
  const relation = typeof raw === 'string' ? raw : raw?.relation ?? raw?.aliasRelation;
  const normalized = relation == null ? 'unknown' : String(relation);
  if (!ALIAS_RELATIONS.has(normalized)) fail('memory-ssa-build-invalid-alias-relation');""", """function normalizeAliasResult(raw) {
  const relation = typeof raw === 'string' ? raw : raw?.relation ?? raw?.aliasRelation;
  if (relation != null && typeof relation !== 'string') fail('memory-ssa-build-invalid-alias-relation');
  const normalized = relation ?? 'unknown';
  if (!ALIAS_RELATIONS.has(normalized)) fail('memory-ssa-build-invalid-alias-relation');""")

for path in ['js/semantics/memoryssa/contract.js','js/semantics/cfg/index.js']:
    replace(path, """function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}""", """function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}""")

replace('js/semantics/memoryssa/validate.js', """    const actual = memorySsa.defUseLinks
      .map((link) => ({ definitionId: String(link.definitionId), useIds: [...link.useIds].map(String).sort() }))
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId));""", """    const actual = memorySsa.defUseLinks
      .map((link) => {
        if (!link || typeof link !== 'object' || typeof link.definitionId !== 'string' || !link.definitionId.trim() || !Array.isArray(link.useIds)) {
          fail('memory-ssa-validate-invalid-def-use-index');
        }
        const useIds = link.useIds.map((id) => {
          if (typeof id !== 'string' || !id.trim()) fail('memory-ssa-validate-invalid-def-use-index');
          return id;
        }).sort();
        return { definitionId:link.definitionId, useIds };
      })
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId));""")
replace('js/semantics/memoryssa/validate.js', """      const id = String(item.memorySsaEntityId ?? '');
      if (!id) fail('memory-ssa-validate-access-metadata-id-required');
      if (metadataIds.has(`${id}\\u0000${item.regionId}`)) fail('memory-ssa-validate-duplicate-access-metadata');
      metadataIds.add(`${id}\\u0000${item.regionId}`);
      if (!definitionIds.has(id) && !useIds.has(id)) fail('memory-ssa-validate-dangling-access-metadata');
      if (!regionIds.has(String(item.regionId))) fail('memory-ssa-validate-access-metadata-region-mismatch');""", """      if (typeof item.memorySsaEntityId !== 'string' || !item.memorySsaEntityId.trim()) fail('memory-ssa-validate-access-metadata-id-required');
      if (typeof item.regionId !== 'string' || !item.regionId.trim()) fail('memory-ssa-validate-access-metadata-region-mismatch');
      const id = item.memorySsaEntityId;
      if (metadataIds.has(`${id}\\u0000${item.regionId}`)) fail('memory-ssa-validate-duplicate-access-metadata');
      metadataIds.add(`${id}\\u0000${item.regionId}`);
      if (!definitionIds.has(id) && !useIds.has(id)) fail('memory-ssa-validate-dangling-access-metadata');
      if (!regionIds.has(item.regionId)) fail('memory-ssa-validate-access-metadata-region-mismatch');""")

Path('tests/semantic-memoryssa-cfg-strict.mjs').write_text(r'''import assert from 'node:assert/strict';
import { createMemoryRegionRef } from '../js/semantics/memoryssa/contract.js';
import { createSemanticCfg } from '../js/semantics/cfg/index.js';

const region={id:'r',kind:'stack-fixed',functionId:'f',offset:0};
assert.equal(createMemoryRegionRef(region).id,'r');
for (const [field,value] of [['id',['r']],['kind',['stack-fixed']],['functionId',['f']]]) {
  const bad={...region,[field]:value};
  assert.throws(()=>createMemoryRegionRef(bad),TypeError);
}
const cfg={functionId:'f',entryBlockId:'b0',blocks:[{id:'b0',successors:[]}]};
assert.equal(createSemanticCfg(cfg).functionId,'f');
assert.throws(()=>createSemanticCfg({...cfg,entryBlockId:['b0']}),TypeError);
assert.throws(()=>createSemanticCfg({...cfg,blocks:[{id:['b0'],successors:[]}]}),TypeError);
assert.throws(()=>createSemanticCfg({functionId:'f',entryBlockId:'b0',blocks:[{id:'b0',successors:[{to:'b0',kind:['branch']}]}]}),TypeError);
console.log('semantic-memoryssa-cfg-strict: PASS');
''')
