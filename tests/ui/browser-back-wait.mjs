export const FUNCTION_ROUTE_WAIT_TIMEOUT_MS = 2000;
export const FUNCTION_ROUTE_WAIT_POLL_MS = 20;

export function functionRouteReady(state, expectedPath) {
  return state?.locationPath === expectedPath
    && state?.routerPath === expectedPath
    && state?.routeHostVisible === true
    && state?.functionScreenCount === 1;
}

function timeoutError(expectedPath, lastState) {
  const error = new Error(`Timed out waiting for function route ${expectedPath}`);
  error.code = 'FUNCTION_ROUTE_WAIT_TIMEOUT';
  error.expectedPath = expectedPath;
  error.lastState = lastState;
  return error;
}

export async function waitForFunctionRoute(readState, expectedPath, {
  timeoutMs = FUNCTION_ROUTE_WAIT_TIMEOUT_MS,
  pollMs = FUNCTION_ROUTE_WAIT_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof readState !== 'function') throw new TypeError('readState must be a function');
  if (typeof expectedPath !== 'string' || !expectedPath.startsWith('/')) throw new TypeError('expectedPath must be an absolute route');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive and finite');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new RangeError('pollMs must be positive and finite');

  const deadline = now() + timeoutMs;
  let lastState = null;
  while (true) {
    const remainingBeforeRead = deadline - now();
    if (remainingBeforeRead <= 0) throw timeoutError(expectedPath, lastState);
    let timeoutId;
    try {
      lastState = await Promise.race([
        Promise.resolve().then(readState),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(timeoutError(expectedPath, lastState)), remainingBeforeRead);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
    if (functionRouteReady(lastState, expectedPath)) return lastState;
    const remaining = deadline - now();
    if (remaining <= 0) throw timeoutError(expectedPath, lastState);
    await sleep(Math.min(pollMs, remaining));
  }
}
