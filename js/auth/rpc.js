import { safeIdentity, ANONYMOUS_IDENTITY } from './capabilities.js';
const PROTOCOL = 'hex-auth-rpc-v1';
const METHODS = new Set(['identity', 'child', 'authorize', 'login', 'logout']);
const ID = /^[a-f0-9]{32}$/;
function valid(message) { return message && typeof message === 'object' && message.protocol === PROTOCOL && typeof message.id === 'string' && ID.test(message.id) && METHODS.has(message.method); }
export function createAuthRpcServer({ port, auth, showLogin } = {}) {
  let closed = false; const active = new Set();
  const send = (message) => { if (!closed) { try { port.postMessage(message); } catch {} } };
  const listener = (event) => {
    const message = event.data;
    if (!valid(message) || message.kind !== 'request' || active.has(message.id) || active.size >= 8) return;
    active.add(message.id);
    void handle(message);
  };
  async function handle(message) {
    try {
      if (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) throw new Error('invalid request');
      if (message.method !== 'authorize' && Object.keys(message.params || {}).length) throw new Error('invalid request');
      let result;
      switch (message.method) {
        case 'identity': result = safeIdentity(await auth.refresh()); break;
        case 'child': result = await auth.source('child'); break;
        case 'authorize': {
          const params = message.params || {};
          if (Object.keys(params).some((key) => key !== 'policy') || !['normal', 'yolo'].includes(params.policy)) throw new Error('invalid policy');
          result = safeIdentity(await auth.authorize(params.policy)); break;
        }
        case 'login': showLogin(); result = null; break;
        case 'logout': await auth.logout(); result = null; break;
      }
      send({ protocol: PROTOCOL, kind: 'result', id: message.id, method: message.method, result });
    } catch { send({ protocol: PROTOCOL, kind: 'error', id: message.id, method: message.method, error: 'auth-denied' }); }
    finally { active.delete(message.id); }
  }
  port.addEventListener('message', listener); port.start?.();
  const unsubscribe = auth.subscribe((identity) => send({ protocol: PROTOCOL, kind: 'identity', identity: safeIdentity(identity) }));
  return { close() { closed = true; unsubscribe(); active.clear(); port.removeEventListener('message', listener); } };
}
export function createAuthRpcClient({ port, timeoutMs = 15000 } = {}) {
  let identity = ANONYMOUS_IDENTITY, closed = false, refreshGeneration = 0;
  const pending = new Map(), listeners = new Set();
  const update = (value) => { identity = safeIdentity(value); for (const listener of listeners) { try { listener(identity); } catch {} } return identity; };
  const listener = (event) => {
    const message = event.data;
    if (closed || message?.protocol !== PROTOCOL) return;
    if (message.kind === 'identity') { refreshGeneration++; update(message.identity); return; }
    if (!valid(message) || !['result', 'error'].includes(message.kind)) return;
    const task = pending.get(message.id);
    if (!task || task.method !== message.method) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.kind === 'result') task.resolve(message.result); else task.reject(new Error('HEX authorization denied.'));
  };
  const call = (method, params) => {
    if (closed || pending.size >= 8) return Promise.reject(new Error('HEX auth channel unavailable.'));
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); update(ANONYMOUS_IDENTITY); reject(new Error('HEX auth channel timed out.')); }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try { port.postMessage({ protocol: PROTOCOL, kind: 'request', id, method, params }); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error('HEX auth channel unavailable.')); }
    });
  };
  port.addEventListener('message', listener); port.start?.();
  return Object.freeze({
    getIdentity: () => identity,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh() {
      const generation = ++refreshGeneration;
      try { const value = await call('identity'); if (generation === refreshGeneration) update(value); }
      catch {
        // A late failure may reflect a channel loss or a newer server-side
        // revocation than an already-applied success. Never let request order
        // preserve a privileged child identity after any authority failure.
        if (!closed) { refreshGeneration++; update(ANONYMOUS_IDENTITY); }
      }
      return identity;
    },
    async authorize(policy = 'normal') {
      const generation = refreshGeneration;
      try {
        const value = safeIdentity(await call('authorize', { policy }));
        if (closed) throw new Error('HEX auth channel closed.');
        // Parent identity broadcasts precede replies; never revive an older Admin.
        const latest = generation === refreshGeneration ? update(value) : identity;
        if (!latest.capabilities.canUseDevAgent || (policy === 'yolo' && !latest.capabilities.canUseDevYolo)) throw new Error('Dev authorization denied.');
        return latest;
      } catch (error) { update(ANONYMOUS_IDENTITY); throw error; }
    },
    source: (kind) => kind === 'child' ? call('child') : Promise.reject(new Error('Parent source is not a child capability.')),
    login: () => call('login'),
    async logout() { try { await call('logout'); } finally { update(ANONYMOUS_IDENTITY); } },
    close() { closed = true; port.removeEventListener('message', listener); for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('HEX auth channel closed.')); } pending.clear(); update(ANONYMOUS_IDENTITY); listeners.clear(); },
  });
}
