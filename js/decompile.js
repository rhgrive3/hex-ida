/* Thin conflict-resistant wrapper around the exact main decompiler snapshot.
 * `decompile-base.js` remains the compatibility implementation. Canonical
 * Semantic-v2 function results can attach a presentation-only model carrying
 * the already-produced decompiler snapshot; never re-decompile that snapshot
 * through the legacy architecture path. */
import { decompile as baseDecompile } from './decompile-base.js';
import { optimizeSemanticDecompilation } from './decompiler/pipeline.js';
import {
  getEngineMode,
  isWasmEngineAvailable,
  recordFallback,
  wasmDecompileArm64Function,
} from './core/hex-engine-bridge.js';
export { optimizeSemanticDecompilation } from './decompiler/pipeline.js';

export * from './decompile-base.js';

function canonicalSnapshot(model) {
  const snapshot = model?.__canonicalDecompiler ?? null;
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    ...snapshot,
    lines: Array.isArray(snapshot.lines) ? snapshot.lines.map((line) => ({ ...line })) : [],
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.slice() : [],
    evidence: Array.isArray(snapshot.evidence) ? snapshot.evidence.slice() : [],
  };
}

function detectModelArchitecture(model, opts) {
  const raw = opts?.arch
    ?? opts?.architecture
    ?? model?.arch
    ?? model?.architecture
    ?? model?.profile?.architecture
    ?? null;
  if (typeof raw === 'string' && raw.trim()) {
    const norm = raw.trim().toLowerCase();
    if (norm === 'arm64' || norm === 'aarch64') return 'arm64';
    return norm;
  }
  const insns = model?.instructions;
  if (Array.isArray(insns) && insns.length > 0) {
    const first = insns[0];
    if (typeof first?.arch === 'string' && first.arch.trim()) {
      const norm = first.arch.trim().toLowerCase();
      return norm === 'aarch64' ? 'arm64' : norm;
    }
    const dsv = String(
      opts?.decoderSemanticVersion
      ?? model?.decoderSemanticVersion
      ?? first?.decoderSemanticVersion
      ?? '',
    ).toLowerCase();
    if (dsv) {
      if (dsv.includes('arm64e')) return 'arm64e';
      if (dsv.includes('arm64_32')) return 'arm64_32';
      if (dsv.includes('arm64') || dsv.includes('aarch64')) return 'arm64';
      if (dsv.includes('x86_64') || dsv.includes('amd64')) return 'x86_64';
      if (dsv.includes('x86')) return 'x86';
      if (dsv.includes('riscv')) return 'riscv64';
      return 'unknown';
    }
    if (typeof first?.word === 'number' && Number.isFinite(first.word)) {
      return 'arm64';
    }
  }
  return 'unknown';
}

function extractArm64Words(insns) {
  if (!Array.isArray(insns) || insns.length === 0) return null;
  const words = new Uint32Array(insns.length);
  for (let i = 0; i < insns.length; i += 1) {
    const ins = insns[i];
    if (typeof ins?.word === 'number' && Number.isFinite(ins.word)) {
      words[i] = ins.word >>> 0;
    } else if (ins?.rawBytes instanceof Uint8Array && ins.rawBytes.length === 4) {
      const b = ins.rawBytes;
      words[i] = ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
    } else {
      return null;
    }
  }
  return words;
}

function tryWasmDecompile(model, opts) {
  const effectiveMode = getEngineMode(opts);
  if (effectiveMode === 'js') {
    recordFallback('decompile:wasm_disabled');
    return null;
  }
  if (!isWasmEngineAvailable()) {
    recordFallback('decompile:wasm_unavailable');
    return null;
  }
  const arch = detectModelArchitecture(model, opts);
  if (arch !== 'arm64') {
    recordFallback(`decompile:non_arm64_arch:${arch}`);
    return null;
  }
  if (opts?.beginner === true) {
    recordFallback('decompile:beginner_mode');
    return null;
  }
  if (opts?.functionPrototype || opts?.cxxEvidence || opts?.ir || opts?.abiAdapter) {
    recordFallback('decompile:rich_semantic_context');
    return null;
  }
  const insns = model?.instructions;
  const words = extractArm64Words(insns);
  if (!words) {
    recordFallback('decompile:missing_arm64_words');
    return null;
  }
  const baseAddr = opts?.addr != null
    ? BigInt(opts.addr)
    : (insns[0]?.address != null ? BigInt(insns[0].address) : 0n);
  const funcName = String(opts?.name ?? model?.name ?? '');
  const wasmRes = wasmDecompileArm64Function({
    words,
    baseAddr,
    funcName,
    insns,
  });
  if (!wasmRes) return null;
  return {
    pseudocode: wasmRes.pseudocode,
    lines: wasmRes.lines,
    sourceMap: wasmRes.sourceMap,
    warnings: [],
    evidence: [],
    semantic: false,
    wasmAccelerated: true,
  };
}

export function decompile(model, opts = {}) {
  const canonical = canonicalSnapshot(model);
  if (canonical) return canonical;
  const wasmRes = tryWasmDecompile(model, opts);
  if (wasmRes) return wasmRes;
  return baseDecompile(model, opts);
}

/** Explicit asynchronous optimization; the default decompile stays synchronous. */
export async function decompileWithProof(model, options = {}, proofOptions = {}) {
  const result = decompile(model,{...options,phase8Optimize:false,phase8PrepareProof:true,phase8ProofOnlyRewrites:true});
  return optimizeSemanticDecompilation(result,{...proofOptions,requireProofOnlyRewrites:true});
}
