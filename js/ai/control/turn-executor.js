import { executeTurn as executeBaseTurn } from './turn-executor-base.js';
import { evidenceByStatus } from '../evidence-status-index.js';

export async function executeTurn(input = {}, options = {}) {
  const runtime = this;
  const evidenceDescriptor = Object.getOwnPropertyDescriptor(runtime, 'evidenceStore');
  const finalizeDescriptor = Object.getOwnPropertyDescriptor(runtime, 'finalize');
  const originalFinalize = runtime.finalize;
  let currentStore = runtime.evidenceStore;
  let wrappedStore = null;
  let originalAll = null;
  let finalized = false;

  const restoreStoreAll = () => {
    if (wrappedStore && originalAll) wrappedStore.all = originalAll;
    wrappedStore = null; originalAll = null;
  };
  const wrapStore = (store) => {
    if (!store || store === wrappedStore || typeof store.all !== 'function') return;
    restoreStoreAll();
    wrappedStore = store;
    originalAll = store.all;
    store.all = function indexedAllAfterFinalize(...args) {
      if (!finalized) return originalAll.apply(this, args);
      // executeTurn has exactly one EvidenceStore.all() after finalize: the
      // lossless confirmedFindings persistence projection. Return the canonical
      // verified index so the existing verified filter stays behaviorally equal
      // without copying/scanning every evidence record.
      return evidenceByStatus(this, 'verified');
    };
  };

  Object.defineProperty(runtime, 'evidenceStore', {
    configurable:true,
    enumerable:evidenceDescriptor?.enumerable ?? true,
    get() { return currentStore; },
    set(store) { currentStore = store; wrapStore(store); },
  });
  wrapStore(currentStore);

  runtime.finalize = function indexedFinalize(...args) {
    const result = originalFinalize.apply(this, args);
    finalized = true;
    return result;
  };

  try {
    return await executeBaseTurn.call(runtime, input, options);
  } finally {
    restoreStoreAll();
    if (finalizeDescriptor) Object.defineProperty(runtime, 'finalize', finalizeDescriptor);
    else delete runtime.finalize;
    if (evidenceDescriptor) {
      Object.defineProperty(runtime, 'evidenceStore', { ...evidenceDescriptor, value:currentStore });
    } else {
      delete runtime.evidenceStore;
      runtime.evidenceStore = currentStore;
    }
  }
}
