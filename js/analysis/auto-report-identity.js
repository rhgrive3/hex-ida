import { createBinaryIdFromDigest } from '../core/identity/index.js';

const INSTALL_VERSION = 'auto-report-identity/v3';
const STATE = new WeakMap();
const SNAPSHOT_TRACKERS = new WeakMap();

function storeValue(app, key) { try { return app?.store?.get?.(key) ?? null; } catch { return null; } }
function nonNegativeIdentity(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function sliceIdentity(value, fallback = -1) {
  if (value == null) return fallback;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : null;
}
function projectRevision(app) {
  const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.project ?? null;
  return nonNegativeIdentity(project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision, 0);
}
function canonicalContentBinaryId(value) {
  if (value === null || value === undefined || typeof value !== 'string') return null;
  try { return createBinaryIdFromDigest(value); }
  catch { return null; }
}
function binaryIdentity(app) {
  const backendBinaryId = app?.backend?.binaryId;
  if (backendBinaryId !== null && backendBinaryId !== undefined) return backendBinaryId;
  const contentHash = app?.backend?.contentHash;
  if (contentHash !== null && contentHash !== undefined) return canonicalContentBinaryId(contentHash);
  return storeValue(app, 'fileInfo')?.binaryId ?? null;
}
function liveIdentity(app, currentSnapshotId = null) {
  return Object.freeze({
    binaryId:binaryIdentity(app),
    sliceIndex:sliceIdentity(storeValue(app, 'sliceIndex'), -1),
    analysisEpoch:nonNegativeIdentity(app?.backend?.gen ?? app?.analysisEpoch, 0),
    projectRevision:projectRevision(app),
    snapshotId:currentSnapshotId,
  });
}
function sameIdentity(bound, live) {
  if (!bound || !live) return false;
  if (![bound.analysisEpoch, bound.projectRevision, live.analysisEpoch, live.projectRevision]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) return false;
  if (![bound.sliceIndex, live.sliceIndex]
    .every((value) => Number.isSafeInteger(value) && value >= -1)) return false;
  if (bound.analysisEpoch !== live.analysisEpoch) return false;
  if (bound.sliceIndex !== live.sliceIndex) return false;
  if (bound.projectRevision !== live.projectRevision) return false;
  if ((bound.binaryId || live.binaryId) && bound.binaryId !== live.binaryId) return false;
  // Once a current AnalysisSnapshot is known, a report without that exact
  // snapshot identity is historical evidence, never current Results authority.
  if (live.snapshotId && bound.snapshotId !== live.snapshotId) return false;
  return true;
}
function isWellFormedSourceIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  if (![identity.analysisEpoch, identity.projectRevision]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) return false;
  if (!(Number.isSafeInteger(identity.sliceIndex) && identity.sliceIndex >= -1)) return false;
  if (identity.binaryId != null && typeof identity.binaryId !== 'string') return false;
  if (identity.snapshotId != null && typeof identity.snapshotId !== 'string') return false;
  return true;
}
function bindValue(app, value, currentSnapshotId = null) {
  if (!value || typeof value !== 'object') return { value, identity:null };
  const report = value.report && typeof value.report === 'object' ? value.report : null;
  const wrapperSnapshotId = value.snapshotId ?? null;
  const reportSnapshotId = report?.snapshotId ?? null;
  // An existing sourceIdentity is producer-time authority. It is validated and
  // preserved verbatim, never re-derived from the setter-time live identity: a
  // report that was produced against another binary/epoch must not be relabelled
  // by landing in a different app state (#5796).
  const existingSourceIdentity = isWellFormedSourceIdentity(value.sourceIdentity)
    ? value.sourceIdentity
    : isWellFormedSourceIdentity(report?.sourceIdentity) ? report.sourceIdentity : null;
  if (value.sourceIdentity != null || report?.sourceIdentity != null) {
    if (!existingSourceIdentity) return { value, identity:null };
    const liveAtBind = liveIdentity(app, currentSnapshotId);
    if (!sameIdentity(existingSourceIdentity, liveAtBind)) return { value, identity:null };
    const existingSnapshotId = existingSourceIdentity.snapshotId ?? null;
    if ((wrapperSnapshotId != null && wrapperSnapshotId !== existingSnapshotId)
      || (reportSnapshotId != null && reportSnapshotId !== existingSnapshotId)) {
      return { value, identity:null };
    }
    return { value:{ ...value, snapshotId:existingSnapshotId, sourceIdentity:existingSourceIdentity }, identity:existingSourceIdentity };
  }
  if (wrapperSnapshotId != null && reportSnapshotId != null && wrapperSnapshotId !== reportSnapshotId) {
    return { value, identity:null };
  }
  const snapshotId = wrapperSnapshotId ?? reportSnapshotId ?? null;
  const identity = liveIdentity(app, null);
  if (report && !report.snapshotId && snapshotId) {
    try { report.snapshotId = snapshotId; } catch { /* compatibility report may be frozen */ }
  }
  const sourceIdentity = Object.freeze({ ...identity, snapshotId });
  if (report) {
    try { Object.defineProperty(report, 'sourceIdentity', { value:sourceIdentity, enumerable:true, configurable:true }); }
    catch { /* compatibility report may be frozen */ }
  }
  return { value:{ ...value, snapshotId, sourceIdentity }, identity:sourceIdentity };
}

function updateSnapshotSubscriber(app, state, snapshotId) {
  state.currentSnapshotId = snapshotId;
  if (state.bound && !sameIdentity(state.bound.identity, liveIdentity(app, snapshotId))) {
    state.stale = state.bound;
    state.bound = null;
  }
}

function subscribeToSnapshotOwner(app, state) {
  const snapshotOwner = app?.analysisQueries;
  if (!snapshotOwner || typeof snapshotOwner.snapshot !== 'function') return;

  let tracker = SNAPSHOT_TRACKERS.get(snapshotOwner);
  if (!tracker) {
    const originalSnapshot = snapshotOwner.snapshot.bind(snapshotOwner);
    tracker = {
      subscribers:new Map(),
      hasSnapshot:false,
      currentSnapshotId:null,
    };
    snapshotOwner.snapshot = async function trackedAnalysisSnapshot(options = {}) {
      const snapshot = await originalSnapshot(options);
      const snapshotId = snapshot?.snapshotId ?? null;
      tracker.hasSnapshot = true;
      tracker.currentSnapshotId = snapshotId;
      for (const [subscriberApp, subscriberState] of tracker.subscribers) {
        updateSnapshotSubscriber(subscriberApp, subscriberState, snapshotId);
      }
      return snapshot;
    };
    SNAPSHOT_TRACKERS.set(snapshotOwner, tracker);
    try {
      Object.defineProperty(snapshotOwner, '__autoReportSnapshotTracker', { value:INSTALL_VERSION, configurable:true });
    } catch { /* marker is diagnostic only; the WeakMap owns tracker identity */ }
  }

  tracker.subscribers.set(app, state);
  // The snapshot identity belongs to the shared query owner, not to whichever
  // app happened to install the wrapper first. A later subscriber therefore
  // inherits the most recent successfully published snapshot immediately.
  if (tracker.hasSnapshot) updateSnapshotSubscriber(app, state, tracker.currentSnapshotId);
}

export function installAutoReportIdentityBoundary(app) {
  if (!app || app.__autoReportIdentityVersion === INSTALL_VERSION) return app;
  const initial = app.autoReport ?? null;
  const state = { bound:null, stale:null, currentSnapshotId:null };
  STATE.set(app, state);

  subscribeToSnapshotOwner(app, state);

  Object.defineProperty(app, 'autoReport', {
    configurable:true,
    enumerable:true,
    get() {
      if (!state.bound) return null;
      if (!sameIdentity(state.bound.identity, liveIdentity(app, state.currentSnapshotId))) {
        state.stale = state.bound;
        state.bound = null;
        return null;
      }
      return state.bound.value;
    },
    set(value) {
      const bound = value == null ? null : bindValue(app, value, state.currentSnapshotId);
      // A value that failed producer-identity validation was never current, so
      // it must not be retained — not as bound and not as historical evidence.
      state.bound = bound && bound.identity ? bound : null;
      if (value != null) state.stale = null;
    },
  });
  if (initial) app.autoReport = initial;
  Object.defineProperty(app, 'historicalAutoReport', {
    configurable:true,
    enumerable:false,
    get() { return state.stale?.value ?? null; },
  });
  Object.defineProperty(app, '__autoReportIdentityVersion', { value:INSTALL_VERSION, configurable:true });
  return app;
}

export const __autoReportIdentityInternalsForTests = Object.freeze({ liveIdentity, sameIdentity, bindValue });
