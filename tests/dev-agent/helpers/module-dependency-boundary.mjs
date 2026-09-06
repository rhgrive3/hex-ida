import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const STATIC_MODULE_PARSE = String.raw`
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(0, 'utf8');
const module = new vm.SourceTextModule(source);
process.stdout.write(JSON.stringify(module.dependencySpecifiers));
`;

function staticModuleSpecifiers(source) {
  const output = execFileSync(process.execPath, [
    '--no-warnings',
    '--experimental-vm-modules',
    '--input-type=module',
    '--eval',
    STATIC_MODULE_PARSE,
  ], {
    input:String(source),
    encoding:'utf8',
    maxBuffer:1024 * 1024,
  });
  const specifiers = JSON.parse(output);
  if (!Array.isArray(specifiers) || specifiers.some((value) => typeof value !== 'string')) {
    throw new TypeError('module-dependency-parser-invalid-result');
  }
  return specifiers;
}

function hasDynamicImport(source) {
  const text = String(source);
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"') {
      index = skipQuoted(text, index, char);
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      index = skipLineComment(text, index + 2);
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index = skipBlockComment(text, index + 2);
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = index++;
      while (index < text.length && isIdentifierPart(text[index])) index++;
      if (text.slice(start, index) !== 'import') continue;
      const next = skipTrivia(text, index);
      if (text[next] === '(') return true;
      continue;
    }
    index++;
  }
  return false;
}

function skipTrivia(text, start) {
  let index = start;
  while (index < text.length) {
    if (/\s/u.test(text[index])) { index++; continue; }
    if (text[index] === '/' && text[index + 1] === '/') {
      index = skipLineComment(text, index + 2);
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      index = skipBlockComment(text, index + 2);
      continue;
    }
    break;
  }
  return index;
}

function skipQuoted(text, start, quote) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') { index += 2; continue; }
    if (text[index] === quote) return index + 1;
    index++;
  }
  return text.length;
}

function skipLineComment(text, start) {
  const newline = text.indexOf('\n', start);
  return newline === -1 ? text.length : newline + 1;
}

function skipBlockComment(text, start) {
  const close = text.indexOf('*/', start);
  return close === -1 ? text.length : close + 2;
}

function isIdentifierStart(char) { return /[A-Za-z_$]/u.test(char || ''); }
function isIdentifierPart(char) { return /[A-Za-z0-9_$]/u.test(char || ''); }

export function assertModuleDependencyBoundary(source, allowedSpecifiers) {
  const actual = staticModuleSpecifiers(source);
  assert.deepEqual(actual, allowedSpecifiers,
    'module static dependencies must exactly match the allowlist');
  assert.equal(hasDynamicImport(source), false,
    'dynamic import expressions are forbidden at this dependency boundary');
  return actual;
}

export const __moduleDependencyBoundaryForTests = Object.freeze({
  staticModuleSpecifiers,
  hasDynamicImport,
});
