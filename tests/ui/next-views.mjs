/*
 * The one vocabulary every analysis result uses to offer another view of the
 * same routine: which views exist, where each one goes, what happens when a
 * view cannot be built, and that the destinations are real routes.
 */
import { matchRoute } from '../../js/ui/router.js';
import { ROUTES, FUNCTION_TABS } from '../../js/ui/registry.js';
import { FUNCTION_VIEWS, functionViews, openFunctionView, viewLabel } from '../../js/ui/next-views.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const ADDRESS = 0x100000000n;

/* ── the vocabulary ─────────────────────────────────────────── */

check('pseudo-C and the flow diagram are offered, not only the assembly',
  ['pseudocode', 'flow', 'calls', 'assembly', 'report', 'evidence'].every((id) => FUNCTION_VIEWS.some((v) => v.id === id)),
  FUNCTION_VIEWS.map((v) => v.id).join(','));
check('every view is labelled and explained in both languages',
  FUNCTION_VIEWS.every((v) => v.ja && v.en && v.hintJa && v.hintEn));
check('labels resolve by id and language', viewLabel('pseudocode', true) === '疑似Cで読む' && viewLabel('pseudocode', false) === 'Read as pseudo-C');
check('an unknown view has no label', viewLabel('nope') === '');

check('the canonical view list and every definition entry are frozen',
  Object.isFrozen(FUNCTION_VIEWS) && FUNCTION_VIEWS.every((item) => Object.isFrozen(item)));

const isolatedViews = await import(`../../js/ui/next-views.js?immutability=${Date.now()}`);
const isolatedReport = isolatedViews.FUNCTION_VIEWS.find((item) => item.id === 'report');
const isolatedPseudo = isolatedViews.FUNCTION_VIEWS.find((item) => item.id === 'pseudocode');
const rejectsAssignment = (object, key, value) => {
  try { object[key] = value; return false; } catch { return true; }
};
const routeMutationRejected = rejectsAssignment(isolatedReport, 'route', '/corrupted/:address');
const metadataMutationRejected = [
  ['needsDisassembly', false],
  ['legacy', 'code'],
  ['ja', '改変済み'],
].every(([key, value]) => rejectsAssignment(isolatedPseudo, key, value));
const isolatedReportView = isolatedViews.functionViews({ address: 123n, include: ['report'] })[0];
const isolatedPseudoView = isolatedViews.functionViews({
  address: 123n,
  capability: { canDisassemble: false },
  include: ['pseudocode'],
})[0];
check('canonical view mutation is rejected without poisoning route or metadata',
  routeMutationRejected && metadataMutationRejected
  && isolatedReportView.route === '/function/123/overview'
  && isolatedPseudoView.legacy === 'decompiler'
  && isolatedPseudoView.label === '疑似Cで読む'
  && isolatedPseudoView.available === false);

/* ── destinations are canonical routes ──────────────────────── */

const views = functionViews({ address: ADDRESS });
for (const view of views) {
  const hit = matchRoute(ROUTES, view.route);
  const ok = hit && (hit.route.id === 'function' || hit.route.id === 'code')
    && hit.params.address === ADDRESS.toString();
  check(`the ${view.id} view points at a real route`, !!ok, view.route);
}
check('workspace views use tabs the workspace actually has',
  views.filter((v) => v.route.startsWith('/function/'))
    .every((v) => FUNCTION_TABS.some((tab) => v.route.endsWith('/' + tab.id))));

/* ── composition ────────────────────────────────────────────── */

check('the surface you are already on is not offered again',
  !functionViews({ address: ADDRESS, exclude: ['report'] }).some((v) => v.id === 'report'));
check('include fixes both the set and the order',
  functionViews({ address: ADDRESS, include: ['flow', 'pseudocode'] }).map((v) => v.id).join(',') === 'flow,pseudocode');
check('exactly one view is the primary one',
  functionViews({ address: ADDRESS, primary: 'pseudocode' }).filter((v) => v.primary).length === 1);
check('English labels are used when the UI is in English',
  functionViews({ address: ADDRESS, ja: false })[0].label === 'Function overview');

/* ── honesty when a view cannot be built ────────────────────── */

const noCpu = functionViews({ address: ADDRESS, capability: { canDisassemble: false } });
const pseudo = noCpu.find((v) => v.id === 'pseudocode');
const calls = noCpu.find((v) => v.id === 'calls');
check('a CPU without a decompiler disables pseudo-C and says why',
  pseudo && !pseudo.available && /疑似C/.test(pseudo.reason), pseudo && pseudo.reason);
check('the views that do not need disassembly stay available', !!calls && calls.available);
check('a result with no address disables every view',
  functionViews({ address: null }).every((v) => !v.available && v.reason));

/* ── dispatch ───────────────────────────────────────────────── */

const routerCalls = [];
const router = { navigate: (path) => { routerCalls.push(path); return true; } };
check('a view opens through the product router',
  openFunctionView(views.find((v) => v.id === 'flow'), { router }) === true
  && routerCalls[0] === '/function/' + ADDRESS.toString() + '/flow', routerCalls.join(','));

const OVERRIDE_ADDRESS = ADDRESS + 0x20n;
for (const view of views) {
  const calls = [];
  const overrideRouter = { navigate: (path) => { calls.push(path); return true; } };
  const opened = openFunctionView(view, { router: overrideRouter, address: OVERRIDE_ADDRESS });
  const hit = calls.length === 1 ? matchRoute(ROUTES, calls[0]) : null;
  check(`the ${view.id} router destination honors an address override`,
    opened === true && !!hit && hit.params.address === OVERRIDE_ADDRESS.toString(),
    calls.join(','));
}
const invalidOverrideCalls = [];
check('an invalid address override fails before router navigation',
  openFunctionView(views.find((v) => v.id === 'report'), {
    router: { navigate: (path) => { invalidOverrideCalls.push(path); return true; } },
    address: 'not-an-address',
  }) === false && invalidOverrideCalls.length === 0);

const overrideFlowRoute = '/function/' + OVERRIDE_ADDRESS.toString() + '/flow';
check('already-open success compares against the overridden canonical route',
  openFunctionView(views.find((v) => v.id === 'flow'), {
    router: { current: { fullPath: overrideFlowRoute }, navigate: () => false },
    address: OVERRIDE_ADDRESS,
  }) === true);

const failedRouter = { current: { fullPath: '/code' }, navigate: () => false };
check('a failed router render is reported instead of pretending the view opened',
  openFunctionView(views.find((v) => v.id === 'flow'), { router: failedRouter }) === false);
const sameRoute = views.find((v) => v.id === 'flow').route;
check('an already-open canonical route is still a successful destination',
  openFunctionView(views.find((v) => v.id === 'flow'), { router: { current: { fullPath: sameRoute }, navigate: () => false } }) === true);
check('a throwing router is contained and reported as a failed destination',
  openFunctionView(views.find((v) => v.id === 'flow'), { router: { navigate: () => { throw new Error('render failed'); } } }) === false);

const legacyCalls = [];
const legacy = {
  report: (a) => legacyCalls.push('report:' + a),
  decompiler: (a) => legacyCalls.push('decompiler:' + a),
  cfg: (a) => legacyCalls.push('cfg:' + a),
  callGraph: (a) => legacyCalls.push('callGraph:' + a),
  code: (a) => legacyCalls.push('code:' + a),
};
check('with no router the same view opens the legacy sheet',
  openFunctionView(views.find((v) => v.id === 'pseudocode'), { router: null, legacy }) === true
  && legacyCalls[0] === 'decompiler:' + ADDRESS.toString(), legacyCalls.join(','));
check('the legacy fallback honors the same address override',
  openFunctionView(views.find((v) => v.id === 'pseudocode'), {
    router: null,
    legacy,
    address: OVERRIDE_ADDRESS,
  }) === true
  && legacyCalls[1] === 'decompiler:' + OVERRIDE_ADDRESS.toString(), legacyCalls.join(','));
check('a view with no legacy fallback reports failure instead of doing nothing',
  openFunctionView(views.find((v) => v.id === 'evidence'), { router: null, legacy }) === false);
check('an unavailable view never navigates',
  openFunctionView(pseudo, { router }) === false && routerCalls.length === 1, routerCalls.join(','));

if (failures) process.exit(1);
console.log('Next-view wiring checks passed');
