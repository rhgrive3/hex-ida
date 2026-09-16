import assert from 'node:assert/strict';
import { AdminAuthProvider } from '../../js/ai/dev/auth/admin-provider.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';

class MutableAdminProvider extends AdminAuthProvider {
  constructor() {
    super();
    this.authorized = true;
  }

  getIdentity() {
    return {
      authenticated: this.authorized,
      admin: this.authorized,
      provider: 'mutable-fixture',
    };
  }
}

const provider = new MutableAdminProvider();
const settings = new DevAgentUiSettings({ authProvider: provider, storage: null });
settings.setAgentProfile('dev');
settings.setDecisionPolicy('yolo');
let notifications = 0;
settings.on(() => { notifications += 1; });

provider.authorized = false;
assert.deepEqual([...settings.profiles()], ['standard']);
assert.equal(settings.agentProfile, 'standard');
assert.equal(settings.decisionPolicy, 'normal');
assert.equal(settings.snapshot().identity.admin, false);
assert.ok(notifications >= 1, 'privilege loss must emit a downgraded state');
console.log('ok    #8854 live privilege revocation');
