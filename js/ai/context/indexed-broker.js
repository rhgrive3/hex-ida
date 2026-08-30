import { ContextBroker as BaseContextBroker, UNTRUSTED_NOTICE } from './broker.js';
import { recentEvidenceByStatus } from '../evidence-status-index.js';

export { UNTRUSTED_NOTICE };

export class ContextBroker extends BaseContextBroker {
  buildModelContext(options = {}) {
    const store = options.evidenceStore;
    if (!store) return super.buildModelContext(options);
    const recentVerified = recentEvidenceByStatus(store, 'verified', 32);
    const evidenceStore = {
      all: () => recentVerified,
      pinned: (ids) => typeof store.pinned === 'function'
        ? store.pinned(ids)
        : (ids || []).map((id) => store.get?.(id)).filter(Boolean),
    };
    return super.buildModelContext({ ...options, evidenceStore });
  }
}
