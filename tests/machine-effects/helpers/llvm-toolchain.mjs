import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LLVM18_VERSION = '18.1.3';

const TOOL_NAMES = Object.freeze({
  clang: Object.freeze(['clang-18', 'clang']),
  lld: Object.freeze(['ld.lld-18', 'ld.lld']),
  'lld-link': Object.freeze(['lld-link-18', 'lld-link']),
  'llvm-mc': Object.freeze(['llvm-mc-18', 'llvm-mc']),
  'llvm-objcopy': Object.freeze(['llvm-objcopy-18', 'llvm-objcopy']),
  'llvm-objdump': Object.freeze(['llvm-objdump-18', 'llvm-objdump']),
  'llvm-readobj': Object.freeze(['llvm-readobj-18', 'llvm-readobj']),
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function candidatePaths(name, env) {
  if (name.includes(path.sep)) return [name];
  const directories = unique([
    env.HEX_P56_TOOLCHAIN_BIN,
    ...(String(env.PATH || '').split(path.delimiter)),
    '/usr/bin',
    '/usr/local/bin',
  ]);
  return directories.map((directory) => path.join(directory, name));
}

function defaultCandidates(tool, env) {
  const names = TOOL_NAMES[tool];
  if (!names) throw new TypeError(`unknown LLVM 18 tool: ${tool}`);
  return unique(names.flatMap((name) => candidatePaths(name, env)));
}

function isExecutable(candidate) {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function probeVersion(candidate) {
  try {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      output: `${result.stdout || ''}\n${result.stderr || ''}`.replace(/\s+/g, ' ').trim(),
    };
  } catch (error) {
    return { status: null, signal: null, error, output: '' };
  }
}

function matchesVersion(output, expectedVersion) {
  const escaped = String(expectedVersion).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^0-9])${escaped}(?:$|[^0-9])`).test(output);
}

/**
 * Resolve a real LLVM 18.1.3 executable from the configured toolchain.
 *
 * PATH is searched before fixed system directories so a supplied frozen
 * toolchain wrapper wins over an older system installation. Every candidate
 * is version-probed; a present but older executable is never accepted.
 */
export function resolveLlvmTool18(tool, {
  env = process.env,
  candidates = null,
  expectedVersion = LLVM18_VERSION,
  isExecutable: executable = isExecutable,
  probe = probeVersion,
} = {}) {
  const requested = candidates == null ? defaultCandidates(tool, env) : unique(candidates);
  const attempts = [];
  for (const candidate of requested) {
    if (!executable(candidate)) continue;
    const result = probe(candidate);
    const output = String(result?.output || '').replace(/\s+/g, ' ').trim();
    const status = result?.status == null ? 'spawn-error' : String(result.status);
    attempts.push(`${candidate} [status=${status}${output ? `, version=${output.slice(0, 160)}` : ''}]`);
    if (result?.status === 0 && matchesVersion(output, expectedVersion)) return candidate;
  }
  const detail = attempts.length ? ` Attempts: ${attempts.join('; ')}` : '';
  throw new Error(`LLVM ${tool} ${expectedVersion} executable is required; no exact version found.${detail}`);
}
