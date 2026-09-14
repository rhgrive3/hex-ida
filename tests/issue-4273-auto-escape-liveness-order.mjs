// Regression for #4273: at maxTools=1 an auto-scope escape tool is a control
// plane liveness guarantee and must be reserved before previous-tool
// continuity, so `search_functions` can never be squeezed out of the window.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectToolWindow } from '../js/ai/control/tool-window.js';

const functionTools = [{ name: 'get_function' }, { name: 'get_cfg' }];
const registry = {
  definitionsForModel({ scope } = {}) {
    if (scope === 'auto') return [...functionTools, { name: 'search_functions' }];
    return functionTools.slice();
  },
};
const names = (window) => window.tools.map((tool) => tool.name);

test('#4273 auto escape survives previous-tool continuity at maxTools=1', () => {
  const window = selectToolWindow(registry, {
    requestedScope: 'auto', effectiveScope: 'function',
    observations: [{ tool: 'get_function' }], maxTools: 1,
  });
  assert.deepEqual(names(window), ['search_functions']);
});

test('#4273 maxTools>=2 keeps both continuity and escape', () => {
  const window = selectToolWindow(registry, {
    requestedScope: 'auto', effectiveScope: 'function',
    observations: [{ tool: 'get_function' }], maxTools: 2,
  });
  assert.deepEqual(names(window).slice(0, 2), ['search_functions', 'get_function']);
});

test('#4273 non-auto scopes never receive the forced escape', () => {
  const window = selectToolWindow(registry, {
    requestedScope: 'function', effectiveScope: 'function',
    observations: [{ tool: 'get_function' }], maxTools: 1,
  });
  assert.deepEqual(names(window), ['get_function']);
});

test('#4273 an unavailable escape tool is never fabricated', () => {
  const narrow = {
    definitionsForModel() { return functionTools.slice(); },
  };
  const window = selectToolWindow(narrow, {
    requestedScope: 'auto', effectiveScope: 'function',
    observations: [{ tool: 'get_function' }], maxTools: 1,
  });
  assert.equal(names(window).includes('search_functions'), false);
});
