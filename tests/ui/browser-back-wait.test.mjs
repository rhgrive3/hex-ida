import assert from 'node:assert/strict';
import test from 'node:test';

import {
  functionRouteReady,
  waitForFunctionRoute,
} from './browser-back-wait.mjs';

const EXPECTED_PATH = '/function/4294968384/overview';

function routeState({
  locationPath = EXPECTED_PATH,
  routerPath = EXPECTED_PATH,
  routeHostVisible = true,
  functionScreenCount = 1,
} = {}) {
  return { locationPath, routerPath, routeHostVisible, functionScreenCount };
}

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
  };
}

test('#7331 old immediate screen-count check fails before delayed navigation', () => {
  const pending = routeState({
    locationPath: '/explorer/functions',
    routerPath: '/explorer/functions',
    routeHostVisible: true,
    functionScreenCount: 0,
  });

  assert.equal(pending.functionScreenCount === 1, false);
  assert.equal(functionRouteReady(pending, EXPECTED_PATH), false);
});

test('#7331 delayed correct route eventually satisfies the bounded semantic wait', async () => {
  const clock = fakeClock();
  const pending = routeState({
    locationPath: '/explorer/functions',
    routerPath: '/explorer/functions',
    functionScreenCount: 0,
  });
  const restored = routeState();
  let current = pending;

  const result = await waitForFunctionRoute(
    () => {
      if (clock.now() >= 40) current = restored;
      return current;
    },
    EXPECTED_PATH,
    { timeoutMs: 100, pollMs: 10, now: clock.now, sleep: clock.sleep },
  );

  assert.deepEqual(result, restored);
  assert.equal(clock.now() >= 40, true);
});

test('#7331 wrong route fails closed instead of accepting a function DOM', async () => {
  const clock = fakeClock();
  const wrongRoute = routeState({
    locationPath: '/function/4294968385/overview',
    routerPath: '/function/4294968385/overview',
  });

  await assert.rejects(
    waitForFunctionRoute(
      () => wrongRoute,
      EXPECTED_PATH,
      { timeoutMs: 30, pollMs: 10, now: clock.now, sleep: clock.sleep },
    ),
    (error) => error?.code === 'FUNCTION_ROUTE_WAIT_TIMEOUT'
      && error.expectedPath === EXPECTED_PATH
      && error.lastState === wrongRoute,
  );
});

test('#7331 no transition fails closed when the old route remains mounted', async () => {
  const clock = fakeClock();
  const unchanged = routeState({
    locationPath: '/explorer/functions',
    routerPath: '/explorer/functions',
    functionScreenCount: 0,
  });

  await assert.rejects(
    waitForFunctionRoute(
      () => unchanged,
      EXPECTED_PATH,
      { timeoutMs: 30, pollMs: 10, now: clock.now, sleep: clock.sleep },
    ),
    (error) => error?.code === 'FUNCTION_ROUTE_WAIT_TIMEOUT'
      && error.lastState === unchanged,
  );
});

test('#7331 a state read that outlives the deadline cannot pass late', async () => {
  await assert.rejects(
    waitForFunctionRoute(
      () => new Promise((resolve) => setTimeout(() => resolve(routeState()), 30)),
      EXPECTED_PATH,
      { timeoutMs: 5, pollMs: 1 },
    ),
    (error) => error?.code === 'FUNCTION_ROUTE_WAIT_TIMEOUT'
      && error.expectedPath === EXPECTED_PATH,
  );
});
