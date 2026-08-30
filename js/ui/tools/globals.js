import { Sheet, el, list, tapRow, noteBox } from '../../ui.js';
import { addrHex } from '../../format.js';
import { findGlobals } from '../../linkage.js';
import { globalReferenceStats } from '../../analysis/global-ref-stats.js';

function abortError(signal) {
  const error=signal?.reason instanceof Error?signal.reason:new Error('Operation aborted');
  if(!error.name||error.name==='Error')error.name='AbortError';
  return error;
}
function waitFor(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(fn,v)=>{if(done)return;done=true;signal.removeEventListener('abort',onAbort);fn(v);};
    const onAbort=()=>finish(reject,abortError(signal));
    signal.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(promise).then((v)=>finish(resolve,v),(e)=>finish(reject,e));
  });
}

function mergeGlobals(named, stats, limit=400) {
  const seen=new Set(), out=[];
  for (const row of named || []) {
    const key=BigInt(row.addr).toString(), counted=stats?.counts?.get?.(key);
    seen.add(key); out.push({ ...row, refs:counted?.refs ?? 0 });
  }
  if (stats?.counts) {
    for (const hit of stats.counts.values()) {
      const key=hit.addr.toString(); if(seen.has(key)||hit.refs<2)continue;
      out.push({addr:hit.addr,name:null,readable:'off_'+hit.addr.toString(16).toUpperCase(),region:hit.region,refs:hit.refs,named:false});
    }
  }
  out.sort((a,b)=>b.refs-a.refs||(a.addr<b.addr?-1:a.addr>b.addr?1:0));
  return out.slice(0,limit);
}

function renderRows(app, host, rows, { pending=false, complete=true, reason=null }={}) {
  host.replaceChildren();
  host.append(el('div','hint', pending
    ? '名前付きの共有データを先に表示しています。参照頻度はバックグラウンドで集計中です。'
    : complete ? '参照頻度まで確認済みです。' : `参照頻度は一部のみ確認済みです${reason?`（${reason}）`:''}。`));
  if(!rows.length){host.append(noteBox(pending?'名前付きグローバルはまだ見つかっていません。':'見つかりませんでした（未解析範囲がある場合は absence を確定しません）。'));return;}
  const l=list();
  for(const g of rows.slice(0,300)) l.append(tapRow(g.readable||g.name||('off_'+g.addr.toString(16).toUpperCase()),{
    sub:addrHex(g.addr)+'  ·  '+(g.region||'')+(pending?'  ·  参照数を集計中':'  ·  '+g.refs+' か所から参照')+(g.named?'':'\n（名前は残っていません。参照の多さから見つけました）'),
    onTap:()=>{host.closest?.('.sheet')?.remove?.();app.goToAddress(g.addr,{announce:true});},
  }));
  host.append(l);
}

export function showGlobals(app) {
  const controller=new AbortController();
  const sheet=new Sheet('グローバル変数',{onClose:()=>controller.abort('globals-sheet-closed')});
  const host=el('div'); sheet.body.append(host);
  const regions=app.store.get('regions')||[];
  const named=findGlobals(app.symbols,null,regions,{limit:400});
  renderRows(app,host,named,{pending:true,complete:false});

  (async()=>{
    try {
      const program=await waitFor(app.ensureProgram?.(),controller.signal);
      if(!program||controller.signal.aborted||!sheet.root.isConnected)return;
      const stats=await globalReferenceStats(program,regions,{signal:controller.signal});
      if(controller.signal.aborted||!sheet.root.isConnected)return;
      renderRows(app,host,mergeGlobals(named,stats),{complete:stats.complete,reason:stats.reason});
    } catch(error) {
      if(error?.name==='AbortError'||controller.signal.aborted)return;
      if(sheet.root.isConnected)renderRows(app,host,named,{complete:false,reason:error?.message||'参照集計に失敗'});
    }
  })();
  return sheet;
}
