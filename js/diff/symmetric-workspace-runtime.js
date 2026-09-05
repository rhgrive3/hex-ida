import { runDiffInWorker } from './runtime.js';
import { createSymmetricCodeFunctionSet, SYMMETRIC_CODE_PROFILE } from './symmetric-function-set.js';

const INSTALL_VERSION = 'symmetric-workspace-diff/v2';
const MAX_DIFF_FUNCTIONS = 350000;
const DISCOVERY_GLOBAL_CAP = 400000;

function abortError(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('Binary diff aborted');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  if (!error.code) error.code = 'ABORT_ERR';
  return error;
}
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(signal); }
function requestWithSignal(request, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { request?.cancel?.(); } catch { /* best effort */ }
      finish(reject, abortError(signal));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once:true });
    Promise.resolve(request).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
function executableRegions(regions) {
  return Array.from(regions || []).filter((region) => {
    try { return region?.exec === true && BigInt(region.size ?? 0) > 0n && !region.zerofill; } catch { return false; }
  }).sort((a, b) => BigInt(a.vmAddr) < BigInt(b.vmAddr) ? -1 : BigInt(a.vmAddr) > BigInt(b.vmAddr) ? 1 : 0);
}
function splitLimit(remaining, size, remainingBytes) {
  if (!(remaining > 0) || remainingBytes <= 0n) return 0;
  return Math.max(1, Math.min(remaining, Number((BigInt(remaining) * size + remainingBytes - 1n) / remainingBytes)));
}
async function discoverBaselineFunctions(baseline, { signal = null, onProgress = null } = {}) {
  const symbols = baseline?.symbols;
  if (!symbols || symbols.functionStartsComplete === true) return symbols;
  const regions = executableRegions(baseline?.slice?.regions || []);
  if (!regions.length || typeof baseline?.backend?.guessFunctions !== 'function') return symbols;
  let remaining = Math.max(0, DISCOVERY_GLOBAL_CAP - Math.min(DISCOVERY_GLOBAL_CAP, symbols.functionCount || 0));
  let remainingBytes = regions.reduce((sum, region) => sum + BigInt(region.size), 0n);
  const results = [], reasons = [];
  for (let index = 0; index < regions.length; index++) {
    throwIfAborted(signal);
    const region = regions[index], size = BigInt(region.size);
    const share = splitLimit(remaining, size, remainingBytes);
    if (share <= 0) {
      results.push({ regionId:region.id, complete:false, skipped:true });
      reasons.push(`function-global-budget:${region.id}`);
      remainingBytes -= size;
      continue;
    }
    const request = baseline.backend.guessFunctions(region.id, share, (progress) => {
      try { onProgress?.({ phase:'baseline-functions', region:region.id, done:index + (progress?.all ? Math.min(1, progress.done / progress.all) : 0), all:regions.length }); } catch { /* observer only */ }
    });
    try {
      const result = await requestWithSignal(request, signal);
      const starts = Array.isArray(result?.starts) ? result.starts : [];
      const room = Math.max(0, Math.min(share, remaining));
      const accepted = starts.slice(0, room);
      const overCap = starts.length > accepted.length;
      if (accepted.length) {
        symbols.addFunctions(accepted, { source:'heuristic', confidence:0.55, confirmed:false });
        symbols.guessed = true;
        remaining = Math.max(0, remaining - accepted.length);
      }
      const complete = !overCap && (result?.discoveryComplete === true || result?.completeness?.complete === true || result?.complete === true);
      results.push({ regionId:region.id, complete, capped:!!result?.capped || overCap, discovered:accepted.length });
      if (!complete) reasons.push(overCap ? `function-global-budget:${region.id}` : `${region.id}:${result?.completeness?.reason || result?.truncationReason || 'function-discovery-incomplete'}`);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      results.push({ regionId:region.id, complete:false, error:true });
      reasons.push(`${region.id}:function-discovery-failed`);
    }
    remainingBytes -= size;
  }
  const complete = results.length === regions.length && results.every((row) => row.complete === true);
  symbols.functionDiscovery = {
    complete,
    attempted:true,
    regionSetKey:regions.map((region) => region.id).join('|'),
    regions:results,
    reasons:[...new Set(reasons)],
    capped:results.some((row) => row.capped),
  };
  symbols.functionStartsComplete = complete;
  symbols.functionStartsCapped = symbols.functionDiscovery.capped || reasons.some((reason) => reason.includes('budget'));
  return symbols;
}
function demoteIncompleteAbsenceClaims(result, reason) {
  if (!reason) return result;
  const unresolved = [];
  for (const change of result?.deleted || []) unresolved.push({ ...change, status:'unresolved', changeType:'unresolved', confidence:0, reason, side:'before' });
  for (const change of result?.new || []) unresolved.push({ ...change, status:'unresolved', changeType:'unresolved', confidence:0, reason, side:'after' });
  if (!unresolved.length) return result;
  const keep = (result.changes || []).filter((change) => change.changeType !== 'deleted' && change.changeType !== 'new');
  return {
    ...result,
    deleted:[],
    new:[],
    unresolved:[...(result.unresolved || []), ...unresolved],
    changes:[...keep, ...unresolved].sort((a, b) => {
      const x = a.before?.address ?? a.after?.address ?? 0n;
      const y = b.before?.address ?? b.after?.address ?? 0n;
      return x < y ? -1 : x > y ? 1 : 0;
    }),
  };
}
function currentRegions(app) {
  return typeof app?.programRegions === 'function' ? app.programRegions() : executableRegions(app?.store?.get?.('regions') || []);
}

export function installSymmetricWorkspaceDiff(app) {
  const workspace = app?.workspace;
  if (!workspace || workspace.__symmetricWorkspaceDiffVersion === INSTALL_VERSION) return workspace ?? null;
  const originalLoadBaseline = workspace.loadBaseline.bind(workspace);
  // Single-flight waiter bookkeeping. Concurrent callers share one producer
  // task but wait on isolated promises: a waiter abort ends only that
  // waiter's promise, and the producer aborts only when no waiter remains.
  let diffFlight = null;
  function releaseDiffFlight(flight) {
    flight.waiters = Math.max(0, flight.waiters - 1);
    if (flight.waiters === 0 && diffFlight === flight) {
      try { flight.abort(); } catch { /* best effort */ }
    }
  }
  function joinDiffFlight(flight, callerSignal) {
    if (callerSignal?.aborted) {
      releaseDiffFlight(flight);
      return Promise.reject(abortError(callerSignal));
    }
    flight.waiters++;
    if (!callerSignal) return flight.task.finally(() => releaseDiffFlight(flight));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        callerSignal.removeEventListener('abort', onCallerAbort);
        releaseDiffFlight(flight);
      };
      const onCallerAbort = () => { done(); reject(abortError(callerSignal)); };
      callerSignal.addEventListener('abort', onCallerAbort, { once:true });
      flight.task.then((value) => { done(); resolve(value); }, (error) => { done(); reject(error); });
    });
  }

  workspace.loadBaseline = async function loadSymmetricBaseline(file, options = {}) {
    const baseline = await originalLoadBaseline(file, options);
    try {
      await discoverBaselineFunctions(baseline, options);
      throwIfAborted(options.signal);
      baseline.functions = await createSymmetricCodeFunctionSet({
        backend:baseline.backend,
        symbols:baseline.symbols,
        regions:baseline.slice?.regions || [],
        architecture:baseline.architecture,
        limit:MAX_DIFF_FUNCTIONS,
        signal:options.signal ?? null,
        onProgress:options.onProgress,
      });
      baseline.complete = baseline.functions.complete === true;
      baseline.evidenceProfile = baseline.functions.evidenceProfile;
      workspace.diffState = null;
      return baseline;
    } catch (error) {
      if (workspace.baseline === baseline) workspace.baseline = null;
      if (baseline?.ownedBackend) baseline.backend?.dispose?.();
      throw error;
    }
  };

  workspace.diff = async function symmetricDiff(options = {}) {
    if (diffFlight) return joinDiffFlight(diffFlight, options.signal);
    const producer = new AbortController();
    const flight = { task:null, abort:() => producer.abort(), waiters:0 };
    diffFlight = flight;
    const signal = producer.signal;
    const revision = workspace.bindingRevision;
    const baseline = workspace.baseline;
    let task;
    task = (async () => {
      if (!baseline) throw new Error('baseline-not-loaded');
      const assertCurrent = () => {
        workspace._assertBinding(revision);
        if (workspace.baseline !== baseline) {
          const error = new Error('workspace-binding-changed');
          error.code = 'HEX_WORKSPACE_STALE';
          throw error;
        }
      };
      throwIfAborted(signal);
      const currentRegion = app.codeRegion?.() || currentRegions(app)[0] || null;
      await app.ensureFunctions?.(currentRegion, { signal:signal ?? null, onProgress:options.onProgress, priority:'user-visible' });
      throwIfAborted(signal);
      assertCurrent();
      const current = await createSymmetricCodeFunctionSet({
        backend:app.backend,
        symbols:app.symbols,
        regions:currentRegions(app),
        architecture:workspace.identity?.metadata?.architecture,
        limit:MAX_DIFF_FUNCTIONS,
        signal:signal ?? null,
        onProgress:options.onProgress,
      });
      const before = baseline.functions;
      if (before?.evidenceProfile !== SYMMETRIC_CODE_PROFILE || current?.evidenceProfile !== SYMMETRIC_CODE_PROFILE ||
          before?.fingerprintVersion !== current?.fingerprintVersion) {
        const error = new Error('diff-fingerprint-profile-mismatch');
        error.code = 'DIFF_FINGERPRINT_PROFILE_MISMATCH';
        throw error;
      }
      let result = await runDiffInWorker(before, current, {
        mode:'full',
        signal,
        threshold:options.threshold ?? 0.62,
        matchBudget:options.matchBudget || { maxCandidateEvaluations:1500000, maxEdges:300000, maxComponentNodes:4096, maxComponentEdges:65536 },
      });
      assertCurrent();
      const inputsComplete = before.complete === true && current.complete === true;
      result = demoteIncompleteAbsenceClaims(result, inputsComplete ? null : 'incomplete-symmetric-code-evidence');
      const reasons = [];
      if (!before.complete) reasons.push(before.truncationReason || 'baseline-function-set-incomplete');
      if (!current.complete) reasons.push(current.truncationReason || 'current-function-set-incomplete');
      if (result.truncated) reasons.push('matcher-truncated');
      result.completeness = {
        complete:inputsComplete && !result.truncated,
        reasons:[...new Set(reasons)],
        evidenceProfile:SYMMETRIC_CODE_PROFILE,
        fingerprintVersion:before.fingerprintVersion,
        evidenceSymmetric:true,
        baseline:{ complete:before.complete === true, total:before.total, scanned:before.scanned, missingEvidence:before.missingEvidence, reason:before.truncationReason },
        current:{ complete:current.complete === true, total:current.total, scanned:current.scanned, missingEvidence:current.missingEvidence, reason:current.truncationReason },
      };
      result.provenance = {
        baselineHash:baseline.hash,
        currentHash:workspace.identity?.hash || null,
        architecture:baseline.architecture,
        currentArchitecture:workspace.identity?.metadata?.architecture || null,
        baselineName:baseline.info?.name || baseline.file?.name || null,
        currentName:workspace.identity?.metadata?.name || null,
        complete:result.completeness.complete,
        functionSetsComplete:inputsComplete,
        fingerprintProfile:SYMMETRIC_CODE_PROFILE,
        fingerprintVersion:before.fingerprintVersion,
        evidenceSymmetric:true,
      };
      workspace.diffState = result;
      return result;
    })().finally(() => { if (workspace.busy === task) workspace.busy = null; if (diffFlight === flight) diffFlight = null; });
    flight.task = task;
    workspace.busy = task;
    return joinDiffFlight(flight, options.signal);
  };

  Object.defineProperty(workspace, '__symmetricWorkspaceDiffVersion', { value:INSTALL_VERSION, configurable:true });
  return workspace;
}

export const __symmetricWorkspaceInternalsForTests = Object.freeze({
  demoteIncompleteAbsenceClaims,
  discoverBaselineFunctions,
});
