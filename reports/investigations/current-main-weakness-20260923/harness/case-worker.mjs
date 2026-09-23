#!/usr/bin/env node
/*
 * One-case measurement worker (child process).
 *
 * Opens one binary once through the read-only production host, decompiles every
 * discovered function with per-function progress reporting and soft timeout,
 * and persists one receipt after each function.
 *
 * Timeout semantics:
 *   - Emits progress events ({ type: 'function-start' }, { type: 'function-end' })
 *     via IPC and stdout for parent watchdog monitoring.
 *   - Runs an in-process AbortController timer (soft timeout).
 *   - Enforces invariant: any function whose measured elapsedMs exceeds
 *     functionTimeoutMs is never recorded as PASS (marked TIMEOUT).
 *   - If the parent watchdog fires (SIGKILL), the parent writes the hard TIMEOUT receipt
 *     and respawns the worker.
 *
 * The worker never rewrites an existing receipt for a different identity.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openProduct } from '../../../../tools/validation/public-benchmark/product-host.mjs';
import {
  CASE_SCHEMA,
  FUNCTION_SCHEMA,
  atomicWriteJson,
  caseFileName,
  optionValue,
  readJson,
  receiptFileName,
} from './lib.mjs';

const args = process.argv.slice(2);
const caseId = optionValue(args, '--case-id');
const binary = optionValue(args, '--binary');
const outDir = optionValue(args, '--out');
const receiptDir = optionValue(args, '--receipt-dir');
const sourceIdentity = optionValue(args, '--source-id');
const configHash = optionValue(args, '--config-hash');
const headSha = optionValue(args, '--head');
const functionTimeoutMs = Number(optionValue(args, '--function-timeout-ms', '10000'));
const structureMode = optionValue(args, '--structure', 'slow');
const structureThresholdMs = Number(optionValue(args, '--structure-threshold-ms', '250'));
const inflightFile = optionValue(args, '--inflight', null);

function gotoCount(text) {
  return (String(text ?? '').match(/\bgoto\b/g) ?? []).length;
}

function projectionInfo(value) {
  const coverage = value?.coverage ?? null;
  return {
    coverageMode: coverage?.mode ?? null,
    structured: coverage?.mode === 'structured',
    warnings: Array.isArray(value?.warnings) ? value.warnings.length : 0,
    evidence: Array.isArray(value?.evidence) ? value.evidence.length : 0,
    semantic: value?.semantic != null,
    signature: value?.signature != null,
  };
}

async function structuralMetrics(product, snapshot, address) {
  const started = performance.now();
  const metrics = { cfgBlocks: null, cfgEdges: null, irValues: null, irInstructions: null, irBlocks: null, structuralMs: 0, structuralReason: null };
  try {
    const cfgResponse = await product.query.cfg(snapshot, address);
    const cfg = cfgResponse?.value ?? null;
    if (cfg) {
      const blocks = Array.isArray(cfg.blocks) ? cfg.blocks : Array.isArray(cfg?.nodes) ? cfg.nodes : null;
      metrics.cfgBlocks = blocks ? blocks.length : null;
      const edges = Array.isArray(cfg.edges) ? cfg.edges : null;
      metrics.cfgEdges = edges ? edges.length : null;
      if (metrics.cfgBlocks == null) metrics.structuralReason = 'cfg-shape-unknown';
    } else {
      metrics.structuralReason = cfgResponse?.status?.reason ?? 'cfg-unavailable';
    }
    const irResponse = await product.query.semanticIR(snapshot, address);
    const ir = irResponse?.value ?? null;
    if (ir) {
      metrics.irValues = Array.isArray(ir.values) ? ir.values.length : null;
      metrics.irInstructions = Array.isArray(ir.instructions) ? ir.instructions.length : null;
      metrics.irBlocks = Array.isArray(ir.blocks) ? ir.blocks.length : null;
      if (metrics.irValues == null && !metrics.structuralReason) metrics.structuralReason = 'ir-shape-unknown';
    } else {
      metrics.structuralReason = metrics.structuralReason ?? irResponse?.status?.reason ?? 'semantic-ir-unavailable';
    }
  } catch (error) {
    metrics.structuralReason = `structure-error:${error?.name || 'unknown'}`;
  }
  metrics.structuralMs = performance.now() - started;
  return metrics;
}
async function main() {
  if (!caseId || !binary || !outDir || !receiptDir || !sourceIdentity || !configHash || !headSha) {
    throw new Error('case-worker-required-argument-missing');
  }
  fs.mkdirSync(receiptDir, { recursive: true });
  const caseStarted = performance.now();
  const rows = [];
  let product = null;
  let caseRecord = null;
  try {
    product = await openProduct(binary);
    if (product.unsupported) {
      caseRecord = {
        schema: CASE_SCHEMA, caseId, binary, state: 'UNSUPPORTED', reason: product.reason ?? 'unsupported',
        architecture: null, endianness: null, productRoute: null,
        functionDiscoveryComplete: false, functionCount: 0, functions: [], setup: product.profile ?? {},
        sourceIdentity, configHash, headSha, elapsedMs: performance.now() - caseStarted,
      };
      return;
    }
    const snapshot = await product.query.snapshot();
    let offset = 0;
    const discovered = [];
    while (true) {
      const page = await product.query.functions(snapshot, {}, { offset, limit: 1000 });
      discovered.push(...(page.value ?? []));
      if (page.page?.next == null) break;
      offset = page.page.next;
    }

    for (let index = 0; index < discovered.length; index++) {
      const fn = discovered[index];
      const address = String(fn.address);
      const receiptPath = path.join(receiptDir, receiptFileName(address));
      const existing = readJson(receiptPath);
      if (existing?.schema === FUNCTION_SCHEMA && existing.caseId === caseId
        && existing.sourceIdentity === sourceIdentity && existing.configHash === configHash
        && existing.headSha === headSha) {
        rows.push(existing);
        continue;
      }
      if (inflightFile) {
        atomicWriteJson(inflightFile, { caseId, address, index, name: fn.name ?? null, startedAt: new Date().toISOString() });
      }
      const fnStarted = performance.now();
      const startedAtIso = new Date().toISOString();
      const progressStart = JSON.stringify({ type: 'function-start', address, index, startedAt: startedAtIso });
      try {
        if (process.send) process.send({ type: 'function-start', address, index, startedAt: startedAtIso });
      } catch {}
      process.stdout.write(`${progressStart}\n`);

      const controller = new AbortController();
      const timeoutError = new Error('function-timeout');
      timeoutError.name = 'AbortError';
      const timer = setTimeout(() => controller.abort(timeoutError), functionTimeoutMs);
      const base = {
        schema: FUNCTION_SCHEMA, caseId, address, index,
        name: fn.name ?? null,
        end: fn.end == null ? null : String(fn.end),
        sizeBytes: fn.end == null ? null : Number(BigInt(fn.end) - BigInt(fn.address)),
      };
      let row;
      try {
        const currentSnapshot = await product.query.snapshot({ signal: controller.signal });
        const response = await product.query.decompile(currentSnapshot, address, { signal: controller.signal });
        const value = response?.value ?? null;
        const completeness = response?.status?.completeness ?? 'unknown';
        const pseudocode = value?.pseudocode ?? value?.code ?? value?.text ?? null;
        row = {
          ...base,
          state: value ? (completeness === 'complete' ? 'PASS' : String(completeness).toUpperCase()) : 'UNSUPPORTED',
          completeness,
          reason: response?.status?.reason ?? null,
          projection: response?.status?.projection ?? null,
          unknownInstructions: typeof value?.unknownInstructions === 'number' ? value.unknownInstructions : null,
          ...projectionInfo(value),
          elapsedMs: null,
          structure: null,
          pseudocodeChars: pseudocode == null ? null : pseudocode.length,
          nonEmptyLines: pseudocode == null ? null : pseudocode.split(/\r?\n/).filter(line => line.trim()).length,
          gotos: gotoCount(pseudocode),
          pseudocode,
        };
      } catch (error) {
        const aborted = error?.name === 'AbortError';
        row = {
          ...base,
          state: aborted ? 'TIMEOUT' : 'CRASH',
          completeness: null,
          reason: aborted ? 'function-watchdog-timeout' : String(error?.message || error).slice(0, 400),
          projection: null,
          unknownInstructions: null,
          coverageMode: null, structured: null, warnings: null, evidence: null, semantic: null, signature: null,
          elapsedMs: null,
          structure: null,
          pseudocodeChars: null,
          nonEmptyLines: null,
          gotos: null,
          pseudocode: null,
        };
      } finally {
        clearTimeout(timer);
        if (inflightFile) fs.rmSync(inflightFile, { force: true });
      }
      row.elapsedMs = performance.now() - fnStarted;
      if (row.elapsedMs > functionTimeoutMs && row.state === 'PASS') {
        row.state = 'TIMEOUT';
        row.reason = row.reason ?? 'function-timeout-elapsed-exceeded';
      }
      const progressEnd = JSON.stringify({ type: 'function-end', address, index, elapsedMs: row.elapsedMs, state: row.state });
      try {
        if (process.send) process.send({ type: 'function-end', address, index, elapsedMs: row.elapsedMs, state: row.state });
      } catch {}
      process.stdout.write(`${progressEnd}\n`);
      const wantStructure = structureMode === 'all' || (structureMode === 'slow' && row.elapsedMs >= structureThresholdMs);
      if (wantStructure && row.state !== 'TIMEOUT' && row.state !== 'CRASH') {
        const snapshotAfter = await product.query.snapshot();
        row.structure = await structuralMetrics(product, snapshotAfter, address);
      }
      atomicWriteJson(receiptPath, row);
      rows.push(row);
    }

    const functionStates = {};
    for (const row of rows) functionStates[row.state] = (functionStates[row.state] ?? 0) + 1;
    caseRecord = {
      schema: CASE_SCHEMA, caseId, binary, state: 'MEASURED', reason: null,
      architecture: product.architecture ?? null, endianness: product.endianness ?? null,
      productRoute: product.app?.backend?.analysisRouteInfo?.() ?? null,
      functionDiscoveryComplete: product.app?.symbols?.functionStartsComplete === true,
      functionCount: discovered.length, functions: rows, functionStates,
      setup: product.profile ?? {},
      sourceIdentity, configHash, headSha,
      elapsedMs: performance.now() - caseStarted,
    };
  } catch (error) {
    caseRecord = {
      schema: CASE_SCHEMA, caseId, binary, state: 'ERROR',
      reason: String(error?.stack || error).slice(0, 4000),
      architecture: null, endianness: null, productRoute: null,
      functionDiscoveryComplete: false, functionCount: rows.length, functions: rows,
      setup: product?.profile ?? {},
      sourceIdentity, configHash, headSha, elapsedMs: performance.now() - caseStarted,
    };
  } finally {
    atomicWriteJson(path.join(outDir, 'cases', caseFileName(caseId)), caseRecord);
    if (inflightFile) fs.rmSync(inflightFile, { force: true });
    await product?.close?.();
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
}
