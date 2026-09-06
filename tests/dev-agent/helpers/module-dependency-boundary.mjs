import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const MODULE_DEPENDENCY_PARSE = String.raw`
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { parse } = require('internal/deps/acorn/acorn/dist/acorn');
const source = readFileSync(0, 'utf8');
const module = new vm.SourceTextModule(source);
const ast = parse(source, { ecmaVersion:'latest', sourceType:'module', allowHashBang:true });
let dynamicImport = false;
const stack = [ast];
while (stack.length) {
  const node = stack.pop();
  if (!node || typeof node !== 'object') continue;
  if (node.type === 'ImportExpression') dynamicImport = true;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) stack.push(...value);
    else if (value && typeof value === 'object') stack.push(value);
  }
}
process.stdout.write(JSON.stringify({
  staticSpecifiers: module.dependencySpecifiers,
  hasDynamicImport: dynamicImport,
}));
`;

const cache = new Map();
function parseModuleDependencies(source) {
  const text = String(source);
  const cached = cache.get(text);
  if (cached) return cached;
  const output = execFileSync(process.execPath, [
    '--no-warnings',
    '--experimental-vm-modules',
    '--expose-internals',
    '--input-type=module',
    '--eval',
    MODULE_DEPENDENCY_PARSE,
  ], {
    input:text,
    encoding:'utf8',
    maxBuffer:1024 * 1024,
  });
  const result = JSON.parse(output);
  if (!result || !Array.isArray(result.staticSpecifiers)
      || result.staticSpecifiers.some((value) => typeof value !== 'string')
      || typeof result.hasDynamicImport !== 'boolean') {
    throw new TypeError('module-dependency-parser-invalid-result');
  }
  cache.set(text, result);
  return result;
}

function staticModuleSpecifiers(source) {
  return parseModuleDependencies(source).staticSpecifiers;
}

function hasDynamicImport(source) {
  return parseModuleDependencies(source).hasDynamicImport;
}

export function assertModuleDependencyBoundary(source, allowedSpecifiers) {
  const actual = parseModuleDependencies(source);
  assert.deepEqual(actual.staticSpecifiers, allowedSpecifiers,
    'module static dependencies must exactly match the allowlist');
  assert.equal(actual.hasDynamicImport, false,
    'dynamic import expressions are forbidden at this dependency boundary');
  return actual.staticSpecifiers;
}

export const __moduleDependencyBoundaryForTests = Object.freeze({
  staticModuleSpecifiers,
  hasDynamicImport,
});
