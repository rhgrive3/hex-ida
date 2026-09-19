import { Worker as Thread } from 'node:worker_threads';
const active = new Set();
export class ProductNodeWorker {
  constructor(url, options={}) {
    this.ready = false; this.queue = []; this.listeners = new Map(); this.closed = false; this.termination = null;
    this.thread = new Thread(new URL('./node-worker-entry.mjs', import.meta.url), {
      workerData:{url:String(url),type:options.type ?? 'classic'},resourceLimits:{maxOldGenerationSizeMb:512},
    });
    active.add(this);
    this.timer = setTimeout(() => { this.emit('error', {message:'worker-boot-timeout'}); void this.terminate(); }, 15000);
    this.thread.on('message', packet => {
      if (packet.kind==='ready') {
        clearTimeout(this.timer); this.ready=true;
        for(const [message,transfer] of this.queue) this.thread.postMessage(message,transfer);
        this.queue=[];
      } else if(packet.kind==='message') this.emit('message', {data:packet.message});
      else this.emit('error', {message:packet.message});
    });
    this.thread.on('error', error=>this.emit('error',{message:error.message,error}));
    this.thread.on('exit', code=>{active.delete(this);clearTimeout(this.timer);if(!this.closed)this.emit('error',{message:`worker-exited:${code}`});});
  }
  emit(type,event){ this[`on${type}`]?.(event);for(const fn of this.listeners.get(type)??[])fn(event); }
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  postMessage(message,transfer){if(this.closed)throw new Error('worker-closed');if(this.ready)this.thread.postMessage(message,transfer);else this.queue.push([message,transfer]);}
  terminate(){
    if (this.termination) return this.termination;
    this.closed=true; clearTimeout(this.timer); this.queue=[];
    // Keep the worker in `active` until the underlying thread actually exits.
    // Otherwise closeNodeWorkers() can miss an in-flight termination and let a
    // benchmark process stay alive after its result has already been emitted.
    this.termination = Promise.resolve(this.thread.terminate()).finally(()=>active.delete(this));
    return this.termination;
  }
}
export function installNodeWorkerTransport(){globalThis.Worker=ProductNodeWorker;}
export async function closeNodeWorkers(){await Promise.all([...active].map(worker=>worker.terminate()));}
export function activeNodeWorkerCount(){return active.size;}
