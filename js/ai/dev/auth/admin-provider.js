export const ADMIN_AUTH_PROVIDER_KIND = 'admin-auth-provider';

export class AdminAuthProvider {
  getIdentity() {
    throw new Error('AdminAuthProvider.getIdentity() must be implemented.');
  }
}

export class DenyAdminProvider extends AdminAuthProvider {
  getIdentity() { return Object.freeze({ authenticated: false, admin: false, provider: 'no-session' }); }
}

// Explicit test/development fixture. Never a production default.
export class AllowAllAdminProvider extends AdminAuthProvider {
  getIdentity() {
    return Object.freeze({
      authenticated: true,
      admin: true,
      provider: 'allow-all-admin',
      capabilities: Object.freeze({ canUseDevAgent: true, canUseDevYolo: true }),
    });
  }
}

export function readAdminIdentity(provider) {
  if (!provider || typeof provider.getIdentity !== 'function') {
    throw new TypeError('An AdminAuthProvider is required.');
  }
  const identity = provider.getIdentity();
  if (!identity || typeof identity !== 'object') throw new TypeError('AdminAuthProvider returned an invalid identity.');
  const authenticated = identity.authenticated === true;
  const admin = authenticated && identity.admin === true;
  // Existing providers historically exposed only `admin`. New session-backed
  // providers keep explicit capabilities so future role-policy changes (for
  // example VIP Dev without YOLO) do not collapse back into an Admin boolean.
  const explicit = identity.capabilities && typeof identity.capabilities === 'object' ? identity.capabilities : null;
  const capabilities = Object.freeze({
    canUseDevAgent: authenticated && (explicit ? explicit.canUseDevAgent === true : admin),
    canUseDevYolo: authenticated && (explicit ? explicit.canUseDevYolo === true : admin),
  });
  return Object.freeze({
    authenticated,
    admin,
    provider: String(identity.provider || 'unknown'),
    capabilities,
  });
}
