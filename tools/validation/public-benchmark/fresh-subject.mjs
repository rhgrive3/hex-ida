#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProduct } from './product-host.mjs';
import { classifySubjectResult, SUBJECT_RESULT_SCHEMA } from './outcome.mjs';
import {
  atomicWriteJson,
  configDigest,
  loadReceipt,
  receiptIdentity,
  sha256,
  shouldReuseReceipt,
  stableJson,
  writeReceipt,
} from './fresh-state.mjs';

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) if (args[index] === name && args[index + 1] != null) values.push(args[index + 1]);
  return values;
}

export async function runFreshSubject({
  binary,
  caseId,
  receiptDir,
  sourceIdentity,
  configHash = null,
  functionTimeoutMs = 10000,
  retryStates = new Set(),
  inflightFile = path.join(receiptDir, 'inflight.json'),
  now = () => performance.now(),
  openProductFn = openProduct,
} = {}) {
  if (!binary || !caseId || !receiptDir || !sourceIdentity) throw new Error('fresh-subject-required-argument-missing');
  if (!Number.isSafeInteger(functionTimeoutMs) || functionTimeoutMs < 100 || functionTimeoutMs > 900000) throw new Error('fresh-subject-timeout-invalid');
  const effectiveConfigHash = configHash || configDigest({ functionTimeoutMs });
  const started = now();
  let product;
  let reusedFunctions = 0;
  let executedFunctions = 0;
  const functionTimings = [];
  try {
    product = await openProductFn(binary);
    if (product.unsupported) {
      return classifySubjectResult({
        schema:SUBJECT_RESULT_SCHEMA,
        state:'UNSUPPORTED',
        reason:product.reason,
        functions:[],
        performance:{ setup:product.profile ?? {}, totalMs:now() - started, reusedFunctions, executedFunctions },
      });
    }

    const snapshot = await product.query.snapshot();
    let offset = 0;
    const discovered = [];
    while (true) {
      const page = await product.query.functions(snapshot, {}, { offset, limit:1000 });
      discovered.push(...(page.value ?? []));
      if (page.page?.next == null) break;
      offset = page.page.next;
    }

    const identity = receiptIdentity({
      caseId,
      binarySha256:product.sha,
      sourceIdentity,
      configHash:effectiveConfigHash,
      architecture:product.architecture,
      endianness:product.endianness,
    });

    const rows = [];
    for (let index = 0; index < discovered.length; index++) {
      const fn = { ...discovered[index], index };
      const existing = loadReceipt(receiptDir, identity, fn.address);
      if (shouldReuseReceipt(existing, retryStates)) {
        reusedFunctions++;
        rows.push(existing.result);
        continue;
      }

      atomicWriteJson(inflightFile, {
        ...identity,
        functionAddress:String(fn.address),
        functionIndex:index,
        functionName:fn.name ?? null,
        functionEnd:fn.end == null ? null : String(fn.end),
        startedAt:new Date().toISOString(),
        functionTimeoutMs,
      });

      executedFunctions++;
      const fnStarted = now();
      let functionResult;
      const controller = new AbortController();
      const timeoutError = new Error('function-timeout');
      timeoutError.name = 'AbortError';
      const timer = setTimeout(() => controller.abort(timeoutError), functionTimeoutMs);
      try {
        const currentSnapshot = await product.query.snapshot({ signal:controller.signal });
        const response = await product.query.decompile(currentSnapshot, fn.address, { signal:controller.signal });
        const value = response?.value;
        const completeness = response?.status?.completeness ?? response?.completeness ?? 'unknown';
        functionResult = {
          address:String(fn.address),
          name:fn.name ?? null,
          end:fn.end == null ? null : String(fn.end),
          state:value ? (completeness === 'complete' ? 'PASS' : String(completeness).toUpperCase()) : 'UNSUPPORTED',
          completeness,
          pseudocode:value?.pseudocode ?? value?.code ?? null,
        };
      } catch (error) {
        functionResult = {
          address:String(fn.address),
          name:fn.name ?? null,
          state:error?.name === 'AbortError' ? 'TIMEOUT' : 'CRASH',
          reason:String(error?.message || error),
          pseudocode:null,
        };
      } finally {
        clearTimeout(timer);
      }
      const elapsedMs = now() - fnStarted;
      if (elapsedMs > functionTimeoutMs && functionResult.state === 'PASS') {
        functionResult = {
          ...functionResult,
          state:'TIMEOUT',
          reason:functionResult.reason ?? 'function-timeout-elapsed-exceeded',
        };
      }
      functionTimings.push(elapsedMs);
      writeReceipt(receiptDir, identity, fn, {
        state:functionResult.state,
        completeness:functionResult.completeness ?? null,
        reason:functionResult.reason ?? null,
        elapsedMs,
        resultDigest:sha256(stableJson(functionResult)),
        functionResult,
      });
      fs.rmSync(inflightFile, { force:true });
      rows.push(functionResult);
    }

    const result = classifySubjectResult({
      schema:SUBJECT_RESULT_SCHEMA,
      state:'PASS',
      inputSha256:product.sha,
      productRoute:product.app.backend.analysisRouteInfo(),
      functionDiscoveryComplete:product.app.symbols.functionStartsComplete === true,
      functions:rows,
      performance:{
        setup:product.profile ?? {},
        totalMs:now() - started,
        reusedFunctions,
        executedFunctions,
        functionTimingsMs:functionTimings,
      },
    });
    return result;
  } finally {
    fs.rmSync(inflightFile, { force:true });
    await product?.close?.();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const binary = args[0];
  const caseId = optionValue(args, '--case-id');
  const receiptDir = optionValue(args, '--receipt-dir');
  const sourceIdentity = optionValue(args, '--source-id');
  const functionTimeoutMs = Number(optionValue(args, '--function-timeout-ms', '10000'));
  const configHash = optionValue(args, '--config-hash');
  const inflightFile = optionValue(args, '--inflight-file', receiptDir ? path.join(receiptDir, 'inflight.json') : null);
  const retryStates = new Set(optionValues(args, '--retry-state').map(String));
  try {
    const result = await runFreshSubject({ binary, caseId, receiptDir, sourceIdentity, configHash, functionTimeoutMs, retryStates, inflightFile });
    console.log(JSON.stringify(result));
    process.exitCode = result.state === 'CRASH' || result.state === 'TIMEOUT' || result.state === 'ERROR' ? 1 : result.state === 'UNSUPPORTED' ? 2 : 0;
  } catch (error) {
    console.log(JSON.stringify(classifySubjectResult({ schema:SUBJECT_RESULT_SCHEMA, state:'CRASH', reason:String(error?.stack || error), functions:[] })));
    process.exitCode = 1;
  }
}
