#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubjectOutput, SUBJECT_RESULT_SCHEMA } from './outcome.mjs';
import { atomicWriteJson, readJson, sha256, stableJson, writeReceipt } from './fresh-state.mjs';

const SUBJECT_PATH = fileURLToPath(new URL('./fresh-subject.mjs', import.meta.url));

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) if (args[index] === name && args[index + 1] != null) values.push(args[index + 1]);
  return values;
}
function appendBounded(current, chunk, cap = 8 * 1024 * 1024) {
  const next = current + chunk.toString();
  return next.length > cap ? next.slice(-cap) : next;
}
function timeoutFunctionResult(marker, state, reason) {
  return {
    address:String(marker.functionAddress),
    name:marker.functionName ?? null,
    state,
    reason,
    pseudocode:null,
  };
}
function persistHardFailure(receiptDir, marker, state, reason, elapsedMs) {
  const fn = {
    address:String(marker.functionAddress),
    index:Number(marker.functionIndex),
    name:marker.functionName ?? null,
    end:marker.functionEnd ?? null,
  };
  const functionResult = timeoutFunctionResult(marker, state, reason);
  return writeReceipt(receiptDir, marker, fn, {
    state,
    hard:true,
    reason,
    elapsedMs,
    resultDigest:sha256(stableJson(functionResult)),
    functionResult,
  });
}

export async function runFreshCase({
  binary,
  out,
  caseId,
  receiptDir,
  sourceIdentity,
  configHash,
  functionTimeoutMs = 10000,
  setupTimeoutMs = 60000,
  watchdogGraceMs = 2000,
  retryStates = [],
  subjectPath = SUBJECT_PATH,
  spawnChild = spawn,
  pollMs = 100,
} = {}) {
  if (!binary || !out || !caseId || !receiptDir || !sourceIdentity || !configHash) throw new Error('fresh-case-required-argument-missing');
  if (!Number.isSafeInteger(functionTimeoutMs) || functionTimeoutMs < 100) throw new Error('fresh-case-function-timeout-invalid');
  if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs < 1000) throw new Error('fresh-case-setup-timeout-invalid');
  fs.mkdirSync(receiptDir, { recursive:true });
  const inflightFile = path.join(receiptDir, 'inflight.json');
  const started = performance.now();
  let restarts = 0;
  let firstLaunch = true;

  while (restarts < 10000) {
    fs.rmSync(inflightFile, { force:true });
    const args = [subjectPath, binary,
      '--case-id', caseId,
      '--receipt-dir', receiptDir,
      '--source-id', sourceIdentity,
      '--config-hash', configHash,
      '--function-timeout-ms', String(functionTimeoutMs),
      '--inflight-file', inflightFile,
    ];
    if (firstLaunch) for (const state of retryStates) args.push('--retry-state', state);
    firstLaunch = false;

    const launchAt = performance.now();
    let stdout = '';
    let stderr = '';
    let closeResolve;
    let spawnError = null;
    const closed = new Promise(resolve => { closeResolve = resolve; });
    let child;
    try {
      child = spawnChild(process.execPath, args, {
        stdio:['ignore', 'pipe', 'pipe'],
        env:{ ...process.env, HEX_PUBLIC_BENCH_OFFLINE:'1' },
      });
    } catch (error) {
      spawnError = error;
    }
    if (spawnError || !child?.once) {
      const row = { schema:SUBJECT_RESULT_SCHEMA, state:'CRASH', reason:`fresh-subject-spawn-error:${spawnError?.code || spawnError?.name || 'unknown'}`, functions:[] };
      atomicWriteJson(out, row);
      return { row, restarts, elapsedMs:performance.now() - started };
    }
    child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => closeResolve({ code, signal }));

    let killed = null;
    while (true) {
      const outcome = await Promise.race([
        closed.then(value => ({ kind:'closed', value })),
        new Promise(resolve => setTimeout(() => resolve({ kind:'poll' }), pollMs)),
      ]);
      if (outcome.kind === 'closed') {
        const marker = readJson(inflightFile);
        if ((outcome.value.signal || spawnError) && marker?.functionAddress != null) {
          const state = spawnError ? 'CRASH' : 'CRASH';
          persistHardFailure(receiptDir, marker, state, spawnError ? `function-process-error:${spawnError.code || spawnError.name || 'unknown'}` : `function-process-signal:${outcome.value.signal}`, performance.now() - launchAt);
          fs.rmSync(inflightFile, { force:true });
          restarts++;
          break;
        }
        const parsed = parseSubjectOutput(stdout);
        if (!parsed.error) {
          const row = {
            ...parsed.result,
            freshRunner:{
              restarts,
              elapsedMs:performance.now() - started,
              stderr:String(stderr).slice(-4000),
            },
          };
          atomicWriteJson(out, row);
          fs.rmSync(inflightFile, { force:true });
          return { row, restarts, elapsedMs:performance.now() - started };
        }
        const row = {
          schema:SUBJECT_RESULT_SCHEMA,
          state:'CRASH',
          reason:spawnError ? `fresh-subject-error:${spawnError.code || spawnError.name || 'unknown'}` : parsed.error,
          functions:[],
          freshRunner:{ restarts, elapsedMs:performance.now() - started, childExitCode:outcome.value.code ?? null, childSignal:outcome.value.signal ?? null, stderr:String(stderr).slice(-4000) },
        };
        atomicWriteJson(out, row);
        fs.rmSync(inflightFile, { force:true });
        return { row, restarts, elapsedMs:performance.now() - started };
      }

      const marker = readJson(inflightFile);
      if (marker?.functionAddress != null) {
        let markerAge = performance.now() - launchAt;
        try { markerAge = Date.now() - fs.statSync(inflightFile).mtimeMs; } catch {}
        if (markerAge > functionTimeoutMs + watchdogGraceMs) {
          killed = { marker, state:'TIMEOUT', reason:'function-watchdog-timeout', elapsedMs:markerAge };
        }
      } else if (performance.now() - launchAt > setupTimeoutMs) {
        killed = { marker:null, state:'TIMEOUT', reason:'case-setup-timeout', elapsedMs:performance.now() - launchAt };
      }
      if (killed) {
        try { child.kill('SIGKILL'); } catch {}
        await closed;
        if (killed.marker) {
          persistHardFailure(receiptDir, killed.marker, killed.state, killed.reason, killed.elapsedMs);
          fs.rmSync(inflightFile, { force:true });
          restarts++;
          break;
        }
        const row = { schema:SUBJECT_RESULT_SCHEMA, state:'TIMEOUT', reason:killed.reason, functions:[], freshRunner:{ restarts, elapsedMs:performance.now() - started } };
        atomicWriteJson(out, row);
        return { row, restarts, elapsedMs:performance.now() - started };
      }
    }
  }
  const row = { schema:SUBJECT_RESULT_SCHEMA, state:'CRASH', reason:'fresh-case-restart-limit', functions:[] };
  atomicWriteJson(out, row);
  return { row, restarts, elapsedMs:performance.now() - started };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const binary = args[0];
  const out = optionValue(args, '--out');
  const caseId = optionValue(args, '--case-id');
  const receiptDir = optionValue(args, '--receipt-dir');
  const sourceIdentity = optionValue(args, '--source-id');
  const configHash = optionValue(args, '--config-hash');
  try {
    const result = await runFreshCase({
      binary, out, caseId, receiptDir, sourceIdentity, configHash,
      functionTimeoutMs:Number(optionValue(args, '--function-timeout-ms', '10000')),
      setupTimeoutMs:Number(optionValue(args, '--setup-timeout-ms', '60000')),
      watchdogGraceMs:Number(optionValue(args, '--watchdog-grace-ms', '2000')),
      retryStates:optionValues(args, '--retry-state'),
    });
    process.exitCode = result.row.state === 'CRASH' || result.row.state === 'TIMEOUT' || result.row.state === 'ERROR' ? 1 : result.row.state === 'UNSUPPORTED' ? 2 : 0;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
