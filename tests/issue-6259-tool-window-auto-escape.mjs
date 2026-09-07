import assert from 'node:assert/strict';
import { selectToolWindow } from '../js/ai/control/tool-window.js';

const functionTools = [
  { name: 'get_cfg' },
  { name: 'future_probe' },
  { name: 'future_probe_two' },
  { name: 'future_probe_three' },
];
const registry = {
  definitionsForModel({ scope } = {}) {
    if (scope === 'auto') return [...functionTools, { name: 'search_functions' }];
    return functionTools.slice();
  },
};
const names = (window) => window.tools.map((tool) => tool.name);

const narrow = selectToolWindow(registry, {
  requestedScope: 'auto', effectiveScope: 'function', maxTools: 1,
  observations: [{ tool: 'get_cfg' }],
});
assert.deepEqual(names(narrow), ['search_functions'], 'auto must retain its sole liveness escape at maxTools=1');

const continuity = selectToolWindow(registry, {
  requestedScope: 'auto', effectiveScope: 'function', maxTools: 2,
  observations: [{ tool: 'get_cfg' }],
});
assert.deepEqual(names(continuity).slice(0, 2), ['search_functions', 'get_cfg'], 'auto escape and previous tool coexist when capacity permits');

const alreadyEscape = selectToolWindow(registry, {
  requestedScope: 'auto', effectiveScope: 'function', maxTools: 1,
  observations: [{ tool: 'search_functions' }],
});
assert.deepEqual(names(alreadyEscape), ['search_functions'], 'previous escape must not be duplicated');

const explicit = selectToolWindow(registry, {
  requestedScope: 'function', effectiveScope: 'function', maxTools: 1,
  observations: [{ tool: 'get_cfg' }],
});
assert.deepEqual(names(explicit), ['get_cfg'], 'explicit scopes do not receive the auto escape reservation');

const invalidPrevious = selectToolWindow(registry, {
  requestedScope: 'auto', effectiveScope: 'function', maxTools: 1,
  observations: [{ tool: 'removed_tool' }],
});
assert.equal(names(invalidPrevious).includes('removed_tool'), false, 'invalid previous tools stay out of the window');

const rotating = selectToolWindow(registry, {
  requestedScope: 'auto', effectiveScope: 'function', maxTools: 4,
  observations: [{ tool: 'get_cfg' }, { tool: 'future_probe' }],
});
assert.equal(names(rotating).includes('search_functions'), true, 'novel-tool rotation must not evict the auto escape');

console.log('issue-6259-tool-window-auto-escape: PASS');
