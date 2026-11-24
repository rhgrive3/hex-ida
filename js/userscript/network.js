const ABSOLUTE_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export function installUserscriptNetworkBridge({ apiBase = globalThis.__HEX_API_BASE__ } = {}) {
  if (globalThis.__HEX_NATIVE_FETCH__) return globalThis.fetch;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.__HEX_NATIVE_FETCH__ = nativeFetch;

  const base = normalizeBase(apiBase);
  const bridgedFetch = async (input, init = {}) => {
    const target = targetFor(input, base);
    if (!target.useBridge) return nativeFetch(input, init);
    return gmFetch(target.url, init, input);
  };
  Object.defineProperty(bridgedFetch, '__hexUserscriptFetch', { value: true });
  globalThis.fetch = bridgedFetch;
  return bridgedFetch;
}

export async function gmFetch(input, init = {}, requestInput = null) {
  const gm = userscriptRequest();
  if (!gm) {
    const nativeFetch = globalThis.__HEX_NATIVE_FETCH__ || globalThis.fetch;
    return nativeFetch(input, init);
  }

  const request = requestInput instanceof Request ? requestInput : (input instanceof Request ? input : null);
  const url = request ? request.url : String(input);
  const method = String(init.method || request?.method || 'GET').toUpperCase();
  const headers = new Headers(request?.headers || undefined);
  if (init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));

  let body = init.body;
  if (body == null && request && method !== 'GET' && method !== 'HEAD') {
    body = await request.clone().arrayBuffer();
  }
  if (body instanceof URLSearchParams) body = body.toString();

  const signal = init.signal || request?.signal || null;
  if (signal?.aborted) throw abortError(signal.reason);

  return new Promise((resolve, reject) => {
    let settled = false;
    let handle = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { handle?.abort?.(); } catch { /* best effort */ }
      finish(reject, abortError(signal?.reason));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      handle = gm({
        method,
        url,
        headers: Object.fromEntries(headers.entries()),
        data: body == null ? undefined : body,
        responseType: 'arraybuffer',
        anonymous: true,
        redirect: 'error',
        onload: (response) => {
          try {
            const status = Number(response?.status) || 0;
            if (!status) {
              finish(reject, new TypeError(`Hex request failed before an HTTP response was received: ${url}`));
              return;
            }
            if (response.finalUrl != null && response.finalUrl !== '') {
              let requestedOrigin = null;
              let finalOrigin = null;
              try {
                const baseHref = globalThis.location?.href;
                requestedOrigin = new URL(url, baseHref).origin;
                finalOrigin = new URL(String(response.finalUrl), baseHref).origin;
              } catch {
                finish(reject, new TypeError(`Hex request returned an invalid finalUrl: ${url}`));
                return;
              }
              if (!requestedOrigin || requestedOrigin === 'null' || finalOrigin !== requestedOrigin) {
                finish(reject, new TypeError(`Hex request redirected across origins: ${url}`));
                return;
              }
            }
            const isNullBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;
            const raw = response.response ?? response.responseText;
            const responseBody = isNullBodyStatus
              ? null
              : (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)
                ? raw
                : (typeof raw === 'string' ? raw : null));
            if (!isNullBodyStatus && responseBody === null) {
              finish(reject, new TypeError(`Hex request returned a body that is neither bytes nor text: ${url}`));
              return;
            }
            finish(resolve, new Response(responseBody, {
              status,
              statusText: response.statusText || '',
              headers: parseHeaders(response.responseHeaders),
            }));
          } catch (error) {
            finish(reject, error);
          }
        },
        onerror: () => finish(reject, new TypeError(`Hex request failed: ${url}`)),
        ontimeout: () => finish(reject, new DOMException('Hex request timed out.', 'TimeoutError')),
        onabort: () => finish(reject, abortError(signal?.reason)),
      });
      if (handle && typeof handle.catch === 'function') handle.catch((error) => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}

function userscriptRequest() {
  const modern = globalThis.GM?.xmlHttpRequest;
  if (typeof modern === 'function') return modern.bind(globalThis.GM);
  const legacy = globalThis.GM_xmlhttpRequest;
  return typeof legacy === 'function' ? legacy : null;
}

function targetFor(input, base) {
  if (!base) return { useBridge: false, url: input };
  if (input instanceof Request || input instanceof URL) {
    const url = new URL(input.url || input.href);
    return { useBridge: url.origin === base.origin, url: url.href };
  }
  const raw = String(input);
  const trimmed = raw.trim();
  if (!ABSOLUTE_SCHEME.test(trimmed) && !/^[\\/]{2}/.test(trimmed)) {
    const url = new URL(raw, base);
    return { useBridge: url.origin === base.origin, url: url.href };
  }
  const url = new URL(raw, location.href);
  return { useBridge: url.origin === base.origin, url: url.href };
}

function normalizeBase(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), location.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
  } catch { return null; }
}

function parseHeaders(raw) {
  const headers = new Headers();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name) headers.append(name, value);
  }
  return headers;
}

function abortError(reason) {
  return new DOMException(String(reason || 'cancelled'), 'AbortError');
}
