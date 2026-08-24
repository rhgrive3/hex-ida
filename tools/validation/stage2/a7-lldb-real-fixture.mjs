/*
 * Bounded exact-run probe for the native A7 provider.  This is intentionally
 * an x86_64-only observation: one active LLDB session cannot prove the four
 * architecture profiles in the Stage 2 denominator.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntimeAuthorityBinding, createRuntimeObservation, validateRuntimeObservation } from '../../../js/runtime/authority.js';
import {
  A7_OBSERVED_CAPABILITIES,
  A7_PROFILE_BINDINGS,
  A7_UNSUPPORTED_CAPABILITIES,
  validateA7FixtureSource,
} from './a7-profile-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const A7_LLDB_PROOF_SCHEMA = 'hex-stage2-a7-lldb-provider-proof/v1';
export const A7_LLDB_FIXTURE_PATH = 'tests/stage2/fixtures/a7-runtime/x86_64-long64.S';
export const A7_X86_REQUIRED_CAPABILITIES = A7_OBSERVED_CAPABILITIES;
export const A7_X86_UNSUPPORTED_CAPABILITIES = A7_UNSUPPORTED_CAPABILITIES;
const TARGET_PROFILE = 'x86_64:long-64';
const PROVIDER_PROFILE = 'native:lldb-compatible-v1:host';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function run(command, args, code) {
  const result = spawnSync(command, args, { cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024, env:{ ...process.env, DEBUGINFOD_URLS:'' } });
  if (result.status !== 0 || result.signal) throw new Error(`${code}:${result.signal || result.status}:${String(result.stderr || '').trim()}`);
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function symbolValue(readobj, name) {
  const blocks = String(readobj).match(/Symbol \{[\s\S]*?\n  \}/g) || [];
  const block = blocks.find((value) => new RegExp(`\\bName: ${name}(?: \\(|\\n)`).test(value));
  const value = block && /\bValue: (0x[0-9A-Fa-f]+)/.exec(block)?.[1];
  if (!value) throw new Error(`a7-lldb-oracle-symbol-missing:${name}`);
  return BigInt(value);
}

function executableIdentity(command, acceptedBasenames) {
  let resolved;
  try { resolved = fs.realpathSync(command); } catch { throw new Error(`a7-lldb-executable-missing:${command}`); }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || !acceptedBasenames.includes(path.basename(resolved))) throw new Error(`a7-lldb-executable-untrusted:${command}`);
  return Object.freeze({ path:resolved, sha256:sha256(fs.readFileSync(resolved)) });
}

function fixture(directory, { clang = 'clang', readobj = 'llvm-readobj-18' } = {}) {
  const source = path.join(ROOT, A7_LLDB_FIXTURE_PATH);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('a7-lldb-real-fixture-missing');
  const sourceBytes = fs.readFileSync(source);
  const sourceDigest = sha256(sourceBytes);
  if (!validateA7FixtureSource(TARGET_PROFILE, A7_LLDB_FIXTURE_PATH, sourceDigest, sourceBytes.toString('utf8'))) throw new Error('a7-lldb-fixture-source-contract-mismatch');
  const outputA = path.join(directory, 'x86_64-long64-a.elf');
  const outputB = path.join(directory, 'x86_64-long64-b.elf');
  const args = ['--target=x86_64-linux-gnu','-fuse-ld=lld','-nostdlib','-static','-Wl,-e,_start',A7_LLDB_FIXTURE_PATH];
  run(clang, [...args,'-o',outputA], 'a7-lldb-fixture-build-failed');
  run(clang, [...args,'-o',outputB], 'a7-lldb-fixture-rebuild-failed');
  const bytes = fs.readFileSync(outputA);
  if (!bytes.equals(fs.readFileSync(outputB))) throw new Error('a7-lldb-fixture-nondeterministic');
  const oracle = run(readobj, ['--file-headers','--symbols',outputA], 'a7-lldb-independent-oracle-failed');
  if (!oracle.includes('Machine: EM_X86_64')) throw new Error('a7-lldb-target-profile-mismatch');
  const entryText = /\bEntry: (0x[0-9A-Fa-f]+)/.exec(oracle)?.[1];
  if (!entryText) throw new Error('a7-lldb-oracle-entry-missing');
  return { absolute:outputA, digest:sha256(bytes), sourceDigest, sourceSemantics:[...A7_PROFILE_BINDINGS[TARGET_PROFILE].semanticMarkers], entry:BigInt(entryText), probeWord:symbolValue(oracle,'probe_word'), oracleDigest:sha256(Buffer.from(oracle)) };
}

function lldbCommand(pathname, entry, probeWord) {
  return [
    '-b', '-Q',
    '-o', 'settings set symbols.enable-external-lookup false',
    '-o', `target create ${pathname}`,
    '-o', 'target modules list',
    '-o', 'process launch --stop-at-entry',
    '-o', 'process status',
    '-o', 'target modules list',
    '-o', 'thread list',
    '-o', 'register read rip rsp rax',
    '-o', `memory read -fx -s8 -c1 0x${probeWord.toString(16)}`,
    '-o', 'register write rax 0x42',
    '-o', 'register read rax',
    '-o', `memory write -s8 0x${probeWord.toString(16)} 0x8877665544332211`,
    '-o', `memory read -fx -s8 -c1 0x${probeWord.toString(16)}`,
    '-o', `breakpoint set -a 0x${(entry + 1n).toString(16)}`,
    '-o', 'continue',
    '-o', 'thread step-inst',
    '-o', 'breakpoint delete 1',
    '-o', 'process kill',
  ];
}

export function parseLldbOutput(output, { fixturePath = A7_LLDB_FIXTURE_PATH, entry = null, probeWord = null } = {}) {
  const text = String(output || '');
  const target = new RegExp(`Current executable set to '.*${fixturePath.replaceAll('/', '[\\\\/]')}' \\(x86_64\\)\\.`).test(text);
  if (!target) throw new Error('a7-lldb-target-profile-mismatch');
  const process = /Process (\d+) launched: .* \(x86-64\)/.exec(text) || /Process (\d+) launched: .* \(x86_64\)/.exec(text);
  if (!process) throw new Error('a7-lldb-process-launch-missing');
  if (!new RegExp(`Process ${process[1]} stopped`).test(text)) throw new Error('a7-lldb-stop-observation-missing');
  const modulePath = text.split('\n').find((line) => line.includes(fixturePath) && /\[\s*0\]/.test(line))?.trim();
  if (!modulePath) throw new Error('a7-lldb-module-observation-missing');
  const thread = /\* thread #1: tid = (\d+)/.exec(text);
  const rip = /rip = (0x[0-9a-f]+)/i.exec(text)?.[1];
  const rsp = /rsp = (0x[0-9a-f]+)/i.exec(text)?.[1];
  if (!thread || !rip || !rsp) throw new Error('a7-lldb-register-observation-missing');
  if (entry != null && BigInt(rip) !== BigInt(entry)) throw new Error('a7-lldb-entry-register-mismatch');
  if (!/rax = 0x0*42\b/i.test(text)) throw new Error('a7-lldb-register-write-missing');
  if (entry != null && (!new RegExp(`Breakpoint 1:.*0x0*${(entry + 1n).toString(16)}`, 'i').test(text)
    || !/stop reason = breakpoint 1\.1/.test(text) || !/stop reason = instruction step into/.test(text))) throw new Error('a7-lldb-breakpoint-step-missing');
  if (probeWord != null && (!new RegExp(`0x0*${probeWord.toString(16)}: 0x1020304050607080`, 'i').test(text)
    || !new RegExp(`0x0*${probeWord.toString(16)}: 0x8877665544332211`, 'i').test(text))) throw new Error('a7-lldb-memory-read-write-missing');
  if (!/1 breakpoints deleted; 0 breakpoint locations disabled\./.test(text)) throw new Error('a7-lldb-breakpoint-removal-missing');
  if (!/exited with status = 9 .* killed/.test(text)) throw new Error('a7-lldb-session-cleanup-missing');
  return Object.freeze({ pid: Number(process[1]), threadId: Number(thread[1]), modulePath, rip, rsp, targetProfileId: TARGET_PROFILE, capabilityResults:Object.freeze(Object.fromEntries(A7_X86_REQUIRED_CAPABILITIES.map((capability) => [capability, true]))) });
}

export function collectA7X86LldbProof({
  lldb = process.env.LLDB || (fs.existsSync('/usr/bin/lldb') ? '/usr/bin/lldb' : '/usr/bin/lldb-18'),
  clang = fs.existsSync('/usr/bin/clang') ? '/usr/bin/clang' : '/usr/bin/clang-18',
  readobj = fs.existsSync('/usr/bin/llvm-readobj-18') ? '/usr/bin/llvm-readobj-18' : 'llvm-readobj',
} = {}) {
  const clean = git(['status', '--porcelain', '--untracked-files=all']);
  if (clean) throw new Error('a7-lldb-proof-worktree-dirty');
  const currentCommitSha = git(['rev-parse', 'HEAD']);
  const currentTreeSha = git(['rev-parse', 'HEAD^{tree}']);
  const versionResult = spawnSync(lldb, ['--version'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
  if (versionResult.status !== 0) throw new Error('a7-lldb-provider-unavailable');
  const version = /lldb version (\d+\.\d+\.\d+)/.exec(`${versionResult.stdout}\n${versionResult.stderr}`)?.[1];
  if (!version) throw new Error('a7-lldb-provider-version-missing');
  const compilerVersion = run(clang, ['--version'], 'a7-lldb-compiler-unavailable').split('\n').find(Boolean)?.trim();
  const executableIdentities = Object.freeze({
    lldb: executableIdentity(lldb, ['lldb', 'lldb-18']),
    clang: executableIdentity(clang, ['clang', 'clang-18']),
    readobj: executableIdentity(readobj, ['llvm-readobj-18', 'llvm-readobj']),
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-a7-x86-'));
  let checkedFixture;
  let observed;
  try {
    checkedFixture = fixture(directory, { clang, readobj });
    const result = spawnSync(lldb, lldbCommand(checkedFixture.absolute, checkedFixture.entry, checkedFixture.probeWord), { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status !== 0 || result.signal) throw new Error(`a7-lldb-provider-command-failed:${result.signal || result.status}`);
    observed = parseLldbOutput(output, { fixturePath:checkedFixture.absolute, entry:checkedFixture.entry, probeWord:checkedFixture.probeWord });
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
  const bindingContract = A7_PROFILE_BINDINGS[TARGET_PROFILE];
  if (!bindingContract || bindingContract.sourcePath !== A7_LLDB_FIXTURE_PATH || bindingContract.providerProfileId !== PROVIDER_PROFILE || bindingContract.providerProofCommandId !== 'a7-lldb-real-fixture') throw new Error('a7-lldb-profile-contract-mismatch');
  const binaryIdentity = `sha256:${checkedFixture.digest}`;
  const buildIdentity = `clang-lld-static:${checkedFixture.sourceDigest}:${binaryIdentity}`;
  const sessionIdentity = `lldb-session:${version}:${observed.pid}:${currentCommitSha}`;
  const providerFingerprint = sha256(Buffer.from(JSON.stringify({ version, executableIdentities })));
  const binding = createRuntimeAuthorityBinding({
    providerIdentity: `lldb:${version}:${providerFingerprint}`,
    providerProfileId: PROVIDER_PROFILE,
    providerVersion: version,
    runtimeInstanceIdentity: `lldb-process:${observed.pid}`,
    targetIdentity: `lldb-target:${binaryIdentity}`,
    targetProfileId: TARGET_PROFILE,
    binaryIdentity,
    buildIdentity,
    moduleIdentity: `lldb-module:${binaryIdentity}:${sha256(Buffer.from(observed.modulePath))}`,
    loadMappingIdentity: `lldb-load:${binaryIdentity}:${sha256(Buffer.from(observed.modulePath))}`,
    sessionIdentity,
    capabilityVersion: 'debug/v1',
    commitSha: currentCommitSha,
    treeSha: currentTreeSha,
    epoch: 0,
  });
  const observation = createRuntimeObservation({ binding, sequence: 1, observedAt: new Date().toISOString(), kind: 'active-x86-debug-session', payload: { provider: 'lldb', providerVersion: version, threadId: observed.threadId, registers: { rip: observed.rip, rsp: observed.rsp }, fixturePath: A7_LLDB_FIXTURE_PATH, observedCapabilities:observed.capabilityResults, closedCapabilities:A7_X86_REQUIRED_CAPABILITIES, unsupportedCapabilities:A7_X86_UNSUPPORTED_CAPABILITIES } });
  const checkedObservation = validateRuntimeObservation(binding, observation);
  if (!checkedObservation.ok) throw new Error(`a7-lldb-runtime-observation-invalid:${checkedObservation.reason}`);
  return Object.freeze({
    schemaVersion: A7_LLDB_PROOF_SCHEMA,
    status: 'exact-active-provider-observed',
    promotion: 'requires-canonical-four-profile-evidence-assembly',
    candidateCommitSha: currentCommitSha,
    candidateTreeSha: currentTreeSha,
    providerProfileId: PROVIDER_PROFILE,
    providerVersion: version,
    targetProfileId: TARGET_PROFILE,
    fixture: { path: A7_LLDB_FIXTURE_PATH, sourceSha256:checkedFixture.sourceDigest, sha256: checkedFixture.digest, targetTriple: 'x86_64-linux-gnu', compilerVersion, semantics:checkedFixture.sourceSemantics },
    independentOracle: { id:'llvm-readobj-18', executableIdentity:executableIdentities.readobj, outputSha256:checkedFixture.oracleDigest },
    providerExecutableIdentities:executableIdentities,
    binding,
    observation,
    closedCapabilities:A7_X86_REQUIRED_CAPABILITIES,
    unsupportedCapabilities:A7_X86_UNSUPPORTED_CAPABILITIES,
    closedChecks: Object.freeze(['deterministic-real-fixture-byte-identity', 'independent-llvm-object-oracle', 'lldb-version-observed', 'lldb-target-x86_64', 'lldb-process-launched', 'lldb-stop-at-entry', 'lldb-registers-observed', 'lldb-register-write-observed', 'lldb-memory-read-write-observed', 'lldb-breakpoint-step-remove-observed', 'runtime-binding-exact-head', 'runtime-observation-identity']),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const proof = collectA7X86LldbProof();
    process.stdout.write(`A7_X86_LLDB_PROVIDER_PROOF=${JSON.stringify(proof)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
