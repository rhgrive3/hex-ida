/*
 * Exact active-provider proof for the non-host native A7 target profiles.
 * Tracked assembly sources are compiled twice, independently inspected by
 * LLVM, then executed under the matching QEMU user target and controlled by
 * LLDB's gdb-remote provider. No host-architecture label is reused as proof.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRuntimeAuthorityBinding, createRuntimeObservation, validateRuntimeObservation } from '../../../js/runtime/authority.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const A7_CROSS_TARGET_PROOF_SCHEMA = 'hex-stage2-a7-cross-target-provider-proof/v1';
export const A7_CROSS_TARGET_PROVIDER_PROFILE = 'native:remote-debug-v1:qemu-lldb';
export const A7_REQUIRED_CAPABILITIES = Object.freeze([
  'attach', 'breakpointAddress', 'cancel', 'connect', 'disconnect', 'modules', 'pause',
  'readMemory', 'readRegisters', 'removeBreakpoint', 'resume', 'stepInto', 'threads', 'writeMemory',
]);
export const A7_CROSS_TARGETS = Object.freeze([
  Object.freeze({
    targetProfileId:'arm64:a64', sourcePath:'tests/stage2/fixtures/a7-runtime/aarch64-a64.S',
    targetTriple:'aarch64-linux-gnu', qemu:'qemu-aarch64', qemuCpuArgs:Object.freeze(['-cpu','max']),
    lldbArchitecture:'aarch64', register:'x0', breakOffset:4, llvmMachine:'EM_AARCH64',
  }),
  Object.freeze({
    targetProfileId:'arm64e:a64+pac', sourcePath:'tests/stage2/fixtures/a7-runtime/aarch64-pac.S',
    targetTriple:'aarch64-linux-gnu', qemu:'qemu-aarch64', qemuCpuArgs:Object.freeze(['-cpu','max']),
    lldbArchitecture:'aarch64', register:'x0', breakOffset:8, llvmMachine:'EM_AARCH64', pac:true,
  }),
  Object.freeze({
    targetProfileId:'riscv64:rv64imc', sourcePath:'tests/stage2/fixtures/a7-runtime/riscv64-rv64imc.S',
    targetTriple:'riscv64-linux-gnu', qemu:'qemu-riscv64', qemuCpuArgs:Object.freeze([]),
    lldbArchitecture:'riscv64', register:'a0', breakOffset:2, llvmMachine:'EM_RISCV', rv64imc:true,
  }),
]);

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function commandVersion(command) {
  const result = spawnSync(command, ['--version'], { cwd:ROOT, encoding:'utf8', timeout:10_000, maxBuffer:2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`a7-cross-provider-unavailable:${command}`);
  const line = `${result.stdout || ''}\n${result.stderr || ''}`.split('\n').find((value) => value.trim())?.trim();
  if (!line) throw new Error(`a7-cross-provider-version-missing:${command}`);
  return line;
}
function git(args) {
  const result = spawnSync('git', args, { cwd:ROOT, encoding:'utf8', maxBuffer:8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}
function run(command, args, code, options = {}) {
  const result = spawnSync(command, args, { cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024, env:{ ...process.env, DEBUGINFOD_URLS:'' }, ...options });
  if (result.status !== 0 || result.signal) throw new Error(`${code}:${result.signal || result.status}:${String(result.stderr || '').trim()}`);
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}
function symbolValue(readobj, name) {
  const blocks = String(readobj).match(/Symbol \{[\s\S]*?\n  \}/g) || [];
  const block = blocks.find((value) => new RegExp(`\\bName: ${name}(?: \\(|\\n)`).test(value));
  const value = block && /\bValue: (0x[0-9A-Fa-f]+)/.exec(block)?.[1];
  if (!value) throw new Error(`a7-cross-oracle-symbol-missing:${name}`);
  return BigInt(value);
}
function executable(command) {
  for (const prefix of ['/usr/bin/', '/usr/local/bin/']) {
    for (const name of [command, `${command}-18`]) {
      const candidate = `${prefix}${name}`;
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return command;
}
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!Number.isInteger(port)) throw new Error('a7-cross-port-reservation-failed');
  return port;
}

export function parseCrossTargetLldbOutput(output, target, { binaryPath, entry, probeWord } = {}) {
  const text = String(output || '');
  const escaped = String(binaryPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`Current executable set to '${escaped}' \\(${target.lldbArchitecture}\\)\\.`).test(text)) throw new Error('a7-cross-lldb-target-profile-mismatch');
  const processId = /Process (\d+) stopped/.exec(text)?.[1];
  if (!processId || !/stop reason = signal SIGTRAP/.test(text)) throw new Error('a7-cross-lldb-active-process-missing');
  if (!text.split('\n').some((line) => line.includes(binaryPath) && /\[\s*0\]/.test(line))) throw new Error('a7-cross-lldb-module-missing');
  if (!/\* thread #1: tid = /.test(text)) throw new Error('a7-cross-lldb-thread-missing');
  if (!new RegExp(`pc = 0x0*${entry.toString(16)}`, 'i').test(text) || !/\bsp = 0x[0-9a-f]+/i.test(text)) throw new Error('a7-cross-lldb-register-read-missing');
  if (!new RegExp(`${target.register} = 0x0*42\\b`, 'i').test(text)) throw new Error('a7-cross-lldb-register-write-missing');
  if (!new RegExp(`0x0*${probeWord.toString(16)}: 0x1020304050607080`, 'i').test(text)) throw new Error('a7-cross-lldb-memory-read-missing');
  if (!new RegExp(`0x0*${probeWord.toString(16)}: 0x8877665544332211`, 'i').test(text)) throw new Error('a7-cross-lldb-memory-write-missing');
  if (!/Breakpoint 1:/.test(text) || !/stop reason = breakpoint 1\.1/.test(text)) throw new Error('a7-cross-lldb-breakpoint-missing');
  if (!/stop reason = instruction step into/.test(text)) throw new Error('a7-cross-lldb-step-missing');
  if (!/1 breakpoints deleted; 0 breakpoint locations disabled\./.test(text)) throw new Error('a7-cross-lldb-breakpoint-removal-missing');
  if (!new RegExp(`Process ${processId} exited`).test(text)) throw new Error('a7-cross-lldb-disconnect-missing');
  return Object.freeze({ processId:Number(processId), outputSha256:sha256(Buffer.from(text)) });
}

function compileAndInspect(target, directory, versions) {
  const sourceAbsolute = path.join(ROOT, target.sourcePath);
  if (!fs.existsSync(sourceAbsolute)) throw new Error(`a7-cross-fixture-source-missing:${target.targetProfileId}`);
  const outputA = path.join(directory, `${target.targetProfileId.replaceAll(/[^a-z0-9]+/gi, '-')}-a.elf`);
  const outputB = path.join(directory, `${target.targetProfileId.replaceAll(/[^a-z0-9]+/gi, '-')}-b.elf`);
  const targetArgs = target.rv64imc ? ['--target=riscv64-linux-gnu','-march=rv64imc','-mabi=lp64'] : ['--target=aarch64-linux-gnu'];
  const buildArgs = [...targetArgs, '-fuse-ld=lld', '-nostdlib', '-static', '-Wl,-e,_start', target.sourcePath];
  run(versions.clang, [...buildArgs, '-o', outputA], 'a7-cross-fixture-build-failed');
  run(versions.clang, [...buildArgs, '-o', outputB], 'a7-cross-fixture-rebuild-failed');
  const bytes = fs.readFileSync(outputA);
  if (!bytes.equals(fs.readFileSync(outputB))) throw new Error(`a7-cross-fixture-nondeterministic:${target.targetProfileId}`);
  const readobj = run(versions.readobj, ['--file-headers','--symbols',outputA], 'a7-cross-llvm-readobj-failed');
  if (!readobj.includes(`Machine: ${target.llvmMachine}`)) throw new Error(`a7-cross-llvm-machine-mismatch:${target.targetProfileId}`);
  if (target.rv64imc && !/Flags \[[\s\S]*\bEF_RISCV_RVC\b/.test(readobj)) throw new Error('a7-cross-rv64imc-rvc-flag-missing');
  const disassembly = run(versions.objdump, ['-d',outputA], 'a7-cross-llvm-objdump-failed');
  if (target.pac && (!/\bpaciasp\b/.test(disassembly) || !/\bautiasp\b/.test(disassembly))) throw new Error('a7-cross-pac-oracle-missing');
  const entryMatch = /\bEntry: (0x[0-9A-Fa-f]+)/.exec(readobj)?.[1];
  if (!entryMatch) throw new Error('a7-cross-oracle-entry-missing');
  return Object.freeze({
    path:outputA, bytes, binarySha256:sha256(bytes), sourceSha256:sha256(fs.readFileSync(sourceAbsolute)),
    entry:BigInt(entryMatch), probeWord:symbolValue(readobj, 'probe_word'),
    oracleOutputSha256:sha256(Buffer.from(`${readobj}\n${disassembly}`)),
  });
}

async function runActiveTarget(target, fixture, versions) {
  const port = await reservePort();
  const qemu = spawn(versions[target.qemu], [...target.qemuCpuArgs, '-g', String(port), fixture.path], { cwd:ROOT, stdio:['ignore','pipe','pipe'] });
  let qemuError = '';
  qemu.stderr.on('data', (chunk) => { qemuError += String(chunk); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (qemu.exitCode != null) throw new Error(`a7-cross-qemu-start-failed:${target.targetProfileId}:${qemuError.trim()}`);
  const breakpoint = fixture.entry + BigInt(target.breakOffset);
  const args = [
    '-b','-Q',
    '-o','settings set symbols.enable-external-lookup false',
    '-o',`target create ${fixture.path}`,
    '-o',`gdb-remote 127.0.0.1:${port}`,
    '-o','process status',
    '-o','target modules list',
    '-o','thread list',
    '-o',`register read pc sp ${target.register}`,
    '-o',`memory read -fx -s8 -c1 0x${fixture.probeWord.toString(16)}`,
    '-o',`register write ${target.register} 0x42`,
    '-o',`register read ${target.register}`,
    '-o',`memory write -s8 0x${fixture.probeWord.toString(16)} 0x8877665544332211`,
    '-o',`memory read -fx -s8 -c1 0x${fixture.probeWord.toString(16)}`,
    '-o',`breakpoint set -a 0x${breakpoint.toString(16)}`,
    '-o','continue',
    '-o','thread step-inst',
    '-o','breakpoint delete 1',
    '-o','process kill',
  ];
  try {
    const result = spawnSync(versions.lldb, args, { cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status !== 0 || result.signal) throw new Error(`a7-cross-lldb-command-failed:${target.targetProfileId}:${result.signal || result.status}`);
    return Object.freeze({ ...parseCrossTargetLldbOutput(output, target, { binaryPath:fixture.path, entry:fixture.entry, probeWord:fixture.probeWord }), qemuPid:qemu.pid });
  } finally {
    if (qemu.exitCode == null) qemu.kill('SIGKILL');
  }
}

export async function collectA7CrossTargetProofs({ requireClean = true } = {}) {
  if (requireClean && git(['status','--porcelain','--untracked-files=all'])) throw new Error('a7-cross-proof-worktree-dirty');
  const commitSha = git(['rev-parse','HEAD']);
  const treeSha = git(['rev-parse','HEAD^{tree}']);
  const versions = Object.freeze({
    clang:executable('clang'), lldb:executable('lldb'), readobj:executable('llvm-readobj-18'), objdump:executable('llvm-objdump-18'),
    'qemu-aarch64':executable('qemu-aarch64'), 'qemu-riscv64':executable('qemu-riscv64'),
  });
  const versionIdentities = Object.freeze(Object.fromEntries(Object.entries(versions).map(([id, command]) => [id, commandVersion(command)])));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-a7-cross-'));
  const proofs = [];
  try {
    for (const target of A7_CROSS_TARGETS) {
      const fixture = compileAndInspect(target, directory, versions);
      const observed = await runActiveTarget(target, fixture, versions);
      const binaryIdentity = `sha256:${fixture.binarySha256}`;
      const providerVersion = `${versionIdentities.lldb};${versionIdentities[target.qemu]}`;
      const binding = createRuntimeAuthorityBinding({
        providerIdentity:`lldb-gdb-remote+${target.qemu}:${sha256(Buffer.from(providerVersion))}`,
        providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE,
        providerVersion,
        runtimeInstanceIdentity:`qemu-user-process:${observed.qemuPid}`,
        targetIdentity:`qemu-user-target:${target.targetProfileId}:${binaryIdentity}`,
        targetProfileId:target.targetProfileId,
        binaryIdentity,
        buildIdentity:`clang-lld-static:${fixture.sourceSha256}:${binaryIdentity}`,
        moduleIdentity:`lldb-module:${target.targetProfileId}:${binaryIdentity}`,
        loadMappingIdentity:`lldb-load:${target.targetProfileId}:${binaryIdentity}:0x${fixture.entry.toString(16)}`,
        sessionIdentity:`lldb-gdb-remote:${target.targetProfileId}:${observed.processId}:${commitSha}`,
        capabilityVersion:'debug/v1', commitSha, treeSha, epoch:0,
      });
      const observation = createRuntimeObservation({
        binding, sequence:1, observedAt:new Date().toISOString(), kind:'active-cross-target-debug-session',
        payload:{ targetProfileId:target.targetProfileId, providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, outputSha256:observed.outputSha256, closedCapabilities:A7_REQUIRED_CAPABILITIES },
      });
      const validation = validateRuntimeObservation(binding, observation);
      if (!validation.ok) throw new Error(`a7-cross-runtime-observation-invalid:${target.targetProfileId}:${validation.reason}`);
      proofs.push(Object.freeze({
        schemaVersion:A7_CROSS_TARGET_PROOF_SCHEMA, status:'exact-active-provider-observed',
        candidateCommitSha:commitSha, candidateTreeSha:treeSha, targetProfileId:target.targetProfileId,
        providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, providerVersion,
        fixture:Object.freeze({ sourcePath:target.sourcePath, sourceSha256:fixture.sourceSha256, binarySha256:fixture.binarySha256, targetTriple:target.targetTriple }),
        independentOracle:Object.freeze({ id:'llvm-readobj+llvm-objdump-18', outputSha256:fixture.oracleOutputSha256 }),
        binding, observation, closedCapabilities:A7_REQUIRED_CAPABILITIES,
      }));
    }
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
  return Object.freeze({
    schemaVersion:A7_CROSS_TARGET_PROOF_SCHEMA, candidateCommitSha:commitSha, candidateTreeSha:treeSha,
    providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, versionIdentities, proofs:Object.freeze(proofs),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const proof = await collectA7CrossTargetProofs();
    process.stdout.write(`A7_CROSS_TARGET_PROVIDER_PROOF=${JSON.stringify(proof)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
