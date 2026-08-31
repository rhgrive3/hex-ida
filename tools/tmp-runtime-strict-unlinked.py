from pathlib import Path

def edit(path, replacements):
    p=Path(path); s=p.read_text()
    for old,new,label in replacements:
        if old not in s: raise SystemExit(f'{path}: anchor drift: {label}')
        s=s.replace(old,new,1)
    p.write_text(s)

edit('js/adapters/index.js', [(
"if (options.signal && !options.signal.aborted) options.signal.addEventListener('abort', onAbort, { once:true });\n    if (run.cancelled) sandbox.emulator.stopped = 'cancelled';",
"if (options.signal) {\n      options.signal.addEventListener('abort', onAbort, { once:true });\n      if (options.signal.aborted) onAbort();\n    }\n    if (run.cancelled) sandbox.emulator.stopped = 'cancelled';",
'local sandbox abort registration')])

edit('js/debug/remote-protocol.js', [(
"""      if (pending.signal) {
        pending.abortHandler = () => this.cancel(id, String(pending.signal.reason ?? 'cancelled'));
        pending.signal.addEventListener('abort', pending.abortHandler, { once:true });
      }
      this.pending.set(id, pending);
      this.sendPacket(packet).catch((err) => {""",
"""      this.pending.set(id, pending);
      if (pending.signal) {
        pending.abortHandler = () => this.cancel(id, String(pending.signal.reason ?? 'cancelled'));
        pending.signal.addEventListener('abort', pending.abortHandler, { once:true });
        if (pending.signal.aborted) pending.abortHandler();
      }
      if (!this.pending.has(id)) return;
      this.sendPacket(packet).catch((err) => {""",
'remote pending registration')])

p=Path('js/runtime/evidence-bridge.js'); s=p.read_text()
old="""function completeness(value, fallback = 'partial') {
  const normalized = String(value ?? fallback);
  if (!EVIDENCE_COMPLETENESS.includes(normalized)) throw new DebugAdapterError('runtime-invalid-completeness', `invalid evidence completeness: ${normalized}`);
  return normalized;
}"""
new="""function completeness(value, fallback = 'partial') {
  const normalized = value == null ? fallback : value;
  if (typeof normalized !== 'string' || !EVIDENCE_COMPLETENESS.includes(normalized)) throw new DebugAdapterError('runtime-invalid-completeness', 'invalid evidence completeness');
  return normalized;
}

function evidenceConfidence(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DebugAdapterError('runtime-invalid-confidence', 'runtime evidence confidence must be a finite number');
  return value;
}"""
if old not in s: raise SystemExit('evidence completeness anchor drift')
s=s.replace(old,new,1)
s=s.replace("confidence: options.confidence == null ? null : Number(options.confidence),", "confidence: evidenceConfidence(options.confidence),",1)
old="""  linkClaim(claimId, evidenceId, relation, resolution = null) {
    const type = String(relation);
    if (!RELATIONS.includes(type)) throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${type}`);"""
new="""  linkClaim(claimId, evidenceId, relation, resolution = null) {
    if (typeof relation !== 'string') throw new DebugAdapterError('runtime-invalid-evidence-relation', 'runtime evidence relation must be a string');
    const type = relation;
    if (!RELATIONS.includes(type)) throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${type}`);"""
if old not in s: raise SystemExit('evidence relation anchor drift')
s=s.replace(old,new,1); p.write_text(s)

p=Path('js/runtime/events.js'); s=p.read_text()
old="""function safeInteger(value, fallback, name, { min = 0 } = {}) {
  if (value == null) return fallback;
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
    throw new DebugAdapterError('runtime-invalid-event-integer', `${name} must be a safe integer >= ${min}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new DebugAdapterError('runtime-invalid-event-integer', `${name} must be a safe integer >= ${min}`);
  return n;
}"""
new="""function safeInteger(value, fallback, name, { min = 0 } = {}) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new DebugAdapterError('runtime-invalid-event-integer', `${name} must be a safe integer >= ${min}`);
  }
  return value;
}"""
if old not in s: raise SystemExit('events integer anchor drift')
s=s.replace(old,new,1)
old="""function normalizeCompleteness(value, fallback = 'partial') {
  const completeness = String(value ?? fallback);
  if (!EVIDENCE_COMPLETENESS.includes(completeness)) throw new DebugAdapterError('runtime-invalid-completeness', `invalid runtime completeness: ${completeness}`);
  return completeness;
}"""
new="""function normalizeCompleteness(value, fallback = 'partial') {
  const completeness = value == null ? fallback : value;
  if (typeof completeness !== 'string' || !EVIDENCE_COMPLETENESS.includes(completeness)) throw new DebugAdapterError('runtime-invalid-completeness', 'invalid runtime completeness');
  return completeness;
}"""
if old not in s: raise SystemExit('events completeness anchor drift')
s=s.replace(old,new,1)
old="""function normalizeMode(value) {
  const mode = String(value ?? 'observed');
  if (!RUNTIME_OBSERVATION_MODES.includes(mode)) throw new DebugAdapterError('runtime-invalid-observation-mode', `invalid runtime observation mode: ${mode}`);
  return mode;
}"""
new="""function normalizeMode(value) {
  const mode = value == null ? 'observed' : value;
  if (typeof mode !== 'string' || !RUNTIME_OBSERVATION_MODES.includes(mode)) throw new DebugAdapterError('runtime-invalid-observation-mode', 'invalid runtime observation mode');
  return mode;
}"""
if old not in s: raise SystemExit('events mode anchor drift')
s=s.replace(old,new,1)
s=s.replace("const providerVersion = String(input.providerVersion ?? '1');", "const providerVersion = input.providerVersion == null ? '1' : required(input.providerVersion, 'runtime-provider-version-invalid', 'runtime provider version must be a non-empty string');",1)
p.write_text(s)

edit('js/runtime/authority.js', [(
"""function numericPrimitive(value, code) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  throw new TypeError(code);
}""",
"""function numericPrimitive(value, code) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(code);
}""",
'authority numeric primitive')])

p=Path('js/runtime/debugger-provider.js'); s=p.read_text()
old="""function sameModuleBinding(current, next) {
  if (!current || !next) return false;
  const scalar = (value) => value == null ? null : String(value);
  const currentEvidence = current.identityEvidenceIds ?? [];
  const nextEvidence = next.identityEvidenceIds ?? [];
  return scalar(current.runtimeBase) === scalar(next.runtimeBase)
    && scalar(current.runtimeSize) === scalar(next.runtimeSize)
    && scalar(current.staticBase) === scalar(next.staticBase)
    && scalar(current.pathHint) === scalar(next.pathHint)
    && scalar(current.binaryId) === scalar(next.binaryId)
    && scalar(current.sliceId) === scalar(next.sliceId)
    && scalar(current.imageId) === scalar(next.imageId)
    && scalar(current.identityState) === scalar(next.identityState)"""
new="""function sameModuleBinding(current, next) {
  if (!current || !next) return false;
  const currentEvidence = current.identityEvidenceIds ?? [];
  const nextEvidence = next.identityEvidenceIds ?? [];
  return current.runtimeBase === next.runtimeBase
    && current.runtimeSize === next.runtimeSize
    && current.staticBase === next.staticBase
    && current.pathHint === next.pathHint
    && current.binaryId === next.binaryId
    && current.sliceId === next.sliceId
    && current.imageId === next.imageId
    && current.identityState === next.identityState"""
if old not in s: raise SystemExit('debugger same binding anchor drift')
s=s.replace(old,new,1); p.write_text(s)

Path('tests/phase10/runtime-unlinked-strict-boundaries.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RuntimeEvidenceBridge, conservativeCompleteness } from '../../js/runtime/evidence-bridge.js';
import { createRuntimeEvent } from '../../js/runtime/events.js';
import { createRuntimeAuthorityBinding, createRuntimeObservation } from '../../js/runtime/authority.js';
import { RemoteProtocolClient } from '../../js/debug/remote-protocol.js';

assert.throws(() => conservativeCompleteness(['complete']), /runtime-invalid-completeness/);
const bridge=new RuntimeEvidenceBridge();
const event={runtimeSessionId:'s',providerId:'p',providerVersion:'1',sessionEpoch:1,sequence:1,kind:'trace-marker',observationMode:'observed',completeness:'partial'};
assert.throws(() => bridge.eventToEvidence(event,null,{confidence:'0.9'}), /runtime-invalid-confidence/);
assert.throws(() => bridge.linkClaim('c','e',['supports']), /runtime-invalid-evidence-relation/);
for (const bad of ['1',['1'],true]) assert.throws(() => createRuntimeEvent({...event, sessionEpoch:bad}), /runtime-invalid-event-integer/);
assert.throws(() => createRuntimeEvent({...event, completeness:['complete']}), /runtime-invalid-completeness/);
assert.throws(() => createRuntimeEvent({...event, observationMode:['observed']}), /runtime-invalid-observation-mode/);
assert.throws(() => createRuntimeEvent({...event, providerVersion:['1']}), /runtime-provider-version-invalid/);

const bindingInput={providerIdentity:'p',runtimeInstanceIdentity:'r',targetIdentity:'t',binaryIdentity:'b',moduleIdentity:'m',loadMappingIdentity:'l',sessionIdentity:'s',capabilityVersion:'1',epoch:1};
const binding=createRuntimeAuthorityBinding(bindingInput);
assert.throws(() => createRuntimeAuthorityBinding({...bindingInput,epoch:'1'}), /runtime-epoch-invalid/);
assert.throws(() => createRuntimeObservation({binding,sequence:'1',observedAt:'now',kind:'trace-marker',payload:{},authority:{}}), /runtime-observation-sequence-invalid|runtime-sequence-invalid/);

const sent=[];
const transport={send:async(packet)=>{sent.push(packet);},onMessage(){return ()=>{};}};
const client=new RemoteProtocolClient(transport);
const signal={aborted:false,reason:'cancelled',addEventListener(_t,fn){fn();},removeEventListener(){}};
await assert.rejects(client.request('readMemory',{}, {signal}), /cancelled/);
assert.equal(sent.some((packet)=>packet.type==='request'), false, 'cancelled request packet must not be sent');

const adapters=fs.readFileSync(new URL('../../js/adapters/index.js',import.meta.url),'utf8');
assert.ok(adapters.includes("options.signal.addEventListener('abort', onAbort, { once:true });\n      if (options.signal.aborted) onAbort();"));
const debuggerProvider=fs.readFileSync(new URL('../../js/runtime/debugger-provider.js',import.meta.url),'utf8');
const sameBinding=debuggerProvider.slice(debuggerProvider.indexOf('function sameModuleBinding'),debuggerProvider.indexOf('export class DebuggerProvider'));
assert.ok(!sameBinding.includes('String(value)'));
assert.ok(sameBinding.includes('current.binaryId === next.binaryId'));
console.log('phase10 runtime unlinked strict boundaries: PASS');
''')
