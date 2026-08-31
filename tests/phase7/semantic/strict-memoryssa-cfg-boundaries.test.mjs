import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';

const region = { id:'r', kind:'stack-fixed', functionId:'f', offset:0 };

test('#2818 memory SSA contract identities are string-only', () => {
  assert.equal(createMemoryRegionRef(region).id, 'r');
  for (const [field,value] of [['id',['r']],['kind',['stack-fixed']],['functionId',['f']]]) {
    assert.throws(() => createMemoryRegionRef({...region,[field]:value}), TypeError);
  }
});

test('#2826 semantic CFG identities and edge kinds are string-only', () => {
  const cfg = { functionId:'f', entryBlockId:'b0', blocks:[{id:'b0',successors:[]}] };
  assert.equal(createSemanticCfg(cfg).functionId, 'f');
  assert.throws(() => createSemanticCfg({...cfg,entryBlockId:['b0']}), TypeError);
  assert.throws(() => createSemanticCfg({...cfg,blocks:[{id:['b0'],successors:[]}]}), TypeError);
  assert.throws(() => createSemanticCfg({functionId:'f',entryBlockId:'b0',blocks:[{id:'b0',successors:[{to:'b0',kind:['branch']}]}]}), TypeError);
});

test('#2817 alias relation normalization cannot String-coerce objects', () => {
  const source = fs.readFileSync(new URL('../../../js/semantics/memoryssa/build.js', import.meta.url), 'utf8');
  assert.match(source, /relation != null && typeof relation !== 'string'/);
  assert.doesNotMatch(source, /const normalized = relation == null \? 'unknown' : String\(relation\)/);
});

test('#2823 auxiliary def-use and access metadata IDs are validated before comparison', () => {
  const source = fs.readFileSync(new URL('../../../js/semantics/memoryssa/validate.js', import.meta.url), 'utf8');
  assert.match(source, /typeof link\.definitionId !== 'string'/);
  assert.match(source, /typeof id !== 'string'/);
  assert.match(source, /typeof item\.memorySsaEntityId !== 'string'/);
  assert.match(source, /typeof item\.regionId !== 'string'/);
  assert.doesNotMatch(source, /definitionId: String\(link\.definitionId\)/);
});
