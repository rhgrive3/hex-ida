const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[2]));const N=+process.argv[3]||40;
const byId=new Map(p.nodes.map(n=>[n.id,n]));const parent=new Map();for(const n of p.nodes)for(const c of n.children||[])parent.set(c,n.id);
const selfT=new Map();for(let i=0;i<p.samples.length;i++)selfT.set(p.samples[i],(selfT.get(p.samples[i])||0)+(p.timeDeltas[i]||0));
const key=n=>n.callFrame.functionName+' '+n.callFrame.url.split('/js/').pop()+':'+(n.callFrame.lineNumber+1);
const incl=new Map();let total=0;
for(const [id,t] of selfT){total+=t;const seen=new Set();let cur=id;while(cur!=null){const k=key(byId.get(cur));if(!seen.has(k)){seen.add(k);incl.set(k,(incl.get(k)||0)+t);}cur=parent.get(cur);}}
console.log('total',(total/1e3).toFixed(0),'ms');
console.log([...incl].sort((a,b)=>b[1]-a[1]).slice(0,N).map(([k,v])=>(v/1e3).toFixed(0).padStart(7)+'ms '+k).join('\n'));
