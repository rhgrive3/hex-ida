/** Private finite worker for trials.mjs; never a default model/provider loader. */
import fs from 'node:fs';
import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createCompetitiveProtocol } from '../../js/analysis/benchmark/competitive-protocol.js';
import { createAstraTrialPlan, runAstraTrials, packAstraTrialContinuation, reviewAstraTrialReadiness, ASTRA_TRIAL_MODES } from '../../js/analysis/benchmark/scoped-trials.js';
import { ScopedAnalysisWork } from '../../js/core/budgets/scoped-work.js';
if (isMainThread || !parentPort) throw new TypeError('trial-worker-parent-required');
const { input, hostPath, hostSha256, timeoutMs, maximumTrials, resumeFrom } = workerData;
let plan, work;
try {
  const protocols = Object.fromEntries(ASTRA_TRIAL_MODES.map(mode => [mode, createCompetitiveProtocol(input.protocols[mode])]));
  plan = createAstraTrialPlan(protocols, input.config);
  work = new ScopedAnalysisWork({ name:'same-astra-cli', limits:{ deadlineMs:timeoutMs, calls:4096, workUnits:1000000, residentBytes:128*1024*1024 } });
  const bytes = fs.readFileSync(hostPath);
  if (bytes.length > 1048576 || createHash('sha256').update(bytes).digest('hex') !== hostSha256) throw new TypeError('trial-host-source-changed');
  const module = await work.await(() => import(pathToFileURL(hostPath).href));
  if (typeof module.createTrialHost !== 'function') throw new TypeError('trial-host-factory-required');
  const host = await work.await(signal => module.createTrialHost({ plan, protocols, signal }));
  const result = await runAstraTrials(plan, protocols, { work, maximumTrials, resumeFrom, getAdapter:host?.getAdapter ?? null, adjudicate:host?.adjudicate ?? null });
  parentPort.postMessage({ status:'executed-not-admitted', planId:plan.id, result:packAstraTrialContinuation(plan,result), review:reviewAstraTrialReadiness(plan,result), releaseQualified:false });
} catch(error) {
  parentPort.postMessage({ status:'failed', planId:plan?.id ?? null, reason:/^[a-z0-9_.:-]{1,256}$/i.test(error.message) ? error.message : 'trial-host-failed',
    denominator:plan?.denominator ?? null, retainedUnmeasuredCells:plan?.denominator ?? null, releaseQualified:false });
} finally { work?.dispose(); parentPort.close(); }
