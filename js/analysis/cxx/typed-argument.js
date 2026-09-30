// A deliberately small Itanium ABI subset: a global, ordinary function with
// exactly one pointer-to-named-object parameter. Qualified functions may be
// static members; templates may encode return types. Neither is accepted.
import { deepFreeze, stableDigest } from '../../core/identity/index.js';

const canonical = new WeakSet();
export const isCanonicalCppTypedArgumentEvidence = value => value !== null
  && typeof value === 'object' && canonical.has(value);

export function createCppTypedArgumentEvidence({symbol,functionAddress,architecture='arm64'}={}) {
  if(typeof symbol!=='string'||symbol.length>1024||!/^_Z[1-9]/.test(symbol)
    ||!['arm64','arm64_32'].includes(architecture)
    ||typeof functionAddress!=='bigint'||functionAddress<0n)return null;
  let position=2;
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
  // No substitutions, multiple parameters, template suffixes, version suffixes
  // or trailing garbage can silently become an object-argument assertion.
  if(position!==symbol.length)return null;
  const record={schema:'cpp-typed-object-argument/v1',symbol,functionName,functionAddress,
    className:components.join('::'),pointeeConst,receiverRole:'typed-argument',
    architecture,argumentIndex:0,register:'x0',rule:'itanium-global-single-object-pointer-parameter'};
  record.digest=stableDigest(record);const proof=deepFreeze(record);canonical.add(proof);return proof;
}
