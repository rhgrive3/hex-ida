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
  return Object.freeze({
    processId:Number(processId),
    outputSha256:sha256(Buffer.from(text)),
    capabilityResults:capabilityMap(BASELINE_CAPABILITIES),
  });
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
  return Object.freeze({
    path:outputA, bytes, binarySha256:sha256(bytes), sourceSha256,
    sourceSemantics:Object.freeze([...binding.semanticMarkers]),
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

function crossActiveOpsPython(target, fixture, port) {
  return `
import json
import lldb
import os
import threading
import time

FIXTURE = ${JSON.stringify(fixture.path)}
PORT = ${port}
PROBE = ${fixture.probeWord.toString()}
REGISTER = ${JSON.stringify(target.register)}
ARCH = ${JSON.stringify(target.lldbArchitecture)}
MARKER = ${JSON.stringify('A7_CROSS_ACTIVE_OPS')}

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
    return os.path.realpath(os.path.join(spec.GetDirectory() or '', spec.GetFilename() or ''))

result = {'kind': 'active-provider-operations'}
process = None
try:
    lldb.SBDebugger.Initialize()
    debugger = lldb.SBDebugger.Create()
    debugger.SkipLLDBInitFiles(True)
    debugger.SetAsync(False)
    target = debugger.CreateTarget(FIXTURE)
    if not target.IsValid():
        fail('target-create-failed')
    error = lldb.SBError()
    process = target.ConnectRemote(debugger.GetListener(), 'connect://127.0.0.1:' + str(PORT), 'gdb-remote', error)
    if not error.Success() or not process.IsValid():
        fail('remote-attach-failed:' + str(error))
    attached_pid = process.GetProcessID()
    if attached_pid <= 0:
        fail('remote-process-identity-missing')
    if not lldb.SBDebugger.StateIsStoppedState(process.GetState()):
        fail('remote-attach-not-stopped')
    triple = target.GetTriple() or ''
    if ARCH not in triple:
        fail('remote-target-architecture-mismatch:' + triple)
    observed_module = module_path(target)
    if observed_module != os.path.realpath(FIXTURE):
        fail('remote-module-mismatch')
    thread, frame = current_frame()
    pc = reg(frame, 'pc')
    sp = reg(frame, 'sp')
    operand = reg(frame, REGISTER)
    memory_error = lldb.SBError()
    probe_value = process.ReadUnsignedFromMemory(PROBE, 8, memory_error)
    if not memory_error.Success() or probe_value != 0x1020304050607080:
        fail('remote-memory-mismatch')
    result['attach'] = {
        'observed': True, 'transport': 'gdb-remote', 'processId': attached_pid,
        'targetTriple': triple, 'modulePath': observed_module, 'threadId': thread.GetThreadID(),
        'registers': {'pc': hex(pc), 'sp': hex(sp), REGISTER: hex(operand)},
        'memoryProbe': hex(probe_value), 'state': state_name(process.GetState()),
    }

    before_operand = operand
    debugger.SetAsync(True)
    continue_error = process.Continue()
    if not continue_error.Success():
        fail('pause-continue-failed:' + str(continue_error))
    time.sleep(0.05)
    stop_error = process.Stop()
    if not stop_error.Success():
        fail('pause-stop-failed:' + str(stop_error))
    stopped_state = wait_for(lldb.SBDebugger.StateIsStoppedState)
    if not lldb.SBDebugger.StateIsStoppedState(stopped_state):
        fail('pause-stop-not-observed:' + state_name(stopped_state))
    thread, frame = current_frame()
    pause_pc = reg(frame, 'pc')
    pause_sp = reg(frame, 'sp')
    pause_operand = reg(frame, REGISTER)
    if pause_operand == before_operand:
        fail('pause-no-execution-observed')
    result['pause'] = {
        'observed': True, 'continueAccepted': True, 'stopAccepted': True,
        'runningObserved': True, 'runningEvidence': 'continue-success+register-progress',
        'stoppedObserved': True, 'executionAdvanced': True,
        'processId': process.GetProcessID(), 'threadId': thread.GetThreadID(),
        'registers': {'pc': hex(pause_pc), 'sp': hex(pause_sp), REGISTER: hex(pause_operand)},
        'state': state_name(process.GetState()),
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
    time.sleep(0.05)
    if not worker.is_alive():
        fail('cancel-command-not-inflight')
    if not interpreter.InterruptCommand():
        fail('cancel-interrupt-not-accepted')
    worker.join(3.0)
    if worker.is_alive():
        fail('cancel-command-not-settled')
    stopped_state = wait_for(lldb.SBDebugger.StateIsStoppedState)
    if not lldb.SBDebugger.StateIsStoppedState(stopped_state):
        fail('cancel-target-not-stopped:' + state_name(stopped_state))
    thread, frame = current_frame()
    cancel_pc = reg(frame, 'pc')
    cancel_operand = reg(frame, REGISTER)
    if cancel_operand == pause_operand:
        fail('cancel-no-execution-observed')
    first_state = process.GetState()
    time.sleep(0.10)
    thread2, frame2 = current_frame()
    late_pc = reg(frame2, 'pc')
    late_operand = reg(frame2, REGISTER)
    late_state = process.GetState()
    if first_state != late_state or cancel_pc != late_pc or cancel_operand != late_operand:
        fail('cancel-late-success-observed')
    result['cancel'] = {
        'observed': True, 'inFlightObserved': True, 'inFlightEvidence': 'blocking-command-thread-alive',
        'executionAdvanced': True, 'interruptAccepted': True,
        'interpreterWasInterrupted': bool(interpreter.WasInterrupted()), 'commandSettled': True,
        'processId': process.GetProcessID(), 'threadId': thread.GetThreadID(), 'settlement': 'cancelled', 'providerDisposition': 'interrupted-command',
        'lateResultRejected': True, 'lateStateStable': True,
        'registers': {'pc': hex(cancel_pc), REGISTER: hex(cancel_operand)}, 'state': state_name(late_state),
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
        if 'debugger' in globals():
            lldb.SBDebugger.Destroy(debugger)
        lldb.SBDebugger.Terminate()
    except BaseException:
        pass
print(MARKER + '=' + json.dumps(result, sort_keys=True))
`;
}

function runLldbPythonProof(lldb, python, directory, pythonSource, stem) {
  const scriptPath = path.join(directory, `${stem}.py`);
  fs.writeFileSync(scriptPath, pythonSource, { encoding:'utf8', mode:0o600 });
  const pythonPathResult = spawnSync(lldb, ['-P'], { cwd:ROOT, encoding:'utf8', timeout:10_000, maxBuffer:2 * 1024 * 1024 });
  const lldbPythonPath = String(pythonPathResult.stdout || '').trim();
  if (pythonPathResult.status !== 0 || !lldbPythonPath) throw new Error('a7-cross-lldb-python-provider-path-unavailable');
  const result = spawnSync(python, [scriptPath], {
    cwd:ROOT, encoding:'utf8', timeout:30_000, maxBuffer:16 * 1024 * 1024,
    env:{ ...process.env, DEBUGINFOD_URLS:'', PYTHONPATH:[lldbPythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
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

export function parseCrossTargetActiveOpsOutput(output, target, { binaryPath, probeWord } = {}) {
  const proof = parseMarker(output, ACTIVE_MARKER, 'a7-cross-active-ops');
  if (proof?.kind !== 'active-provider-operations') throw new Error('a7-cross-active-ops-kind-mismatch');
  const attach = proof.attach || {};
  const pause = proof.pause || {};
  const cancel = proof.cancel || {};
  if (proof.operationResults?.attach !== true || attach.observed !== true || attach.transport !== 'gdb-remote') throw new Error('a7-cross-attach-not-observed');
  if (!Number.isSafeInteger(attach.processId) || attach.processId <= 0) throw new Error('a7-cross-attach-process-identity-missing');
  if (!String(attach.targetTriple || '').includes(target.lldbArchitecture)) throw new Error('a7-cross-attach-target-identity-mismatch');
  if (binaryPath != null && path.resolve(String(attach.modulePath || '')) !== path.resolve(binaryPath)) throw new Error('a7-cross-attach-module-identity-mismatch');
  if (!attach.registers?.pc || !attach.registers?.sp || !Object.prototype.hasOwnProperty.call(attach.registers, target.register)) throw new Error('a7-cross-attach-register-observation-missing');
  if (probeWord != null && String(attach.memoryProbe || '').toLowerCase() !== '0x1020304050607080') throw new Error('a7-cross-attach-memory-observation-missing');
  if (proof.operationResults?.pause !== true || pause.observed !== true || pause.runningObserved !== true || pause.stoppedObserved !== true || pause.executionAdvanced !== true || pause.continueAccepted !== true || pause.stopAccepted !== true) throw new Error('a7-cross-pause-not-observed');
  if (pause.runningEvidence !== 'continue-success+register-progress') throw new Error('a7-cross-pause-running-evidence-missing');
  if (pause.processId !== attach.processId || !pause.registers?.pc || !Object.prototype.hasOwnProperty.call(pause.registers, target.register)) throw new Error('a7-cross-pause-session-identity-mismatch');
  if (proof.operationResults?.cancel !== true || cancel.observed !== true || cancel.inFlightObserved !== true || cancel.interruptAccepted !== true || cancel.executionAdvanced !== true) throw new Error('a7-cross-cancel-not-observed');
  if (cancel.inFlightEvidence !== 'blocking-command-thread-alive') throw new Error('a7-cross-cancel-inflight-evidence-missing');
  if (cancel.commandSettled !== true || cancel.settlement !== 'cancelled' || cancel.providerDisposition !== 'interrupted-command' || cancel.lateResultRejected !== true || cancel.lateStateStable !== true) throw new Error('a7-cross-cancel-settlement-missing');
  if (cancel.processId !== attach.processId || !cancel.registers?.pc || !Object.prototype.hasOwnProperty.call(cancel.registers, target.register)) throw new Error('a7-cross-cancel-session-identity-mismatch');
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
    const activeRun = runLldbPythonProof(versions.lldb, versions.python, directory, crossActiveOpsPython(target, fixture, port), stem);
    return Object.freeze({ ...parseCrossTargetActiveOpsOutput(activeRun.output, target, { binaryPath:fixture.path, probeWord:fixture.probeWord }), qemuPid:qemu.pid, lldbPythonPath:activeRun.lldbPythonPath });
  } finally {
    if (qemu.exitCode == null) qemu.kill('SIGKILL');
  }
}

export async function collectA7CrossTargetProofs({ requireClean = true } = {}) {
  if (requireClean && git(['status','--porcelain','--untracked-files=all'])) throw new Error('a7-cross-proof-worktree-dirty');
  const commitSha = git(['rev-parse','HEAD']);
  const treeSha = git(['rev-parse','HEAD^{tree}']);
  const versions = Object.freeze({
    clang:executable('clang'), lldb:executable('lldb'), python:executable('python3'), readobj:executable('llvm-readobj-18'), objdump:executable('llvm-objdump-18'),
    'qemu-aarch64':executable('qemu-aarch64'), 'qemu-riscv64':executable('qemu-riscv64'),
  });
  for (const target of A7_CROSS_TARGETS) targetContract(target);
  const executableBasenames = Object.freeze({
    clang:['clang','clang-18'], lldb:['lldb','lldb-18'], python:['python3','python3.10','python3.11','python3.12','python3.13'], readobj:['llvm-readobj-18','llvm-readobj'], objdump:['llvm-objdump-18','llvm-objdump'],
    'qemu-aarch64':['qemu-aarch64'], 'qemu-riscv64':['qemu-riscv64'],
  });
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
      const providerFingerprint = sha256(Buffer.from(JSON.stringify({
        providerVersion,
        lldb:executableIdentities.lldb,
        qemu:executableIdentities[target.qemu],
        python:executableIdentities.python,
        lldbPythonPath:activeOperations.lldbPythonPath,
      })));
      const binding = createRuntimeAuthorityBinding({
        providerIdentity:`lldb-gdb-remote+${target.qemu}:${providerFingerprint}`,
        providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE,
        providerVersion,
        runtimeInstanceIdentity:`qemu-user-process:${activeOperations.qemuPid}`,
        targetIdentity:`qemu-user-target:${target.targetProfileId}:${activeOperations.attach.processId}:${binaryIdentity}`,
        targetProfileId:target.targetProfileId,
        binaryIdentity,
        buildIdentity:`clang-lld-static:${fixture.sourceSha256}:${binaryIdentity}`,
        moduleIdentity:`lldb-module:${target.targetProfileId}:${binaryIdentity}:${sha256(Buffer.from(path.resolve(activeOperations.attach.modulePath)))}`,
        loadMappingIdentity:`lldb-load:${target.targetProfileId}:${binaryIdentity}:${activeOperations.pause.registers.pc}`,
        sessionIdentity:`lldb-gdb-remote:${target.targetProfileId}:${activeOperations.attach.processId}:${commitSha}`,
        capabilityVersion:'debug/v1', commitSha, treeSha, epoch:0,
      });
      const observation = createRuntimeObservation({
        binding, sequence:1, observedAt:new Date().toISOString(), kind:'active-cross-target-debug-session',
        payload:{ targetProfileId:target.targetProfileId, providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, outputSha256:observed.outputSha256, processIdentity:activeOperations.attach.processId, modulePath:path.resolve(activeOperations.attach.modulePath), attach:activeOperations.attach, pause:activeOperations.pause, cancel:activeOperations.cancel, observedCapabilities:Object.freeze({ ...observed.capabilityResults, ...activeOperations.capabilityResults }), closedCapabilities, unsupportedCapabilities:A7_UNSUPPORTED_CAPABILITIES },
      });
      const validation = validateRuntimeObservation(binding, observation);
      if (!validation.ok) throw new Error(`a7-cross-runtime-observation-invalid:${target.targetProfileId}:${validation.reason}`);
      proofs.push(Object.freeze({
        schemaVersion:A7_CROSS_TARGET_PROOF_SCHEMA, status:'exact-active-provider-observed',
        candidateCommitSha:commitSha, candidateTreeSha:treeSha, targetProfileId:target.targetProfileId,
        providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, providerVersion,
        fixture:Object.freeze({ sourcePath:target.sourcePath, sourceSha256:fixture.sourceSha256, binarySha256:fixture.binarySha256, targetTriple:target.targetTriple, semantics:fixture.sourceSemantics }),
        independentOracle:Object.freeze({ id:'llvm-readobj+llvm-objdump-18', executableIdentities:Object.freeze({ readobj:executableIdentities.readobj, objdump:executableIdentities.objdump }), outputSha256:fixture.oracleOutputSha256 }),
        lldbPythonPath:activeOperations.lldbPythonPath,
        activeOperations:Object.freeze({ attach:activeOperations.attach, pause:activeOperations.pause, cancel:activeOperations.cancel }),
        binding, observation, closedCapabilities, unsupportedCapabilities:A7_UNSUPPORTED_CAPABILITIES,
      }));
    }
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
  return Object.freeze({
    schemaVersion:A7_CROSS_TARGET_PROOF_SCHEMA, candidateCommitSha:commitSha, candidateTreeSha:treeSha,
    providerProfileId:A7_CROSS_TARGET_PROVIDER_PROFILE, versionIdentities, executableIdentities, proofs:Object.freeze(proofs),
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
