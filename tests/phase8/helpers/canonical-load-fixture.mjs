import assert from 'node:assert/strict';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } from '../../../js/semantics/memoryssa/build.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import { isCanonicalExactMemoryForwarding, canonicalMemoryForwardingContextForLoad } from '../../../js/semantics/memoryssa/queries.js';

// Same real IR -> CFG -> MemorySSA -> compatibility chain used by the existing
// C2-01 byte-forwarding regressions. No fabricated exact fact/provider token.
export function canonicalLoad(bits = 32) {
  const origin = (id, index) => ({ instructionIds:[id], virtualRanges:[{ start:0x3000n + BigInt(index * 4), end:0x3004n + BigInt(index * 4) }] });
  const type = { kind:'bitvector', widthBits:bits }, address = { kind:'address', widthBits:64, addressSpace:'memory' };
  const value = (id, node, machineType, index) => ({ id, kind:'definition', machineType,
    definitionNodeId:node, sourceEntityId:node, origin:origin(id, index) });
  const access = () => ({ addressSpace:'memory', addressExpr:{ valueId:'addr' }, widthBits:bits,
    endian:'little', alignment:bits / 8, volatility:false, atomic:false, ordering:'unknown', faults:[] });
  const nodes = [
    { id:'n_addr', kind:'address', blockId:'b0', inputs:[], outputs:['addr'], attributes:{ value:'0x4000' }, origin:origin('addr', 0) },
    { id:'n_value', kind:'const', blockId:'b0', inputs:[], outputs:['stored'], attributes:{ value:37 }, origin:origin('value', 1) },
    { id:'n_store', kind:'store', blockId:'b0', inputs:['addr', 'stored'], outputs:[], memory:access(), origin:origin('store', 2) },
    { id:'n_load', kind:'load', blockId:'b0', inputs:['addr'], outputs:['loaded'], memory:access(), origin:origin('load', 3) },
    { id:'n_return', kind:'return', blockId:'b0', inputs:['loaded'], outputs:[], origin:origin('return', 4) },
  ];
  const canonicalIr = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId:'precomputed_load', entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:nodes.map(node => node.id), origin:origin('block', 0) }], nodes,
    values:[value('addr', 'n_addr', address, 0), { ...value('stored', 'n_value', type, 1), metadata:{ constant:{ kind:'bitvector', widthBits:bits, value:37n } } }, value('loaded', 'n_load', type, 3)],
    completeness:'complete', unknowns:[], origin:origin('function', 0) });
  const cfg = createSemanticCfg({ functionId:canonicalIr.functionId, entryBlockId:'b0', blocks:[{ id:'b0', successors:[] }] });
  const region = createMemoryRegionRef({ id:'global', kind:'global-absolute', binaryId:'constant-history', address:'0x4000', widthBits:bits, origin:origin('region', 0) });
  const irIdentity = { functionId:canonicalIr.functionId, semanticIrId:'ir', semanticIrContractVersion:'2.0.0', semanticIrDigest:stableDigest(canonicalIr) };
  const memorySsa = buildMemorySsa(canonicalIr, cfg, { regions:[region], resolveRegion:() => region,
    queryAlias:() => ({ relation:'must', reasonCodes:['identical-region-identity'], evidenceIds:['canonical-fixture-alias'],
      proof:{ analyzerId:'phase7.alias.solver', analyzerVersion:'1.1.0', completeness:'complete', stopReason:null } }),
    identity:{ ...irIdentity, binaryId:'constant-history', sliceId:'slice', snapshotId:'snapshot',
      scalarSsaId:'ssa', scalarSsaBuildVersion:'1.0.0', scalarSsaDigest:'ssa-digest',
      memorySsaId:'mssa', memorySsaBuildVersion:MEMORY_SSA_BUILD_VERSION, analyzerVersion:'memoryssa-fixture' },
    snapshotId:'snapshot', canonicalIrIdentity:irIdentity });
  const ir = projectSemanticIrV2ToLegacyV1(canonicalIr, { memorySsa, cfg });
  const load = ir.instructions.find(inst => inst.semanticNodeId === 'n_load');
  assert.equal(load.dst.const, 37n);
  assert.ok(isCanonicalExactMemoryForwarding(load.memoryForwarding, canonicalMemoryForwardingContextForLoad(load.memoryForwarding, load, load.memoryForwardingContext)));
  return { ir, load, store:ir.instructions.find(inst => inst.semanticNodeId === 'n_store') };
}

