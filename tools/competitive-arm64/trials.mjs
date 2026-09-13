#!/usr/bin/env node
/** Explicit, local T0--T3 host entry point. Default is plan-only. Host execution
 * runs in a terminateable Node worker with a wall/memory bound. This isolates
 * JavaScript loops, not external programs, networks, accounts or remote jobs:
 * host adapters still MUST own and enforce those resource/cancellation limits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createCompetitiveProtocol } from '../../js/analysis/benchmark/competitive-protocol.js';
import { createAstraTrialPlan, validateAstraTrialContinuation, ASTRA_TRIAL_MODES } from '../../js/analysis/benchmark/scoped-trials.js';
import { exactInteger, recordFields, snapshotContractData } from '../../js/core/identity/structured.js';
import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function read(file, maximum = 1048576) {
  const resolved = fs.realpathSync(path.resolve(file));
  // Opening a FIFO with 'r' blocks before fstat and before the worker timeout.
  // Pin the resolved path without following a replacement symlink; reject every
  // non-regular descriptor before reading. Regular files remain size bounded.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(resolved, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new TypeError('trial-input-file-bound');
    // The cap also holds if a local file grows after fstat.
    const buffer = Buffer.alloc(maximum + 1); let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    if (length > maximum) throw new TypeError('trial-input-file-bound');
    return { resolved, bytes: buffer.subarray(0, length) };
  } finally { fs.closeSync(fd); }
}
export async function executeAstraTrialFile(file, { hostPath = null, timeoutMs = 30000, maximumTrials = 64, resumePath = null, compactResult = false } = {}) {
  if (typeof compactResult !== 'boolean') throw new TypeError('trial-cli-result-format');
  exactInteger(timeoutMs, 'trial-cli-timeout', { min: 100, max: 120000 }); exactInteger(maximumTrials, 'trial-cli-count', { min: 1, max: 256 });
  const source = read(file), input = snapshotContractData(JSON.parse(source.bytes), { maxBytes: 2097152 });
  recordFields(input, ['protocols', 'config'], 'trial-cli-input-fields'); recordFields(input.protocols, ASTRA_TRIAL_MODES, 'trial-cli-track-fields');
  const protocols = Object.fromEntries(ASTRA_TRIAL_MODES.map(mode => [mode, createCompetitiveProtocol(input.protocols[mode])]));
  const plan = createAstraTrialPlan(protocols, input.config);
  if (resumePath !== null && !hostPath) throw new TypeError('trial-resume-requires-explicit-host');
  if (!hostPath) return { status: 'planned-only', inputSha256: digest(source.bytes), plan, modelsCalled: false, releaseQualified: false };
  const host = read(hostPath), hostSha256 = digest(host.bytes);
  if (!host.resolved.endsWith('.mjs')) throw new TypeError('trial-host-module-extension');
  let resumeFrom = null;
  if (resumePath !== null) {
    const saved = read(resumePath, 8388608);
    const report = snapshotContractData(JSON.parse(saved.bytes), { maxBytes: 8388608, maxNodes: 200000 });
    if (report.status !== 'executed-not-admitted' || report.inputSha256 !== digest(source.bytes)
      || report.hostSha256 !== hostSha256 || report.planId !== plan.id
      || ['releaseQualified', 'defaultRolloutEligible', 'victoryEstablished'].some(key => report[key] !== false)) throw new TypeError('trial-resume-input-host-binding');
    // Validate BEFORE starting a worker or evaluating the explicit host module.
    validateAstraTrialContinuation(plan, protocols, report.result);
    resumeFrom = report.result;
  }
  const worker = new Worker(new URL('./trial-worker.mjs', import.meta.url), {
    workerData: { input, hostPath: host.resolved, hostSha256, timeoutMs, maximumTrials, resumeFrom },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }, stdout: true, stderr: true,
  });
  let timer, messageBytes = 0, settled = false;
  try {
    return await new Promise(resolve => {
      const failed = reason => ({ status: 'failed', reason, planId: plan.id, denominator: plan.denominator,
        retainedUnmeasuredCells: plan.denominator, inputSha256: digest(source.bytes), hostSha256, releaseQualified: false });
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
      timer = setTimeout(() => finish(failed('trial-worker-timeout')), timeoutMs);
      const drain = data => { messageBytes += data.length; if (messageBytes > 32768) finish(failed('trial-host-log-budget')); };
      worker.stdout.on('data', drain); worker.stderr.on('data', drain); // never publish host logs/secrets
      worker.on('message', data => {
        try { const response = snapshotContractData(data, { maxBytes: 8388608, maxNodes: 200000 });
          if (response.planId !== plan.id || !['failed', 'executed-not-admitted'].includes(response.status)) throw new TypeError('trial-worker-plan-binding');
          for (const object of [response, response.result, response.review]) {
            if (object && ['releaseQualified', 'defaultRolloutEligible', 'victoryEstablished'].some(key => object[key] === true)) throw new TypeError('trial-worker-admission-forbidden');
          }
          let checkedResult = null;
          if (response.status === 'executed-not-admitted') {
            checkedResult = validateAstraTrialContinuation(plan, protocols, response.result);
            if (response.result.progress.nextOrdinal < (resumeFrom?.progress.nextOrdinal ?? 0)
              || response.result.progress.attemptedTotal !== (resumeFrom?.progress.attemptedTotal ?? 0) + response.result.attempted
              || response.result.progress.invocation !== (resumeFrom?.progress.invocation ?? 0) + 1) throw new TypeError('trial-worker-continuation-binding');
          }
          finish({ ...response, ...(checkedResult && !compactResult ? { result: checkedResult } : {}), inputSha256: digest(source.bytes), hostSha256, hostLogBytes: messageBytes,
            resultProvenance: 'local-host-report-not-independently-admitted', releaseQualified: false, defaultRolloutEligible: false, victoryEstablished: false });
        } catch { finish(failed('trial-worker-result-contract')); }
      });
      worker.on('error', () => finish(failed('trial-worker-error')));
      worker.on('exit', () => finish(failed('trial-worker-ended-without-result')));
    });
  } finally {
    clearTimeout(timer); worker.unref();
    // A stuck host cannot indefinitely delay the CLI's shutdown path.
    let stopTimer; await Promise.race([worker.terminate(), new Promise(resolve => { stopTimer = setTimeout(resolve, 2000); })]).finally(() => clearTimeout(stopTimer));
  }
}
async function main() {
  const argv = process.argv.slice(2), mode = argv.shift(), file = argv.shift();
  if (!['--plan', '--run'].includes(mode) || !file) throw new TypeError('usage: trials.mjs --plan input.json | --run input.json --host host.mjs [--resume previous.json] [--out result.json] [--timeout-ms 30000] [--maximum-trials 64]');
  const flags = new Map();
  while (argv.length) { const key = argv.shift(), value = argv.shift();
    if (!['--host','--out','--timeout-ms','--maximum-trials','--resume'].includes(key) || value == null || flags.has(key)) throw new TypeError('trial-cli-flag'); flags.set(key,value); }
  if (mode === '--run' && !flags.has('--host') || mode === '--plan' && (flags.has('--host') || flags.has('--resume'))) throw new TypeError('trial-cli-host-requires-explicit-run');
  // Reserve the output before executing any explicit host: an existing output
  // or a checkpoint-overwrite typo must not spend a trial and then fail to save.
  let output = null, fd = null;
  if (flags.has('--out')) {
    output = path.resolve(flags.get('--out'));
    const protectedFiles = [file, flags.get('--host'), flags.get('--resume')].filter(Boolean).map(name => fs.realpathSync(path.resolve(name)));
    if (protectedFiles.includes(output)) throw new TypeError('trial-cli-refuses-input-overwrite');
    fd = fs.openSync(output, 'wx', 0o600);
  }
  try {
    const result = await executeAstraTrialFile(file, { hostPath: flags.get('--host') ?? null, resumePath: flags.get('--resume') ?? null, compactResult: true,
      timeoutMs: flags.has('--timeout-ms') ? Number(flags.get('--timeout-ms')) : 30000,
      maximumTrials: flags.has('--maximum-trials') ? Number(flags.get('--maximum-trials')) : 64 });
    const encoded = JSON.stringify(result) + '\n';
    if (Buffer.byteLength(encoded) > 8388608) throw new TypeError('trial-cli-output-bound');
    if (fd !== null) {
      fs.writeFileSync(fd, encoded); fs.closeSync(fd); fd = null;
      console.log(JSON.stringify({status:result.status,output,releaseQualified:false}));
    } else process.stdout.write(encoded);
    if (result.status === 'failed') process.exitCode = 1;
  } finally {
    if (fd !== null) { fs.closeSync(fd); fs.unlinkSync(output); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({status:'failed',reason:error.message}));process.exitCode=1; });
