import { matchRoute, ProductRouter, routeHistoryUrl } from '../js/ui/router.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const routes = Object.freeze([
  Object.freeze({ id: 'investigate', pattern: '/investigate' }),
  Object.freeze({ id: 'code', pattern: '/code/:address?' }),
]);

const rawQueryPath = '/investigate?url=https://example.com/a//b&encoded=%2F%2F';
check('query slashes do not affect route matching', matchRoute(routes, rawQueryPath)?.route.id === 'investigate');
check('query-free route matching is unchanged', matchRoute(routes, '/investigate')?.route.id === 'investigate');
check('optional route parameter remains optional', matchRoute(routes, '/code')?.route.id === 'code');
check('optional route parameter still resolves when present', matchRoute(routes, '/code/4096')?.params.address === '4096');
check(
  'history URL preserves raw query spelling',
  routeHistoryUrl(rawQueryPath, { href: 'https://hex.test/app#old' }) ===
    'https://hex.test/app#/investigate?url=https://example.com/a//b&encoded=%2F%2F',
);

const previousWindow = globalThis.window;
const previousHistory = globalThis.history;
const writes = [];
try {
  globalThis.window = {
    location: { href: 'https://hex.test/app#/code', hash: '#/code' },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.history = {
    state: { hexUi: true, key: 1, depth: 0, viewState: null },
    pushState(state, _title, url) { this.state = state; writes.push({ kind: 'push', url }); },
    replaceState(state, _title, url) { this.state = state; writes.push({ kind: 'replace', url }); },
    back() {},
    forward() {},
  };

  const router = new ProductRouter(routes, { defaultPath: '/investigate' });
  const current = matchRoute(routes, '/code');
  router.current = { ...current, fullPath: '/code', query: new URLSearchParams() };
  router.depth = 0;

  const navigated = router.navigate('/investigate//?url=https://example.com/a//b&encoded=%2F%2F');
  check('navigate succeeds after pathname-only slash normalization', navigated === true);
  check(
    'pathname slashes normalize without touching query bytes',
    router.current?.fullPath === '/investigate/?url=https://example.com/a//b&encoded=%2F%2F',
    router.current?.fullPath,
  );
  check('current query preserves URL value', router.current?.query.get('url') === 'https://example.com/a//b');
  check('encoded query slashes are not reserialized', router.current?.fullPath.includes('encoded=%2F%2F'));
  check('encoded query value still decodes canonically', router.current?.query.get('encoded') === '//');
  check(
    'history receives the same preserved query',
    writes.at(-1)?.kind === 'push' &&
      writes.at(-1)?.url === 'https://hex.test/app#/investigate/?url=https://example.com/a//b&encoded=%2F%2F',
    writes.at(-1)?.url,
  );
} finally {
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  if (previousHistory === undefined) delete globalThis.history; else globalThis.history = previousHistory;
}

if (failures) process.exit(1);
console.log('Issue #5156 router query normalization regression checks passed');
