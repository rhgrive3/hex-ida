/*
 * Bounded exact-run probe for the native A7 provider.  This is intentionally
 * an x86_64-only observation: one active LLDB session cannot prove the four
 * architecture profiles in the Stage 2 denominator.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntimeAuthorityBinding, createRuntimeObservation, validateRuntimeObservation } from '../../../js/runtime/authority.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const A7_LLDB_PROOF_SCHEMA = 'hex-stage2-a7-lldb-provider-proof/v1';
export const A7_LLDB_FIXTURE_PATH = 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf';
const TARGET_PROFILE = 'x86_64:long-64';
const PROVIDER_PROFILE = 'native:lldb-compatible-v1:host';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function fixture() {
  const absolute = path.join(ROOT, A7_LLDB_FIXTURE_PATH);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error('a7-lldb-real-fixture-missing');
  const bytes = fs.readFileSync(absolute);
  const digest = sha256(bytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/phase5/corpus/manifest.json'), 'utf8'));
  const entry = manifest.foundationVerticalFixtures?.find((item) => item.path === A7_LLDB_FIXTURE_PATH);
  if (!entry || entry.sha256 !== digest || entry.targetTriple !== 'x86_64-unknown-linux-gnu') throw new Error('a7-lldb-real-fixture-identity-invalid');
  return { absolute, digest, entry };
}

function lldbCommand(pathname) {
  return [
    '-b', '-Q',
    '-o', 'settings set symbols.enable-external-lookup false',
    '-o', `target create ${pathname}`,
    '-o', 'target modules list',
    '-o', 'process launch --stop-at-entry',
    '-o', 'thread list',
    '-o', 'register read rip rsp',
    '-o', 'process kill',
  ];
}

export function parseLldbOutput(output, { fixturePath = A7_LLDB_FIXTURE_PATH } = {}) {
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
  if (!/exited with status = 9 .* killed/.test(text)) throw new Error('a7-lldb-session-cleanup-missing');
  return Object.freeze({ pid: Number(process[1]), threadId: Number(thread[1]), modulePath, rip, rsp, targetProfileId: TARGET_PROFILE });
}

export function collectA7X86LldbProof({ lldb = process.env.LLDB || 'lldb' } = {}) {
  const clean = git(['status', '--porcelain', '--untracked-files=all']);
  if (clean) throw new Error('a7-lldb-proof-worktree-dirty');
  const currentCommitSha = git(['rev-parse', 'HEAD']);
  const currentTreeSha = git(['rev-parse', 'HEAD^{tree}']);
  const checkedFixture = fixture();
  const versionResult = spawnSync(lldb, ['--version'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
  if (versionResult.status !== 0) throw new Error('a7-lldb-provider-unavailable');
  const version = /lldb version (\d+\.\d+\.\d+)/.exec(`${versionResult.stdout}\n${versionResult.stderr}`)?.[1];
  if (!version) throw new Error('a7-lldb-provider-version-missing');
  const result = spawnSync(lldb, lldbCommand(checkedFixture.absolute), { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 || result.signal) throw new Error(`a7-lldb-provider-command-failed:${result.signal || result.status}`);
  const observed = parseLldbOutput(output);
  const binaryIdentity = `sha256:${checkedFixture.digest}`;
  const buildIdentity = `lldb-target-build:${binaryIdentity}`;
  const sessionIdentity = `lldb-session:${version}:${observed.pid}:${currentCommitSha}`;
  const binding = createRuntimeAuthorityBinding({
    providerIdentity: `lldb:${version}`,
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
  const observation = createRuntimeObservation({ binding, sequence: 1, observedAt: new Date().toISOString(), kind: 'stop-at-entry', payload: { provider: 'lldb', providerVersion: version, threadId: observed.threadId, registers: { rip: observed.rip, rsp: observed.rsp }, fixturePath: A7_LLDB_FIXTURE_PATH } });
  const checkedObservation = validateRuntimeObservation(binding, observation);
  if (!checkedObservation.ok) throw new Error(`a7-lldb-runtime-observation-invalid:${checkedObservation.reason}`);
  return Object.freeze({
    schemaVersion: A7_LLDB_PROOF_SCHEMA,
    status: 'bounded-x86-provider-observed',
    promotion: 'blocked-four-profile-denominator-incomplete',
    candidateCommitSha: currentCommitSha,
    candidateTreeSha: currentTreeSha,
    providerProfileId: PROVIDER_PROFILE,
    providerVersion: version,
    targetProfileId: TARGET_PROFILE,
    fixture: { path: A7_LLDB_FIXTURE_PATH, sha256: checkedFixture.digest, targetTriple: checkedFixture.entry.targetTriple },
    binding,
    observation,
    closedChecks: Object.freeze(['real-fixture-byte-identity', 'lldb-version-observed', 'lldb-target-x86_64', 'lldb-process-launched', 'lldb-stop-at-entry', 'lldb-registers-observed', 'runtime-binding-exact-head', 'runtime-observation-identity']),
    uncoveredTargetProfiles: Object.freeze(['arm64:a64', 'arm64e:a64+pac', 'riscv64:rv64imc']),
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
