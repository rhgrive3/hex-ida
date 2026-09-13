import { DevSupervisorEngineV0 as BaseDevSupervisorEngineV0 } from './dev-supervisor-engine-v0.js';

/*
 * The base engine's maxDecisions loop is a safety budget for decisions that do
 * not make progress. A successful tool call is positive progress and must not
 * consume that budget forever. This production wrapper keeps the existing
 * fail-closed base loop, but moves its upper bound forward after a tool
 * execution that makes verifiable progress so the Supervisor gets a fresh
 * maxDecisions window.
 *
 * Invalid decisions, unavailable tools, activation rejections and failed tool
 * calls do not mark progress, so they remain bounded by the original window.
 * Repeated identical read-only observations (runtime identity) and control
 * re-declarations (requireActivation) succeed without advancing state, so they
 * only mark progress when their (args, result) fingerprint changes. Every
 * replenished window is additionally capped by an absolute decision ceiling so
 * that no successful-tool loop can extend maxDecisions without a stopping point.
 */

const PROGRESS_ABSOLUTE_DECISION_CEILING = 256;

export class ProgressBudgetDevSupervisorEngineV0 extends BaseDevSupervisorEngineV0 {
  constructor(options = {}) {
    super(options);
    this.progressDecisionWindow = this.maxDecisions;
    this.progressDecisionCount = 0;
    this.progressRunActive = false;
    this.progressObservationFingerprints = Object.create(null);

    /* Never Proxy the production bridge: request may be a non-configurable,
       non-writable own property. A Proxy get trap returning a wrapper function
       violates the ECMAScript invariant and aborts R4 bootstrap. */
    const bridge = this.bridge;
    if (bridge && typeof bridge.request === 'function') {
      const request = bridge.request.bind(bridge);
      this.bridge = Object.freeze({
        request: async (...args) => {
          const result = await request(...args);
          if (this.progressRunActive) this.progressDecisionCount += 1;
          return result;
        },
      });
    }

    const gate = this.selfUpdateGate;
    if (gate && typeof gate.requireActivation === 'function') {
      const requireActivation = gate.requireActivation.bind(gate);
      gate.requireActivation = (...args) => {
        const result = requireActivation(...args);
        this.markControlProgress(args, result);
        return result;
      };
    }
  }

  markToolProgress() {
    if (!this.progressRunActive) return;
    this.maxDecisions = Math.min(
      this.progressDecisionCount + this.progressDecisionWindow,
      PROGRESS_ABSOLUTE_DECISION_CEILING,
    );
  }

  progressFingerprint(payload) {
    try { return JSON.stringify(payload); } catch { return null; }
  }

  markObservationProgress(key, fingerprint) {
    if (!this.progressRunActive) return;
    if (fingerprint === null || fingerprint === this.progressObservationFingerprints[key]) return;
    this.progressObservationFingerprints[key] = fingerprint;
    this.markToolProgress();
  }

  markControlProgress(args, result) {
    this.markObservationProgress('requireActivation', this.progressFingerprint({ args, result }));
  }

  async executeWithinToolBoundary(operation) {
    const result = await super.executeWithinToolBoundary(operation);
    this.markToolProgress();
    return result;
  }

  async readActiveRuntimeIdentity(args = {}) {
    const result = await super.readActiveRuntimeIdentity(args);
    this.markObservationProgress('runtimeIdentity', this.progressFingerprint({ args, result }));
    return result;
  }

  async run(input = {}) {
    if (this.progressRunActive) {
      throw new Error('DevSupervisorEngine run is already in progress');
    }
    this.progressDecisionCount = 0;
    this.progressObservationFingerprints = Object.create(null);
    this.maxDecisions = this.progressDecisionWindow;
    this.progressRunActive = true;
    try {
      return await super.run(input);
    } finally {
      this.progressRunActive = false;
      this.progressDecisionCount = 0;
      this.progressObservationFingerprints = Object.create(null);
      this.maxDecisions = this.progressDecisionWindow;
    }
  }
}
