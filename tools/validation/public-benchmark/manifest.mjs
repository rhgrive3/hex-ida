import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
function safePath(root, rel, code) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw new Error(code);
  const base=path.resolve(root), resolved=path.resolve(base,rel);
  if (resolved!==base && !resolved.startsWith(base+path.sep)) throw new Error(code);
  const realBase=fs.realpathSync(base);
  let realPath;
  try {
    realPath=fs.realpathSync(resolved);
  } catch(error) {
    if(error.code==='ENOENT') return resolved;
    throw error;
  }
  if(realPath!==realBase && !realPath.startsWith(realBase+path.sep)) throw new Error(code);
  return realPath;
}
export function loadManifest(file){
 const raw=JSON.parse(fs.readFileSync(file,'utf8')); if(raw.schema!=='hex-public-benchmark-manifest/v1') throw new Error('public-benchmark-manifest-schema');
 if(!Array.isArray(raw.cases)||!raw.cases.length) throw new Error('public-benchmark-manifest-empty');
 const ids=new Set();
 for(const c of raw.cases){
   if(typeof c.id!=='string'||!c.id||ids.has(c.id))throw new Error('public-benchmark-case-id');ids.add(c.id);
   if(!/^[0-9a-f]{64}$/.test(c.binarySha256||''))throw new Error(`public-benchmark-case-sha:${c.id}`);
   if(!/^[0-9a-f]{64}$/.test(c.reference?.sha256||''))throw new Error(`public-benchmark-reference-sha:${c.id}`);
   if(typeof c.binary!=='string'||typeof c.reference?.path!=='string') throw new Error(`public-benchmark-case-path:${c.id}`);
 }
 return Object.freeze(raw);
}
export function verifyInputs(manifest,root){
 const out=[]; for(const c of manifest.cases){
   const p=safePath(root,c.binary,`public-benchmark-binary-path:${c.id}`);
   if(!fs.existsSync(p)){out.push({...c,path:p,state:'MISSING'});continue;}
   const h=sha(fs.readFileSync(p));
   const rp=safePath(root,c.reference.path,`public-benchmark-reference-path:${c.id}`);
   if(!fs.existsSync(rp)){out.push({...c,path:p,state:'MISSING_REFERENCE'});continue;}
   const rh=sha(fs.readFileSync(rp));
   let state=h===c.binarySha256?'READY':'HASH_MISMATCH';
   if(state==='READY'&&rh!==c.reference.sha256) state='REFERENCE_HASH_MISMATCH';
   out.push({...c,path:p,state,actualSha256:h,actualReferenceSha256:rh});
 } return out;
}
