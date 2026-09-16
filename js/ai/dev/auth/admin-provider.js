export const ADMIN_AUTH_PROVIDER_KIND = 'admin-auth-provider';

export class AdminAuthProvider {
  getIdentity() {
    throw new Error('AdminAuthProvider.getIdentity() must be implemented.');
  }
}

export class AllowAllAdminProvider extends AdminAuthProvider {
  getIdentity() {
    return Object.freeze({
      authenticated: true,
      admin: true,
      provider: 'allow-all-admin',
    });
  }
}

/* #8854: fail-closed default. Production must not manufacture admin authority from a synthetic
   default; a trusted authenticated provider has to be supplied explicitly. When none is wired the
   principal is unauthenticated and Standard-only. */
export class DenyAllAdminProvider extends AdminAuthProvider {
  getIdentity() {
    return Object.freeze({
      authenticated: false,
      admin: false,
      provider: 'deny-all-admin',
    });
  }
}

export function readAdminIdentity(provider) {
  if (!provider || typeof provider.getIdentity !== 'function') {
    throw new TypeError('An AdminAuthProvider is required.');
  }
  const identity = provider.getIdentity();
  if (!identity || typeof identity !== 'object') throw new TypeError('AdminAuthProvider returned an invalid identity.');
  return Object.freeze({
    authenticated: identity.authenticated === true,
    admin: identity.admin === true,
    provider: String(identity.provider || 'unknown'),
  });
}
