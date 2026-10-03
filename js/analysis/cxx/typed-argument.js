// A deliberately small Itanium ABI subset: a global, ordinary function with
// a first pointer-to-named-object parameter. Qualified functions may be
// static members; templates may encode return types. Neither is accepted.
// A single top-level L marks internal linkage of an otherwise ordinary global
// function; it does not introduce an implicit receiver or move argument zero.
import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { demangleCxx } from '../../rtti.js';

const canonical = new WeakSet();
export const isCanonicalCppTypedArgumentEvidence = value => value !== null
  && typeof value === 'object' && canonical.has(value);

export function createCppTypedArgumentEvidence({symbol,functionAddress,architecture='arm64'}={}) {
  if(typeof symbol!=='string'||symbol.length>1024||!/^_ZL?[1-9]/.test(symbol)
    ||!['arm64','arm64_32'].includes(architecture)
    ||typeof functionAddress!=='bigint'||functionAddress<0n)return null;
  const internalLinkage=symbol[2]==='L';
  let position=internalLinkage?3:2;
  const sourceName=()=>{
    const start=position;
    while(position<symbol.length&&/[0-9]/.test(symbol[position]))position++;
    const digits=symbol.slice(start,position);
    if(!/^[1-9][0-9]{0,2}$/.test(digits))return null;
    const size=Number(digits);
    if(size>240||position+size>symbol.length)return null;
    const name=symbol.slice(position,position+size);position+=size;
    // The source-name byte length is unambiguous for this ASCII subset.
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)?name:null;
  };
  const functionName=sourceName();
  if(!functionName||symbol[position++]!=='P')return null;
  const pointeeConst=symbol[position]==='K';if(pointeeConst)position++;
  const components=[];
  if(symbol[position]==='N') {
    position++;
    while(position<symbol.length&&symbol[position]!=='E') {
      if(components.length>=16)return null;
      const name=sourceName();if(!name)return null;components.push(name);
    }
    if(components.length<2||symbol[position++]!=='E')return null;
  } else {
    const name=sourceName();if(!name)return null;components.push(name);
  }
  // ARM64's first ordinary pointer argument remains x0 when later scalar or
  // pointer arguments are present. Validate the entire supported signature;
  // unknown encodings never become an argument assertion by prefix matching.
  let parameterCount=1;
  const trailingType=(depth=0)=>{
    if(depth>8||position>=symbol.length)return false;
    const code=symbol[position];
    if('bcahstijlmxy nofde'.replace(/ /g,'').includes(code)){position++;return true;}
    if(code==='P'||code==='R'||code==='O'||code==='K'||code==='V') {
      position++;
      if(code==='P'&&symbol[position]==='v'){position++;return true;}
      return trailingType(depth+1);
    }
    if(/[1-9]/.test(code))return sourceName()!==null;
    if(code==='N') {
      position++;let count=0;
      while(position<symbol.length&&symbol[position]!=='E') {
        if(count++>=16||!sourceName())return false;
      }
      if(count<2||symbol[position++]!=='E')return false;
      return true;
    }
    // Later parameter substitutions do not move the already proven first
    // pointer argument from x0. Accept only a complete, validated signature;
    // an unresolved substitution or extra suffix still fails closed.
    if(code==='S') {
      const substitution=/^S(?:[0-9A-Z]{1,6})?_/.exec(symbol.slice(position));
      if(!substitution||demangleCxx(symbol)===null)return false;
      position+=substitution[0].length;return true;
    }
    return false;
  };
  while(position<symbol.length) {
    if(parameterCount>=16||!trailingType())return null;
    parameterCount++;
  }
  const record={schema:'cpp-typed-object-argument/v1',symbol,functionName,functionAddress,
    className:components.join('::'),pointeeConst,receiverRole:'typed-argument',
    architecture,argumentIndex:0,register:'x0',parameterCount,rule:'itanium-global-first-object-pointer-parameter'};
  if(internalLinkage)record.internalLinkage=true;
  record.digest=stableDigest(record);const proof=deepFreeze(record);canonical.add(proof);return proof;
}
