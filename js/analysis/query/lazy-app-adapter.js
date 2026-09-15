// #8712: the AnalysisQuery barrel's eager `product-evidence-adapter` re-export
// pulled 242 modules (~4.48 MB raw source) of emulator/decompiler/semantic/
// architecture implementation into the `js/app.js` startup graph and broke the
// #2622 lazy-startup boundary again. App construction must stay synchronous for
// consumers that probe `app.analysisQueries` (hex-context, auto-report
// identity, demand-driven install guards), but the adapter implementation is
// demand-loaded exactly once by the first awaited query. A failed load is
// memoized, so later queries surface the same error instead of re-importing.
import { AnalysisQueryAPI } from './api.js';

const NEVER_DELEGATED = new Set(['then', 'catch', 'finally', 'constructor']);

async function defaultLoadAppAnalysisQueryAdapter(app) {
  const { createAppAnalysisQueryAdapter } = await import('./product-evidence-adapter.js');
  return createAppAnalysisQueryAdapter(app);
}

export function createLazyAppAnalysisQueryAPI(app, loadAdapter = defaultLoadAppAnalysisQueryAdapter) {
  let apiPromise = null;
  const lazyApi = () => {
    if (!apiPromise) {
      apiPromise = Promise.resolve()
        .then(() => loadAdapter(app))
        .then((adapter) => new AnalysisQueryAPI(adapter));
      // The rejection itself is cached for every later caller; this no-op
      // handler only prevents a realm-wide unhandledRejection from the copy
      // the shared promise chain keeps for no observer.
      apiPromise.catch(() => {});
    }
    return apiPromise;
  };
  const facade = Object.create(AnalysisQueryAPI.prototype);
  return new Proxy(facade, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !NEVER_DELEGATED.has(prop)) {
        return async (...args) => {
          const api = await lazyApi();
          return api[prop](...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
