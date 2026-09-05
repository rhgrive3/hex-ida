import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '../../..');
const CORE_OPTIMIZATIONS = Object.freeze(['-O0', '-O1', '-O2', '-O3', '-Os', '-Oz']);
const EXTENDED_OPTIMIZATIONS = Object.freeze(['-O2', '-O3', '-Os', '-Oz']);

function summaryLine(stdout, prefix) {
  const line = (typeof stdout === 'string' ? stdout : '').split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${prefix} `));
  if (!line) return null;
  try { return JSON.parse(line.slice(prefix.length + 1)); } catch { return null; }
}

function fixtureFunctions(root, file) {
  let source;
  try { source = fs.readFileSync(path.join(root, 'tests/compiler-truth/sources', file), 'utf8'); } catch { return new Set(); }
  return new Set([...source.matchAll(/__attribute__\(\(noinline\)\)\s+(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)\s*\(/g)]
    .map((match) => match[1]));
}

function acceptedLanguageRow(language, root, functionName) {
  if (language?.status !== 'ok' || language.executed !== CORE_OPTIMIZATIONS.length
      || language.semanticChecks !== CORE_OPTIMIZATIONS.length * 9
      || !Array.isArray(language.rows) || language.rows.length !== CORE_OPTIMIZATIONS.length
      || !language.rows.every((row, index) => row.optimization === CORE_OPTIMIZATIONS[index]
        && row.checked === 9 && row.semantic === true && row.rawAssemblyFallbacks === 0)
      || typeof language.fixture !== 'string') return false;
  let source;
  try { source = fs.readFileSync(path.join(root, 'tests/compiler-truth/sources', language.fixture), 'utf8'); } catch { return false; }
  return source.includes(functionName);
}

function acceptedCore(core, expectedFunctions) {
  if (!core || core.clangAvailable !== true
      || core.executed !== CORE_OPTIMIZATIONS.length * expectedFunctions.size
      || core.expectedCases !== core.executed || core.hardFailures !== 0
      || !Array.isArray(core.results) || core.results.length !== CORE_OPTIMIZATIONS.length) return false;
  for (let index = 0; index < core.results.length; index++) {
    const row = core.results[index];
    if (row.optimization !== CORE_OPTIMIZATIONS[index] || !Array.isArray(row.functions)
        || row.functions.length !== expectedFunctions.size) return false;
    const names = new Set();
    for (const item of row.functions) {
      names.add(item.function);
      if (!expectedFunctions.has(item.function) || item.semanticTruth?.equivalent !== true
          || !(item.semanticTruth?.checked > 0) || item.asmFallbacks !== 0) return false;
    }
    if (names.size !== expectedFunctions.size) return false;
  }
  return true;
}

function acceptedExtended(extended, expectedFunctions) {
  if (!extended || extended.clangAvailable !== true
      || extended.executed !== EXTENDED_OPTIMIZATIONS.length * expectedFunctions.size
      || !Array.isArray(extended.results) || extended.results.length !== EXTENDED_OPTIMIZATIONS.length) return false;
  for (let index = 0; index < extended.results.length; index++) {
    const row = extended.results[index];
    if (row.optimization !== EXTENDED_OPTIMIZATIONS[index] || !Array.isArray(row.functions)
        || row.functions.length !== expectedFunctions.size) return false;
    const names = new Set();
    for (const item of row.functions) {
      names.add(item.function);
      if (!expectedFunctions.has(item.function) || item.semanticTruth?.equivalent !== true
          || !(item.semanticTruth?.checked > 0) || item.rawAssemblyFallbacks !== 0) return false;
    }
    if (names.size !== expectedFunctions.size) return false;
  }
  return true;
}

export function compilerTruthAccepted(summaries, { repositoryRoot = REPOSITORY_ROOT } = {}) {
  const coreFunctions = fixtureFunctions(repositoryRoot, 'scalars.c');
  const extendedFunctions = fixtureFunctions(repositoryRoot, 'extended.c');
  return acceptedCore(summaries?.core, coreFunctions)
    && acceptedExtended(summaries?.extended, extendedFunctions)
    && acceptedLanguageRow(summaries?.languages?.cpp, repositoryRoot, 'cpp_clamp_i32')
    && acceptedLanguageRow(summaries?.languages?.objc, repositoryRoot, 'objc_clamp_i32');
}

export function compilerTruthGateResult({ repositoryRoot = REPOSITORY_ROOT, env = process.env, spawn = spawnSync } = {}) {
  const command = [process.execPath, 'tests/compiler-truth/run.mjs'];
  let child;
  try {
    child = spawn(command[0], command.slice(1), {
      cwd:repositoryRoot,
      encoding:'utf8',
      maxBuffer:16 * 1024 * 1024,
      env,
    });
  } catch (error) {
    return {
      accepted:false,
      command,
      status:null,
      error:error?.message || String(error),
      stdout:'',
      stderr:'',
      summaries:{ core:null, extended:null, languages:null },
    };
  }
  const stdout = typeof child.stdout === 'string' ? child.stdout : '';
  const stderr = typeof child.stderr === 'string' ? child.stderr : '';
  const summaries = {
    core:summaryLine(stdout, 'COMPILER_TRUTH'),
    extended:summaryLine(stdout, 'COMPILER_TRUTH_EXTENDED'),
    languages:summaryLine(stdout, 'COMPILER_TRUTH_LANGUAGES'),
  };
  return {
    accepted:child.status === 0 && compilerTruthAccepted(summaries, { repositoryRoot }),
    command,
    status:child.status,
    error:child.error?.message || null,
    stdout,
    stderr,
    summaries,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = compilerTruthGateResult();
  process.stdout.write(`T011_COMPILER_TRUTH_GATE ${JSON.stringify({
    accepted:result.accepted,
    command:result.command,
    status:result.status,
    summaries:result.summaries,
    error:result.error,
  })}\n`);
  if (!result.accepted) process.exitCode = 1;
}
