import { AGENT_PROFILE } from '../policy/agent-profile.js';
import { DevSupervisorV0 } from '../supervisor/dev-supervisor-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../supervisor/dev-supervisor-progress-budget.js';

export function createAgentProfileEngine({ standardEngine, settings, supervisor = new DevSupervisorV0(), devEngine = null } = {}) {
  if (!standardEngine || typeof standardEngine.run !== 'function') throw new TypeError('standardEngine.run is required.');
  if (!settings) throw new TypeError('DevAgentUiSettings is required.');
  const dev = devEngine || new ProgressBudgetDevSupervisorEngineV0({ supervisor, settings });
  const devBootstrap = Object.freeze({
    prepare: () => dev.prepareBootstrapExtension(),
    activateAtSafeBoundary: (options) => dev.activateBootstrapAtSafeBoundary(options),
    invoke: (name) => dev.invokeBootstrapCapability(name),
    sessionFor: (conversationId) => dev.bootstrapSessionFor(conversationId),
    createCheckpoint: (options) => dev.createBootstrapCheckpoint(options),
    restore: (handoff) => dev.restoreBootstrapHandoff(handoff),
    runProof: (options) => dev.runBootstrapProof(options),
  });

  const routeRun = async (input = {}) => {
    if (input.mode !== 'agent' || settings.agentProfile !== AGENT_PROFILE.DEV) return standardEngine.run(input);
    return dev.run(input);
  };
  const surface = Object.create(Object.getPrototypeOf(standardEngine));
  Object.defineProperty(surface, 'run', { value: routeRun, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(surface, 'devBootstrap', { value: devBootstrap, writable: false, enumerable: false, configurable: true });

  return new Proxy(surface, {
    get(target, property) {
      if (property === 'run' || property === 'devBootstrap') return target[property];
      const value = Reflect.get(standardEngine, property, standardEngine);
      return typeof value === 'function' ? value.bind(standardEngine) : value;
    },
  });
}
