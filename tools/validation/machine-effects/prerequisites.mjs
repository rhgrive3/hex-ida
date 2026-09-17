import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const MACHINE_EFFECTS_BASELINE = Object.freeze({
  commit: '3f3778e5f2bef638456da19609d616d71a3daedc',
  blobs: Object.freeze([
    Object.freeze({ path: 'js/targets/architecture/arm64e/effects.js', sha: '56a7b2bb6fa34d2d4206f5b463770e6f2726efbc' }),
    Object.freeze({ path: 'tools/validation/phase6/profile.json', sha: '7f8e893d4645a20a7be309f071d1b3a18653b5d1' }),
  ]),
});

const TOOL_SPECS = Object.freeze([
  Object.freeze({ id: 'llvm-mc', env: 'LLVM_MC', candidates: ['/usr/bin/llvm-mc-18', 'llvm-mc-18'] }),
  Object.freeze({ id: 'clang', env: 'CLANG', candidates: ['/usr/bin/clang-18', 'clang-18'] }),
  Object.freeze({ id: 'llvm-objdump', env: 'LLVM_OBJDUMP', candidates: ['/usr/bin/llvm-objdump-18', 'llvm-objdump-18'] }),
  Object.freeze({ id: 'llvm-objcopy', env: 'LLVM_OBJCOPY', candidates: ['/usr/bin/llvm-objcopy-18', 'llvm-objcopy-18'] }),
]);

function execute(command, args, cwd = ROOT, input = undefined) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    timeout: 10000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function outputOf(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

function firstLine(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function major18(text) {
  return /(?:LLVM|clang) version 18(?:\.|\b)|Debian clang version 18(?:\.|\b)/i.test(text);
}

function resolveTool(spec, env, runner) {
  const candidates = [env[spec.env], ...spec.candidates].filter(Boolean);
  const attempts = [];
  for (const candidate of candidates) {
    const result = runner(candidate, ['--version'], ROOT);
    const text = outputOf(result);
    attempts.push(`${candidate}:${result.status ?? result.error?.code ?? 'spawn-error'}`);
    if (result.status !== 0 || !major18(text)) continue;
    return Object.freeze({ id: spec.id, path: candidate, version: firstLine(text), aarch64Target: null });
  }
  throw new Error(`missing ${spec.id} LLVM 18; tried ${attempts.join(', ') || '(none)'}. Install clang-18 and llvm-18, or set ${spec.env} to the LLVM 18 executable.`);
}

function auditNativeOracle(tools, { cwd = ROOT, runner = execute } = {}) {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const llvmMc = byId.get('llvm-mc');
  const clang = byId.get('clang');
  const objdump = byId.get('llvm-objdump');
  const objcopy = byId.get('llvm-objcopy');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-machine-effects-prereq-'));
  const source = '.text\n.globl hex_machine_effects_prereq\nhex_machine_effects_prereq:\n  nop\n';
  const mcObject = path.join(directory, 'llvm-mc-aarch64.o');
  const clangObject = path.join(directory, 'clang-aarch64.o');
  const rawBinary = path.join(directory, 'clang-aarch64.bin');
  try {
    const mc = runner(llvmMc.path, ['-triple=aarch64', '-filetype=obj', '-o', mcObject], cwd, source);
    if (mc.status !== 0) {
      throw new Error(`llvm-mc-18 cannot assemble AArch64: ${firstLine(outputOf(mc)) || `exit ${mc.status ?? mc.error?.code ?? 'spawn-error'}`}`);
    }
    const cc = runner(clang.path, ['--target=aarch64-linux-gnu', '-c', '-x', 'assembler', '-o', clangObject, '-'], cwd, source);
    if (cc.status !== 0) {
      throw new Error(`clang-18 integrated assembler cannot assemble AArch64: ${firstLine(outputOf(cc)) || `exit ${cc.status ?? cc.error?.code ?? 'spawn-error'}`}`);
    }
    const disassembly = runner(objdump.path, ['-d', mcObject], cwd);
    if (disassembly.status !== 0) {
      throw new Error(`llvm-objdump-18 cannot inspect the AArch64 probe object: ${firstLine(outputOf(disassembly)) || `exit ${disassembly.status ?? disassembly.error?.code ?? 'spawn-error'}`}`);
    }
    const extraction = runner(objcopy.path, ['-O', 'binary', clangObject, rawBinary], cwd);
    if (extraction.status !== 0) {
      throw new Error(`llvm-objcopy-18 cannot extract the AArch64 probe object: ${firstLine(outputOf(extraction)) || `exit ${extraction.status ?? extraction.error?.code ?? 'spawn-error'}`}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return Object.freeze(tools.map((tool) => Object.freeze({
    ...tool,
    aarch64Target: tool.id === 'llvm-mc' || tool.id === 'clang' ? true : null,
  })));
}

export function auditMachineEffectsHistory({ cwd = ROOT, runner = execute } = {}) {
  const commit = MACHINE_EFFECTS_BASELINE.commit;
  const commitCheck = runner('git', ['cat-file', '-e', `${commit}^{commit}`], cwd);
  if (commitCheck.status !== 0) {
    throw new Error(`missing historical commit ${commit}. This is a real Git object prerequisite; use a full checkout (actions/checkout fetch-depth: 0) or run \`git fetch --no-tags origin ${commit}\` / \`git fetch --unshallow\` before MachineEffects validation.`);
  }

  const blobs = [];
  for (const expected of MACHINE_EFFECTS_BASELINE.blobs) {
    const resolved = runner('git', ['rev-parse', `${commit}:${expected.path}`], cwd);
    const actual = String(resolved.stdout || '').trim();
    if (resolved.status !== 0 || actual !== expected.sha) {
      throw new Error(`historical blob unresolved or changed: ${commit}:${expected.path}; expected ${expected.sha}, got ${actual || '(unresolved)'}. Fetch the real ${commit} history; do not substitute or fabricate the baseline.`);
    }
    const blobCheck = runner('git', ['cat-file', '-e', `${expected.sha}^{blob}`], cwd);
    if (blobCheck.status !== 0) {
      throw new Error(`historical blob object missing: ${expected.sha} (${expected.path}). Fetch the real ${commit} history before validation.`);
    }
    blobs.push(Object.freeze({ path: expected.path, sha: expected.sha }));
  }
  return Object.freeze({ commit, blobs: Object.freeze(blobs) });
}

export function auditMachineEffectsPrerequisites({ cwd = ROOT, env = process.env, runner = execute } = {}) {
  const resolvedTools = TOOL_SPECS.map((spec) => resolveTool(spec, env, runner));
  const tools = auditNativeOracle(resolvedTools, { cwd, runner });
  const history = auditMachineEffectsHistory({ cwd, runner });
  return Object.freeze({
    schemaVersion: 'machine-effects-prerequisites/v1',
    ok: true,
    tools,
    history,
  });
}

export function assertMachineEffectsPrerequisites(options) {
  try {
    return auditMachineEffectsPrerequisites(options);
  } catch (error) {
    throw new Error(`machine-effects-prerequisite-failure: ${error?.message || String(error)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(assertMachineEffectsPrerequisites(), null, 2)}\n`);
}
