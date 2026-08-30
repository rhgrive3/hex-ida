const INSTALL_VERSION = 'auto-report-identity/v2';
const STATE = new WeakMap();

function storeValue(app, key) { try { return app?.store?.get?.(key) ?? null; } catch { return null; } }
function projectRevision(app) {
  const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.project ?? null;
  const value = Number(project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision ?? 0);
  return Number.isFinite(value) ? value : 0;
}
function liveIdentity(app, currentSnapshotId = null) {
  return Object.freeze({
    binaryId:app?.backend?.binaryId ?? app?.backend?.contentHash ?? storeValue(app, 'fileInfo')?.binaryId ?? null,
    sliceIndex:Number(storeValue(app, 'sliceIndex') ?? -1),
    analysisEpoch:Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0),
    projectRevision:projectRevision(app),
    snapshotId:currentSnapshotId,
  });
}
function sameIdentity(bound, live) {
  if (!bound || !live) return false;
  if (bound.analysisEpoch !== live.analysisEpoch) return false;
  if (bound.sliceIndex !== live.sliceIndex) return false;
  if (bound.projectRevision !== live.projectRevision) return false;
  if (bound.binaryId && live.binaryId && bound.binaryId !== live.binaryId) return false;
  // Once a current AnalysisSnapshot is known, a report without that exact
  // snapshot identity is historical evidence, never current Results authority.
  if (live.snapshotId && bound.snapshotId !== live.snapshotId) return false;
  return true;
}
function bindValue(app, value, currentSnapshotId = null) {
  if (!value || typeof value !== 'object') return { value, identity:null };
  const report = value.report && typeof value.report === 'object' ? value.report : null;
  const snapshotId = value.snapshotId ?? report?.snapshotId ?? null;
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

export function installAutoReportIdentityBoundary(app) {
  if (!app || app.__autoReportIdentityVersion === INSTALL_VERSION) return app;
  const initial = app.autoReport ?? null;
  const state = { bound:null, stale:null, currentSnapshotId:null };
  STATE.set(app, state);

  const snapshotOwner = app.analysisQueries;
  const originalSnapshot = snapshotOwner?.snapshot?.bind(snapshotOwner) ?? null;
  if (snapshotOwner && originalSnapshot && !snapshotOwner.__autoReportSnapshotTracker) {
    snapshotOwner.snapshot = async function trackedAnalysisSnapshot(options = {}) {
      const snapshot = await originalSnapshot(options);
      state.currentSnapshotId = snapshot?.snapshotId ?? null;
      if (state.bound && !sameIdentity(state.bound.identity, liveIdentity(app, state.currentSnapshotId))) {
        state.stale = state.bound;
        state.bound = null;
      }
      return snapshot;
    };
    Object.defineProperty(snapshotOwner, '__autoReportSnapshotTracker', { value:INSTALL_VERSION, configurable:true });
  }

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
      state.bound = value == null ? null : bindValue(app, value, state.currentSnapshotId);
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
