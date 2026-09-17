/** Credential-bearing requests are confined to an exact Worker origin. */
export function createAuthTransport({ apiOrigin, fetchRef = globalThis.fetch?.bind(globalThis), manager = null, token = () => null, web = false, timeoutMs = 12000 } = {}) {
  const allowed = new Set(['/api/auth/me', '/api/auth/csrf', '/api/auth/ai-capability', '/api/auth/dev/authorize', '/api/auth/userscript/start', '/api/auth/userscript/poll', '/api/auth/userscript/complete', '/auth/logout']);
  const base = new URL(apiOrigin);
  if (base.origin !== apiOrigin || (!['https:'].includes(base.protocol) && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))) throw new Error('Invalid HEX auth origin.');
  return async function request(path, { method = 'GET', body, csrf = null, source = false, signal = null } = {}) {
    if (!allowed.has(path) && !/^\/_privileged\/dev\/[a-f0-9]{24}\.[a-f0-9]{24}\/(parent|child)\.js$/.test(path)) throw new Error('Auth route is not allowed.');
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error('Auth origin mismatch.');
    const headers = { accept: source ? 'application/javascript' : 'application/json' };
    const bearer = token();
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-hex-csrf'] = csrf;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const init = { method, headers, signal: controller.signal, credentials: web ? 'same-origin' : 'omit', cache: 'no-store', redirect: 'error', ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const response = await abortable(() => manager ? gmRequest(manager, url.href, init, timeoutMs) : fetchRef(url.href, init), controller.signal);
      if (!response.ok) { const error = new Error(`HEX authentication failed (${response.status}).`); error.status = response.status; throw error; }
      const text = await boundedResponseText(response, source ? 16 * 1024 * 1024 : 65536, controller.signal);
      return source ? { source: text, buildId: response.headers.get('x-hex-privileged-build') } : JSON.parse(text);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}
async function boundedResponseText(response, maxBytes, signal) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('HEX auth response too large.');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('HEX auth request timed out.');
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error('HEX auth request timed out.');
      if (done) break;
      size += value.byteLength; if (size > maxBytes) throw new Error('HEX auth response too large.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function gmRequest(manager, url, init, timeoutMs) {
  if (typeof manager.xmlHttpRequest !== 'function') throw new Error('Userscript private transport unavailable.');
  return new Promise((resolve, reject) => {
    let done = false, handle;
    const finish = (error, value) => { if (done) return; done = true; init.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { try { handle?.abort?.(); } catch {} finish(new Error('HEX auth request cancelled.')); };
    if (init.signal.aborted) { abort(); return; }
    init.signal.addEventListener('abort', abort, { once: true });
    try {
      handle = manager.xmlHttpRequest({ method: init.method, url, headers: init.headers, data: init.body, responseType: 'text', anonymous: true, redirect: 'error', timeout: timeoutMs,
        onload(result) {
          try {
          // Managers may follow redirects. Never accept an off-origin response.
          if (result.finalUrl && new URL(result.finalUrl).origin !== new URL(url).origin) { finish(new Error('HEX auth redirect denied.')); return; }
          const headers = new Headers();
          for (const line of String(result.responseHeaders || '').split(/\r?\n/)) { const colon = line.indexOf(':'); if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
          try { finish(null, new Response(String(result.responseText || ''), { status: Number(result.status), headers })); } catch { finish(new Error('HEX auth response invalid.')); }
          } catch { finish(new Error('HEX auth response invalid.')); }
        },
        onerror: () => finish(new Error('HEX auth request failed.')),
        ontimeout: () => finish(new Error('HEX auth request timed out.')),
        onabort: () => finish(new Error('HEX auth request cancelled.')),
      });
      handle?.catch?.(() => finish(new Error('HEX auth request failed.')));
    } catch { finish(new Error('Userscript private transport unavailable.')); }
  });
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('HEX auth request timed out or cancelled.'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
