/** Read-only terminal host. Analysis, discovery, ranges and rendering belong to
 * the product; this module has no decoder, rewrite rule or oracle access. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Backend } from '../../../js/backend.js';
import { ArtifactStore } from '../../../js/core/artifacts/store.js';
import { MemoryArtifactBackend } from '../../../js/core/artifacts/backends.js';
import { ArtifactAnalysisOrchestrator } from '../../../js/cache/artifact-orchestration.js';
import { installNodeWorkerTransport, closeNodeWorkers } from './node-worker.mjs';
import { App } from '../../../js/app.js';
import { Store } from '../../../js/state.js';
import { SymbolIndex } from '../../../js/symbols.js';
import { EMPTY_NOTES } from '../../../js/names.js';
import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';

export async function openProduct(binaryPath) {
  const started = performance.now();
  const stages = {};
  let stage = performance.now();
  const bytes = await readFile(binaryPath);
  stages.binaryReadMs = performance.now() - stage;
  stage = performance.now();
  const sha = createHash('sha256').update(bytes).digest('hex');
  stages.binaryHashMs = performance.now() - stage;
  const file = new File([bytes], `${sha}.bin`);
  installNodeWorkerTransport();
  const runtime = new ArtifactAnalysisOrchestrator({store:new ArtifactStore({backend:new MemoryArtifactBackend()})});
  const backend = new Backend({artifactOrchestrator:runtime});
  stage = performance.now();
  const info = await backend.open(file);
  stages.binaryOpenMs = performance.now() - stage;
  stage = performance.now();
  await backend.ensureBinaryId();
  stages.binaryIdentityMs = performance.now() - stage;
  backend.formatId = info.formatId ?? info.format;
  const sliceIndex = info.slices.findIndex(s => s.info?.isArm64 || /^(arm64|aarch64)$/i.test(s.capability?.architecture ?? ''));
  if (sliceIndex < 0) return { unsupported: true, reason: 'ARM64_SLICE_UNAVAILABLE', info, sha, profile:{ ...stages, totalSetupMs:performance.now() - started } };
  const slice = info.slices[sliceIndex];
  const app = Object.create(App.prototype);
  app.store = new Store();
  app.backend = backend;
  // Only rendering sinks are inert. Product discovery and range methods are unchanged.
  app.viewer = { setSymbols() {}, clearBlockOverlay() {} };
  app.notes = EMPTY_NOTES;
  app.projectRevision = 0;
  app.store.set({ file, fileInfo:info, sliceIndex, regions:slice.regions,
    architecture:'arm64', capability:slice.capability, canDisassemble:slice.capability?.canDisassemble !== false, instructionAlignment:4 });
  stage = performance.now();
  const analysis = await backend.analyze(sliceIndex);
  stages.symbolAnalysisMs = performance.now() - stage;
  app.symbols = new SymbolIndex({ ...analysis, regions:slice.regions });
  app.store.set({ currentRegion:app.codeRegion() });
  stage = performance.now();
  await app.ensureFunctions(app.codeRegion());
  stages.functionDiscoveryMs = performance.now() - stage;
  stage = performance.now();
  await app.ensureProgram();
  stages.programConstructionMs = performance.now() - stage;
  app.analysisQueries = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const endianness = slice.info?.endianness ?? slice.info?.endian ?? slice.capability?.endianness ?? slice.capability?.endian ?? info?.endianness ?? info?.endian ?? 'unknown';
  const architecture = slice.capability?.architecture ?? (slice.info?.isArm64 ? 'arm64' : app.store.get?.('architecture')) ?? 'arm64';
  stages.totalSetupMs = performance.now() - started;
  return { app, info, sha, sliceIndex, architecture, endianness, profile:stages, query:app.analysisQueries, close:async()=>{backend.dispose();runtime.close();await closeNodeWorkers();} };
}
