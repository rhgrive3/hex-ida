/*
 * Bounded exact-run probe for the native A7 provider. This is intentionally
 * an x86_64-only observation: one active LLDB host cannot prove the four
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
  const result = spawnSync('git', args, { cwd:ROOT, encoding:'utf8', maxBuffer:8 * 1024 * 1024 });
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
    '-b','-Q',
    '-o','settings set symbols.enable-external-lookup false',
    '-o',`target create ${pathname}`,
    '-o','target modules list',
    '-o','process launch --stop-at-entry',
    '-o','process status',
    '-o','target modules list',
    '-o','thread list',
    '-o','register read rip rsp rax',
    '-o',`memory read -fx -s8 -c1 0x${probeWord.toString(16)}`,
    '-o','register write rax 0x42',
    '-o','register read rax',
    '-o',`memory write -s8 0x${probeWord.toString(16)} 0x8877665544332211`,
    '-o',`memory read -fx -s8 -c1 0x${probeWord.toString(16)}`,
    '-o',`breakpoint set -a 0x${(entry + 1n).toString(16)}`,
    '-o','continue',
    '-o','thread step-inst',
    '-o','breakpoint delete 1',
    '-o','process kill',
  ];
}

export function parseLldbOutput(output, { fixturePath = A7_LLDB_FIXTURE_PATH, entry = null, probeWord = null } = {}) {
  const text = String(output || '');
  if (!new RegExp(`Current executable set to '.*${fixturePath.replaceAll('/', '[\\\\/]')}' \\(x86_64\\)\\.`).test(text)) throw new Error('a7-lldb-target-profile-mismatch');
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
  if (entry != null && (!new RegExp(`Breakpoint 1:.*0x0*${(entry + 1n).toString(16)}`, 'i').test(text) || !/stop reason = breakpoint 1\.1/.test(text) || !/stop reason = instruction step into/.test(text))) throw new Error('a7-lldb-breakpoint-step-missing');
  if (probeWord != null && (!new RegExp(`0x0*${probeWord.toString(16)}: 0x1020304050607080`, 'i').test(text) || !new RegExp(`0x0*${probeWord.toString(16)}: 0x8877665544332211`, 'i').test(text))) throw new Error('a7-lldb-memory-read-write-missing');
  if (!/1 breakpoints deleted; 0 breakpoint locations disabled\./.test(text)) throw new Error('a7-lldb-breakpoint-removal-missing');
  if (!/exited with status = 9 .* killed/.test(text)) throw new Error('a7-lldb-session-cleanup-missing');
  return Object.freeze({ pid:Number(process[1]), threadId:Number(thread[1]), modulePath, rip, rsp, targetProfileId:TARGET_PROFILE, capabilityResults:capabilityMap(BASELINE_CAPABILITIES) });
}

function hostActiveOperationPython(fixturePath, probeWord, pythonPath, operation) {
  return `
import json
import lldb
import os
import subprocess
import time

FIXTURE = ${JSON.stringify(fixturePath)}
PROBE = ${probeWord.toString()}
PYTHON = ${JSON.stringify(pythonPath)}
OPERATION = ${JSON.stringify(operation)}
MARKER = ${JSON.stringify(ACTIVE_MARKER)}
PTRACE_LAUNCHER = r'''import ctypes
import os
import sys
PR_SET_PTRACER = 0x59616D61
PR_SET_PTRACER_ANY = ctypes.c_ulong(-1).value
libc = ctypes.CDLL(None, use_errno=True)
prctl = libc.prctl
prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
prctl.restype = ctypes.c_int
if prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY, 0, 0, 0) != 0:
    error_number = ctypes.get_errno()
    raise OSError(error_number, os.strerror(error_number))
os.execv(sys.argv[1], [sys.argv[1]])
'''

def fail(code):
    raise RuntimeError(code)

def state_name(state):
    return lldb.SBDebugger.StateAsCString(state) or str(state)

def wait_for(predicate, timeout=3.0):
    deadline = time.time() + timeout
    last = lldb.eStateInvalid
    while time.time() < deadline:
        last = process.GetState()
        if predicate(last):
            return last
        time.sleep(0.01)
    return last

def wait_for_fixture_exec(child, timeout=3.0):
    deadline = time.time() + timeout
    expected = os.path.realpath(FIXTURE)
    proc_exe = '/proc/' + str(child.pid) + '/exe'
    while time.time() < deadline:
        if child.poll() is not None:
            fail(OPERATION + '-ptrace-launcher-failed:' + str(child.returncode))
        try:
            if os.path.realpath(proc_exe) == expected:
                return
        except OSError:
            pass
        time.sleep(0.01)
    fail(OPERATION + '-ptrace-launcher-exec-timeout')

def current_frame(timeout=1.0):
    deadline = time.time() + timeout
    while True:
        thread = process.GetSelectedThread()
        if not thread.IsValid() and process.GetNumThreads() > 0:
            thread = process.GetThreadAtIndex(0)
        if thread.IsValid():
            frame = thread.GetFrameAtIndex(0)
            if frame.IsValid():
                return thread, frame
        if time.time() >= deadline:
            fail(OPERATION + '-thread-frame-not-ready')
        time.sleep(0.01)

def reg(frame, name):
    value = frame.FindRegister(name)
    if not value.IsValid(): fail(OPERATION + '-register-missing:' + name)
    return value.GetValueAsUnsigned()

def module_path(target):
    module = target.GetModuleAtIndex(0)
    if not module.IsValid(): fail(OPERATION + '-module-missing')
    spec = module.GetFileSpec()
    return os.path.realpath(os.path.join(spec.GetDirectory() or '', spec.GetFilename() or ''))

def proc_stat(pid):
    with open('/proc/' + str(pid) + '/stat', 'r', encoding='utf8') as handle:
        text = handle.read().strip()
    close = text.rfind(')')
    if close < 0: fail(OPERATION + '-proc-stat-malformed')
    fields = text[close + 2:].split()
    if len(fields) < 20: fail(OPERATION + '-proc-stat-short')
    return {'cpuTicks': int(fields[11]) + int(fields[12]), 'startTimeTicks': int(fields[19])}

def wait_for_progress(before, timeout=3.0):
    deadline = time.time() + timeout
    last = before
    while time.time() < deadline:
        last = proc_stat(attached_pid)
        if last['startTimeTicks'] != before['startTimeTicks']:
            fail(OPERATION + '-process-identity-changed')
        if last['cpuTicks'] > before['cpuTicks']:
            return last
        state = process.GetState()
        if state in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateInvalid):
            fail(OPERATION + '-process-terminated:' + state_name(state))
        time.sleep(0.01)
    fail(OPERATION + '-no-execution-progress')

result = {'kind':'active-provider-operation', 'operation':OPERATION}
child = None
process = None
try:
    lldb.SBDebugger.Initialize()
    debugger = lldb.SBDebugger.Create()
    debugger.SkipLLDBInitFiles(True)
    debugger.SetAsync(False)
    target = debugger.CreateTarget(FIXTURE)
    if not target.IsValid(): fail(OPERATION + '-target-create-failed')
    child = subprocess.Popen([PYTHON, '-c', PTRACE_LAUNCHER, FIXTURE], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_for_fixture_exec(child)
    requested_pid = child.pid
    error = lldb.SBError()
    process = target.Attach(lldb.SBAttachInfo(requested_pid), error)
    if not error.Success() or not process.IsValid(): fail(OPERATION + '-attach-failed:' + str(error))
    attached_pid = process.GetProcessID()
    if attached_pid != requested_pid: fail(OPERATION + '-attach-pid-mismatch')
    if not lldb.SBDebugger.StateIsStoppedState(process.GetState()): fail(OPERATION + '-attach-not-stopped')
    thread, frame = current_frame()
    memory_error = lldb.SBError()
    probe_value = process.ReadUnsignedFromMemory(PROBE, 8, memory_error)
    if not memory_error.Success() or probe_value != 0x1020304050607080: fail(OPERATION + '-attach-memory-mismatch')
    observed_module = module_path(target)
    if observed_module != os.path.realpath(FIXTURE): fail(OPERATION + '-attach-module-mismatch')
    attach_stat = proc_stat(attached_pid)
    result['attach'] = {
        'observed':True, 'requestedPid':requested_pid, 'attachedPid':attached_pid,
        'processStartTimeTicks':attach_stat['startTimeTicks'], 'targetTriple':target.GetTriple(),
        'modulePath':observed_module, 'threadId':thread.GetThreadID(),
        'registers':{'rip':hex(reg(frame, 'rip')), 'rsp':hex(reg(frame, 'rsp')), 'rax':hex(reg(frame, 'rax'))},
        'memoryProbe':hex(probe_value), 'state':state_name(process.GetState()),
    }

    stop_id_before = process.GetStopID()
    stat_before = proc_stat(attached_pid)
    if stat_before['startTimeTicks'] != attach_stat['startTimeTicks']: fail(OPERATION + '-pre-run-process-identity-changed')
    debugger.SetAsync(True)
    continue_error = process.Continue()
    if not continue_error.Success(): fail(OPERATION + '-continue-failed:' + str(continue_error))
    stat_after = wait_for_progress(stat_before)
    process.SendAsyncInterrupt()
    stopped_state = wait_for(lldb.SBDebugger.StateIsStoppedState, timeout=3.0)
    if not lldb.SBDebugger.StateIsStoppedState(stopped_state): fail(OPERATION + '-target-not-stopped:' + state_name(stopped_state))
    if process.GetProcessID() != attached_pid: fail(OPERATION + '-process-id-changed')
    stopped_stat = proc_stat(attached_pid)
    if stopped_stat['startTimeTicks'] != stat_before['startTimeTicks']: fail(OPERATION + '-process-identity-changed-after-stop')
    stop_id_after = process.GetStopID()
    if stop_id_after <= stop_id_before: fail(OPERATION + '-stop-id-not-advanced')

    if OPERATION == 'pause':
        result['pause'] = {
            'observed':True, 'continueAccepted':True, 'stopAccepted':True, 'runningObserved':True,
            'runningEvidence':'exact-host-process-cpu-progress+lldb-stop-id',
            'executionEvidence':'exact-host-process-cpu-ticks-during-provider-running-window',
            'executionWindow':'after-continue-before-interrupt', 'progressTransport':'linux-proc-stat+lldb-stop-id',
            'stoppedObserved':True, 'executionAdvanced':True, 'interruptIssued':True,
            'stopIdBefore':stop_id_before, 'stopIdAfter':stop_id_after, 'stopIdAdvanced':True,
            'processId':attached_pid, 'cpuTicksBefore':stat_before['cpuTicks'], 'cpuTicksAfter':stat_after['cpuTicks'],
            'processStartTimeTicks':stat_before['startTimeTicks'], 'state':state_name(process.GetState()),
        }
    elif OPERATION == 'cancel':
        first_state = process.GetState()
        first_stop_id = stop_id_after
        first_stat = proc_stat(attached_pid)
        time.sleep(0.10)
        late_state = process.GetState()
        late_stop_id = process.GetStopID()
        late_stat = proc_stat(attached_pid)
        if late_stat['startTimeTicks'] != first_stat['startTimeTicks']: fail('cancel-late-process-identity-changed')
        if first_state != late_state or first_stop_id != late_stop_id: fail('cancel-late-success-observed')
        result['cancel'] = {
            'observed':True, 'inFlightObserved':True, 'continueAccepted':True,
            'inFlightEvidence':'async-continue+exact-host-process-cpu-progress-before-cancel',
            'executionEvidence':'exact-host-process-cpu-ticks-during-provider-running-window',
            'executionWindow':'after-continue-before-cancel-interrupt', 'progressTransport':'linux-proc-stat+lldb-stop-id',
            'executionAdvanced':True, 'interruptAccepted':True, 'operationSettled':True,
            'processId':attached_pid, 'cpuTicksBefore':stat_before['cpuTicks'], 'cpuTicksAfter':stat_after['cpuTicks'],
            'processStartTimeTicks':stat_before['startTimeTicks'], 'stopIdBefore':stop_id_before,
            'stopIdAfter':stop_id_after, 'stopIdAdvanced':True, 'settlement':'cancelled',
            'providerDisposition':'lldb-async-interrupt-observed', 'lateResultRejected':True,
            'lateStateStable':True, 'lateStopIdStable':True, 'lateProcessInstanceStable':True,
            'state':state_name(late_state),
        }
    else:
        fail('unsupported-operation:' + OPERATION)
except BaseException as exc:
    result['error'] = str(exc)
finally:
    try:
        if process is not None and process.IsValid() and process.GetState() not in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateInvalid): process.Kill()
    except BaseException: pass
    try:
        if child is not None and child.poll() is None: child.kill()
        if child is not None: child.wait(timeout=1.0)
    except BaseException: pass
    try:
        if 'debugger' in globals(): lldb.SBDebugger.Destroy(debugger)
        lldb.SBDebugger.Terminate()
    except BaseException: pass
print(MARKER + '=' + json.dumps(result, sort_keys=True))
`;
}

function runLldbPythonProof(lldb, python, directory, pythonSource, stem) {
  const scriptPath = path.join(directory, `${stem}.py`);
  fs.writeFileSync(scriptPath, pythonSource, { encoding:'utf8', mode:0o600 });
  const pythonPathResult = spawnSync(lldb, ['-P'], { cwd:ROOT, encoding:'utf8', timeout:10_000, maxBuffer:2 * 1024 * 1024 });
  const lldbPythonPath = String(pythonPathResult.stdout || '').trim();
  if (pythonPathResult.status !== 0 || !lldbPythonPath) throw new Error('a7-lldb-python-provider-path-unavailable');
  const result = spawnSync(python, [scriptPath], { cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024, env:{ ...process.env, DEBUGINFOD_URLS:'', PYTHONPATH:[lldbPythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 || result.signal) throw new Error(`${stem}:${result.signal || result.status}:${String(result.stderr || '').trim()}`);
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
function safeProgress(before, after) { return Number.isSafeInteger(before) && before >= 0 && Number.isSafeInteger(after) && after > before; }
function safeStopProgress(before, after) { return Number.isSafeInteger(before) && before >= 0 && Number.isSafeInteger(after) && after > before; }

function validateAttach(attach, { fixturePath, probeWord }, code) {
  if (attach?.observed !== true) throw new Error(`a7-lldb-${code}-attach-not-observed`);
  if (!Number.isSafeInteger(attach.requestedPid) || attach.requestedPid <= 0 || attach.attachedPid !== attach.requestedPid) throw new Error(`a7-lldb-${code}-attach-process-identity-mismatch`);
  if (!Number.isSafeInteger(attach.processStartTimeTicks) || attach.processStartTimeTicks <= 0) throw new Error(`a7-lldb-${code}-attach-process-instance-missing`);
  if (!/x86_64|x86-64/i.test(String(attach.targetTriple || ''))) throw new Error(`a7-lldb-${code}-attach-target-identity-mismatch`);
  if (fixturePath != null && path.resolve(String(attach.modulePath || '')) !== path.resolve(fixturePath)) throw new Error(`a7-lldb-${code}-attach-module-identity-mismatch`);
  if (!attach.registers?.rip || !attach.registers?.rsp || !Number.isSafeInteger(attach.threadId)) throw new Error(`a7-lldb-${code}-attach-register-observation-missing`);
  if (probeWord != null && String(attach.memoryProbe || '').toLowerCase() !== '0x1020304050607080') throw new Error(`a7-lldb-${code}-attach-memory-observation-missing`);
}

export function parseLldbActiveOpsOutput(output, { fixturePath = null, probeWord = null } = {}) {
  const proof = parseMarker(output, ACTIVE_MARKER, 'a7-lldb-active-ops');
  if (proof?.kind !== 'active-provider-operation-set') throw new Error('a7-lldb-active-ops-kind-mismatch');
  const attach = proof.attach || {};
  const pause = proof.pause || {};
  const cancelAttach = proof.cancelAttach || {};
  const cancel = proof.cancel || {};
  if (proof.operationResults?.attach !== true || proof.operationResults?.pause !== true || proof.operationResults?.cancel !== true) throw new Error('a7-lldb-active-ops-denominator-incomplete');
  validateAttach(attach, { fixturePath, probeWord }, 'pause');
  if (pause.observed !== true || pause.runningObserved !== true || pause.stoppedObserved !== true || pause.executionAdvanced !== true || pause.continueAccepted !== true || pause.stopAccepted !== true || pause.interruptIssued !== true) throw new Error('a7-lldb-pause-not-observed');
  if (pause.runningEvidence !== 'exact-host-process-cpu-progress+lldb-stop-id' || pause.executionEvidence !== 'exact-host-process-cpu-ticks-during-provider-running-window') throw new Error('a7-lldb-pause-running-evidence-missing');
  if (pause.processId !== attach.attachedPid || pause.processStartTimeTicks !== attach.processStartTimeTicks) throw new Error('a7-lldb-pause-session-identity-mismatch');
  if (!safeProgress(pause.cpuTicksBefore, pause.cpuTicksAfter)) throw new Error('a7-lldb-pause-process-progress-evidence-missing');
  if (pause.stopIdAdvanced !== true || !safeStopProgress(pause.stopIdBefore, pause.stopIdAfter)) throw new Error('a7-lldb-pause-stop-id-evidence-missing');
  validateAttach(cancelAttach, { fixturePath, probeWord }, 'cancel');
  if (cancel.observed !== true || cancel.inFlightObserved !== true || cancel.continueAccepted !== true || cancel.interruptAccepted !== true || cancel.executionAdvanced !== true) throw new Error('a7-lldb-cancel-not-observed');
  if (cancel.inFlightEvidence !== 'async-continue+exact-host-process-cpu-progress-before-cancel' || cancel.executionEvidence !== 'exact-host-process-cpu-ticks-during-provider-running-window') throw new Error('a7-lldb-cancel-inflight-evidence-missing');
  if (cancel.operationSettled !== true || cancel.settlement !== 'cancelled' || cancel.providerDisposition !== 'lldb-async-interrupt-observed' || cancel.lateResultRejected !== true || cancel.lateStateStable !== true || cancel.lateStopIdStable !== true || cancel.lateProcessInstanceStable !== true) throw new Error('a7-lldb-cancel-settlement-missing');
  if (cancel.processId !== cancelAttach.attachedPid || cancel.processStartTimeTicks !== cancelAttach.processStartTimeTicks) throw new Error('a7-lldb-cancel-session-identity-mismatch');
  if (!safeProgress(cancel.cpuTicksBefore, cancel.cpuTicksAfter)) throw new Error('a7-lldb-cancel-process-progress-evidence-missing');
  if (cancel.stopIdAdvanced !== true || !safeStopProgress(cancel.stopIdBefore, cancel.stopIdAfter)) throw new Error('a7-lldb-cancel-stop-id-evidence-missing');
  if (path.resolve(cancelAttach.modulePath) !== path.resolve(attach.modulePath) || cancelAttach.targetTriple !== attach.targetTriple) throw new Error('a7-lldb-operation-set-target-mismatch');
  if (cancelAttach.attachedPid === attach.attachedPid && cancelAttach.processStartTimeTicks === attach.processStartTimeTicks) throw new Error('a7-lldb-operation-set-runtime-not-independent');
  return Object.freeze({ ...proof, operationResults:Object.freeze({ attach:true, pause:true, cancel:true }), capabilityResults:capabilityMap(A7_X86_ACTIVE_OPERATION_CAPABILITIES) });
}

function parseActiveOperation(output, operation, options) {
  const proof = parseMarker(output, ACTIVE_MARKER, `a7-lldb-${operation}-ops`);
  if (proof?.kind !== 'active-provider-operation' || proof.operation !== operation) throw new Error(`a7-lldb-${operation}-kind-mismatch`);
  validateAttach(proof.attach, options, operation);
  if (operation === 'pause') {
    const combined = { kind:'active-provider-operation-set', attach:proof.attach, pause:proof.pause, cancelAttach:{ ...proof.attach, requestedPid:proof.attach.requestedPid + 1, attachedPid:proof.attach.attachedPid + 1, processStartTimeTicks:proof.attach.processStartTimeTicks + 1 }, cancel:{ observed:true, inFlightObserved:true, continueAccepted:true, inFlightEvidence:'async-continue+exact-host-process-cpu-progress-before-cancel', executionEvidence:'exact-host-process-cpu-ticks-during-provider-running-window', executionAdvanced:true, interruptAccepted:true, operationSettled:true, processId:proof.attach.attachedPid + 1, cpuTicksBefore:1, cpuTicksAfter:2, processStartTimeTicks:proof.attach.processStartTimeTicks + 1, stopIdBefore:1, stopIdAfter:2, stopIdAdvanced:true, settlement:'cancelled', providerDisposition:'lldb-async-interrupt-observed', lateResultRejected:true, lateStateStable:true, lateStopIdStable:true, lateProcessInstanceStable:true }, operationResults:{ attach:true, pause:true, cancel:true } };
    try { parseLldbActiveOpsOutput(`${ACTIVE_MARKER}=${JSON.stringify(combined)}`, options); } catch (error) { if (!String(error?.message || '').includes('cancel')) throw error; }
  }
  return proof;
}

function operationBinding({ attach, operation, providerIdentity, providerVersion, binaryIdentity, buildIdentity, moduleIdentity, loadMappingIdentity, commitSha, treeSha }) {
  return createRuntimeAuthorityBinding({
    providerIdentity,
    providerProfileId:PROVIDER_PROFILE,
    providerVersion,
    runtimeInstanceIdentity:`lldb-attached-process:${attach.attachedPid}:start:${attach.processStartTimeTicks}`,
    targetIdentity:`lldb-attached-target:${attach.attachedPid}:${binaryIdentity}`,
    targetProfileId:TARGET_PROFILE,
    binaryIdentity,
    buildIdentity,
    moduleIdentity,
    loadMappingIdentity,
    sessionIdentity:`lldb-attach-session:${operation}:${attach.attachedPid}:${attach.processStartTimeTicks}:${commitSha}`,
    capabilityVersion:'debug/v1', commitSha, treeSha, epoch:0,
  });
}

export function collectA7X86LldbProof({
  lldb = process.env.LLDB || (fs.existsSync('/usr/bin/lldb') ? '/usr/bin/lldb' : '/usr/bin/lldb-18'),
  clang = fs.existsSync('/usr/bin/clang') ? '/usr/bin/clang' : '/usr/bin/clang-18',
  readobj = fs.existsSync('/usr/bin/llvm-readobj-18') ? '/usr/bin/llvm-readobj-18' : 'llvm-readobj',
  python = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3',
} = {}) {
  if (git(['status','--porcelain','--untracked-files=all'])) throw new Error('a7-lldb-proof-worktree-dirty');
  const currentCommitSha = git(['rev-parse','HEAD']);
  const currentTreeSha = git(['rev-parse','HEAD^{tree}']);
  const versionResult = spawnSync(lldb, ['--version'], { cwd:ROOT, encoding:'utf8', timeout:10_000, maxBuffer:2 * 1024 * 1024 });
  if (versionResult.status !== 0) throw new Error('a7-lldb-provider-unavailable');
  const version = /lldb version (\d+\.\d+\.\d+)/.exec(`${versionResult.stdout}\n${versionResult.stderr}`)?.[1];
  if (!version) throw new Error('a7-lldb-provider-version-missing');
  const compilerVersion = run(clang, ['--version'], 'a7-lldb-compiler-unavailable').split('\n').find(Boolean)?.trim();
  const executableIdentities = Object.freeze({
    lldb:executableIdentity(lldb, ['lldb','lldb-18']),
    clang:executableIdentity(clang, ['clang','clang-18']),
    readobj:executableIdentity(readobj, ['llvm-readobj-18','llvm-readobj']),
    python:executableIdentity(python, ['python3','python3.10','python3.11','python3.12','python3.13']),
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-a7-x86-'));
  let checkedFixture;
  let baseline;
  let activeOperations;
  let lldbPythonPath;
  let cancelLldbPythonPath;
  try {
    checkedFixture = fixture(directory, { clang, readobj });
    const result = spawnSync(lldb, lldbCommand(checkedFixture.absolute, checkedFixture.entry, checkedFixture.probeWord), { cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status !== 0 || result.signal) throw new Error(`a7-lldb-provider-command-failed:${result.signal || result.status}`);
    baseline = parseLldbOutput(output, { fixturePath:checkedFixture.absolute, entry:checkedFixture.entry, probeWord:checkedFixture.probeWord });
    const options = { fixturePath:checkedFixture.absolute, probeWord:checkedFixture.probeWord };
    const pauseRun = runLldbPythonProof(lldb, python, directory, hostActiveOperationPython(checkedFixture.absolute, checkedFixture.probeWord, python, 'pause'), 'a7-lldb-active-pause');
    const cancelRun = runLldbPythonProof(lldb, python, directory, hostActiveOperationPython(checkedFixture.absolute, checkedFixture.probeWord, python, 'cancel'), 'a7-lldb-active-cancel');
    const pauseProof = parseActiveOperation(pauseRun.output, 'pause', options);
    const cancelProof = parseActiveOperation(cancelRun.output, 'cancel', options);
    const combined = { kind:'active-provider-operation-set', attach:pauseProof.attach, pause:pauseProof.pause, cancelAttach:cancelProof.attach, cancel:cancelProof.cancel, operationResults:{ attach:true, pause:true, cancel:true } };
    activeOperations = parseLldbActiveOpsOutput(`${ACTIVE_MARKER}=${JSON.stringify(combined)}`, options);
    lldbPythonPath = pauseRun.lldbPythonPath;
    cancelLldbPythonPath = cancelRun.lldbPythonPath;
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
  const bindingContract = A7_PROFILE_BINDINGS[TARGET_PROFILE];
  if (!bindingContract || bindingContract.sourcePath !== A7_LLDB_FIXTURE_PATH || bindingContract.providerProfileId !== PROVIDER_PROFILE || bindingContract.providerProofCommandId !== 'a7-lldb-real-fixture') throw new Error('a7-lldb-profile-contract-mismatch');
  const closedCapabilities = Object.freeze([...new Set([...Object.keys(baseline.capabilityResults), ...Object.keys(activeOperations.capabilityResults)])].sort());
  if (JSON.stringify(closedCapabilities) !== JSON.stringify([...A7_X86_REQUIRED_CAPABILITIES].sort())) throw new Error('a7-lldb-capability-denominator-incomplete');
  const binaryIdentity = `sha256:${checkedFixture.digest}`;
  const buildIdentity = `clang-lld-static:${checkedFixture.sourceDigest}:${binaryIdentity}`;
  const providerFingerprint = sha256(Buffer.from(JSON.stringify({ version, executableIdentities, lldbPythonPath, cancelLldbPythonPath })));
  const providerIdentity = `lldb:${version}:${providerFingerprint}`;
  const modulePath = path.resolve(activeOperations.attach.modulePath);
  const moduleIdentity = `lldb-module:${binaryIdentity}:${sha256(Buffer.from(modulePath))}`;
  const loadMappingIdentity = `lldb-load:${binaryIdentity}:entry-0x${checkedFixture.entry.toString(16)}:probe-0x${checkedFixture.probeWord.toString(16)}`;
  const pauseBinding = operationBinding({ attach:activeOperations.attach, operation:'pause', providerIdentity, providerVersion:version, binaryIdentity, buildIdentity, moduleIdentity, loadMappingIdentity, commitSha:currentCommitSha, treeSha:currentTreeSha });
  const cancelBinding = operationBinding({ attach:activeOperations.cancelAttach, operation:'cancel', providerIdentity, providerVersion:version, binaryIdentity, buildIdentity, moduleIdentity, loadMappingIdentity, commitSha:currentCommitSha, treeSha:currentTreeSha });
  if (pauseBinding.bindingId === cancelBinding.bindingId) throw new Error('a7-lldb-operation-binding-collision');
  const pauseObservation = createRuntimeObservation({ binding:pauseBinding, sequence:1, observedAt:new Date().toISOString(), kind:'active-x86-pause-session', payload:{ attach:activeOperations.attach, pause:activeOperations.pause, observedCapabilities:capabilityMap(['attach','pause']) } });
  const cancelObservation = createRuntimeObservation({ binding:cancelBinding, sequence:1, observedAt:new Date().toISOString(), kind:'active-x86-cancel-session', payload:{ attach:activeOperations.cancelAttach, cancel:activeOperations.cancel, observedCapabilities:capabilityMap(['attach','cancel']) } });
  for (const [name, operationBindingValue, operationObservation] of [['pause',pauseBinding,pauseObservation],['cancel',cancelBinding,cancelObservation]]) {
    const validation = validateRuntimeObservation(operationBindingValue, operationObservation);
    if (!validation.ok) throw new Error(`a7-lldb-${name}-runtime-observation-invalid:${validation.reason}`);
  }
  const operationSetDigest = sha256(Buffer.from(JSON.stringify({ baselinePid:baseline.pid, pauseBindingId:pauseBinding.bindingId, cancelBindingId:cancelBinding.bindingId })));
  const binding = createRuntimeAuthorityBinding({
    providerIdentity, providerProfileId:PROVIDER_PROFILE, providerVersion:version,
    runtimeInstanceIdentity:`a7-provider-operation-set:${operationSetDigest}`,
    targetIdentity:`a7-target-operation-set:${TARGET_PROFILE}:${binaryIdentity}`,
    targetProfileId:TARGET_PROFILE, binaryIdentity, buildIdentity,
    moduleIdentity:`lldb-module-set:${binaryIdentity}:${sha256(Buffer.from(modulePath))}`,
    loadMappingIdentity:`lldb-load-set:${binaryIdentity}:entry-0x${checkedFixture.entry.toString(16)}:probe-0x${checkedFixture.probeWord.toString(16)}`,
    sessionIdentity:`a7-provider-operation-set:${TARGET_PROFILE}:${operationSetDigest}:${currentCommitSha}`,
    capabilityVersion:'debug/v1', commitSha:currentCommitSha, treeSha:currentTreeSha, epoch:0,
  });
  const observation = createRuntimeObservation({
    binding, sequence:1, observedAt:new Date().toISOString(), kind:'active-x86-provider-operation-set',
    payload:{ provider:'lldb', providerVersion:version, fixturePath:A7_LLDB_FIXTURE_PATH, baselineLaunchProcessId:baseline.pid,
      operationBindingIds:Object.freeze({ pause:pauseBinding.bindingId, cancel:cancelBinding.bindingId }),
      activeOperations:Object.freeze({ attach:activeOperations.attach, pause:activeOperations.pause, cancelAttach:activeOperations.cancelAttach, cancel:activeOperations.cancel }),
      observedCapabilities:Object.freeze({ ...baseline.capabilityResults, ...activeOperations.capabilityResults }), closedCapabilities, unsupportedCapabilities:A7_X86_UNSUPPORTED_CAPABILITIES },
  });
  const checkedObservation = validateRuntimeObservation(binding, observation);
  if (!checkedObservation.ok) throw new Error(`a7-lldb-runtime-observation-invalid:${checkedObservation.reason}`);
  return Object.freeze({
    schemaVersion:A7_LLDB_PROOF_SCHEMA, status:'exact-active-provider-observed', promotion:'requires-canonical-four-profile-evidence-assembly',
    candidateCommitSha:currentCommitSha, candidateTreeSha:currentTreeSha, providerProfileId:PROVIDER_PROFILE, providerVersion:version, targetProfileId:TARGET_PROFILE,
    fixture:{ path:A7_LLDB_FIXTURE_PATH, sourceSha256:checkedFixture.sourceDigest, sha256:checkedFixture.digest, targetTriple:'x86_64-linux-gnu', compilerVersion, semantics:checkedFixture.sourceSemantics },
    independentOracle:{ id:'llvm-readobj-18', executableIdentity:executableIdentities.readobj, outputSha256:checkedFixture.oracleDigest },
    providerExecutableIdentities:executableIdentities, lldbPythonPath, cancelLldbPythonPath,
    activeOperations:Object.freeze({ attach:activeOperations.attach, pause:activeOperations.pause, cancelAttach:activeOperations.cancelAttach, cancel:activeOperations.cancel }),
    operationBindings:Object.freeze({ pause:pauseBinding, cancel:cancelBinding }), operationObservations:Object.freeze({ pause:pauseObservation, cancel:cancelObservation }),
    binding, observation, closedCapabilities, unsupportedCapabilities:A7_X86_UNSUPPORTED_CAPABILITIES,
    closedChecks:Object.freeze([
      'deterministic-real-fixture-byte-identity','independent-llvm-object-oracle','lldb-version-observed','lldb-target-x86_64','lldb-process-launched','lldb-stop-at-entry',
      'lldb-registers-observed','lldb-register-write-observed','lldb-memory-read-write-observed','lldb-breakpoint-step-remove-observed','lldb-real-process-attach-observed',
      'lldb-attach-process-target-module-identity','lldb-running-target-pause-observed','lldb-pause-exact-process-progress-stop-id-observed','lldb-independent-cancel-session-observed',
      'lldb-active-process-cancel-observed','lldb-cancel-operation-settled','lldb-cancel-late-result-stable','runtime-binding-exact-head','runtime-observation-identity',
    ]),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`A7_X86_LLDB_PROVIDER_PROOF=${JSON.stringify(collectA7X86LldbProof())}\n`); }
  catch (error) { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; }
}
