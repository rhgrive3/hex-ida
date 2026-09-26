/*
 * Frozen Phase 8 native inputs exercised through the real js/ir.js facade.
 * The corpus metric route intentionally uses buildSemanticV2CompatibilityPipeline
 * directly; this fixture separately covers the public facade write stages and
 * their private producer handoff on exactly the same assembly entry.
 */

import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { modelFromAssembly } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { buildIR } from '../../../js/ir.js';
import { decompileSemantic, enhanceSemanticDecompilation } from '../../../js/decompile.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

export function nativeFacadeProductDecompilation(id, { decompilerTimeBudgetMs = 20000 } = {}) {
  const corpus = loadCorpus();
  const index = corpus.functions.findIndex(entry => entry.id === id);
  if (index < 0) throw new Error(`phase8 corpus entry is missing: ${id}`);
  const entry = corpus.functions[index];
  if (entry.architectureId !== 'arm64' || entry.representation !== 'assembly') {
    throw new Error(`native facade fixture requires frozen arm64 assembly: ${id}`);
  }
  const baseAddress = 0x100000n + BigInt(index) * 0x10000n;
  const model = modelFromAssembly(entry.assembly, entry.function, baseAddress);
  const rowOfAddress = address => {
    const target = BigInt(address);
    const found = model.instructions.find(instruction => BigInt(instruction.address) === target);
    return found ? found.row : null;
  };
  model.rowOfAddress = rowOfAddress;
  model.addrOfRow = row => model.instructions[row]?.address ?? null;
  const abiAdapter = semanticAbiAdapter(resolveABIPlugin({ architecture:'arm64', platform:'linux' }), {
    architecture:'arm64', platform:'linux', callingConvention:null, name:entry.function,
    binaryId:`phase8-corpus:${id}`, sliceId:`arm64:${entry.optimization}`,
  });
  const ir = buildIR(model, { rowOfAddress, abiAdapter });
  const options = {
    ir,
    profile:'deep',
    abiAdapter,
    decoderSemanticVersion:'arm64-frozen-assembly-parse-v1',
    binaryId:`phase8-corpus:${id}`,
    sliceId:`arm64:${entry.optimization}`,
    addr:model.instructions[0].address,
    name:entry.function,
    functionPrototype:null,
    rowOfAddress,
    deterministicTransforms:true,
    phase8Optimize:true,
    renderProvenance:true,
    decompilerTimeBudgetMs,
  };
  const raw = decompileSemantic(model, options);
  const result = enhanceSemanticDecompilation(raw, model, options);
  return { corpus, index, entry, model, ir, result };
}
