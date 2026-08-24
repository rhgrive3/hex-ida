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
  A7_ACTIVE_OPERATION_CAPABILITIES,
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
export const A7_X86_ACTIVE_OPERATION_CAPABILITIES = A7_ACTIVE_OPERATION_CAPABILITIES;
const BASELINE_CAPABILITIES = Object.freeze(A7_X86_REQUIRED_CAPABILITIES.filter((capability) => !A7_X86_ACTIVE_OPERATION_CAPABILITIES.includes(capability)));
const TARGET_PROFILE = 'x86_64:long-64';
const PROVIDER_PROFILE = 'native:lldb-compatible-v1:host';
const ACTIVE_MARKER = 'A7_LLDB_ACTIVE_OPS';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function capabilityMap(capabilities) { return Object.freeze(Object.fromEntries(capabilities.map((capability) => [capability, true]))); }

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
  return Object.freeze({ pid:Number(process[1]), threadId:Number(thread[1]), modulePath, rip, rsp, targetProfileId:TARGET_PROFILE, capabilityResults:capabilityMap(BASELINE_CAPABILITIES) });
}

function hostActiveOpsPython(fixturePath, probeWord) {
  return `
import json
import lldb
import os
import subprocess
import threading
import time

FIXTURE = ${JSON.stringify(fixturePath)}
PROBE = ${probeWord.toString()}
MARKER = ${JSON.stringify(ACTIVE_MARKER)}

def fail(code):
    raise RuntimeError(code)

def state_name(state):
    return lldb.SBDebugger.StateAsCString(state) or str(state)

def wait_for(predicate, timeout=3.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = process.GetState()
        if predicate(last):
            return last
        time.sleep(0.01)
    return last

def current_frame():
    thread = process.GetSelectedThread()
    if not thread.IsValid() and process.GetNumThreads() > 0:
        thread = process.GetThreadAtIndex(0)
    if not thread.IsValid():
        fail('thread-missing')
    frame = thread.GetFrameAtIndex(0)
    if not frame.IsValid():
        fail('frame-missing')
    return thread, frame

def reg(frame, name):
    value = frame.FindRegister(name)
    if not value.IsValid():
        fail('register-missing:' + name)
    return value.GetValueAsUnsigned()

def module_path(target):
    module = target.GetModuleAtIndex(0)
    if not module.IsValid():
        fail('module-missing')
    spec = module.GetFileSpec()
    directory = spec.GetDirectory() or ''
    filename = spec.GetFilename() or ''
    return os.path.realpath(os.path.join(directory, filename))

result = {'kind': 'active-provider-operations'}
child = None
process = None
try:
    lldb.SBDebugger.Initialize()
    debugger = lldb.SBDebugger.Create()
    debugger.SkipLLDBInitFiles(True)
    debugger.SetAsync(False)
    target = debugger.CreateTarget(FIXTURE)
    if not target.IsValid():
        fail('target-create-failed')
    child = subprocess.Popen([FIXTURE], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.05)
    requested_pid = child.pid
    error = lldb.SBError()
    process = target.Attach(lldb.SBAttachInfo(requested_pid), error)
    if not error.Success() or not process.IsValid():
        fail('attach-failed:' + str(error))
    attached_pid = process.GetProcessID()
    if attached_pid != requested_pid:
        fail('attach-pid-mismatch')
    if not lldb.SBDebugger.StateIsStoppedState(process.GetState()):
        fail('attach-not-stopped')
    thread, frame = current_frame()
    rip = reg(frame, 'rip')
    rsp = reg(frame, 'rsp')
    rax = reg(frame, 'rax')
    memory_error = lldb.SBError()
    probe_value = process.ReadUnsignedFromMemory(PROBE, 8, memory_error)
    if not memory_error.Success() or probe_value != 0x1020304050607080:
        fail('attach-memory-mismatch')
    observed_module = module_path(target)
    if observed_module != os.path.realpath(FIXTURE):
        fail('attach-module-mismatch')
    result['attach'] = {
        'observed': True, 'requestedPid': requested_pid, 'attachedPid': attached_pid,
        'targetTriple': target.GetTriple(), 'modulePath': observed_module,
        'threadId': thread.GetThreadID(), 'registers': {'rip': hex(rip), 'rsp': hex(rsp), 'rax': hex(rax)},
        'memoryProbe': hex(probe_value), 'state': state_name(process.GetState()),
    }

    before_rax = rax
    debugger.SetAsync(True)
    continue_error = process.Continue()
    if not continue_error.Success():
        fail('pause-continue-failed:' + str(continue_error))
    running_state = wait_for(lldb.SBDebugger.StateIsRunningState)
    if not lldb.SBDebugger.StateIsRunningState(running_state):
        fail('pause-running-not-observed')
    time.sleep(0.05)
    stop_error = process.Stop()
    if not stop_error.Success():
        fail('pause-stop-failed:' + str(stop_error))
    stopped_state = wait_for(lldb.SBDebugger.StateIsStoppedState)
    if not lldb.SBDebugger.StateIsStoppedState(stopped_state):
        fail('pause-stop-not-observed')
    thread, frame = current_frame()
    pause_rip = reg(frame, 'rip')
    pause_rsp = reg(frame, 'rsp')
    pause_rax = reg(frame, 'rax')
    if pause_rax == before_rax:
        fail('pause-no-execution-observed')
    result['pause'] = {
        'observed': True, 'runningObserved': True, 'stoppedObserved': True,
        'processId': process.GetProcessID(), 'threadId': thread.GetThreadID(),
        'registers': {'rip': hex(pause_rip), 'rsp': hex(pause_rsp), 'rax': hex(pause_rax)},
        'executionAdvanced': True, 'state': state_name(process.GetState()),
    }

    debugger.SetAsync(False)
    input_error = debugger.SetInputString('process continue\\n')
    if not input_error.Success():
        fail('cancel-input-failed:' + str(input_error))
    interpreter = debugger.GetCommandInterpreter()
    holder = {}
    def run_interpreter():
        try:
            holder['result'] = debugger.RunCommandInterpreter(True, False, lldb.SBCommandInterpreterRunOptions(), 0, False, False)
        except BaseException as exc:
            holder['exception'] = repr(exc)
    worker = threading.Thread(target=run_interpreter, daemon=True)
    worker.start()
    running_state = wait_for(lldb.SBDebugger.StateIsRunningState)
    if not lldb.SBDebugger.StateIsRunningState(running_state):
        fail('cancel-inflight-running-not-observed')
    interrupt_accepted = interpreter.InterruptCommand()
    if not interrupt_accepted:
        fail('cancel-interrupt-not-accepted')
    worker.join(3.0)
    if worker.is_alive():
        fail('cancel-command-not-settled')
    stopped_state = wait_for(lldb.SBDebugger.StateIsStoppedState)
    if not lldb.SBDebugger.StateIsStoppedState(stopped_state):
        fail('cancel-target-not-stopped')
    thread, frame = current_frame()
    cancel_rip = reg(frame, 'rip')
    cancel_rax = reg(frame, 'rax')
    first_state = process.GetState()
    time.sleep(0.10)
    thread2, frame2 = current_frame()
    late_rip = reg(frame2, 'rip')
    late_rax = reg(frame2, 'rax')
    late_state = process.GetState()
    if first_state != late_state or cancel_rip != late_rip or cancel_rax != late_rax:
        fail('cancel-late-success-observed')
    result['cancel'] = {
        'observed': True, 'inFlightObserved': True, 'interruptAccepted': True,
        'interpreterWasInterrupted': bool(interpreter.WasInterrupted()), 'commandSettled': True,
        'processId': process.GetProcessID(), 'threadId': thread.GetThreadID(),
        'settlement': 'cancelled', 'providerDisposition': 'interrupted-command', 'lateResultRejected': True, 'lateStateStable': True,
        'registers': {'rip': hex(cancel_rip), 'rax': hex(cancel_rax)}, 'state': state_name(late_state),
        'interpreterResult': repr(holder.get('result')), 'interpreterException': holder.get('exception'),
    }
    result['operationResults'] = {'attach': True, 'pause': True, 'cancel': True}
except BaseException as exc:
    result['error'] = str(exc)
finally:
    try:
        if process is not None and process.IsValid() and process.GetState() not in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateInvalid):
            process.Kill()
    except BaseException:
        pass
    try:
        if child is not None and child.poll() is None:
            child.kill()
        if child is not None:
            child.wait(timeout=1.0)
    except BaseException:
        pass
    try:
        if 'debugger' in globals():
            lldb.SBDebugger.Destroy(debugger)
        lldb.SBDebugger.Terminate()
    except BaseException:
        pass
print(MARKER + '=' + json.dumps(result, sort_keys=True))
`;
}

function runLldbPythonProof(lldb, python, directory, pythonSource, code) {
  const scriptPath = path.join(directory, `${code}.py`);
  fs.writeFileSync(scriptPath, pythonSource, { encoding:'utf8', mode:0o600 });
  const pythonPathResult = spawnSync(lldb, ['-P'], { cwd:ROOT, encoding:'utf8', timeout:10_000, maxBuffer:2 * 1024 * 1024 });
  const lldbPythonPath = String(pythonPathResult.stdout || '').trim();
  if (pythonPathResult.status !== 0 || !lldbPythonPath) throw new Error('a7-lldb-python-provider-path-unavailable');
  const result = spawnSync(python, [scriptPath], {
    cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024,
    env:{ ...process.env, DEBUGINFOD_URLS:'', PYTHONPATH:[lldbPythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 || result.signal) throw new Error(`${code}:${result.signal || result.status}:${String(result.stderr || '').trim()}`);
  return Object.freeze({ output, lldbPythonPath });
}

function parseMarker(output, marker, code) {
  const prefix = `${marker}=`;
  const line = String(output || '').split(/\r?\n/).find((value) => value.startsWith(prefix));
  if (!line) throw new Error(`${code}-missing`);
  let value;
  try { value = JSON.parse(line.slice(prefix.length)); } catch { throw new Error(`${code}-invalid-json`); }
  if (value?.error) throw new Error(`${code}-failed:${value.error}`);
  return value;
}

export function parseLldbActiveOpsOutput(output, { fixturePath = null, probeWord = null } = {}) {
  const proof = parseMarker(output, ACTIVE_MARKER, 'a7-lldb-active-ops');
  if (proof?.kind !== 'active-provider-operations') throw new Error('a7-lldb-active-ops-kind-mismatch');
  const attach = proof.attach || {};
  const pause = proof.pause || {};
  const cancel = proof.cancel || {};
  if (proof.operationResults?.attach !== true || attach.observed !== true) throw new Error('a7-lldb-attach-not-observed');
  if (!Number.isSafeInteger(attach.requestedPid) || attach.requestedPid <= 0 || attach.attachedPid !== attach.requestedPid) throw new Error('a7-lldb-attach-process-identity-mismatch');
  if (!/x86_64|x86-64/i.test(String(attach.targetTriple || ''))) throw new Error('a7-lldb-attach-target-identity-mismatch');
  if (fixturePath != null && path.resolve(String(attach.modulePath || '')) !== path.resolve(fixturePath)) throw new Error('a7-lldb-attach-module-identity-mismatch');
  if (!attach.registers?.rip || !attach.registers?.rsp || !Number.isSafeInteger(attach.threadId)) throw new Error('a7-lldb-attach-register-observation-missing');
  if (probeWord != null && String(attach.memoryProbe || '').toLowerCase() !== '0x1020304050607080') throw new Error('a7-lldb-attach-memory-observation-missing');
  if (proof.operationResults?.pause !== true || pause.observed !== true || pause.runningObserved !== true || pause.stoppedObserved !== true || pause.executionAdvanced !== true) throw new Error('a7-lldb-pause-not-observed');
  if (pause.processId !== attach.attachedPid || !pause.registers?.rip || !Number.isSafeInteger(pause.threadId)) throw new Error('a7-lldb-pause-session-identity-mismatch');
  if (proof.operationResults?.cancel !== true || cancel.observed !== true || cancel.inFlightObserved !== true || cancel.interruptAccepted !== true) throw new Error('a7-lldb-cancel-not-observed');
  if (cancel.commandSettled !== true || cancel.settlement !== 'cancelled' || cancel.providerDisposition !== 'interrupted-command' || cancel.lateResultRejected !== true || cancel.lateStateStable !== true) throw new Error('a7-lldb-cancel-settlement-missing');
  if (cancel.processId !== attach.attachedPid || !cancel.registers?.rip || !Number.isSafeInteger(cancel.threadId)) throw new Error('a7-lldb-cancel-session-identity-mismatch');
  return Object.freeze({
    ...proof,
    operationResults:Object.freeze({ attach:true, pause:true, cancel:true }),
    capabilityResults:capabilityMap(A7_X86_ACTIVE_OPERATION_CAPABILITIES),
  });
}

export function collectA7X86LldbProof({
  lldb = process.env.LLDB || (fs.existsSync('/usr/bin/lldb') ? '/usr/bin/lldb' : '/usr/bin/lldb-18'),
  clang = fs.existsSync('/usr/bin/clang') ? '/usr/bin/clang' : '/usr/bin/clang-18',
  readobj = fs.existsSync('/usr/bin/llvm-readobj-18') ? '/usr/bin/llvm-readobj-18' : 'llvm-readobj',
  python = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3',
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
    python: executableIdentity(python, ['python3', 'python3.10', 'python3.11', 'python3.12', 'python3.13']),
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-a7-x86-'));
  let checkedFixture;
  let baseline;
  let activeOperations;
  let lldbPythonPath;
  try {
    checkedFixture = fixture(directory, { clang, readobj });
    const result = spawnSync(lldb, lldbCommand(checkedFixture.absolute, checkedFixture.entry, checkedFixture.probeWord), { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status !== 0 || result.signal) throw new Error(`a7-lldb-provider-command-failed:${result.signal || result.status}`);
    baseline = parseLldbOutput(output, { fixturePath:checkedFixture.absolute, entry:checkedFixture.entry, probeWord:checkedFixture.probeWord });
    const activeRun = runLldbPythonProof(lldb, python, directory, hostActiveOpsPython(checkedFixture.absolute, checkedFixture.probeWord), 'a7-lldb-active-ops');
    lldbPythonPath = activeRun.lldbPythonPath;
    activeOperations = parseLldbActiveOpsOutput(activeRun.output, { fixturePath:checkedFixture.absolute, probeWord:checkedFixture.probeWord });
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
  const bindingContract = A7_PROFILE_BINDINGS[TARGET_PROFILE];
  if (!bindingContract || bindingContract.sourcePath !== A7_LLDB_FIXTURE_PATH || bindingContract.providerProfileId !== PROVIDER_PROFILE || bindingContract.providerProofCommandId !== 'a7-lldb-real-fixture') throw new Error('a7-lldb-profile-contract-mismatch');
  const closedCapabilities = Object.freeze([...new Set([...Object.keys(baseline.capabilityResults), ...Object.keys(activeOperations.capabilityResults)])].sort());
  if (JSON.stringify(closedCapabilities) !== JSON.stringify([...A7_X86_REQUIRED_CAPABILITIES].sort())) throw new Error('a7-lldb-capability-denominator-incomplete');
  const binaryIdentity = `sha256:${checkedFixture.digest}`;
  const buildIdentity = `clang-lld-static:${checkedFixture.sourceDigest}:${binaryIdentity}`;
  const attachedPid = activeOperations.attach.attachedPid;
  const sessionIdentity = `lldb-attach-session:${version}:${attachedPid}:${currentCommitSha}`;
  const providerFingerprint = sha256(Buffer.from(JSON.stringify({ version, executableIdentities, lldbPythonPath })));
  const activeModulePath = path.resolve(activeOperations.attach.modulePath);
  const binding = createRuntimeAuthorityBinding({
    providerIdentity: `lldb:${version}:${providerFingerprint}`,
    providerProfileId: PROVIDER_PROFILE,
    providerVersion: version,
    runtimeInstanceIdentity: `lldb-attached-process:${attachedPid}`,
    targetIdentity: `lldb-attached-target:${attachedPid}:${binaryIdentity}`,
    targetProfileId: TARGET_PROFILE,
    binaryIdentity,
    buildIdentity,
    moduleIdentity: `lldb-module:${binaryIdentity}:${sha256(Buffer.from(activeModulePath))}`,
    loadMappingIdentity: `lldb-load:${binaryIdentity}:${sha256(Buffer.from(`${activeModulePath}:${activeOperations.pause.registers.rip}`))}`,
    sessionIdentity,
    capabilityVersion: 'debug/v1',
    commitSha: currentCommitSha,
    treeSha: currentTreeSha,
    epoch: 0,
  });
  const observation = createRuntimeObservation({
    binding, sequence:1, observedAt:new Date().toISOString(), kind:'active-x86-debug-session',
    payload:{
      provider:'lldb', providerVersion:version, fixturePath:A7_LLDB_FIXTURE_PATH,
      processIdentity:attachedPid, modulePath:activeModulePath,
      attach:activeOperations.attach, pause:activeOperations.pause, cancel:activeOperations.cancel,
      baselineLaunchProcessId:baseline.pid,
      observedCapabilities:Object.freeze({ ...baseline.capabilityResults, ...activeOperations.capabilityResults }),
      closedCapabilities, unsupportedCapabilities:A7_X86_UNSUPPORTED_CAPABILITIES,
    },
  });
  const checkedObservation = validateRuntimeObservation(binding, observation);
  if (!checkedObservation.ok) throw new Error(`a7-lldb-runtime-observation-invalid:${checkedObservation.reason}`);
  return Object.freeze({
    schemaVersion:A7_LLDB_PROOF_SCHEMA,
    status:'exact-active-provider-observed',
    promotion:'requires-canonical-four-profile-evidence-assembly',
    candidateCommitSha:currentCommitSha,
    candidateTreeSha:currentTreeSha,
    providerProfileId:PROVIDER_PROFILE,
    providerVersion:version,
    targetProfileId:TARGET_PROFILE,
    fixture:{ path:A7_LLDB_FIXTURE_PATH, sourceSha256:checkedFixture.sourceDigest, sha256:checkedFixture.digest, targetTriple:'x86_64-linux-gnu', compilerVersion, semantics:checkedFixture.sourceSemantics },
    independentOracle:{ id:'llvm-readobj-18', executableIdentity:executableIdentities.readobj, outputSha256:checkedFixture.oracleDigest },
    providerExecutableIdentities:executableIdentities,
    lldbPythonPath,
    activeOperations:Object.freeze({ attach:activeOperations.attach, pause:activeOperations.pause, cancel:activeOperations.cancel }),
    binding, observation, closedCapabilities, unsupportedCapabilities:A7_X86_UNSUPPORTED_CAPABILITIES,
    closedChecks:Object.freeze([
      'deterministic-real-fixture-byte-identity','independent-llvm-object-oracle','lldb-version-observed',
      'lldb-target-x86_64','lldb-process-launched','lldb-stop-at-entry','lldb-registers-observed','lldb-register-write-observed',
      'lldb-memory-read-write-observed','lldb-breakpoint-step-remove-observed','lldb-real-process-attach-observed',
      'lldb-attach-process-target-module-identity','lldb-running-target-pause-observed','lldb-pause-register-pc-observed',
      'lldb-inflight-command-cancel-observed','lldb-cancel-command-settled','lldb-cancel-late-result-stable',
      'runtime-binding-exact-head','runtime-observation-identity',
    ]),
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
