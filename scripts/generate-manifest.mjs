#!/usr/bin/env node
/**
 * Generate MANIFEST.json by parsing every authored JS/MJS module under js/ with acorn.
 * Ensures parseErrors === 0 and deterministic sorted output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const acorn = require('/usr/share/nodejs/acorn/dist/acorn.js');

const HOST_LAYER_GROUPS = new Set(['ui', 'ai', 'auth', 'userscript']);
const WASM_ARTIFACTS = new Set([
  'js/bytesource/string-scan-wasm.js',
  'js/controlflow-wasm.js',
  'js/core/identity/fnv64-wasm.js',
  'js/platform/byte-search-wasm.js',
  'js/symbolic/solver/sat-wasm.js',
]);
const PARTIAL_WASM = new Set([
  'js/binary/strings.js',
  'js/bytesource/strings.js',
  'js/controlflow.js',
  'js/core/identity/fnv64.js',
  'js/platform/byte-search.js',
  'js/platform/worker.js',
  'js/symbolic/solver/bitblast-backend.js',
]);

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (/\.(m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveRelDep(fromRel, spec) {
  if (!spec || !spec.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  return resolved;
}

function collectPatternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ObjectPattern':
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, out);
        else collectPatternNames(prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) collectPatternNames(el, out);
      break;
    case 'AssignmentPattern':
      collectPatternNames(node.left, out);
      break;
    case 'RestElement':
      collectPatternNames(node.argument, out);
      break;
    default:
      break;
  }
}

function analyzeFile(absPath) {
  const rel = path.relative(root, absPath).replace(/\\/g, '/');
  const src = fs.readFileSync(absPath, 'utf8');
  const lines = src.length === 0 ? 0 : src.split('\n').length;
  const parts = rel.split('/');
  const group = parts.length <= 2 ? 'root' : parts[1];

  let ast = null;
  let sourceType = 'module';
  let parseError = null;
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
  } catch (errMod) {
    try {
      sourceType = 'script';
      ast = acorn.parse(src, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowHashBang: true,
        allowReturnOutsideFunction: true,
      });
    } catch (errScript) {
      parseError = { path: rel, message: errScript.message || errMod.message };
    }
  }

  const deps = new Set();
  const functions = [];
  const classes = [];
  const constants = [];
  const exportsList = [];
  const globals = [];

  if (ast) {
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        const dep = resolveRelDep(rel, node.source?.value);
        if (dep) deps.add(dep);
      } else if (node.type === 'FunctionDeclaration' && node.id?.name) {
        functions.push(node.id.name);
      } else if (node.type === 'ClassDeclaration' && node.id?.name) {
        classes.push(node.id.name);
      } else if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations) {
          const names = [];
          collectPatternNames(decl.id, names);
          for (const n of names) {
            if (decl.init && (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression')) {
              functions.push(n);
            } else if (node.kind === 'const') {
              constants.push(n);
            } else {
              globals.push(n);
            }
          }
        }
      } else if (node.type === 'ExportNamedDeclaration') {
        if (node.source) {
          const dep = resolveRelDep(rel, node.source.value);
          if (dep) deps.add(dep);
        }
        if (node.declaration) {
          const d = node.declaration;
          if (d.type === 'FunctionDeclaration' && d.id?.name) {
            functions.push(d.id.name);
            exportsList.push(d.id.name);
          } else if (d.type === 'ClassDeclaration' && d.id?.name) {
            classes.push(d.id.name);
            exportsList.push(d.id.name);
          } else if (d.type === 'VariableDeclaration') {
            for (const decl of d.declarations) {
              const names = [];
              collectPatternNames(decl.id, names);
              for (const n of names) {
                if (decl.init && (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression')) {
                  functions.push(n);
                } else if (d.kind === 'const') {
                  constants.push(n);
                } else {
                  globals.push(n);
                }
                exportsList.push(n);
              }
            }
          }
        }
        for (const spec of node.specifiers || []) {
          exportsList.push(spec.exported?.name || spec.local?.name);
        }
      } else if (node.type === 'ExportDefaultDeclaration') {
        exportsList.push('default');
        const d = node.declaration;
        if (d?.type === 'FunctionDeclaration' && d.id?.name) functions.push(d.id.name);
        if (d?.type === 'ClassDeclaration' && d.id?.name) classes.push(d.id.name);
      } else if (node.type === 'ExportAllDeclaration') {
        const dep = resolveRelDep(rel, node.source?.value);
        if (dep) deps.add(dep);
        exportsList.push(`* from ${dep || node.source?.value}`);
      }
    }
  }

  let migrationStatus = 'pending';
  let testStatus = 'untested';
  if (HOST_LAYER_GROUPS.has(group)) {
    migrationStatus = 'needs-review-host-layer';
  } else if (WASM_ARTIFACTS.has(rel)) {
    migrationStatus = 'wasm-artifact';
    testStatus = 'parity-passed';
  } else if (PARTIAL_WASM.has(rel)) {
    migrationStatus = 'partial-wasm';
    testStatus = 'parity-passed';
  }

  return {
    parseError,
    entry: {
      path: rel,
      group,
      sourceType,
      lines,
      dependencies: [...deps].sort(),
      functions,
      classes,
      constants,
      exports: exportsList,
      globals,
      migrationStatus,
      testStatus,
    },
  };
}

const files = walkJs(path.join(root, 'js')).sort();
const parseErrors = [];
const modules = [];
const byGroup = {};
let totalLines = 0;
let totalFunctions = 0;
let totalClasses = 0;
let totalConstants = 0;
let totalExports = 0;
let totalGlobals = 0;

for (let i = 0; i < files.length; i += 1) {
  const { parseError, entry } = analyzeFile(files[i]);
  if (parseError) parseErrors.push(parseError);
  const id = `M${String(i + 1).padStart(4, '0')}`;
  modules.push({ id, ...entry });
  totalLines += entry.lines;
  totalFunctions += entry.functions.length;
  totalClasses += entry.classes.length;
  totalConstants += entry.constants.length;
  totalExports += entry.exports.length;
  totalGlobals += entry.globals.length;
  if (!byGroup[entry.group]) {
    byGroup[entry.group] = { files: 0, lines: 0, functions: 0, classes: 0 };
  }
  byGroup[entry.group].files += 1;
  byGroup[entry.group].lines += entry.lines;
  byGroup[entry.group].functions += entry.functions.length;
  byGroup[entry.group].classes += entry.classes.length;
}

let baseCommit = 'unknown';
try {
  baseCommit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
} catch {
  // ignore
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseCommit,
  summary: {
    totalFiles: modules.length,
    totalLines,
    totalFunctions,
    totalClasses,
    totalConstants,
    totalExports,
    totalGlobals,
    parseErrors: parseErrors.length,
    byGroup,
  },
  parseErrors,
  modules,
};

fs.writeFileSync(path.join(root, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `MANIFEST.json generated: files=${modules.length} lines=${totalLines} funcs=${totalFunctions} ` +
  `classes=${totalClasses} parseErrors=${parseErrors.length}`,
);
if (parseErrors.length > 0) {
  console.error('Parse errors detected:', parseErrors);
  process.exit(1);
}
