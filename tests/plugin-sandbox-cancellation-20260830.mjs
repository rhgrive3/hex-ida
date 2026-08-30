import assert from 'node:assert/strict';
import fs from 'node:fs';

const plugins = fs.readFileSync(new URL('../js/plugins.js', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../js/tools-base.js', import.meta.url), 'utf8');
const sandbox = fs.readFileSync(new URL('../js/sandbox.js', import.meta.url), 'utf8');

assert.match(plugins, /async run\(id, out, options = \{\}\)/);
assert.match(plugins, /createApi\(this\.app, out, options\)/);
assert.match(plugins, /mode: 'plugin'[\s\S]*signal \}/);
assert.match(tools, /new Sheet\('プラグイン', \{[\s\S]*plugin-sheet-closed/);
assert.match(tools, /plugin-run-replaced/);
assert.match(tools, /app\.plugins\.run\(p\.id, write, \{ signal:controller\.signal \}\)/);
assert.match(tools, /controller\.signal\.aborted \|\| !sheet\.root\.isConnected/);
assert.match(sandbox, /export function runInSandbox\(\{[\s\S]*signal/);
assert.match(sandbox, /function onAbort\(\)[\s\S]*aborted: true/);
assert.match(sandbox, /signal\.addEventListener\('abort', onAbort, \{ once: true \}\)/);
assert.match(sandbox, /signal\.removeEventListener\('abort', onAbort\)/);

console.log('plugin sandbox cancellation wiring: PASS');
