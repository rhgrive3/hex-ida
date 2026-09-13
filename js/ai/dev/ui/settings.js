import { DenyAdminProvider, readAdminIdentity } from '../auth/admin-provider.js';
import { AGENT_PROFILE, assertAgentProfile, availableAgentProfiles, canSelectAgentProfile } from '../policy/agent-profile.js';
import { DEV_DECISION_POLICY, assertDevDecisionPolicy } from '../policy/decision-policy.js';
import { createDevAnalysisScopeRequest, ANALYSIS_SCOPE_INITIALS } from '../run/analysis-scope.js';

const STORAGE_KEY = 'hex.ai.dev.settings.v1';

export class DevAgentUiSettings {
  constructor({ authProvider = new DenyAdminProvider(), storage = defaultStorage(), key = STORAGE_KEY } = {}) {
    this.authProvider = authProvider;
    this.identity = readAdminIdentity(authProvider);
    this.storage = storage;
    this.key = key;
    this.listeners = new Set();
    const saved = this.load();
    this.agentProfile = safeProfile(saved.agentProfile);
    if (!canSelectAgentProfile(this.identity, this.agentProfile)) this.agentProfile = AGENT_PROFILE.STANDARD;
    this.decisionPolicy = this.identity.capabilities.canUseDevYolo ? safePolicy(saved.decisionPolicy) : DEV_DECISION_POLICY.NORMAL;
    this.analysisScope = safeScope(saved.analysisScope);
    this.lastRun = null;
    this.unsubscribeAuth = authProvider.subscribe?.(() => this.refreshIdentity());
  }

  refreshIdentity() {
    this.identity = readAdminIdentity(this.authProvider);
    if (!this.identity.capabilities.canUseDevAgent) this.agentProfile = AGENT_PROFILE.STANDARD;
    if (!this.identity.capabilities.canUseDevYolo) this.decisionPolicy = DEV_DECISION_POLICY.NORMAL;
    if (!this.identity.capabilities.canUseDevAgent || !this.identity.capabilities.canUseDevYolo) this.persist();
    this.emit(); return this.identity;
  }
  destroy() { this.unsubscribeAuth?.(); this.listeners.clear(); }
  profiles() { return availableAgentProfiles(this.identity); }
  setAgentProfile(profile) {
    this.refreshIdentity();
    const next = assertAgentProfile(profile);
    if (!canSelectAgentProfile(this.identity, next)) throw new Error('Admin privileges are required for the Dev profile.');
    if (this.agentProfile === next) return false;
    this.agentProfile = next;
    this.persist(); this.emit(); return true;
  }
  setDecisionPolicy(policy) {
    const next = assertDevDecisionPolicy(policy);
    this.refreshIdentity();
    if (next === DEV_DECISION_POLICY.YOLO && !this.identity.capabilities.canUseDevYolo) throw new Error('Admin privileges are required for YOLO.');
    if (this.decisionPolicy === next) return false;
    this.decisionPolicy = next;
    this.persist(); this.emit(); return true;
  }
  setAnalysisScope(initial) {
    if (typeof initial !== 'string') {
      throw new TypeError(`Analysis scope must be a string, got ${initial === null ? 'null' : typeof initial}`);
    }
    const normalized = initial.trim().toLowerCase();
    if (!ANALYSIS_SCOPE_INITIALS.includes(normalized)) throw new TypeError(`Unsupported analysis scope: ${initial}`);
    const next = createDevAnalysisScopeRequest(normalized);
    if (this.analysisScope.initial === next.initial) return false;
    this.analysisScope = next;
    this.persist(); this.emit(); return true;
  }
  setLastRun(run) { this.lastRun = run || null; this.emit(); }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot() {
    return Object.freeze({
      identity: this.identity,
      agentProfile: this.agentProfile,
      decisionPolicy: this.decisionPolicy,
      analysisScope: this.analysisScope,
      lastRun: this.lastRun,
    });
  }
  emit() { for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* isolated UI listener */ } } }
  load() {
    if (!this.storage) return {};
    try { const raw = this.storage.getItem(this.key); const parsed = raw ? JSON.parse(raw) : null; return parsed && typeof parsed === 'object' ? parsed : {}; }
    catch { return {}; }
  }
  persist() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify({
        agentProfile: this.agentProfile,
        decisionPolicy: this.decisionPolicy,
        analysisScope: this.analysisScope,
      }));
      return true;
    } catch { return false; }
  }
}

function safePolicy(value) { try { return assertDevDecisionPolicy(value || DEV_DECISION_POLICY.NORMAL); } catch { return DEV_DECISION_POLICY.NORMAL; } }
function safeScope(value) { try { return value?.initial ? createDevAnalysisScopeRequest(value.initial) : createDevAnalysisScopeRequest(); } catch { return createDevAnalysisScopeRequest(); } }
function defaultStorage() { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }

function safeProfile(value) { try { return assertAgentProfile(value || AGENT_PROFILE.STANDARD); } catch { return AGENT_PROFILE.STANDARD; } }
