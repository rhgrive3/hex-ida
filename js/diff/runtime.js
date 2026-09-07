let sequence = 1;
function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? 'Binary diff cancelled' : String(signal.reason));
  error.name='AbortError'; error.code='ABORT_ERR'; return error;
}
function cloneOptions(options) {
  const matchBudget={...(options.matchBudget||{})}; delete matchBudget.signal;
  return { mode:options.mode||'fast', threshold:options.threshold, matchBudget };
}
export function runDiffInWorker(before, after, options = {}) {
  const signal=options.signal??null;
  if(signal?.aborted)return Promise.reject(abortError(signal));
  const workerFactory=options.workerFactory||(()=>new Worker(new URL('./worker.js',import.meta.url),{type:'module'}));
  const worker=workerFactory(); const id=sequence++;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',onAbort);try{worker.terminate();}catch{}fn(value);};
    const onAbort=()=>finish(reject,abortError(signal));
    signal?.addEventListener('abort',onAbort,{once:true});
    worker.onmessage=(event)=>{const msg=event.data||{};if(msg.id!==id)return;if(msg.ok)finish(resolve,msg.result);else{const error=new Error(msg.error?.message||'Binary diff worker failed');error.name=msg.error?.name||'Error';if(msg.error?.code)error.code=msg.error.code;finish(reject,error);}};
    worker.onerror=(event)=>finish(reject,event?.error||new Error(event?.message||'Binary diff worker failed'));
    worker.onmessageerror=(event)=>finish(reject,event?.error||new Error('Binary diff worker message failed'));
    try{worker.postMessage({t:'diff',id,before,after,options:cloneOptions(options)});}catch(error){finish(reject,error);}
  });
}
