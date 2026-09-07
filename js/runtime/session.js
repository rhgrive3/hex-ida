import { TraceRingBuffer } from '../trace/ring-buffer.js';
import { DebugAdapterError, boundedInteger } from '../debug/adapter.js';
import { decodeWireValue, encodeWireValue } from '../debug/remote-protocol.js';

let nextSession = 1;

function sessionSafe(value) {
  try { return encodeWireValue(value); }
  catch (error) {
    if (error instanceof DebugAdapterError) throw new DebugAdapterError('session-serialize', error.message, error.details);
    throw new DebugAdapterError('session-serialize', 'session data is not serializable');
  }
}

function wireSafeTraceEvent(value) {
  try { return decodeWireValue(encodeWireValue(value)); }
  catch { return null; }
}

function eventEpoch(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function traceEventEpochAuthority(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return { explicit:false, materialize:false, epoch:null, value:null };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'epoch');
    if (descriptor?.enumerable) {
      return { explicit:true, materialize:false, epoch:null, value:null };
    }
    const rawEpoch = descriptor
      ? Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : Reflect.get(value, 'epoch')
      : Reflect.get(value, 'epoch');
    if (rawEpoch == null) {
      return { explicit:false, materialize:false, epoch:null, value:null };
    }
    const epoch = eventEpoch(rawEpoch);
    if (epoch == null) return null;
    return { explicit:true, materialize:true, epoch, value:rawEpoch };
  } catch {
    return null;
  }
}

function debugSessionId(value) {
  if (value == null) return `debug:${nextSession++}`;
  // The trimmed form is the canonical session identity: accepting the raw
  // string while validating the trimmed one would let `' session-1 '` and
  // `'session-1'` register as two different sessions and hide the padded one
  // from trimmed lookups (#5959).
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new DebugAdapterError('session-id', 'debug session id must be a non-empty string');
  return text;
}

export class DebugSession {
  constructor(adapter, options = {}) {
    if (!adapter) throw new DebugAdapterError('adapter','DebugSession requires an adapter');
    this.id = debugSessionId(options.id); this.adapter = adapter; this.backend = adapter.kind;
    this.binaryHash = options.binaryHash || null; this.modules=[]; this.threads=[]; this.breakpoints=[]; this.experiments=[]; this.observations=[];
    this.traces = new TraceRingBuffer(options.trace || {}); this.epoch=1; this.connected=false; this.closed=false; this.controllers=new Set(); this._unsubscribe=null;
    this.refreshErrors={modules:null,threads:null}; this._refreshToken=null; this._onClosed=typeof options.onClosed==='function'?options.onClosed:null; this._disconnecting=null;
  }
  async connect(options = {}) {
    if (this.closed) throw new DebugAdapterError('session-closed','cannot reconnect a closed debug session');
    if (this.connected) return { adapter:this.adapter.id, capabilities:this.adapter.capabilities, reused:true };
    if (typeof this.adapter.setEpoch === 'function') this.adapter.setEpoch(this.epoch);
    let result;
    try {
      result = await this.adapter.connect(options);
      if (typeof this.adapter.onEvent === 'function') {
        const subscriptionEpoch = this.epoch;
        const unsubscribe = this.adapter.onEvent((event)=>this.acceptEvent(event,subscriptionEpoch));
        if (unsubscribe != null && typeof unsubscribe !== 'function') throw new DebugAdapterError('event-subscription','adapter onEvent must return an unsubscribe function');
        this._unsubscribe=unsubscribe || null;
      }
      this.connected=true;
    } catch (error) {
      if (typeof this._unsubscribe==='function') { try { this._unsubscribe(); } catch {} }
      this._unsubscribe=null; this.connected=false;
      try { if (this.adapter.connected && typeof this.adapter.disconnect==='function') await this.adapter.disconnect(); } catch {}
      throw error;
    }
    await this.refreshState();
    return result;
  }
  async refreshState() {
    const refreshToken={};
    const refreshEpoch=this.epoch;
    this._refreshToken=refreshToken;
    const isCurrent=()=>!this.closed&&this.epoch===refreshEpoch&&this._refreshToken===refreshToken;
    const snapshot=()=>({modules:this.modules,threads:this.threads,errors:{...this.refreshErrors}});
    let modules=this.modules;
    let threads=this.threads;
    const errors={...this.refreshErrors};
    if (this.adapter.capabilities.modules) {
      try {
        const next=await this.adapter.getModules();
        if (!Array.isArray(next)) throw new DebugAdapterError('refresh-failed','adapter getModules must return an array');
        if (!isCurrent()) return snapshot();
        modules=next;
        errors.modules=null;
      } catch (error) {
        if (!isCurrent()) return snapshot();
        errors.modules={code:error?.code||'refresh-failed',message:String(error?.message||error)};
      }
    }
    if (this.adapter.capabilities.threads) {
      try {
        const next=await this.adapter.getThreads();
        if (!Array.isArray(next)) throw new DebugAdapterError('refresh-failed','adapter getThreads must return an array');
        if (!isCurrent()) return snapshot();
        threads=next;
        errors.threads=null;
      } catch (error) {
        if (!isCurrent()) return snapshot();
        errors.threads={code:error?.code||'refresh-failed',message:String(error?.message||error)};
      }
    }
    if (!isCurrent()) return snapshot();
    this.modules=modules;
    this.threads=threads;
    this.refreshErrors.modules=errors.modules;
    this.refreshErrors.threads=errors.threads;
    return snapshot();
  }
  _prepareEvent(event, sourceEpoch = null) {
    if (!event) return { ok:true, present:false, value:null };
    const epochAuthority = traceEventEpochAuthority(event);
    if (epochAuthority == null) return { ok:false, reason:'event-epoch-invalid' };
    const safeEvent = wireSafeTraceEvent(event);
    if (safeEvent == null) return { ok:false, reason:'wire-unsafe' };
    let epoch;
    if (epochAuthority.materialize) {
      if (!safeEvent || typeof safeEvent !== 'object' || Array.isArray(safeEvent)) {
        return { ok:false, reason:'event-epoch-invalid' };
      }
      Object.defineProperty(safeEvent,'epoch',{value:epochAuthority.value,enumerable:true,writable:true,configurable:true});
      epoch = epochAuthority.epoch;
    } else {
      const hasSafeEpoch = safeEvent && typeof safeEvent === 'object'
        && Object.prototype.hasOwnProperty.call(safeEvent, 'epoch');
      if (epochAuthority.explicit && !hasSafeEpoch) return { ok:false, reason:'event-epoch-missing' };
      const safeEpoch = hasSafeEpoch ? safeEvent.epoch : null;
      epoch = safeEpoch != null ? eventEpoch(safeEpoch) : eventEpoch(sourceEpoch);
    }
    if (epoch == null) return { ok:false, reason:'event-epoch-invalid' };
    if (epoch !== this.epoch) return { ok:false, reason:'event-epoch-mismatch' };
    return { ok:true, present:true, value:safeEvent };
  }
  acceptEvent(event, sourceEpoch = null) {
    if (this.closed) return false;
    const prepared = this._prepareEvent(event, sourceEpoch);
    if (!prepared.ok) return false;
    if (prepared.present) this.traces.push(prepared.value);
    return true;
  }
  acceptEvents(events, sourceEpoch = null) {
    if (this.closed) return { ok:false, reason:'closed-session' };
    if (!Array.isArray(events)) return { ok:false, reason:'events-not-array' };
    const prepared = [];
    for (const event of events) {
      const item = this._prepareEvent(event, sourceEpoch);
      if (!item.ok) return item;
      if (item.present) prepared.push(item.value);
    }
    for (const event of prepared) this.traces.push(event);
    return { ok:true, count:prepared.length };
  }
  newEpoch() {
    const next = this.epoch + 1;
    if (typeof this.adapter.setEpoch === 'function') this.adapter.setEpoch(next); else if (typeof this.adapter.nextEpoch === 'function') this.adapter.nextEpoch();
    this.epoch = next;
    this.cancelAll('session-epoch-changed'); this.traces.clear(); return this.epoch;
  }
  controller() { const c=new AbortController(); this.controllers.add(c); c.signal.addEventListener('abort',()=>this.controllers.delete(c),{once:true}); return c; }
  releaseController(controller) { this.controllers.delete(controller); }
  cancelAll(reason='cancelled') { for (const c of [...this.controllers]) c.abort(reason); this.controllers.clear(); }
  addExperiment(exp) { this.experiments.push(exp); if (this.experiments.length>256) this.experiments.shift(); }
  addObservation(obs) { this.observations.push(obs); if (this.observations.length>1024) this.observations.shift(); }
  addBreakpoint(bp) { const i=this.breakpoints.findIndex((b)=>b.id===bp.id); if(i>=0)this.breakpoints[i]=bp; else this.breakpoints.push(bp); return bp; }
  removeBreakpoint(id) { const before=this.breakpoints.length; this.breakpoints=this.breakpoints.filter((b)=>b.id!==id); return before!==this.breakpoints.length; }
  serialize() {
    return sessionSafe({ version:2,id:this.id,backend:this.backend,binaryHash:this.binaryHash,modules:this.modules,threads:this.threads,refreshErrors:this.refreshErrors,breakpoints:this.breakpoints,experiments:this.experiments,observations:this.observations,traces:this.traces.snapshot(),epoch:this.epoch });
  }
  replayShape(experimentId = null) {
    const experiments=experimentId==null?this.experiments:this.experiments.filter((e)=>e.id===experimentId);
    return sessionSafe({ version:2,binaryHash:this.binaryHash,backend:this.backend,experiments,observations:this.observations.filter((o)=>!experimentId||o.experimentId===experimentId),trace:this.traces.snapshot() });
  }
  async disconnect() {
    if(this.closed)return;
    if(this._disconnecting)return this._disconnecting;
    this.cancelAll('disconnected');
    const attempt=(async()=>{ await this.adapter.disconnect(); })();
    this._disconnecting=attempt;
    try{
      await attempt;
      if(typeof this._unsubscribe==='function') { try { this._unsubscribe(); } catch {} }
      this._unsubscribe=null; this.connected=false; this.closed=true;
    }
    finally{ if(this._disconnecting===attempt) this._disconnecting=null; }
    const onClosed=this._onClosed; this._onClosed=null;
    if(onClosed) { try { onClosed(this); } catch {} }
  }
}

export class DebugSessionManager {
  constructor(options={}){this.sessions=new Map();this.current=null;this.maxSessions=boundedInteger(options.maxSessions,8,1,32,'maxSessions');}
  create(adapter,options={}){
    if(this.sessions.size>=this.maxSessions)throw new DebugAdapterError('session-limit',`debug session limit reached (${this.maxSessions})`);
    for(const active of this.sessions.values())if(!active.closed&&active.adapter===adapter)throw new DebugAdapterError('adapter-in-use','a debug adapter cannot be shared by multiple live sessions');
    // A caller may legitimately hold `debug:N` as an explicit id. The auto
    // counter must skip live ids, or a create with free capacity fails once
    // with duplicate-session-id and succeeds on blind retry (#5933). The
    // counter stays monotonic so abandoned ids are not reused in-process.
    const requested={...options};
    if(requested.id==null){
      do{ requested.id=`debug:${nextSession++}`; }while(this.sessions.has(requested.id));
    }
    const callerOnClosed=typeof options.onClosed==='function'?options.onClosed:null;
    const session=new DebugSession(adapter,{...requested,onClosed:(closed)=>{this._sessionClosed(closed);if(callerOnClosed){try{callerOnClosed(closed);}catch{}}}});
    if(this.sessions.has(session.id)) throw new DebugAdapterError('duplicate-session-id',`debug session id already exists: ${session.id}`,{id:session.id});
    this.sessions.set(session.id,session);this.current=session;return session;
  }
  _sessionClosed(session){
    if(this.sessions.get(session.id)===session)this.sessions.delete(session.id);
    if(this.current===session)this.current=null;
  }
  get(id){return id==null?null:(this.sessions.get(debugSessionId(id))||null);}
  switch(id){
    const next=this.get(id);if(!next)throw new DebugAdapterError('session-not-found',`debug session not found: ${id}`);
    // Selecting a session is UI/manager state and must not invalidate execution state.
    this.current=next;return next;
  }
  async close(id){
    const s=this.get(id);if(!s)return false;
    await s.disconnect();
    this._sessionClosed(s);
    return true;
  }
}