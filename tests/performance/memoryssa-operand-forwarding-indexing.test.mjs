import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../js/core/identity/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import {
  MEMORY_SSA_BUILD_VERSION,
  buildMemorySsa,
  canonicalMemorySsaProducerDigest,
  canonicalMemorySsaProducerMatchesSemanticIr,
} from '../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { forwardExactStackOperandIdentity } from '../../js/semantics/memoryssa/operand-forwarding.js';

function fixture(count = 32) {
  const functionId = 'memoryssa_operand_forwarding_indexing';
  const origin = (id, index = 0) => ({ instructionIds:[id], virtualRanges:[{ start:0x1000n + BigInt(index * 4), end:0x1004n + BigInt(index * 4) }] });
  const memory = valueId => ({ addressSpace:'memory', addressExpr:{ valueId }, widthBits:32, endian:'little', alignment:4,
    volatility:false, atomic:false, ordering:'unknown', faults:[] });
  const values = [], nodes = [], regions = [];
  for (let index = 0; index < count; index += 1) {
    const addressId = `addr_${index}`, storedId = `stored_${index}`, loadedId = `loaded_${index}`;
    values.push(
      { id:addressId, kind:'entry', machineType:{ kind:'address', widthBits:64, addressSpace:'memory' }, sourceEntityId:functionId, origin:origin(addressId, index * 4) },
      { id:storedId, kind:'entry', machineType:{ kind:'bitvector', widthBits:32 }, sourceEntityId:functionId, origin:origin(storedId, index * 4 + 1) },
      { id:loadedId, kind:'definition', machineType:{ kind:'bitvector', widthBits:32 }, definitionNodeId:`load_${index}`, sourceEntityId:`load_${index}`, origin:origin(loadedId, index * 4 + 2) },
    );
    nodes.push(
      { id:`store_${index}`, kind:'store', blockId:'b0', inputs:[addressId, storedId], outputs:[], memory:memory(addressId), origin:origin(`store_${index}`, index * 4 + 3) },
      { id:`load_${index}`, kind:'load', blockId:'b0', inputs:[addressId], outputs:[loadedId], memory:memory(addressId), origin:origin(`load_${index}`, index * 4 + 4) },
      { id:`sink_${index}`, kind:'state-write', blockId:'b0', inputs:[loadedId], outputs:[],
        variable:{ key:`sink.${index}`, kind:'logical-state', scope:'function' }, origin:origin(`sink_${index}`, index * 4 + 5) },
    );
    regions.push(createMemoryRegionRef({ id:`region_${index}`, kind:'stack-fixed', functionId, offset:String(index * 8), widthBits:32,
      metadata:{ canonicalAddressIncludesOperationDisplacement:true }, origin:origin(`region_${index}`, index * 4 + 6) }));
  }
  const ir = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId, entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:nodes.map(node => node.id), origin:origin('block') }], values, nodes,
    completeness:'complete', unknowns:[], origin:origin('function') });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'b0', blocks:[{ id:'b0', successors:[] }] });
  const semanticIrDigest = stableDigest(ir);
  const memorySsa = buildMemorySsa(ir, cfg, {
    regions,
    resolveRegion(_access, context) { return regions[Number(context.node.id.split('_')[1])]; },
    queryAlias(left, right) {
      return { relation:left.id === right.id ? 'must' : 'no', reasonCodes:['fixture-region-identity'], evidenceIds:[`${left.id}:${right.id}`],
        proof:{ analyzerId:'phase7.alias.solver', analyzerVersion:'1.1.0', completeness:'complete', stopReason:null } };
    },
    identity:{ binaryId:'binary', sliceId:'slice', functionId, semanticIrId:'ir', snapshotId:'snapshot', semanticIrContractVersion:'2.0.0',
      semanticIrDigest, scalarSsaId:'ssa', scalarSsaBuildVersion:'1.0.0', scalarSsaDigest:'ssa-digest', memorySsaId:'memoryssa',
      memorySsaBuildVersion:MEMORY_SSA_BUILD_VERSION, analyzerVersion:'fixture' },
    snapshotId:'snapshot',
    canonicalIrIdentity:{ functionId, semanticIrId:'ir', semanticIrContractVersion:'2.0.0', semanticIrDigest },
  });
  return { ir, memorySsa };
}

test('exact stack operand forwarding indexes canonical MemorySSA tables once', () => {
  const { ir, memorySsa } = fixture();
  const originalFilter = Array.prototype.filter;
  const originalFind = Array.prototype.find;
  let tableFilters = 0, regionFinds = 0;
  Array.prototype.filter = function patchedFilter(...args) {
    if (this === memorySsa.uses || this === memorySsa.definitions || this === memorySsa.accessMetadata || this === memorySsa.byteCoverage) tableFilters += 1;
    return Reflect.apply(originalFilter, this, args);
  };
  Array.prototype.find = function patchedFind(...args) {
    if (this === memorySsa.regions) regionFinds += 1;
    return Reflect.apply(originalFind, this, args);
  };
  try {
    for (let repeat = 0; repeat < 4; repeat += 1) {
      for (const use of memorySsa.uses) assert.equal(forwardExactStackOperandIdentity(memorySsa, use, ir)?.exact, true);
    }
  } finally {
    Array.prototype.filter = originalFilter;
    Array.prototype.find = originalFind;
  }
  assert.equal(tableFilters, 0, `operand forwarding rescanned canonical MemorySSA tables ${tableFilters} times`);
  assert.equal(regionFinds, 0, `operand forwarding rescanned canonical MemorySSA regions ${regionFinds} times`);
});


test('MemorySSA producer binding authenticates only the exact source IR and published digest', () => {
  const { ir, memorySsa } = fixture(2);
  assert.equal(canonicalMemorySsaProducerMatchesSemanticIr(memorySsa, ir), true);
  assert.equal(canonicalMemorySsaProducerMatchesSemanticIr(memorySsa, { ...ir }), false);
  assert.equal(canonicalMemorySsaProducerDigest(memorySsa), memorySsa.canonicalDigest);
  const copied = { ...memorySsa };
  assert.equal(canonicalMemorySsaProducerMatchesSemanticIr(copied, ir), false);
  assert.equal(canonicalMemorySsaProducerDigest(copied), null);
});
