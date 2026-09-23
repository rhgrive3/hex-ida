const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[2]));const target=process.argv[3];const depth=+process.argv[4]||1;
const byId=new Map(p.nodes.map(n=>[n.id,n]));const parent=new Map();for(const n of p.nodes)for(const c of n.children||[])parent.set(c,n.id);
const selfT=new Map();for(let i=0;i<p.samples.length;i++)selfT.set(p.samples[i],(selfT.get(p.samples[i])||0)+(p.timeDeltas[i]||0));
const key=n=>n.callFrame.functionName+' '+n.callFrame.url.split('/js/').pop()+':'+(n.callFrame.lineNumber+1);
const agg=new Map();
for(const [id,t] of selfT){ let cur=id; const chain=[]; while(cur!=null){chain.push(cur);cur=parent.get(cur);} 
  // find outermost occurrence of target
  let idx=-1; for(let i=chain.length-1;i>=0;i--){ if(key(byId.get(chain[i])).startsWith(target)){idx=i;break;} }
  if(idx<0) continue; const path=[]; for(let d=1;d<=depth&&idx+d<chain.length;d++) path.push(key(byId.get(chain[idx+d])));
  const k=path.join(' <- '); agg.set(k,(agg.get(k)||0)+t); }
console.log([...agg].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([k,v])=>(v/1e3).toFixed(0).padStart(7)+'ms '+k).join('\n'));
