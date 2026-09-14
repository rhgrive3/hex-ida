import { captureDexValidationMetadata as captureBase, validateDexMethod } from './validation-base.js';
import { readDexUleb128, readDexSleb128 } from './leb128.js';
export { validateDexMethod };
function entry(image,index){for(const c of image?.classes??[]){for(const m of c.directMethods??[])if(m.methodIdx===index)return m;for(const m of c.virtualMethods??[])if(m.methodIdx===index)return m}return null}
function strictExceptions(image,index){
 const e=entry(image,index),bytes=image?.rawBytes;if(!e?.codeOff||!(bytes instanceof Uint8Array))return;
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),off=e.codeOff;if(off+16>bytes.length)throw new TypeError('dex-validation-truncated-code-item');
 const tries=v.getUint16(off+6,true),insns=v.getUint32(off+12,true);if(!tries)return;let p=off+16+insns*2;if(insns&1)p+=2;const triesEnd=p+tries*8;if(triesEnd>bytes.length)throw new TypeError('dex-validation-truncated-try-items');p=triesEnd;
 let r=readDexUleb128(bytes,p,bytes.length,'dex-validation-malformed-uleb128');const count=r.value;p=r.nextOffset;if(count>65535||count>bytes.length-p)throw new TypeError('dex-validation-handler-count-invalid');
 for(let i=0;i<count;i++){const s=readDexSleb128(bytes,p,bytes.length,'dex-validation-malformed-sleb128');p=s.nextOffset;const n=Math.abs(s.value);if(n>Math.floor((bytes.length-p)/2))throw new TypeError('dex-validation-handler-count-invalid');for(let j=0;j<n;j++){r=readDexUleb128(bytes,p,bytes.length,'dex-validation-malformed-uleb128');p=r.nextOffset;r=readDexUleb128(bytes,p,bytes.length,'dex-validation-malformed-uleb128');p=r.nextOffset}if(s.value<=0){r=readDexUleb128(bytes,p,bytes.length,'dex-validation-malformed-uleb128');p=r.nextOffset}}
}
export function captureDexValidationMetadata(methodIdx,image){
 const out=captureBase(methodIdx,image);try{strictExceptions(image,methodIdx);return out}catch(error){return {...out,exceptionComplete:false,structuralErrors:[...(out.structuralErrors??[]),{code:'dex-malformed-catch-handler-list',detail:error?.message??String(error)}],partialReasons:[...(out.partialReasons??[]),{code:'dex-exception-metadata-incomplete'}]}}
}
