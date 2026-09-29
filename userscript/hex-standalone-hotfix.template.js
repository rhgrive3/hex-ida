// ==UserScript==
// @name         Hex for ChatGPT (Emergency Standalone)
// @namespace    https://github.com/rhgrive3/hex
// @version      __HEX_EMERGENCY_VERSION__
// @description  Emergency standalone Hex loader while the production Cloudflare runtime publication is inconsistent.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @connect      raw.githubusercontent.com
// @connect      ida.rhgrive.workers.dev
// @updateURL    https://raw.githubusercontent.com/rhgrive3/hex-ida/hotfix/live-2213-runtime-worker/userscript/hex-standalone-hotfix.user.js
// @downloadURL  https://raw.githubusercontent.com/rhgrive3/hex-ida/hotfix/live-2213-runtime-worker/userscript/hex-standalone-hotfix.user.js
// ==/UserScript==

(() => {
  const API_ORIGIN = 'https://ida.rhgrive.workers.dev';
  const RUNTIME_URL = 'https://raw.githubusercontent.com/rhgrive3/hex-ida/hotfix/live-2213-runtime-worker/userscript/hex-standalone-runtime.js';
  const RUNTIME_SHA256 = '__HEX_RUNTIME_SHA256__';
  const RUNTIME_BYTES = __HEX_RUNTIME_BYTES__;
  const LOADER_VERSION = '__HEX_LOADER_VERSION__';
  const BUILD_ID = '__HEX_BUILD_ID__';
  const PRIVILEGED_MANIFEST = __HEX_PRIVILEGED_MANIFEST__;

  if (!isTopFrame()) return;
  const start = () => boot().catch(showFailure);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  function isTopFrame() {
    try { return globalThis.self === globalThis.top; } catch { return false; }
  }

  async function boot() {
    if (!globalThis.crypto?.subtle) throw new Error('WebCrypto is required to start Hex.');
    const status = showStatus('Loading emergency Hex runtime…', true);
    const runtime = await gmArrayBuffer(RUNTIME_URL, 60_000);
    if (!(runtime instanceof ArrayBuffer) || runtime.byteLength !== RUNTIME_BYTES) {
      throw new Error(`Emergency runtime length mismatch (${runtime?.byteLength ?? 'unknown'} != ${RUNTIME_BYTES}).`);
    }
    const digest = await sha256(runtime);
    if (!same(digest, RUNTIME_SHA256)) {
      new Uint8Array(runtime).fill(0);
      throw new Error('Emergency runtime SHA-256 mismatch.');
    }

    const hostLocation = snapshotLocation();
    globalThis.__HEX_RUNTIME_ORIGIN__ = API_ORIGIN;
    globalThis.__HEX_RUNTIME_HOST_HREF__ = hostLocation.href;
    globalThis.__HEX_RUNTIME_HOST_ORIGIN__ = hostLocation.origin;
    globalThis.__HEX_RUNTIME_HOST_PATHNAME__ = hostLocation.pathname;
    globalThis.__HEX_RUNTIME_HOST_SEARCH__ = hostLocation.search;
    globalThis.__HEX_RUNTIME_HOST_LOCATION__ = hostLocation;
    globalThis.__HEX_SECURE_LOADER__ = { version: LOADER_VERSION, buildId: BUILD_ID };

    const blob = URL.createObjectURL(new Blob([runtime.slice(0)], { type: 'text/javascript' }));
    let sourceCalls = 0;
    try {
      const module = await import(blob);
      if (typeof module?.startProtectedRuntime !== 'function') throw new Error('Protected runtime entry point is unavailable.');
      await module.startProtectedRuntime({
        hostLocation,
        privilegedManifest: PRIVILEGED_MANIFEST,
        userscriptManager: userscriptManager(),
        apiOrigin: API_ORIGIN,
        loaderVersion: LOADER_VERSION,
        buildId: BUILD_ID,
        sourceCommit: null,
        runtimeContentHash: RUNTIME_SHA256,
        runtimeSourceProvider() {
          sourceCalls += 1;
          if (sourceCalls > 1) throw new Error('Emergency runtime source was requested more than once.');
          return runtime.slice(0);
        },
      });
      status.remove();
    } finally {
      URL.revokeObjectURL(blob);
      new Uint8Array(runtime).fill(0);
    }
  }

  function userscriptManager() {
    const manager = typeof GM === 'object' && GM ? GM : null;
    if (!manager) return null;
    const out = {};
    for (const name of ['getValue', 'setValue', 'deleteValue', 'xmlHttpRequest']) {
      if (typeof manager[name] !== 'function') return null;
      out[name] = manager[name].bind(manager);
    }
    return Object.freeze(out);
  }

  function gmArrayBuffer(url, timeoutMs) {
    const manager = typeof GM === 'object' && GM ? GM : null;
    if (!manager || typeof manager.xmlHttpRequest !== 'function') {
      return Promise.reject(new Error('GM.xmlHttpRequest is unavailable.'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
      manager.xmlHttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        anonymous: true,
        onload(response) {
          const status = Number(response?.status || 0);
          if (status !== 200) return finish(reject, new Error(`Emergency runtime fetch failed (${status}).`));
          const value = response?.response;
          if (value instanceof ArrayBuffer) return finish(resolve, value);
          if (ArrayBuffer.isView(value)) {
            const copy = new Uint8Array(value.byteLength);
            copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            return finish(resolve, copy.buffer);
          }
          return finish(reject, new Error('Emergency runtime response was not binary.'));
        },
        onerror() { finish(reject, new Error('Emergency runtime network request failed.')); },
        ontimeout() { finish(reject, new Error('Emergency runtime request timed out.')); },
      });
    });
  }

  async function sha256(value) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
    let out = '';
    for (const byte of digest) out += byte.toString(16).padStart(2, '0');
    return out;
  }

  function same(left, right) {
    if (left.length !== right.length) return false;
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
  }

  function snapshotLocation() {
    return Object.freeze({
      origin: String(location.origin || ''),
      pathname: String(location.pathname || '/'),
      search: String(location.search || ''),
      href: String(location.href || ''),
    });
  }

  function showStatus(text, disabled = false) {
    let node = document.getElementById('hex-secure-loader');
    if (!node) {
      node = document.createElement('button');
      node.id = 'hex-secure-loader';
      Object.assign(node.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
        minHeight: '44px', maxWidth: 'min(92vw,520px)', padding: '8px 12px',
        border: '0', borderRadius: '12px', background: '#111827', color: '#fff',
        font: '600 13px system-ui', boxShadow: '0 4px 18px rgba(0,0,0,.28)',
      });
      document.documentElement.append(node);
    }
    node.textContent = text;
    node.disabled = !!disabled;
    return node;
  }

  function showFailure(error) {
    const message = String(error?.message || error || 'Unknown startup error.');
    const node = showStatus(`Emergency Hex failed — retry · ${message.slice(0, 140)}`, false);
    node.title = message;
    node.onclick = () => { node.remove(); boot().catch(showFailure); };
  }
})();
