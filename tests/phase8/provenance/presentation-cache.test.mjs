import assert from 'node:assert/strict';
import test from 'node:test';
import { Backend } from '../../../js/backend.js';
import { ArtifactAnalysisOrchestrator, createWorkerAnalysisArtifactDescriptor } from '../../../js/cache/artifact-orchestration.js';
import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';
import { analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function.js';
import { X86_SEMANTIC_FUNCTION_SCHEMA_VERSION } from '../../../js/targets/architecture/x86_64/semantic-function-contract.js';
import { X86_DECODER_SEMANTIC_VERSION } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { RISCV64_DECODER_SEMANTIC_VERSION } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { resolveRiscvIsaProfile } from '../../../js/binary/riscv-isa.js';
import { createCapstoneX86Session } from '../../phase5/helpers/capstone-session.mjs';
import { createCapstoneRiscv64Session } from '../../phase6/helpers/capstone-session.mjs';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';

const OLD_SCHEMA = 'semantic-ir-v2-compat-function-v1';
function runtime(entries) {
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend({ entries }) });
  return new ArtifactAnalysisOrchestrator({ store, scheduler:new AnalysisScheduler({ store, maxConcurrency:1 }) });
}

for (const architecture of ['x86_64', 'riscv64']) test(`C4-03 ${architecture} replaces persisted pre-provenance presentation and reuses the new schema`, async () => {
  const session = await (architecture === 'x86_64' ? createCapstoneX86Session() : createCapstoneRiscv64Session());
  const entries = new Map(), runtimes = [];
  let decodes = 0, analyses = 0;
  try {
    const bytes = Buffer.from(architecture === 'x86_64' ? 'b807000000c3' : '1305700067800000', 'hex');
    const options = { binaryId:`bin_sha256_${'7'.repeat(64)}`, address:0x1000n, length:bytes.length,
      architecture, abiId:architecture === 'x86_64' ? 'sysv-amd64' : 'lp64', platform:'linux',
      dataEndianness:'little', instructionEndianness:'little', name:'return_seven',
      ...(architecture === 'riscv64' ? { riscvIsa:resolveRiscvIsaProfile(null, 0x1000n, { allowAssumed:true }) } : {}) };
    const decoderVersion = architecture === 'x86_64' ? X86_DECODER_SEMANTIC_VERSION : RISCV64_DECODER_SEMANTIC_VERSION;
    function openBackend() {
      const rt = runtime(entries); runtimes.push(rt);
      const backend = new Backend({ artifactOrchestrator:rt });
      // Exercise the real public Backend/cache/codec/store paths and real
      // shipped-byte decoder/shared analyzer. Only Worker transport is local.
      backend.disassembleAt = async () => {
        decodes++;
        return { supported:true, found:true, fileOffset:0n, instructions:session.decode(bytes, options.address) };
      };
      backend._callTo = async (worker, type, { input }) => {
        assert.equal(worker, 'platform'); assert.equal(type, 'semanticFunction');
        analyses++; return analyzeDecodedSemanticFunction(input);
      };
      return backend;
    }
    const seed = openBackend(), current = seed._semanticFunctionArtifactDescriptor(options);
    assert.notEqual(current.versions.semanticSchema, OLD_SCHEMA, 'pre-map payloads must have a different cache key');
    assert.equal(current.versions.semanticSchema, X86_SEMANTIC_FUNCTION_SCHEMA_VERSION, 'both architectures share the presentation contract');
    const old = createWorkerAnalysisArtifactDescriptor({
      binaryId:options.binaryId, sliceIndex:0, architecture, artifactKind:current.artifactKind,
      producerVersion:current.producerVersion, loaderVersion:current.versions.loader,
      architectureSemanticVersion:current.versions.architectureSemantic, abiSemanticVersion:current.versions.abiSemantic,
      semanticSchemaVersion:OLD_SCHEMA,
      config:{ address:String(options.address), length:options.length, architecture, abiId:options.abiId, platform:'linux',
        decoderSemanticVersion:decoderVersion, analysisVersion:current.producerVersion, functionPrototype:null,
        dataEndianness:'little', instructionEndianness:'little', ...(options.riscvIsa ? { riscvIsa:options.riscvIsa } : {}) },
      keyExtras:{ decoderContract:architecture === 'x86_64' ? 'x86-64-decoded-instruction/v1' : 'riscv64-decoded-instruction/v1',
        decoderSemanticVersion:decoderVersion, semanticRoute:'machine-effects>semantic-ir-v2>cfg>ssa>memoryssa>compat>shared-decompiler' },
      originRefs:current.originRefs,
    });
    assert.equal(old.canonicalConfigHash, current.canonicalConfigHash);
    assert.equal(old.keyMaterialHash, current.keyMaterialHash, 'only the schema changes identity, not route/config/denominator');
    assert.notEqual(old.artifactId, current.artifactId);
    const oldPayload = { route:'phase5-shadow-v2', abiId:options.abiId, pipeline:{ instrumentation:{ v2Executed:true } },
      decompiler:{ semantic:true, pseudocode:'old_without_map', lines:[] } };
    // This is exactly the existing payload predicate, not a contrived corrupt
    // row: it accepts a historical payload with no renderProvenance.
    const validate = payload => payload?.route === 'phase5-shadow-v2'
      && payload?.pipeline?.instrumentation?.v2Executed === true && payload?.abiId === options.abiId;
    assert.equal(validate(oldPayload), true);
    await runtimes[0].request({ descriptor:old, produce:async () => oldPayload, validate });
    await runtimes[0].close();
    assert.equal(entries.has(old.artifactId), true, 'old encoded row survives the producer store lifetime');

    const cold = await openBackend().analyzeSemanticFunction(options);
    assert.equal(cold.reused, false);
    assert.equal(cold.artifactId, current.artifactId);
    assert.equal(cold.decompiler.renderProvenance?.completeness, 'complete');
    assert.match(cold.decompiler.pseudocode, /return .*7/);
    assert.equal(decodes, 1); assert.equal(analyses, 1);
    await runtimes[1].close();
    const warm = await openBackend().analyzeSemanticFunction(options);
    assert.equal(warm.reused, true, 'a fresh Backend, scheduler and store read the persisted new row');
    assert.equal(warm.artifactId, cold.artifactId);
    assert.deepEqual(warm.decompiler, cold.decompiler);
    assert.equal(decodes, 1); assert.equal(analyses, 1);
    assert.equal(entries.has(old.artifactId), true, 'version invalidation does not delete unrelated immutable artifacts');

    let epoch = 1;
    const api = new AnalysisQueryAPI({ ...createAppAnalysisQueryAdapter({ analyzeFunction:async () => warm }),
      currentIdentity:async () => ({ binaryId:options.binaryId, projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }) });
    const query = await api.decompile(await api.snapshot(), '0x1000');
    const nav = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
    assert.equal(nav.available, true, nav.reason);
    const entity = Object.values(query.value.renderProvenance.entities).find(item => item.role === 'semantic');
    assert.ok(entity);
    assert.equal((await nav.selectLine(entity.lineIndex)).state, 'ready');
    epoch++;
    assert.equal((await nav.selectLine(entity.lineIndex)).reason, 'stale-query-snapshot');
  } finally {
    for (const rt of runtimes) await rt.close();
    session.close();
  }
});
