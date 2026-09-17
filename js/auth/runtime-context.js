import { ANONYMOUS_IDENTITY } from './capabilities.js';
const anonymous = Object.freeze({ getIdentity: () => ANONYMOUS_IDENTITY, refresh: async () => ANONYMOUS_IDENTITY, subscribe: () => () => {}, authorize: async () => { throw new Error('Dev authorization denied.'); }, aiCapability: async () => { throw new Error('AI authorization denied.'); } });
let current = null;
export function setAuthContext(context) {
  if (current && current !== context) current.close?.();
  current = context;
  return () => { if (current === context) current = null; };
}
export function getAuthContext() { return current || Object.freeze({ auth: anonymous, childExtension: null, login: () => {}, logout: async () => {} }); }
