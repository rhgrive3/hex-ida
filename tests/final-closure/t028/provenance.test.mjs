import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile } from '../../../js/decompile.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';
import { parseOperands } from '../../../js/arm64.js';
import { analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function-base.js';
import { createBinaryIdFromDigest, createSliceId } from '../../../js/core/identity/index.js';
import {
  attachDecompilerProvenance,
  buildDecompilerProvenance,
  resolveDecompilerProvenance,
  reverseDecompilerProvenance,
  validateDecompilerProvenance,
} from '../../../js/decompiler/provenance.js';

function syntheticResult(text = 'return merged;') {
  return {
    ir: { instructions: [
      { id:'raw-a', row:1, address:0x1000n, op:'add' },
      { id:'raw-b', row:2, address:0x1004n, op:'mov' },
      { id:'raw-c', row:3, address:0x1008n, op:'dead' },
      { id:'raw-d', row:4, address:0x100cn, op:'dead' },
    ] },
    semanticAst: { values: [
      { valueId:'left', expression:{ kind:'var', name:'left', source:{ ir:'raw-a' } }, source:{ ir:'raw-a' } },
      { valueId:'right', expression:{ kind:'var', name:'right', source:{ ir:'raw-a' } }, source:{ ir:'raw-a' } },
      { valueId:'join', expression:{ kind:'binary', op:'add', left:{ kind:'var', name:'left', source:{ ir:'raw-a' } }, right:{ kind:'var', name:'right', source:{ ir:'raw-b' } }, source:{ ir:['raw-a','raw-b'] } }, source:{ ir:['raw-a','raw-b'] } },
    ] },
    cAst: { body:[{ kind:'stmt', indent:1, text, source:{ ir:['raw-a','raw-b'] } }] },
    sourceMap:[{ outputStartLine:1, outputEndLine:1, source:{ ir:['raw-a','raw-b'] } }],
    phase8:{ published:true, completeness:'complete', passes:[] },
  };
}

test('T028 maps merged, deleted, and rendered entities in both directions', () => {
  const result = syntheticResult();
  const provenance = buildDecompilerProvenance(result, {
    identity:{ binaryId:'fixture-binary', sliceId:'fixture-slice', snapshotId:'snapshot-1' },
    transforms:[{
      passId:'phase8.dce', passVersion:'1', ruleId:'dead-code-elimination',
      proofKind:'unused-value', targets:['value:dead'], originRefs:['instruction:raw-c'],
      deletedEntityIds:['value:dead', 'instruction:raw-d'],
    }],
  });

  assert.equal(validateDecompilerProvenance(provenance).length, 0);
  assert.equal(provenance.status, 'current');
  const rawA = provenance.raw.find((item) => item.identity.explicit === 'raw-a');
  const rawD = provenance.raw.find((item) => item.identity.explicit === 'raw-d');
  const joined = provenance.optimized.find((item) => item.identity.explicit === 'join');
  const rendered = provenance.rendered[0];
  assert.equal(rawA.status, 'merged');
  assert.equal(rawD.status, 'deleted');
  assert.equal(joined.status, 'merged');
  assert.deepEqual(resolveDecompilerProvenance(provenance, rawA.id).ids, rawA.optimizedEntityIds);
  assert.deepEqual(resolveDecompilerProvenance(provenance, joined.id, { direction:'optimized-to-raw' }).ids, joined.rawEntityIds);
  assert.deepEqual(resolveDecompilerProvenance(provenance, rendered.id, { direction:'rendered-to-optimized' }).ids, rendered.optimizedEntityIds);
  assert.deepEqual(reverseDecompilerProvenance(provenance, joined.id).ids, joined.rawEntityIds);
  assert.deepEqual(reverseDecompilerProvenance(provenance, rendered.id).ids, rendered.optimizedEntityIds);
  assert.ok(provenance.optimized.some((item) => item.metadata.tombstone === true && item.status === 'deleted'));
  assert.equal(resolveDecompilerProvenance(provenance, 'rendered:line:forged-text-id').status, 'unknown');
});

test('T028 preserves stable IDs across rendering changes and rejects stale snapshots', () => {
  const first = buildDecompilerProvenance(syntheticResult('return merged;'), { identity:{ snapshotId:'snapshot-1' } });
  const second = buildDecompilerProvenance(syntheticResult('return renamed;'), { identity:{ snapshotId:'snapshot-1' } });
  assert.deepEqual(first.raw.map((item) => item.id), second.raw.map((item) => item.id));
  assert.deepEqual(first.optimized.map((item) => item.id), second.optimized.map((item) => item.id));
  assert.deepEqual(first.rendered.map((item) => item.id), second.rendered.map((item) => item.id));
  assert.equal(resolveDecompilerProvenance(first, first.raw[0].id, { identity:{ snapshotId:'snapshot-other' } }).status, 'stale');
  assert.equal(resolveDecompilerProvenance(first, first.raw[0].id, { identity:{ snapshotId:'snapshot-1' } }).status, 'current');

  const invalidated = buildDecompilerProvenance({ ...syntheticResult(), phase8:{ published:false, completeness:'unknown', invalidated:['valueNumbers'] } });
  assert.equal(invalidated.status, 'invalidated');
  assert.equal(resolveDecompilerProvenance(invalidated, invalidated.raw[0].id).status, 'stale');
});

test('T028 preserves mixed numeric source ordering and spelling ties', () => {
  const huge = '1234567890123456789012345678901234567890';
  const provenance = buildDecompilerProvenance({
    cAst: { body:[{
      kind:'stmt', text:'return ordered;',
      source:{ rows:['10', '2', '01', '1', '-0', '0', '-10', 'foo', '2', null,
        `-${huge}`, huge, '00000000000000000000001'] },
    }] },
    phase8:{ published:true, completeness:'complete', passes:[] },
  });

  assert.deepEqual(provenance.rendered[0].source.rows,
    [`-${huge}`, '-10', '-0', '0', '00000000000000000000001', '01', '1', '2', '10', huge, 'foo']);
  assert.equal(validateDecompilerProvenance(provenance).length, 0);

  const mixedRows = ['2', '10', '1a'];
  for (const rows of [mixedRows, [...mixedRows].reverse(), ['1a', '2', '10']]) {
    const variant = buildDecompilerProvenance({
      cAst:{ body:[{ kind:'stmt', text:'return mixed;', source:{ rows } }] },
      phase8:{ published:true, completeness:'complete', passes:[] },
    });
    assert.deepEqual(variant.rendered[0].source.rows, ['10', '1a', '2'],
      'mixed numeric/text ordering must remain canonical across input order');
  }
});

test('T028 finalizes merged source refs before caching and freezes consumer tokens', () => {
  const lineSource = { ir:['raw-a'] };
  const mapSource = { ir:['raw-b'] };
  const result = {
    ir: { instructions: [
      { id:'raw-a', row:1, address:0x1000n, op:'add' },
      { id:'raw-b', row:2, address:0x1004n, op:'mov' },
    ] },
    cAst: { body:[{ kind:'stmt', text:'return x;', source:lineSource }] },
    sourceMap:[{ outputStartLine:1, outputEndLine:1, source:mapSource }],
    phase8:{ published:true, completeness:'complete', passes:[] },
  };
  const provenance = buildDecompilerProvenance(result);
  const rendered = provenance.rendered[0];
  assert.deepEqual(rendered.source.ir, ['raw-a', 'raw-b']);
  assert.ok(provenance.mapping.rawToRendered['raw:instruction:raw-b']?.includes(rendered.id));
  assert.equal(validateDecompilerProvenance(provenance).length, 0);

  lineSource.ir.push('raw-c');
  mapSource.ir.push('raw-c');
  assert.deepEqual(rendered.source.ir, ['raw-a', 'raw-b'], 'caller mutation must not alter finalized refs');
  assert.equal(Object.isFrozen(rendered.source.ir), true);
  assert.throws(() => rendered.source.ir.push('raw-c'), TypeError, 'consumers cannot mutate cached refs');
});

test('T028 is wired into the real decompiler product and query-facing lines', () => {
  const base = 0x2000n;
  const raw = ['mov w0, #1', 'ret'].map((text, row) => {
    const split = text.indexOf(' ');
    return { row, address:base + BigInt(row * 4), mn:split < 0 ? text : text.slice(0, split), ops:split < 0 ? '' : text.slice(split + 1) };
  });
  const rowOfAddress = (address) => Number((BigInt(address) - base) / 4n);
  const model = buildSemanticModel(raw, { startRow:0, endRow:1, rowOfAddress, name:'t028_product' });
  const product = decompile(model, { addr:base, rowOfAddress, name:'t028_product' });
  assert.ok(product.provenance, 'decompile() must publish provenance for query/UI consumers');
  assert.equal(product.lines.some((line) => line.provenanceId), true);
  assert.equal(validateDecompilerProvenance(product.provenance).length, 0);
  assert.equal(attachDecompilerProvenance(product).provenance, product.provenance);
});

test('T028 attaches provenance to cached query decompiler artifacts without mutating the cache', async () => {
  const cached = syntheticResult();
  const adapter = createAppAnalysisQueryAdapter({
    getDecompile: async () => cached,
  });
  const response = await adapter.decompile({ id:'snapshot-cached' }, '0x1000');

  assert.equal(response.status.completeness, 'complete');
  assert.ok(response.value.provenance);
  assert.equal(response.value.provenance.identity.snapshotId, 'snapshot-cached');
  assert.equal(response.value.provenance.identity.functionId, '0x1000');
  assert.equal(cached.provenance, undefined, 'cache authority must remain unchanged');
  assert.equal(validateDecompilerProvenance(response.value.provenance).length, 0);
});

test('T028 preserves provenance at the canonical semantic-function snapshot boundary', () => {
  const binaryId = createBinaryIdFromDigest('c028'.repeat(16));
  const sliceId = createSliceId({ binaryId, index:0, architecture:'arm64' });
  const result = analyzeDecodedSemanticFunction({
    architecture:'arm64', abiId:'aapcs64', platform:'linux', binaryId, sliceId,
    decoderSemanticVersion:'t028-arm64-v1',
    instructions:[
      { address:0x3000n, length:4, size:4, mnemonic:'mov', operands:'x0, x0', opStr:'x0, x0', ops:parseOperands('x0, x0'), mode:'a64' },
      { address:0x3004n, length:4, size:4, mnemonic:'ret', operands:'', opStr:'', ops:parseOperands(''), mode:'a64' },
    ],
  });

  assert.ok(result.decompiler.provenance);
  assert.ok(result.decompiler.provenance.raw.length >= 2);
  assert.ok(result.decompiler.lines.some((line) => line.provenanceId));
  assert.equal(validateDecompilerProvenance(result.decompiler.provenance).length, 0);
  assert.equal('ir' in result.decompiler, false, 'raw IR remains private to the snapshot producer');
});
