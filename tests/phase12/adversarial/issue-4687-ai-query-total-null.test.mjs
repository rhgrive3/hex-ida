import assert from 'node:assert/strict';
import { createHexAIContext } from '../../../js/ai/ui/hex-context.js';
import { createHexAIContext as createQueryBaseContext } from '../../../js/ai/ui/hex-context-query-base.js';

function pageResult(total, value = [{ address:'0x1000', id:1, text:'hit' }], completeness = 'partial') {
  return {
    value,
    page:{ offset:0, limit:10, returned:value.length, total, next:null },
    status:{ completeness, reason:completeness === 'complete' ? null : 'producer-incomplete' },
  };
}

function createApp({ total = null } = {}) {
  const result = () => pageResult(total);
  return {
    analysisArtifactVersions:{},
    analysisQueries:{
      async snapshot() { return { id:'snap-4687', artifactVersions:{} }; },
      async functions() { return result(); },
      async instructions() { return result(); },
      async xrefs() { return result(); },
      async callers() { return result(); },
      async callees() { return result(); },
      async binaryInfo() {
        return {
          value:{ regions:[{ id:'r0', vmAddr:0x1000n, size:0x100n }] },
          status:{ completeness:'complete' },
        };
      },
      async search(_snapshot, _query, page = {}) {
        // The requested global offset is already applied by the producer.
        // An unknown total must not be coerced to zero and used to discard this row.
        return {
          value:[{ address:'0x1004', text:'after-offset' }],
          page:{ offset:page.offset ?? 0, limit:page.limit ?? 10, returned:1, total:null, next:null },
          status:{ completeness:'partial', reason:'search-total-unknown' },
        };
      },
    },
  };
}

async function assertUnknownTotalPreserved(create, name) {
  const context = create(createApp({ total:null }));
  const probes = [
    ['searchFunctions', () => context.searchFunctions('needle', { limit:10 })],
    ['getInstructions', () => context.getInstructions('0x1000', { limit:10 })],
    ['getXrefs', () => context.getXrefs('0x1000', { limit:10 })],
    ['getCallers', () => context.getCallers('0x1000', { limit:10 })],
    ['getCallees', () => context.getCallees('0x1000', { limit:10 })],
  ];
  for (const [surface, run] of probes) {
    const out = await run();
    assert.equal(out.total, null, `${name}/${surface}: unknown page.total must remain null`);
    assert.equal(out.completeness.total, null, `${name}/${surface}: nested completeness total must remain null`);
    assert.equal(out.returned, 1, `${name}/${surface}: real rows must remain visible`);
  }

  const searched = await context.searchStrings('x', { offset:1, limit:10 });
  assert.equal(searched.results.length, 1, `${name}/searchStrings: unknown total must not discard a returned row`);
  assert.equal(searched.results[0].text, 'after-offset');
  assert.equal(searched.total, null);
  assert.equal(searched.complete, false);
}

for (const [name, create] of [['facade', createHexAIContext], ['query-base', createQueryBaseContext]]) {
  await assertUnknownTotalPreserved(create, name);

  const zero = await create(createApp({ total:0 })).getInstructions('0x1000', { limit:10 });
  assert.equal(zero.total, 0, `${name}: explicit numeric zero remains exact zero`);

  for (const malformed of ['7', ['7'], { value:7 }, true]) {
    const out = await create(createApp({ total:malformed })).getInstructions('0x1000', { limit:10 });
    assert.equal(out.total, null, `${name}: structured/coerced total must not gain numeric authority`);
    assert.equal(out.completeness.total, null);
  }
}

console.log('issue-4687-ai-query-total-null: ok');

// The actual first-party tool registry must preserve the same unknown-total
// authority when it projects QueryAPI assembly pages.
{
  const { createHexToolRegistry } = await import('../../../js/ai/tools/registry.js');
  const registry = createHexToolRegistry({
    analysisAuthority:'AnalysisQueryAPI',
    binaryId:'issue-4687',
    analysisRevision:'rev-1',
    addressExists:() => true,
    async getInstructions(_address, options = {}) {
      return {
        results:[{ id:0, row:0, address:'0x1000', mnemonic:'nop', operands:'' }],
        offset:options.offset ?? 0,
        returned:1,
        total:null,
        complete:false,
        truncated:true,
        reason:'producer-incomplete',
      };
    },
  });
  const executed = await registry.execute('inspect_function_region', {
    functionAddress:'0x1000',
    view:'assembly',
    start:0,
    count:1,
  }, { scope:'function' });
  const result = executed.result ?? executed;
  assert.equal(result.total, null, 'createHexToolRegistry: unknown assembly total must remain null');
  assert.equal(result.returned, 1);
  assert.equal(result.complete, false);
}
