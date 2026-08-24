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
import {
  A7_ACTIVE_OPERATION_CAPABILITIES,
  A7_OBSERVED_CAPABILITIES,
  A7_PROFILE_BINDINGS,
  A7_UNSUPPORTED_CAPABILITIES,
  validateA7FixtureSource,
} from './a7-profile-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const A7_CROSS_TARGET_PROOF_SCHEMA = 'hex-stage2-a7-cross-target-provider-proof/v1';
export const A7_CROSS_TARGET_PROVIDER_PROFILE = 'native:remote-debug-v1:qemu-lldb';
export const A7_REQUIRED_CAPABILITIES = A7_OBSERVED_CAPABILITIES;
export const A7_UNSUPPORTED_PROVIDER_CAPABILITIES = A7_UNSUPPORTED_CAPABILITIES;
export const A7_CROSS_ACTIVE_OPERATION_CAPABILITIES = A7_ACTIVE_OPERATION_CAPABILITIES;
const BASELINE_CAPABILITIES = Object.freeze(A7_REQUIRED_CAPABILITIES.filter((capability) => !A7_CROSS_ACTIVE_OPERATION_CAPABILITIES.includes(capability)));
const ACTIVE_MARKER = 'A7_CROSS_ACTIVE_OPS';
const INITIAL_PROBE_VALUE = 0x1020304050607080n;

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
function capabilityMap(capabilities) { return Object.freeze(Object.fromEntries(capabilities.map((capability) => [capability, true]))); }
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
function executableIdentity(command, acceptedBasenames) {
  let resolved;
  try { resolved = fs.realpathSync(command); } catch { throw new Error(`a7-cross-provider-executable-missing:${command}`); }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || !acceptedBasenames.includes(path.basename(resolved))) throw new Error(`a7-cross-provider-executable-untrusted:${command}`);
  return Object.freeze({ path:resolved, sha256:sha256(fs.readFileSync(resolved)) });
}
function targetContract(target) {
  const binding = A7_PROFILE_BINDINGS[target.targetProfileId];
  if (!binding || binding.sourcePath !== target.sourcePath || binding.targetTriple !== target.targetTriple
    || binding.providerProfileId !== A7_CROSS_TARGET_PROVIDER_PROFILE
    || binding.providerProofCommandId !== 'a7-cross-target-real-fixtures') {
    throw new Error(`a7-cross-target-contract-mismatch:${target.targetProfileId}`);
  }
  return binding;
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
  return Object.freeze({ processId:Number(processId), outputSha256:sha256(Buffer.from(text)), capabilityResults:capabilityMap(BASELINE_CAPABILITIES) });
}

function compileAndInspect(target, directory, versions) {
  const binding = targetContract(target);
  const sourceAbsolute = path.join(ROOT, target.sourcePath);
  if (!fs.existsSync(sourceAbsolute)) throw new Error(`a7-cross-fixture-source-missing:${target.targetProfileId}`);
  const sourceBytes = fs.readFileSync(sourceAbsolute);
  const sourceSha256 = sha256(sourceBytes);
  if (!validateA7FixtureSource(target.targetProfileId, target.sourcePath, sourceSha256, sourceBytes.toString('utf8'))) throw new Error(`a7-cross-fixture-source-contract-mismatch:${target.targetProfileId}`);
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
  return Object.freeze({ path:outputA, bytes, binarySha256:sha256(bytes), sourceSha256, sourceSemantics:Object.freeze([...binding.semanticMarkers]), entry:BigInt(entryMatch), probeWord:symbolValue(readobj, 'probe_word'), oracleOutputSha256:sha256(Buffer.from(`${readobj}\n${disassembly}`)) });
}

async function runActiveTarget(target, fixture, versions) {
  const port = await reservePort();
  const qemu = spawn(versions[target.qemu], [...target.qemuCpuArgs, '-g', String(port), fixture.path], { cwd:ROOT, stdio:['ignore','pipe','pipe'] });
  let qemuError = '';
  qemu.stderr.on('data', (chunk) => { qemuError += String(chunk); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (qemu.exitCode != null) throw new Error(`a7-cross-qemu-start-failed:${target.targetProfileId}:${qemuError.trim()}`);
  const breakpoint = fixture.entry + BigInt(target.breakOffset);
  const args = ['-b','-Q','-o','settings set symbols.enable-external-lookup false','-o',`target create ${fixture.path}`,'-o',`gdb-remote 127.0.0.1:${port}`,'-o','process status','-o','target modules list','-o','thread list','-o',`register read pc sp ${target.register}`,'-o',`memory read -fx -s8 -c1 0x${fixture.probeWord.toString(16)}`,'-o',`register write ${target.register} 0x42`,'-o',`register read ${target.register}`,'-o',`memory write -s8 0x${fixture.probeWord.toString(16)} 0x8877665544332211`,'-o',`memory read -fx -s8 -c1 0x${fixture.probeWord.toString(16)}`,'-o',`breakpoint set -a 0x${breakpoint.toString(16)}`,'-o','continue','-o','thread step-inst','-o','breakpoint delete 1','-o','process kill'];
  try {
    const result = spawnSync(versions.lldb, args, { cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status !== 0 || result.signal) throw new Error(`a7-cross-lldb-command-failed:${target.targetProfileId}:${result.signal || result.status}`);
    return Object.freeze({ ...parseCrossTargetLldbOutput(output, target, { binaryPath:fixture.path, entry:fixture.entry, probeWord:fixture.probeWord }), qemuPid:qemu.pid });
  } finally { if (qemu.exitCode == null) qemu.kill('SIGKILL'); }
}

function crossActiveOpsPython(target, fixture, port, qemuPid) {
  return `
import json
import lldb
import os
import signal
import threading
import time

FIXTURE = ${JSON.stringify(fixture.path)}
PORT = ${port}
QEMU_PID = ${qemuPid}
PROBE = ${fixture.probeWord.toString()}
REGISTER = ${JSON.stringify(target.register)}
ARCH = ${JSON.stringify(target.lldbArchitecture)}
MARKER = ${JSON.stringify(ACTIVE_MARKER)}
EXPECTED_PROBE = 0x1020304050607080

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

def wait_for_process_event(listener, predicate, timeout=3.0):
    deadline = time.time() + timeout
    last = lldb.eStateInvalid
    while time.time() < deadline:
        event = lldb.SBEvent()
        if not listener.WaitForEvent(1, event):
            continue
        if not lldb.SBProcess.EventIsProcessEvent(event):
            continue
        event_process = lldb.SBProcess.GetProcessFromEvent(event)
        if not event_process.IsValid() or event_process.GetProcessID() != process.GetProcessID():
            continue
        last = lldb.SBProcess.GetStateFromEvent(event)
        if predicate(last):
            return last
    return last

def current_frame(timeout=2.0):
    deadline = time.time() + timeout
    thread = lldb.SBThread()
    while time.time() < deadline:
        thread = process.GetSelectedThread()
        if not thread.IsValid() and process.GetNumThreads() > 0:
            thread = process.GetThreadAtIndex(0)
        if thread.IsValid():
            frame = thread.GetFrameAtIndex(0)
            if frame.IsValid():
                return thread, frame
        time.sleep(0.01)
    if not thread.IsValid(): fail('thread-missing')
    fail('frame-missing')

def reg(frame, name):
    value = frame.FindRegister(name)
    if not value.IsValid(): fail('register-missing:' + name)
    return value.GetValueAsUnsigned()

def module_path(target):
    module = target.GetModuleAtIndex(0)
    if not module.IsValid(): fail('module-missing')
    spec = module.GetFileSpec()
    return os.path.realpath(os.path.join(spec.GetDirectory() or '', spec.GetFilename() or ''))

def qemu_sample(code):
    stat_path = '/proc/' + str(QEMU_PID) + '/stat'
    try:
        text = open(stat_path, 'r', encoding='utf8').read().strip()
    except BaseException as exc:
        fail(code + '-qemu-stat-read-failed:' + repr(exc))
    close = text.rfind(')')
    first_space = text.find(' ')
    if close < 0 or first_space < 0:
        fail(code + '-qemu-stat-malformed')
    try:
        pid = int(text[:first_space])
        fields = text[close + 2:].split()
        if len(fields) <= 19:
            fail(code + '-qemu-stat-short:' + str(len(fields)))
        utime = int(fields[11])
        stime = int(fields[12])
        start_time = int(fields[19])
    except BaseException as exc:
        fail(code + '-qemu-stat-invalid:' + repr(exc))
    if pid != QEMU_PID or start_time <= 0 or utime < 0 or stime < 0:
        fail(code + '-qemu-stat-identity-invalid')
    return {'pid': pid, 'startTimeTicks': start_time, 'cpuTicks': utime + stime}

def require_same_qemu(before, after, code):
    if before['pid'] != QEMU_PID or after['pid'] != QEMU_PID or before['startTimeTicks'] != after['startTimeTicks']:
        fail(code + '-qemu-instance-changed')

def require_qemu_progress(before, after, code):
    require_same_qemu(before, after, code)
    if after['cpuTicks'] <= before['cpuTicks']:
        fail(code + '-qemu-cpu-not-advanced:' + str(before['cpuTicks']) + ':' + str(after['cpuTicks']))

def read_probe(code):
    memory_error = lldb.SBError()
    value = process.ReadUnsignedFromMemory(PROBE, 8, memory_error)
    if not memory_error.Success():
        fail(code + '-memory-read-failed:' + str(memory_error))
    if value != EXPECTED_PROBE:
        fail(code + '-memory-identity-mismatch:' + hex(value))
    return value

def signal_qemu_and_wait(listener, code):
    try:
        os.kill(QEMU_PID, 0)
        os.kill(QEMU_PID, signal.SIGINT)
    except BaseException as exc:
        fail(code + '-qemu-signal-failed:' + repr(exc))
    stopped = wait_for_process_event(listener, lldb.SBDebugger.StateIsStoppedState)
    if not lldb.SBDebugger.StateIsStoppedState(stopped):
        stopped = wait_for(lldb.SBDebugger.StateIsStoppedState)
    if not lldb.SBDebugger.StateIsStoppedState(stopped):
        fail(code + '-stop-not-observed:' + state_name(stopped))
    try:
        os.kill(QEMU_PID, 0)
    except BaseException as exc:
        fail(code + '-qemu-identity-lost:' + repr(exc))
    return stopped

result = {'kind': 'active-provider-operations'}
process = None
try:
    lldb.SBDebugger.Initialize()
    debugger = lldb.SBDebugger.Create()
    debugger.SkipLLDBInitFiles(True)
    debugger.SetAsync(False)
    target = debugger.CreateTarget(FIXTURE)
    if not target.IsValid(): fail('target-create-failed')
    listener = debugger.GetListener()
    error = lldb.SBError()
    process = target.ConnectRemote(listener, 'connect://127.0.0.1:' + str(PORT), 'gdb-remote', error)
    if not error.Success() or not process.IsValid(): fail('remote-attach-failed:' + str(error))
    attached_pid = process.GetProcessID()
    if attached_pid <= 0: fail('remote-process-identity-missing')
    if not lldb.SBDebugger.StateIsStoppedState(process.GetState()): fail('remote-attach-not-stopped')
    triple = target.GetTriple() or ''
    if ARCH not in triple: fail('remote-target-architecture-mismatch:' + triple)
    if target.GetByteOrder() != lldb.eByteOrderLittle: fail('remote-target-byte-order-mismatch')
    observed_module = module_path(target)
    if observed_module != os.path.realpath(FIXTURE): fail('remote-module-mismatch')
    thread, frame = current_frame()
    attached_thread_id = thread.GetThreadID()
    pc = reg(frame, 'pc')
    sp = reg(frame, 'sp')
    operand = reg(frame, REGISTER)
    attach_qemu = qemu_sample('attach')
    probe_value = read_probe('attach')
    result['attach'] = {'observed': True, 'transport': 'gdb-remote', 'registerTransport': 'SBFrame', 'processId': attached_pid, 'qemuHostPid': QEMU_PID, 'qemuStartTimeTicks': attach_qemu['startTimeTicks'], 'qemuCpuTicks': attach_qemu['cpuTicks'], 'targetTriple': triple, 'modulePath': observed_module, 'threadId': attached_thread_id, 'registers': {'pc': hex(pc), 'sp': hex(sp), REGISTER: hex(operand)}, 'memoryProbe': hex(probe_value), 'state': state_name(process.GetState())}

    pause_stop_id_before = process.GetStopID(False)
    pause_qemu_before = qemu_sample('pause-before')
    require_same_qemu(attach_qemu, pause_qemu_before, 'pause-before')
    debugger.SetAsync(True)
    continue_error = process.Continue()
    if not continue_error.Success(): fail('pause-continue-failed:' + str(continue_error))
    running_state = wait_for_process_event(listener, lldb.SBDebugger.StateIsRunningState)
    if not lldb.SBDebugger.StateIsRunningState(running_state): fail('pause-running-event-not-observed:' + state_name(running_state))
    time.sleep(0.08)
    signal_qemu_and_wait(listener, 'pause')
    pause_stop_id_after = process.GetStopID(False)
    if pause_stop_id_after <= pause_stop_id_before: fail('pause-stop-id-not-advanced')
    pause_qemu_after = qemu_sample('pause-after')
    require_qemu_progress(pause_qemu_before, pause_qemu_after, 'pause')
    pause_probe = read_probe('pause')
    pause_module = module_path(target)
    if pause_module != observed_module: fail('pause-module-identity-changed')
    result['pause'] = {'observed': True, 'continueAccepted': True, 'interruptIssued': True, 'runningObserved': True, 'runningEvidence': 'provider-running-state-event+qemu-proc-cpu-ticks+lldb-stop-id+guest-memory', 'stoppedObserved': True, 'executionAdvanced': True, 'executionEvidence': 'qemu-proc-cpu-ticks-advanced', 'progressTransport': 'linux-proc-stat+lldb-gdb-remote-memory', 'stopIdAdvanced': True, 'stopIdBefore': pause_stop_id_before, 'stopIdAfter': pause_stop_id_after, 'processId': process.GetProcessID(), 'qemuHostPid': QEMU_PID, 'qemuStartTimeTicks': pause_qemu_after['startTimeTicks'], 'qemuCpuTicksBefore': pause_qemu_before['cpuTicks'], 'qemuCpuTicksAfter': pause_qemu_after['cpuTicks'], 'providerDisposition': 'qemu-user-sigint-observed-by-lldb', 'modulePath': pause_module, 'memoryProbe': hex(pause_probe), 'state': state_name(process.GetState())}

    cancel_stop_id_before = process.GetStopID(False)
    cancel_qemu_before = qemu_sample('cancel-before')
    require_same_qemu(pause_qemu_after, cancel_qemu_before, 'cancel-before')
    debugger.SetAsync(False)
    cancel_holder = {}
    def run_cancel_continue():
        try:
            cancel_holder['result'] = process.Continue()
        except BaseException as exc:
            cancel_holder['exception'] = repr(exc)
    cancel_worker = threading.Thread(target=run_cancel_continue, daemon=True)
    cancel_worker.start()
    time.sleep(0.05)
    if not cancel_worker.is_alive(): fail('cancel-continue-not-inflight:' + str(cancel_holder))
    cancel_running_state = wait_for_process_event(listener, lldb.SBDebugger.StateIsRunningState)
    if not lldb.SBDebugger.StateIsRunningState(cancel_running_state): fail('cancel-running-event-not-observed:' + state_name(cancel_running_state))
    time.sleep(0.08)
    signal_qemu_and_wait(listener, 'cancel')
    cancel_worker.join(3.0)
    if cancel_worker.is_alive(): fail('cancel-continue-not-settled')
    if 'exception' in cancel_holder: fail('cancel-continue-exception:' + cancel_holder['exception'])
    stopped_state = wait_for(lldb.SBDebugger.StateIsStoppedState)
    if not lldb.SBDebugger.StateIsStoppedState(stopped_state): fail('cancel-target-not-stopped:' + state_name(stopped_state))
    cancel_stop_id_after = process.GetStopID(False)
    if cancel_stop_id_after <= cancel_stop_id_before: fail('cancel-stop-id-not-advanced')
    cancel_qemu_after = qemu_sample('cancel-after')
    require_qemu_progress(cancel_qemu_before, cancel_qemu_after, 'cancel')
    cancel_probe = read_probe('cancel')
    cancel_module = module_path(target)
    if cancel_module != observed_module: fail('cancel-module-identity-changed')
    first_state = process.GetState()
    late_stop_id_before = process.GetStopID(False)
    late_qemu_before = qemu_sample('cancel-late-before')
    time.sleep(0.12)
    late_state = process.GetState()
    late_stop_id_after = process.GetStopID(False)
    late_qemu_after = qemu_sample('cancel-late-after')
    require_same_qemu(late_qemu_before, late_qemu_after, 'cancel-late')
    late_probe = read_probe('cancel-late')
    if first_state != late_state or late_stop_id_before != late_stop_id_after or late_qemu_before['cpuTicks'] != late_qemu_after['cpuTicks'] or cancel_probe != late_probe:
        fail('cancel-late-success-observed')
    result['cancel'] = {'observed': True, 'inFlightObserved': True, 'inFlightEvidence': 'blocking-continue-thread-alive+provider-running-state-event', 'executionAdvanced': True, 'executionEvidence': 'qemu-proc-cpu-ticks-advanced', 'interruptIssued': True, 'operationSettled': True, 'continueSettled': True, 'processId': process.GetProcessID(), 'qemuHostPid': QEMU_PID, 'qemuStartTimeTicks': cancel_qemu_after['startTimeTicks'], 'qemuCpuTicksBefore': cancel_qemu_before['cpuTicks'], 'qemuCpuTicksAfter': cancel_qemu_after['cpuTicks'], 'settlement': 'cancelled', 'providerDisposition': 'qemu-user-sigint-observed-by-lldb', 'progressTransport': 'linux-proc-stat+lldb-gdb-remote-memory', 'modulePath': cancel_module, 'memoryProbe': hex(cancel_probe), 'stopIdAdvanced': True, 'stopIdBefore': cancel_stop_id_before, 'stopIdAfter': cancel_stop_id_after, 'lateResultRejected': True, 'lateStateStable': True, 'lateCpuStable': True, 'lateStopIdStable': True, 'lateMemoryStable': True, 'continueResult': str(cancel_holder.get('result')), 'state': state_name(late_state)}
    result['operationResults'] = {'attach': True, 'pause': True, 'cancel': True}
except BaseException as exc:
    result['error'] = str(exc)
finally:
    try:
        if process is not None and process.IsValid() and process.GetState() not in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateInvalid): process.Kill()
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
  if (pythonPathResult.status !== 0 || !lldbPythonPath) throw new Error('a7-cross-lldb-python-provider-path-unavailable');
  const result = spawnSync(python, [scriptPath], { cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024, env:{ ...process.env, DEBUGINFOD_URLS:'', PYTHONPATH:[lldbPythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 || result.signal) throw new Error(`a7-cross-active-ops-command-failed:${result.signal || result.status}:${String(result.stderr || '').trim()}`);
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

function validQemuSample(value) {
  return Number.isSafeInteger(value?.qemuStartTimeTicks) && value.qemuStartTimeTicks > 0;
}
function validCpuAdvance(value) {
  return Number.isSafeInteger(value?.qemuCpuTicksBefore) && value.qemuCpuTicksBefore >= 0
    && Number.isSafeInteger(value?.qemuCpuTicksAfter) && value.qemuCpuTicksAfter > value.qemuCpuTicksBefore;
}

export function parseCrossTargetActiveOpsOutput(output, target, { binaryPath, probeWord, qemuPid = null } = {}) {
  const proof = parseMarker(output, ACTIVE_MARKER, 'a7-cross-active-ops');
  if (proof?.kind !== 'active-provider-operations') throw new Error('a7-cross-active-ops-kind-mismatch');
  const attach = proof.attach || {};
  const pause = proof.pause || {};
  const cancel = proof.cancel || {};
  if (proof.operationResults?.attach !== true || attach.observed !== true || attach.transport !== 'gdb-remote') throw new Error('a7-cross-attach-not-observed');
  if (!Number.isSafeInteger(attach.processId) || attach.processId <= 0) throw new Error('a7-cross-attach-process-identity-missing');
  if (qemuPid != null && attach.qemuHostPid !== qemuPid) throw new Error('a7-cross-attach-qemu-identity-mismatch');
  if (!validQemuSample(attach)) throw new Error('a7-cross-attach-qemu-instance-identity-missing');
  if (!String(attach.targetTriple || '').includes(target.lldbArchitecture)) throw new Error('a7-cross-attach-target-identity-mismatch');
  if (binaryPath != null && path.resolve(String(attach.modulePath || '')) !== path.resolve(binaryPath)) throw new Error('a7-cross-attach-module-identity-mismatch');
  if (attach.registerTransport !== 'SBFrame' || !attach.registers?.pc || !attach.registers?.sp || !Object.prototype.hasOwnProperty.call(attach.registers, target.register)) throw new Error('a7-cross-attach-register-observation-missing');
  if (probeWord != null && String(attach.memoryProbe || '').toLowerCase() !== `0x${INITIAL_PROBE_VALUE.toString(16)}`) throw new Error('a7-cross-attach-memory-observation-missing');

  if (proof.operationResults?.pause !== true || pause.observed !== true || pause.runningObserved !== true || pause.stoppedObserved !== true || pause.executionAdvanced !== true || pause.continueAccepted !== true || pause.interruptIssued !== true || pause.stopIdAdvanced !== true) throw new Error('a7-cross-pause-not-observed');
  if (pause.runningEvidence !== 'provider-running-state-event+qemu-proc-cpu-ticks+lldb-stop-id+guest-memory' || pause.executionEvidence !== 'qemu-proc-cpu-ticks-advanced' || pause.providerDisposition !== 'qemu-user-sigint-observed-by-lldb' || pause.progressTransport !== 'linux-proc-stat+lldb-gdb-remote-memory') throw new Error('a7-cross-pause-running-evidence-missing');
  if (qemuPid != null && pause.qemuHostPid !== qemuPid) throw new Error('a7-cross-pause-qemu-identity-mismatch');
  if (!validQemuSample(pause) || pause.qemuStartTimeTicks !== attach.qemuStartTimeTicks) throw new Error('a7-cross-pause-qemu-instance-identity-mismatch');
  if (!validCpuAdvance(pause)) throw new Error('a7-cross-pause-execution-progress-missing');
  if (!Number.isSafeInteger(pause.stopIdBefore) || !Number.isSafeInteger(pause.stopIdAfter) || pause.stopIdAfter <= pause.stopIdBefore) throw new Error('a7-cross-pause-stop-id-evidence-missing');
  if (pause.processId !== attach.processId || pause.modulePath !== attach.modulePath || pause.memoryProbe !== attach.memoryProbe) throw new Error('a7-cross-pause-session-identity-mismatch');

  if (proof.operationResults?.cancel !== true || cancel.observed !== true || cancel.inFlightObserved !== true || cancel.interruptIssued !== true || cancel.executionAdvanced !== true) throw new Error('a7-cross-cancel-not-observed');
  if (cancel.inFlightEvidence !== 'blocking-continue-thread-alive+provider-running-state-event') throw new Error('a7-cross-cancel-inflight-evidence-missing');
  if (cancel.operationSettled !== true || cancel.continueSettled !== true || cancel.stopIdAdvanced !== true || cancel.settlement !== 'cancelled' || cancel.providerDisposition !== 'qemu-user-sigint-observed-by-lldb' || cancel.progressTransport !== 'linux-proc-stat+lldb-gdb-remote-memory' || cancel.executionEvidence !== 'qemu-proc-cpu-ticks-advanced' || cancel.lateResultRejected !== true || cancel.lateStateStable !== true || cancel.lateCpuStable !== true || cancel.lateStopIdStable !== true || cancel.lateMemoryStable !== true) throw new Error('a7-cross-cancel-settlement-missing');
  if (qemuPid != null && cancel.qemuHostPid !== qemuPid) throw new Error('a7-cross-cancel-qemu-identity-mismatch');
  if (!validQemuSample(cancel) || cancel.qemuStartTimeTicks !== attach.qemuStartTimeTicks) throw new Error('a7-cross-cancel-qemu-instance-identity-mismatch');
  if (!validCpuAdvance(cancel)) throw new Error('a7-cross-cancel-execution-progress-missing');
  if (!Number.isSafeInteger(cancel.stopIdBefore) || !Number.isSafeInteger(cancel.stopIdAfter) || cancel.stopIdAfter <= cancel.stopIdBefore) throw new Error('a7-cross-cancel-stop-id-evidence-missing');
  if (cancel.processId !== attach.processId || cancel.modulePath !== attach.modulePath || cancel.memoryProbe !== attach.memoryProbe) throw new Error('a7-cross-cancel-session-identity-mismatch');
  return Object.freeze({ ...proof, operationResults:Object.freeze({ attach:true, pause:true, cancel:true }), capabilityResults:capabilityMap(A7_CROSS_ACTIVE_OPERATION_CAPABILITIES) });
}

async function runActiveOperationTarget(target, fixture, versions, directory) {
  const port = await reservePort();
  const qemu = spawn(versions[target.qemu], [...target.qemuCpuArgs, '-g', String(port), fixture.path], { cwd:ROOT, stdio:['ignore','pipe','pipe'] });
  let qemuError = '';
  qemu.stderr.on('data', (chunk) => { qemuError += String(chunk); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (qemu.exitCode != null) throw new Error(`a7-cross-active-qemu-start-failed:${target.targetProfileId}:${qemuError.trim()}`);
  try {
    const stem = `a7-cross-active-${target.targetProfileId.replaceAll(/[^a-z0-9]+/gi, '-')}`;
    const activeRun = runLldbPythonProof(versions.lldb, versions.python, directory, crossActiveOpsPython(target, fixture, port, qemu.pid), stem);
    return Object.freeze({ ...parseCrossTargetActiveOpsOutput(activeRun.output, target, { binaryPath:fixture.path, probeWord:fixture.probeWord, qemuPid:qemu.pid }), qemuPid:qemu.pid, lldbPythonPath:activeRun.lldbPythonPath });
  } finally { if (qemu.exitCode == null) qemu.kill('SIGKILL'); }
}

export async function collectA7CrossTargetProofs({ requireClean = true } = {}) {
  if (requireClean && git(['status','--porcelain','--untracked-files=all'])) throw new Error('a7-cross-proof-worktree-dirty');
  const commitSha = git(['rev-parse','HEAD']);
  const treeSha = git(['rev-parse','HEAD^{tree}']);
  const versions = Object.freeze({ clang:executable('clang'), lldb:executable('lldb'), python:executable('python3'), readobj:executable('llvm-readobj-18'), objdump:executable('llvm-objdump-18'), 'qemu-aarch64':executable('qemu-aarch64'), 'qemu-riscv64':executable('qemu-riscv64') });
  for (const target of A7_CROSS_TARGETS) targetContract(target);
  const executableBasenames = Object.freeze({ clang:['clang','clang-18'], lldb:['lldb','lldb-18'], python:['python3','python3.10','python3.11','python3.12','python3.13'], readobj:['llvm-readobj-18','llvm-readobj'], objdump:['llvm-objdump-18','llvm-objdump'], 'qemu-aarch64':['qemu-aarch64'], 'qemu-riscv64':['qemu-riscv64'] });
  const expectedCrossProfiles = ['arm64:a64', 'arm64e:a64+pac', 'riscv64:rv64imc'];
  const actualCrossProfiles = A7_CROSS_TARGETS.map((target) => target.targetProfileId).sort();
  if (JSON.stringify(actualCrossProfiles) !== JSON.stringify(expectedCrossProfiles.sort())) throw new Error('a7-cross-target-profile-set-mismatch');
  const versionIdentities = Object.freeze(Object.fromEntries(Object.entries(versions).map(([id, command]) => [id, commandVersion(command)])));
  const executableIdentities = Object.freeze(Object.fromEntries(Object.entries(versions).map(([id, command]) => [id, executableIdentity(command, executableBasenames[id])] )));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-a7-cross-'));
  const proofs = [];
  try {
    for (const target of A7_CROSS_TARGETS) {
      const fixture = compileAndInspect(target, directory, versions);
      const observed = await runActiveTarget(target, fixture, versions);
      const activeOperations = await runActiveOperationTarget(target, fixture, versions, directory);
      const closedCapabilities = Object.freeze([...new Set([...Object.keys(observed.capabilityResults), ...Object.keys(activeOperations.capabilityResults)])].sort());
      if (JSON.stringify(closedCapabilities) !== JSON.stringify([...A7_REQUIRED_CAPABILITIES].sort())) throw new Error(`a7-cross-capability-denominator-incomplete:${target.targetProfileId}`);
      const binaryIdentity = `sha256:${fixture.binarySha256}`;
      const providerVersion = `${versionIdentities.lldb};${versionIdentities[target.qemu]}`;
      const providerFingerprint = sha256(Buffer.from(JSON.stringify({ providerVersion, lldb:executableIdentities.lldb, qemu:executableIdentities[target.qemu], python:executableIdentities.python, lldbPythonPath:activeOperations.lldbPythonPath })));
      const runtimeInstanceIdentity = `qemu-user-process:${activeOperations.qemuPid}:start:${activeOperations.attach.qemuStartTimeTicks}`;
      const binding = createRuntimeAuthorityBinding({ providerIdentity:`lldb-gdb-remote+${target.qemu}:${providerFingerprint}`, providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, providerVersion, runtimeInstanceIdentity, targetIdentity:`qemu-user-target:${target.targetProfileId}:${activeOperations.attach.processId}:${binaryIdentity}`, targetProfileId:target.targetProfileId, binaryIdentity, buildIdentity:`clang-lld-static:${fixture.sourceSha256}:${binaryIdentity}`, moduleIdentity:`lldb-module:${target.targetProfileId}:${binaryIdentity}:${sha256(Buffer.from(path.resolve(activeOperations.attach.modulePath)))}`, loadMappingIdentity:`lldb-load:${target.targetProfileId}:${binaryIdentity}:entry-0x${fixture.entry.toString(16)}:probe-0x${fixture.probeWord.toString(16)}`, sessionIdentity:`lldb-gdb-remote:${target.targetProfileId}:${activeOperations.attach.processId}:${commitSha}`, capabilityVersion:'debug/v1', commitSha, treeSha, epoch:0 });
      const observation = createRuntimeObservation({ binding, sequence:1, observedAt:new Date().toISOString(), kind:'active-cross-target-debug-session', payload:{ targetProfileId:target.targetProfileId, providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, outputSha256:observed.outputSha256, processIdentity:activeOperations.attach.processId, qemuHostPid:activeOperations.qemuPid, qemuStartTimeTicks:activeOperations.attach.qemuStartTimeTicks, modulePath:path.resolve(activeOperations.attach.modulePath), attach:activeOperations.attach, pause:activeOperations.pause, cancel:activeOperations.cancel, observedCapabilities:Object.freeze({ ...observed.capabilityResults, ...activeOperations.capabilityResults }), closedCapabilities, unsupportedCapabilities:A7_UNSUPPORTED_CAPABILITIES } });
      const validation = validateRuntimeObservation(binding, observation);
      if (!validation.ok) throw new Error(`a7-cross-runtime-observation-invalid:${target.targetProfileId}:${validation.reason}`);
      proofs.push(Object.freeze({ schemaVersion:A7_CROSS_TARGET_PROOF_SCHEMA, status:'exact-active-provider-observed', candidateCommitSha:commitSha, candidateTreeSha:treeSha, targetProfileId:target.targetProfileId, providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, providerVersion, fixture:Object.freeze({ sourcePath:target.sourcePath, sourceSha256:fixture.sourceSha256, binarySha256:fixture.binarySha256, targetTriple:target.targetTriple, semantics:fixture.sourceSemantics }), independentOracle:Object.freeze({ id:'llvm-readobj+llvm-objdump-18', executableIdentities:Object.freeze({ readobj:executableIdentities.readobj, objdump:executableIdentities.objdump }), outputSha256:fixture.oracleOutputSha256 }), lldbPythonPath:activeOperations.lldbPythonPath, activeOperations:Object.freeze({ attach:activeOperations.attach, pause:activeOperations.pause, cancel:activeOperations.cancel }), binding, observation, closedCapabilities, unsupportedCapabilities:A7_UNSUPPORTED_CAPABILITIES }));
    }
  } finally { fs.rmSync(directory, { recursive:true, force:true }); }
  return Object.freeze({ schemaVersion:A7_CROSS_TARGET_PROOF_SCHEMA, candidateCommitSha:commitSha, candidateTreeSha:treeSha, providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, versionIdentities, executableIdentities, proofs:Object.freeze(proofs) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const proof = await collectA7CrossTargetProofs(); process.stdout.write(`A7_CROSS_TARGET_PROVIDER_PROOF=${JSON.stringify(proof)}\n`); }
  catch (error) { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; }
}
