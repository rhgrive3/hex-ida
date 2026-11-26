/* Browser-backed navigation for canonical product screens. */

function normalize(path) {
  let value = String(path || '/investigate').trim();
  if (value.startsWith('#')) value = value.slice(1);
  const queryIndex = value.indexOf('?');
  const search = queryIndex >= 0 ? value.slice(queryIndex) : '';
  let pathname = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  pathname = pathname.replace(/\/{2,}/g, '/');
  return pathname + search;
}

function escapeSegment(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function compile(pattern) {
  const names = [];
  const parts = normalize(pattern).split('/').filter(Boolean);
  let source = '';
  for (const part of parts) {
    if (!part.startsWith(':')) { source += '/' + escapeSegment(part); continue; }
    const optional = part.endsWith('?');
    names.push(part.slice(1, optional ? -1 : undefined));
    source += optional ? '(?:/([^/]+))?' : '/([^/]+)';
  }
  if (!source) source = '/';
  return { names, re: new RegExp('^' + source + '/?$') };
}

function decodeSegment(value) { try { return decodeURIComponent(value || ''); } catch { return null; } }

// Matcher cache lives in router-private state, never on the published route
// objects: canonical registry entries are frozen, and a cached matcher must
// not survive a definition change as a split-brain contradiction.
const MATCHERS = new WeakMap();
function matcherFor(route) {
  let matcher = MATCHERS.get(route);
  if (!matcher) {
    matcher = compile(route.pattern);
    MATCHERS.set(route, matcher);
  }
  return matcher;
}
export function matchRoute(routes, rawPath) {
  const path = normalize(rawPath).split('?')[0];
  for (const route of routes) {
    const matcher = matcherFor(route);
    const hit = matcher.re.exec(path);
    if (!hit) continue;
    const params = {};
    let valid = true;
    matcher.names.forEach((name, index) => { const value = decodeSegment(hit[index + 1]); if (value == null) valid = false; else params[name] = value; });
    if (!valid) continue;
    return { route, params, path };
  }
  return null;
}

function queryOf(rawPath) { const i = String(rawPath || '').indexOf('?'); return new URLSearchParams(i >= 0 ? String(rawPath).slice(i + 1) : ''); }

function ownedState(state) {
  return !!state && state.hexUi === true && Number.isSafeInteger(state.depth) && state.depth >= 0;
}

/* `srcdoc` documents inherit the embedding document's base URL for resolving
   relative URLs even though their own location is `about:srcdoc`. WebKit
   therefore resolves `'# /code'`-style History API URLs against chatgpt.com and
   rejects the cross-origin replaceState/pushState. Always derive the history URL
   from the document's actual location instead of its inherited base URL. */
export function routeHistoryUrl(path, locationRef = globalThis.location) {
  const route = normalize(path);
  try {
    const href = String(locationRef?.href || '');
    if (href) return `${href.split('#')[0]}#${route}`;
  } catch {}
  return '#' + route;
}

export function createChildTaskScope(parentSignal) {
  let currentController = null;
  let removeParentAbort = null;
  const detachParent = () => { removeParentAbort?.(); removeParentAbort = null; };
  return {
    get signal() { return currentController?.signal ?? null; },
    spawn(reason = 'new-task-started') {
      currentController?.abort(reason);
      detachParent();
      const controller = currentController = new AbortController();
      if (parentSignal) {
        if (parentSignal.aborted) controller.abort(parentSignal.reason);
        else {
          const onParentAbort = () => controller.abort(parentSignal.reason);
          parentSignal.addEventListener('abort', onParentAbort, { once:true });
          removeParentAbort = () => parentSignal.removeEventListener('abort', onParentAbort);
        }
      }
      return controller.signal;
    },
    abort(reason = 'task-scope-aborted') {
      currentController?.abort(reason);
      currentController = null;
      detachParent();
    },
  };
}

const MAX_STACK_ENTRIES = 40;

export class ProductRouter {
  constructor(routes, { defaultPath = '/investigate', onRoute, onState, onError } = {}) {
    this.routes = routes; this.defaultPath = normalize(defaultPath); this.onRoute = onRoute || (() => null); this.onState = onState || (() => {}); this.onError = onError || (() => {});
    this.current = null; this.view = null; this.serial = 0; this.started = false; this.renderGeneration = 0; this.depth = 0; this.maxDepth = 0;
    this.routeController = null;
    this._stack = new Map();
    this._pendingPath = null;
    this.onPop = () => { const raw = history.state; const state = ownedState(raw) ? raw : null; if (state) { this.depth = state.depth; if (this.depth > this.maxDepth) this.maxDepth = this.depth; } this._render(this.locationPath(), { historyNavigation: true }); };
    this.onHash = () => { const path = this.locationPath(); if (this.current?.fullPath === path) return; this._render(path, { historyNavigation: true, hashNavigation: true }); };
  }

  locationPath() { const hash = window.location.hash.replace(/^#/, ''); return normalize(hash || this.defaultPath); }

  _setStackEntry(depth, path, label = null) {
    if (!Number.isSafeInteger(depth) || depth < 0) return;
    const cleanLabel = label == null ? null : (String(label).trim() || null);
    this._stack.set(depth, { path, label: cleanLabel });
    while (this._stack.size > MAX_STACK_ENTRIES) {
      let victim = null;
      let maxDist = -1;
      for (const k of this._stack.keys()) {
        if (k === depth) continue;
        const dist = Math.abs(k - depth);
        if (dist > maxDist || (dist === maxDist && (victim == null || k < victim))) {
          maxDist = dist;
          victim = k;
        }
      }
      if (victim == null) break;
      this._stack.delete(victim);
    }
  }

  setCurrentLabel(label) {
    const path = this._pendingPath || this.current?.fullPath || this.locationPath();
    this._setStackEntry(this.depth, path, label);
  }

  backLabel() {
    if (!this.canBack()) return null;
    const entry = this._stack.get(this.depth - 1);
    return entry ? (entry.label || entry.path) : null;
  }

  forwardLabel() {
    if (!this.canForward()) return null;
    const entry = this._stack.get(this.depth + 1);
    return entry ? (entry.label || entry.path) : null;
  }

  historyEntries() {
    const back = [];
    for (let d = this.depth - 1; d >= 0; d--) {
      const entry = this._stack.get(d);
      if (!entry) continue;
      back.push({ delta: d - this.depth, path: entry.path, label: entry.label || entry.path });
    }
    const forward = [];
    for (let d = this.depth + 1; d <= this.maxDepth; d++) {
      const entry = this._stack.get(d);
      if (!entry) continue;
      forward.push({ delta: d - this.depth, path: entry.path, label: entry.label || entry.path });
    }
    return { back, forward };
  }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('popstate', this.onPop);
    window.addEventListener('hashchange', this.onHash);
    const path = this.locationPath();
    const raw = history.state;
    const state = raw && ownedState(raw) ? raw : null;
    if (!state) { this.depth = 0; this.maxDepth = 0; history.replaceState({ hexUi: true, key: ++this.serial, depth: 0, viewState: null }, '', routeHistoryUrl(path, window.location)); }
    else { this.serial = Math.max(this.serial, Number(state.key) || 0); this.depth = state.depth; this.maxDepth = Math.max(this.maxDepth, state.depth); }
    this._render(path, { replace: true, historyNavigation: true });
  }

  stop() {
    if (!this.started) return;
    this.capture();
    window.removeEventListener('popstate', this.onPop); window.removeEventListener('hashchange', this.onHash);
    this.routeController?.abort('router-stopped');
    this.routeController = null;
    this.disposeView(); this.started = false; this.renderGeneration++;
  }

  capture() {
    if (!this.view || typeof this.view.getState !== 'function') return;
    const current = history.state && history.state.hexUi ? history.state : { hexUi: true, key: ++this.serial, depth: this.depth };
    let viewState;
    try { viewState = this.view.getState(); } catch (error) { this._handleError(error, { phase: 'capture', current: this.current }); return; }
    try { history.replaceState({ ...current, depth: this.depth, viewState }, '', window.location.href); } catch { /* Safari private mode */ }
  }

  navigate(rawPath, { replace = false, forcePush = false } = {}) {
    const requestedPath = normalize(rawPath);
    const path = matchRoute(this.routes, requestedPath) ? requestedPath : this.defaultPath;
    if (!forcePush && this.current && this.current.fullPath === path) return false;
    this.capture();
    const previousDepth = this.depth;
    const previousMaxDepth = this.maxDepth;
    const nextDepth = replace ? previousDepth : previousDepth + 1;
    const nextMaxDepth = replace ? Math.max(previousMaxDepth, nextDepth) : nextDepth;
    const prevStack = new Map(this._stack);

    // Build the destination before committing browser history. If the route
    // renderer throws, the current view, URL and history stack must remain one
    // coherent state instead of leaving a dead entry that only looks opened.
    const generationBefore = this.renderGeneration;
    this.depth = nextDepth;
    this.maxDepth = nextMaxDepth;
    const rendered = this._render(path, { replace, forcePush, restoredState: null });
    if (!rendered) {
      if (this.renderGeneration === generationBefore || this.renderGeneration === generationBefore + 1) {
        this.depth = previousDepth;
        this.maxDepth = previousMaxDepth;
        this._stack = prevStack;
      }
      return false;
    }
    if (this.renderGeneration !== generationBefore + 1 || this.current?.fullPath !== path) {
      return true;
    }

    const state = { hexUi: true, key: ++this.serial, depth: nextDepth, viewState: null };
    try { history[replace ? 'replaceState' : 'pushState'](state, '', routeHistoryUrl(path, window.location)); }
    catch { window.location.hash = path; }
    return true;
  }

  back() { if (!this.canBack()) return false; this.capture(); history.back(); return true; }
  forward() { if (!this.canForward()) return false; this.capture(); history.forward(); return true; }
  canBack() { return this.depth > 0; }
  canForward() { return this.depth < this.maxDepth; }

  disposeView(view = this.view) { if (view && typeof view.dispose === 'function') { try { view.dispose(); } catch (error) { this._handleError(error, { phase: 'dispose' }); } } if (view === this.view) this.view = null; }
  _handleError(error, meta = {}) { try { this.onError(error, meta); } catch { /* error boundary must not throw into navigation */ } }

  _render(rawPath, meta = {}) {
    const requestedPath = normalize(rawPath);
    let resolved = matchRoute(this.routes, requestedPath);
    let fullPath = requestedPath;
    if (!resolved) {
      resolved = matchRoute(this.routes, this.defaultPath);
      fullPath = this.defaultPath;
      if (!resolved) { const error = new Error('No route for ' + requestedPath); this._handleError(error, { phase: 'match', requestedPath }); throw error; }
      const state = history.state?.hexUi ? { ...history.state, depth: this.depth } : { hexUi: true, key: ++this.serial, depth: this.depth, viewState: null };
      try { history.replaceState(state, '', routeHistoryUrl(fullPath, window.location)); } catch { /* URL correction is best effort */ }
    }

    const nextCurrent = { ...resolved, fullPath, query: queryOf(fullPath) };
    const state = Object.hasOwn(meta, 'restoredState')
      ? meta.restoredState
      : (history.state && history.state.hexUi ? history.state.viewState : null);
    const previousView = this.view;
    const previousController = this.routeController;
    const controller = new AbortController();
    const routeGeneration = ++this.renderGeneration;
    let nextView;
    const prevPending = this._pendingPath;
    this._pendingPath = fullPath;
    try {
      nextView = this.onRoute(nextCurrent, {
        ...meta,
        restoredState: state,
        signal: controller.signal,
        routeGeneration,
      }) || null;
    }
    catch (error) {
      this._pendingPath = prevPending;
      controller.abort('route-render-failed');
      this._handleError(error, { phase: 'render', current: nextCurrent });
      return false;
    }
    this._pendingPath = prevPending;

    if (previousController && previousController !== controller) {
      previousController.abort('route-changed');
    }
    this.routeController = controller;
    this.current = nextCurrent;
    this.view = nextView;
    if (!meta.historyNavigation && !meta.replace) {
      for (const d of [...this._stack.keys()]) {
        if (d > this.depth) this._stack.delete(d);
      }
    }
    const existing = this._stack.get(this.depth);
    if (!existing || existing.path !== fullPath) {
      this._setStackEntry(this.depth, fullPath, null);
    }
    if (previousView && previousView !== nextView) this.disposeView(previousView);
    if (state && nextView && typeof nextView.restoreState === 'function') {
      requestAnimationFrame(() => {
        if (routeGeneration !== this.renderGeneration || this.view !== nextView) return;
        try { nextView.restoreState(state); } catch (error) { this._handleError(error, { phase: 'restore', current: nextCurrent }); }
      });
    }
    try {
      this.onState({
        current: this.current,
        canBack: this.canBack(),
        canForward: this.canForward(),
        backLabel: this.backLabel(),
        forwardLabel: this.forwardLabel(),
      });
    } catch (error) { this._handleError(error, { phase: 'state', current: this.current }); }
    return true;
  }
}