import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';

function fail(code) { throw new TypeError(code); }

export function probeWasm(bytes) {
  if (!bytes || bytes.length < 8) return { supported: false, confidence: 0, reason: 'too-small' };
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0x00 && u8[1] === 0x61 && u8[2] === 0x73 && u8[3] === 0x6d) {
    const version = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
    if (version === 1) return { supported: true, confidence: 1.0, formatVersion: '1', vmSpecEdition: 'core-3.0' };
    // Only version 1 is openable; the public probe must not claim support
    // for versions openManagedImage would reject (#5384).
    return { supported: false, confidence: 0.6, reason: 'unsupported-version', formatVersion: String(version) };
  }
  return { supported: false, confidence: 0, reason: 'invalid-magic' };
}

function validateLebWidth(byte,count,width,signed,code){const maxBytes=Math.ceil(width/7);if(count<maxBytes)return;if(count>maxBytes||(byte&0x80)!==0)fail(code);const usedBits=width-(maxBytes-1)*7,payload=byte&0x7f,valueMask=(1<<usedBits)-1,unusedMask=0x7f&~valueMask;if(!signed){if((payload&unusedMask)!==0)fail(code);return;}const signBit=1<<(usedBits-1),expectedUnused=(payload&signBit)!==0?unusedMask:0;if((payload&unusedMask)!==expectedUnused)fail(code);}
export function decodeUleb128(bytes, offset, maxBytes = 5) {
  let result=0,shift=0,pos=offset,count=0;
  while(pos<bytes.length&&count<maxBytes){const byte=bytes[pos++];count++;validateLebWidth(byte,count,32,false,'wasm-malformed-uleb128');result|=(byte&0x7f)<<shift;if((byte&0x80)===0)return{value:result>>>0,nextOffset:pos};shift+=7;}
  fail('wasm-malformed-uleb128');
}
export function decodeSleb128(bytes,offset,maxBytes=5){let result=0,shift=0,pos=offset,count=0,byte=0;while(pos<bytes.length&&count<maxBytes){byte=bytes[pos++];count++;validateLebWidth(byte,count,32,true,'wasm-malformed-sleb128');result|=(byte&0x7f)<<shift;shift+=7;if((byte&0x80)===0){if(shift<32&&(byte&0x40)!==0)result|=(~0<<shift);return{value:result|0,nextOffset:pos};}}fail('wasm-malformed-sleb128');}
export function decodeSleb128_64(bytes,offset){let result=0n,shift=0n,pos=offset,count=0,byte=0;while(pos<bytes.length&&count<10){byte=bytes[pos++];count++;validateLebWidth(byte,count,64,true,'wasm-malformed-sleb128-64');result|=BigInt(byte&0x7f)<<shift;shift+=7n;if((byte&0x80)===0){if(shift<64n&&(byte&0x40)!==0)result|=(~0n<<shift);return{value:BigInt.asIntN(64,result),nextOffset:pos};}}fail('wasm-malformed-sleb128-64');}
export function decodeName(bytes,offset,budget=null){const{value:len,nextOffset}=decodeUleb128(bytes,offset);if(nextOffset+len>bytes.length)fail('wasm-truncated-name');if(budget)budget.chargeBytes(2*len);const nameBytes=bytes.subarray(nextOffset,nextOffset+len);const name=new TextDecoder('utf-8',{fatal:true}).decode(nameBytes);return{name,nextOffset:nextOffset+len};}

const WASM_VALUE_TYPES=new Set([0x7f,0x7e,0x7d,0x7c,0x7b,0x70,0x6f]);
const WASM_MEMORY32_MAX_PAGES=65536;
const WASM_MODULE_LOCAL_BUDGET=1000000;
// #8708: parser-wide module admission budget. A single shared accounting
// surface covers every top-level record vector, retained object materialization,
// decoded work, structural validation depth, wall-clock, and cancellation so no
// one-off section (Type today, Imports/Exports/Elements/Code tomorrow) can
// amplify a sub-MiB valid module into process OOM.
const WASM_PARSE_BUDGET_DEFAULTS = Object.freeze({
  maxRecords: 2000000,
  maxObjects: 2000000,
  maxEstimatedHeapBytes: 96 * 1024 * 1024,
  maxOperations: 200000000,
  maxControlDepth: 65536,
  // #8711: a single multi-million-parameter signature is otherwise admitted by
  // the aggregate heap estimate and then re-traversed (and amplified ~100x into
  // effect objects) by every downstream consumer that walks a callee signature.
  maxSignatureArity: 65536,
  deadlineMs: 30000,
});
const WASM_RECORD_BUDGET_BYTES = 96;
const WASM_OBJECT_BUDGET_BYTES = 48;
const WASM_VALUE_BUDGET_BYTES = 8;
const WASM_TYPE_ENTRY_BUDGET_BYTES = 256; // type object + params + results (measured ~116 B retained in V8)
function createWasmParseBudget(options) {
  const limits = { ...WASM_PARSE_BUDGET_DEFAULTS, ...(options.resourceBudget || {}) };
  const signal = options.signal || null;
  const startedAt = Date.now();
  let records = 0, objects = 0, heapBytes = 0, operations = 0, controlDepth = 0, signatureEntries = 0;
  function checkpoint() {
    operations++;
    if (operations > limits.maxOperations) fail('wasm-resource-limit-operations');
    if ((operations & 0x3fff) === 0) {
      if (signal && signal.aborted) fail('wasm-resource-limit-cancelled');
      if (Date.now() - startedAt > limits.deadlineMs) fail('wasm-resource-limit-deadline');
    }
  }
  function chargeHeap(bytes) {
    heapBytes += bytes;
    if (heapBytes > limits.maxEstimatedHeapBytes) fail('wasm-resource-limit-heap');
  }
  return {
    chargeBytes(bytes) { chargeHeap(bytes); checkpoint(); },
    chargeRecord(bytes = WASM_RECORD_BUDGET_BYTES) {
      records++;
      if (records > limits.maxRecords) fail('wasm-resource-limit-records');
      chargeHeap(bytes);
      checkpoint();
    },
    chargeObjects(count = 1) {
      objects += count;
      if (objects > limits.maxObjects) fail('wasm-resource-limit-objects');
      chargeHeap(count * WASM_OBJECT_BUDGET_BYTES);
    },
    chargeValue() { chargeHeap(WASM_VALUE_BUDGET_BYTES); checkpoint(); },
    beginSignature() { signatureEntries = 0; },
    chargeSignature(count) {
      signatureEntries += count;
      if (signatureEntries > limits.maxSignatureArity) fail('wasm-resource-limit-signature-arity');
      checkpoint();
    },
    checkpoint,
    enterControlFrame() {
      controlDepth++;
      if (controlDepth > limits.maxControlDepth) fail('wasm-resource-limit-depth');
    },
    leaveControlFrame() { if (controlDepth > 0) controlDepth--; },
  };
}
const WASM_STANDARD_SECTION_ORDER = Object.freeze(new Map([
  [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9],
  [12, 10], // Data Count precedes Code/Data despite its numeric section id.
  [10, 11], [11, 12],
]));
function readByte(bytes,offset,code){if(!Number.isSafeInteger(offset)||offset<0||offset>=bytes.length)fail(code);return{value:bytes[offset],nextOffset:offset+1};}
function readValueType(bytes,offset,code='wasm-invalid-value-type'){const{value,nextOffset}=readByte(bytes,offset,code);if(!WASM_VALUE_TYPES.has(value))fail(code);return{value,nextOffset};}
const WASM_ABSTRACT_HEAP_TYPES=new Set([0x74,0x73,0x72,0x71,0x70,0x6f,0x6e,0x6d,0x6c,0x6b,0x6a,0x69]);
function readHeapType(bytes,offset,code,heapTypeIndices){if(offset>=bytes.length)fail(code);const first=bytes[offset];if(WASM_ABSTRACT_HEAP_TYPES.has(first))return{value:first,typeIndex:null,nextOffset:offset+1};const r=decodeSleb128(bytes,offset);if(r.value<0)fail(code);if(heapTypeIndices)heapTypeIndices.push(r.value);return{value:null,typeIndex:r.value,nextOffset:r.nextOffset};}
export function decodeUleb128_64(bytes,offset){let result=0n,shift=0n,pos=offset,count=0;while(pos<bytes.length&&count<10){const byte=bytes[pos++];count++;validateLebWidth(byte,count,64,false,'wasm-malformed-uleb128-64');result|=BigInt(byte&0x7f)<<shift;if((byte&0x80)===0)return{value:result,nextOffset:pos};shift+=7n;}fail('wasm-malformed-uleb128-64');}
function readLimits(bytes,offset,code,{allowI64=false}={}){let r=readByte(bytes,offset,code);const flags=r.value;let pos=r.nextOffset;const i64=(flags&4)!==0;if((flags&~(allowI64?0x07:0x03))!==0||(i64&&(flags&0x02)!==0))fail(`${code}-flags`);const minR=i64?decodeUleb128_64(bytes,pos):decodeUleb128(bytes,pos);pos=minR.nextOffset;let max=null;if(flags&1){const maxR=i64?decodeUleb128_64(bytes,pos):decodeUleb128(bytes,pos);pos=maxR.nextOffset;max=maxR.value;if(max<minR.value)fail(`${code}-max-less-than-min`);}const value={min:minR.value,max,shared:Boolean(flags&2),addressType:i64?'i64':'i32',flags};return{value,nextOffset:pos};}
function readMemoryLimits(bytes,offset){const lim=readLimits(bytes,offset,'wasm-invalid-memory-limits',{allowI64:true});if(lim.value.shared&&lim.value.max==null)fail('wasm-invalid-memory-limits-shared-requires-maximum');if(lim.value.addressType==='i32'&&(lim.value.min>WASM_MEMORY32_MAX_PAGES||(lim.value.max!=null&&lim.value.max>WASM_MEMORY32_MAX_PAGES)))fail('wasm-invalid-memory-limits-page-limit');return lim;}
function readTableType(bytes,offset){const elem=readValueType(bytes,offset,'wasm-invalid-table-element-type');if(elem.value!==0x70&&elem.value!==0x6f)fail('wasm-invalid-table-element-type');const lim=readLimits(bytes,elem.nextOffset,'wasm-invalid-table-limits',{allowI64:true});if(lim.value.shared)fail('wasm-invalid-table-limits-shared-unsupported');return{value:{elemType:elem.value,...lim.value},nextOffset:lim.nextOffset};}
function readGlobalType(bytes,offset){const vt=readValueType(bytes,offset,'wasm-invalid-global-value-type');const mut=readByte(bytes,vt.nextOffset,'wasm-truncated-global-mutability');if(mut.value!==0&&mut.value!==1)fail('wasm-invalid-global-mutability');return{value:{valType:vt.value,mutable:mut.value===1},nextOffset:mut.nextOffset};}
function readConstExpr(bytes,offset,heapTypeIndices,budget=null){const start=offset;let pos=offset;const ops=[];while(pos<bytes.length){const opOffset=pos;const op=bytes[pos++];if(budget)budget.chargeObjects(1);if(op===0x0b)return{value:{ops,rawBytes:bytes.subarray(start,pos)},nextOffset:pos};if(op===0x41){const r=decodeSleb128(bytes,pos);pos=r.nextOffset;ops.push({opcode:op,value:r.value});}else if(op===0x42){const r=decodeSleb128_64(bytes,pos);pos=r.nextOffset;ops.push({opcode:op,value:r.value});}else if(op===0x43){if(pos+4>bytes.length)fail('wasm-truncated-const-expr');const dv=new DataView(bytes.buffer,bytes.byteOffset+pos,4);ops.push({opcode:op,value:dv.getFloat32(0,true)});pos+=4;}else if(op===0x44){if(pos+8>bytes.length)fail('wasm-truncated-const-expr');const dv=new DataView(bytes.buffer,bytes.byteOffset+pos,8);ops.push({opcode:op,value:dv.getFloat64(0,true)});pos+=8;}else if(op===0x23||op===0xd2){const r=decodeUleb128(bytes,pos);pos=r.nextOffset;ops.push({opcode:op,index:r.value});}else if(op===0xd0){const t=readHeapType(bytes,pos,'wasm-invalid-ref-null-type',heapTypeIndices);pos=t.nextOffset;ops.push({opcode:op,refType:t.value,typeIndex:t.typeIndex});}else fail(`wasm-unsupported-const-expr-opcode-0x${op.toString(16)}`);if(pos<=opOffset)fail('wasm-invalid-const-expr-progress');}fail('wasm-truncated-const-expr');}
function readIndexVector(bytes,offset,code,budget=null){const countR=decodeUleb128(bytes,offset);let pos=countR.nextOffset;const values=[];for(let i=0;i<countR.value;i++){const r=decodeUleb128(bytes,pos);pos=r.nextOffset;if(budget)budget.chargeValue();values.push(r.value);}return{value:values,nextOffset:pos};}
function readByteVector(bytes,offset,code){const lenR=decodeUleb128(bytes,offset);const end=lenR.nextOffset+lenR.value;if(end>bytes.length)fail(code);return{value:bytes.subarray(lenR.nextOffset,end),nextOffset:end};}
function requireIndex(length,index,code){if(!Number.isSafeInteger(index)||index<0||index>=length)fail(code);return index;}

function readFunctionBlockType(bytes,offset){if(offset>=bytes.length)fail('wasm-truncated-blocktype');const first=bytes[offset];if(first===0x40||WASM_VALUE_TYPES.has(first))return offset+1;return decodeSleb128(bytes,offset).nextOffset;}
function requireFunctionBytes(bytes,offset,count,code){const end=offset+count;if(!Number.isSafeInteger(end)||end>bytes.length)fail(code);return end;}
function readFunctionU32(bytes,offset){return decodeUleb128(bytes,offset).nextOffset;}
function readFunctionMemarg(bytes,offset){return readFunctionU32(bytes,readFunctionU32(bytes,offset));}
function readFunctionInstructionImmediate(bytes,offset,opcode,dataCount=null,heapTypeIndices=null,budget=null){
  if(opcode===0x0c||opcode===0x0d||opcode===0x10||opcode===0x12||opcode===0x14||opcode===0x15||(opcode>=0x20&&opcode<=0x26)||opcode===0xd2)return readFunctionU32(bytes,offset);
  if(opcode===0x11||opcode===0x13)return readFunctionU32(bytes,readFunctionU32(bytes,offset));
  if(opcode===0x0e){const count=decodeUleb128(bytes,offset);let pos=count.nextOffset;for(let i=0;i<=count.value;i++){if(budget)budget.chargeValue();pos=readFunctionU32(bytes,pos);}return pos;}
  if(opcode===0x1c){const count=decodeUleb128(bytes,offset);let pos=count.nextOffset;for(let i=0;i<count.value;i++){if(pos>=bytes.length||!WASM_VALUE_TYPES.has(bytes[pos]))fail('wasm-invalid-select-value-type');pos++;}return pos;}
  if(opcode>=0x28&&opcode<=0x3e)return readFunctionMemarg(bytes,offset);
  if(opcode===0x3f||opcode===0x40)return readFunctionU32(bytes,offset);
  if(opcode===0x41)return decodeSleb128(bytes,offset).nextOffset;
  if(opcode===0x42)return decodeSleb128_64(bytes,offset).nextOffset;
  if(opcode===0x43)return requireFunctionBytes(bytes,offset,4,'wasm-truncated-f32-immediate');
  if(opcode===0x44)return requireFunctionBytes(bytes,offset,8,'wasm-truncated-f64-immediate');
  if(opcode===0xd0)return readHeapType(bytes,offset,"wasm-invalid-ref-null-type",heapTypeIndices).nextOffset;
  if(opcode===0xfc){const sub=decodeUleb128(bytes,offset);let pos=sub.nextOffset;if(sub.value<=7)return pos;if(sub.value===8){const dataIndex=decodeUleb128(bytes,pos);pos=dataIndex.nextOffset;if(dataCount==null)fail('wasm-data-count-required');requireIndex(dataCount,dataIndex.value,'wasm-invalid-data-index');return readFunctionU32(bytes,pos);}if(sub.value===9){const dataIndex=decodeUleb128(bytes,pos);if(dataCount==null)fail('wasm-data-count-required');requireIndex(dataCount,dataIndex.value,'wasm-invalid-data-index');return dataIndex.nextOffset;}if(sub.value===10||sub.value===12||sub.value===14)return readFunctionU32(bytes,readFunctionU32(bytes,pos));if(sub.value===11||sub.value===13||(sub.value>=15&&sub.value<=17))return readFunctionU32(bytes,pos);fail(`wasm-unsupported-fc-opcode-${sub.value}`);}
  if(opcode===0xfd){const sub=decodeUleb128(bytes,offset);let pos=sub.nextOffset;if(sub.value<=11)return readFunctionMemarg(bytes,pos);if(sub.value===12||sub.value===13)return requireFunctionBytes(bytes,pos,16,'wasm-truncated-simd-immediate');if(sub.value>=21&&sub.value<=34)return requireFunctionBytes(bytes,pos,1,'wasm-truncated-simd-lane');if(sub.value>=84&&sub.value<=91){pos=readFunctionMemarg(bytes,pos);return requireFunctionBytes(bytes,pos,1,'wasm-truncated-simd-lane');}if(sub.value===92||sub.value===93)return readFunctionMemarg(bytes,pos);if((sub.value>=14&&sub.value<=20)||(sub.value>=35&&sub.value<=83)||(sub.value>=94&&sub.value<=255))return pos;fail(`wasm-unsupported-fd-opcode-${sub.value}`);}
  if(opcode===0xfe){const sub=decodeUleb128(bytes,offset);let pos=sub.nextOffset;if(sub.value<=2||(sub.value>=0x10&&sub.value<=0x4e))return readFunctionMemarg(bytes,pos);if(sub.value===3){if(pos>=bytes.length||bytes[pos]!==0)fail('wasm-invalid-atomic-fence-immediate');return pos+1;}fail(`wasm-unsupported-fe-opcode-${sub.value}`);}
  if(opcode===0x00||opcode===0x01||opcode===0x0f||opcode===0x1a||opcode===0x1b||(opcode>=0x45&&opcode<=0xc4)||opcode===0xd1)return offset;
  fail(`wasm-unsupported-function-opcode-0x${opcode.toString(16)}`);
}
function validateFunctionExpression(bytecode,dataCount=null,heapTypeIndices=null,budget=null){if(bytecode.length===0)fail('wasm-function-missing-end');const control=[{kind:'function',elseSeen:false}];let pos=0;while(pos<bytecode.length){if(budget)budget.checkpoint();const opcode=bytecode[pos++];if(opcode===0x02||opcode===0x03||opcode===0x04){pos=readFunctionBlockType(bytecode,pos);if(budget)budget.enterControlFrame();control.push({kind:opcode===0x04?'if':opcode===0x03?'loop':'block',elseSeen:false});continue;}if(opcode===0x05){const frame=control.at(-1);if(!frame||frame.kind!=='if'||frame.elseSeen)fail('wasm-invalid-else');frame.elseSeen=true;continue;}if(opcode===0x0b){const frame=control.pop();if(!frame)fail('wasm-unmatched-end');if(budget&&frame.kind!=='function')budget.leaveControlFrame();if(frame.kind==='function'){if(pos!==bytecode.length)fail('wasm-trailing-bytes-after-function-end');return;}continue;}pos=readFunctionInstructionImmediate(bytecode,pos,opcode,dataCount,heapTypeIndices,budget);}fail('wasm-function-missing-end');}

export function parseWasm(bytes,options={}){
  const probe=probeWasm(bytes);if(!probe.supported)fail(probe.reason === 'unsupported-version' ? 'wasm-unsupported-version' : 'wasm-unsupported-binary');if(probe.formatVersion!=='1')fail('wasm-unsupported-version');
  const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);let pos=8;
  const sections=[],types=[],imports=[],functions=[],tables=[],memories=[],globals=[],exports=[],elements=[],codeBodies=[],dataSegments=[],customSections=[],heapTypeIndices=[];let startFunction=null,dataCount=null,moduleLocals=0;
  const budget=createWasmParseBudget(options);
  const seenSections=new Set();let lastStandardSectionOrder=0;
  while(pos<u8.length){const idR=readByte(u8,pos,'wasm-truncated-section-id');const sectionId=idR.value;pos=idR.nextOffset;if(sectionId!==0){const sectionOrder=WASM_STANDARD_SECTION_ORDER.get(sectionId);if(sectionOrder==null)fail(`wasm-unsupported-section-${sectionId}`);if(seenSections.has(sectionId))fail(`wasm-duplicate-section-${sectionId}`);if(sectionOrder<lastStandardSectionOrder)fail(`wasm-out-of-order-section-${sectionId}`);seenSections.add(sectionId);lastStandardSectionOrder=sectionOrder;}
    const sizeR=decodeUleb128(u8,pos);pos=sizeR.nextOffset;if(sizeR.value>u8.length-pos)fail('wasm-truncated-section-payload');const sectionStart=pos,sectionEnd=pos+sizeR.value,sectionBytes=u8.subarray(sectionStart,sectionEnd);budget.chargeRecord(64);sections.push({id:sectionId,offset:sectionStart,size:sizeR.value});let secPos=0;
    if(sectionId===0){const n=decodeName(sectionBytes,0,budget);budget.chargeRecord(64);customSections.push({name:n.name,data:sectionBytes.subarray(n.nextOffset)});pos=sectionEnd;continue;}
    if(sectionId===1){const countR=decodeUleb128(sectionBytes,secPos);secPos=countR.nextOffset;for(let i=0;i<countR.value;i++){budget.chargeRecord(WASM_TYPE_ENTRY_BUDGET_BYTES);budget.chargeObjects(3);budget.beginSignature();const form=readByte(sectionBytes,secPos,'wasm-malformed-type-section');secPos=form.nextOffset;if(form.value!==0x60)fail('wasm-unsupported-type-form');const pc=decodeUleb128(sectionBytes,secPos);secPos=pc.nextOffset;budget.chargeSignature(pc.value);const params=[];for(let p=0;p<pc.value;p++){const t=readValueType(sectionBytes,secPos);secPos=t.nextOffset;budget.chargeValue();params.push(t.value);}const rc=decodeUleb128(sectionBytes,secPos);secPos=rc.nextOffset;budget.chargeSignature(rc.value);const results=[];for(let r=0;r<rc.value;r++){const t=readValueType(sectionBytes,secPos);secPos=t.nextOffset;budget.chargeValue();results.push(t.value);}types.push({params,results});}}
    else if(sectionId===2){const countR=decodeUleb128(sectionBytes,secPos);secPos=countR.nextOffset;for(let i=0;i<countR.value;i++){budget.chargeRecord(128);budget.chargeObjects(2);const mod=decodeName(sectionBytes,secPos,budget);secPos=mod.nextOffset;const field=decodeName(sectionBytes,secPos,budget);secPos=field.nextOffset;const kr=readByte(sectionBytes,secPos,'wasm-truncated-import-kind');secPos=kr.nextOffset;let desc;if(kr.value===0){const tr=decodeUleb128(sectionBytes,secPos);secPos=tr.nextOffset;desc={kind:0,typeIndex:tr.value};}else if(kr.value===1){const tr=readTableType(sectionBytes,secPos);secPos=tr.nextOffset;desc={kind:1,...tr.value};}else if(kr.value===2){const mr=readMemoryLimits(sectionBytes,secPos);secPos=mr.nextOffset;desc={kind:2,...mr.value};}else if(kr.value===3){const gr=readGlobalType(sectionBytes,secPos);secPos=gr.nextOffset;desc={kind:3,...gr.value};}else fail(`wasm-invalid-import-kind-${kr.value}`);imports.push({module:mod.name,field:field.name,desc});}}
    else if(sectionId===3){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;for(let i=0;i<c.value;i++){budget.chargeRecord(16);const r=decodeUleb128(sectionBytes,secPos);secPos=r.nextOffset;functions.push(r.value);}}
    else if(sectionId===4){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;for(let i=0;i<c.value;i++){budget.chargeRecord(64);budget.chargeObjects(1);const r=readTableType(sectionBytes,secPos);secPos=r.nextOffset;tables.push(r.value);}}
    else if(sectionId===5){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;for(let i=0;i<c.value;i++){budget.chargeRecord(64);budget.chargeObjects(1);const r=readMemoryLimits(sectionBytes,secPos);secPos=r.nextOffset;memories.push(r.value);}}
    else if(sectionId===6){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;for(let i=0;i<c.value;i++){budget.chargeRecord(128);budget.chargeObjects(3);const gt=readGlobalType(sectionBytes,secPos);secPos=gt.nextOffset;const init=readConstExpr(sectionBytes,secPos,heapTypeIndices,budget);secPos=init.nextOffset;globals.push({...gt.value,init:init.value});}}
    else if(sectionId===7){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;const exportNames=new Set();for(let i=0;i<c.value;i++){budget.chargeRecord(64);const n=decodeName(sectionBytes,secPos,budget);secPos=n.nextOffset;const k=readByte(sectionBytes,secPos,'wasm-truncated-export-kind');secPos=k.nextOffset;if(k.value>3)fail(`wasm-invalid-export-kind-${k.value}`);const idx=decodeUleb128(sectionBytes,secPos);secPos=idx.nextOffset;if(exportNames.has(n.name))fail('wasm-duplicate-export-name');exportNames.add(n.name);exports.push({name:n.name,kind:k.value,index:idx.value});}}
    else if(sectionId===8){const r=decodeUleb128(sectionBytes,secPos);secPos=r.nextOffset;startFunction=r.value;}
    else if(sectionId===9){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;for(let i=0;i<c.value;i++){budget.chargeRecord(128);budget.chargeObjects(2);const fr=decodeUleb128(sectionBytes,secPos);secPos=fr.nextOffset;const flags=fr.value;let mode='active',tableIndex=0,offsetExpr=null;if(flags===0){const e=readConstExpr(sectionBytes,secPos,heapTypeIndices,budget);secPos=e.nextOffset;offsetExpr=e.value;}else if(flags===1||flags===3){mode=flags===1?'passive':'declarative';const ek=readByte(sectionBytes,secPos,'wasm-truncated-element-kind');secPos=ek.nextOffset;if(ek.value!==0)fail('wasm-invalid-element-kind');}else if(flags===2){const ti=decodeUleb128(sectionBytes,secPos);secPos=ti.nextOffset;tableIndex=ti.value;const e=readConstExpr(sectionBytes,secPos,heapTypeIndices,budget);secPos=e.nextOffset;offsetExpr=e.value;const ek=readByte(sectionBytes,secPos,'wasm-truncated-element-kind');secPos=ek.nextOffset;if(ek.value!==0)fail('wasm-invalid-element-kind');}else fail(`wasm-unsupported-element-flags-${flags}`);const vec=readIndexVector(sectionBytes,secPos,'wasm-invalid-element-vector',budget);secPos=vec.nextOffset;elements.push({mode,tableIndex,offsetExpr,refType:0x70,functionIndices:vec.value});}}
    else if(sectionId===10){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;for(let i=0;i<c.value;i++){budget.chargeRecord(192);budget.chargeObjects(3);const bodyOffset=sectionStart+secPos;const bodySizeR=decodeUleb128(sectionBytes,secPos);secPos=bodySizeR.nextOffset;if(bodySizeR.value>sectionBytes.length-secPos)fail('wasm-truncated-function-body');const bodyBytes=sectionBytes.subarray(secPos,secPos+bodySizeR.value);secPos+=bodySizeR.value;let bp=0;const lg=decodeUleb128(bodyBytes,bp);bp=lg.nextOffset;const locals=[];for(let g=0;g<lg.value;g++){const count=decodeUleb128(bodyBytes,bp);bp=count.nextOffset;const type=readValueType(bodyBytes,bp,'wasm-invalid-local-type');bp=type.nextOffset;if(count.value>1000000||locals.length+count.value>1000000||moduleLocals+count.value>WASM_MODULE_LOCAL_BUDGET)fail('wasm-too-many-locals');moduleLocals+=count.value;budget.chargeBytes(count.value*WASM_VALUE_BUDGET_BYTES);for(let j=0;j<count.value;j++)locals.push(type.value);}const bytecode=bodyBytes.subarray(bp);validateFunctionExpression(bytecode,dataCount,heapTypeIndices,budget);codeBodies.push({bodyOffset,bytecodeOffset:sectionStart+bodySizeR.nextOffset+bp,bodySize:bodySizeR.value,locals,bytecode,rawBytes:bodyBytes});}}
    else if(sectionId===11){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;for(let i=0;i<c.value;i++){budget.chargeRecord(128);budget.chargeObjects(2);const fr=decodeUleb128(sectionBytes,secPos);secPos=fr.nextOffset;let mode='active',memoryIndex=0,offsetExpr=null;if(fr.value===0){const e=readConstExpr(sectionBytes,secPos,heapTypeIndices,budget);secPos=e.nextOffset;offsetExpr=e.value;}else if(fr.value===1)mode='passive';else if(fr.value===2){const mi=decodeUleb128(sectionBytes,secPos);secPos=mi.nextOffset;memoryIndex=mi.value;const e=readConstExpr(sectionBytes,secPos,heapTypeIndices,budget);secPos=e.nextOffset;offsetExpr=e.value;}else fail(`wasm-unsupported-data-flags-${fr.value}`);const data=readByteVector(sectionBytes,secPos,'wasm-truncated-data-segment');secPos=data.nextOffset;dataSegments.push({mode,memoryIndex,offsetExpr,data:data.value});}}
    else if(sectionId===12){const c=decodeUleb128(sectionBytes,secPos);secPos=c.nextOffset;dataCount=c.value;}
    if(secPos!==sectionBytes.length)fail(`wasm-section-${sectionId}-trailing-bytes`);pos=sectionEnd;
  }
  if(dataCount!=null&&dataCount!==dataSegments.length)fail('wasm-data-count-mismatch');
  const importedFunctions=imports.filter(x=>x.desc.kind===0),importedTables=imports.filter(x=>x.desc.kind===1),importedMemories=imports.filter(x=>x.desc.kind===2),importedGlobals=imports.filter(x=>x.desc.kind===3);
  for(const imp of importedFunctions)requireIndex(types.length,imp.desc.typeIndex,'wasm-invalid-import-type-index');for(const typeIndex of functions)requireIndex(types.length,typeIndex,'wasm-invalid-function-type-index');for(const typeIndex of heapTypeIndices)requireIndex(types.length,typeIndex,'wasm-invalid-ref-null-type-index');if(functions.length!==codeBodies.length)fail('wasm-function-code-count-mismatch');
  const functionCount=importedFunctions.length+functions.length,tableCount=importedTables.length+tables.length,memoryCount=importedMemories.length+memories.length,globalCount=importedGlobals.length+globals.length;
  for(const ex of exports){const lengths=[functionCount,tableCount,memoryCount,globalCount];requireIndex(lengths[ex.kind],ex.index,`wasm-invalid-export-index-${ex.kind}`);}
  if(startFunction!=null){requireIndex(functionCount,startFunction,'wasm-invalid-start-function-index');let typeIndex;if(startFunction<importedFunctions.length)typeIndex=importedFunctions[startFunction].desc.typeIndex;else typeIndex=functions[startFunction-importedFunctions.length];const t=types[typeIndex];if(!t||t.params.length!==0||t.results.length!==0)fail('wasm-invalid-start-function-type');}
  const tableElemTypes=[...importedTables.map((entry)=>entry.desc.elemType),...tables.map((table)=>table.elemType)];
  for(const el of elements){if(el.mode==='active'){requireIndex(tableCount,el.tableIndex,'wasm-invalid-element-table-index');if(tableElemTypes[el.tableIndex]!==el.refType)fail('wasm-invalid-element-table-type-mismatch');}for(const fi of el.functionIndices)requireIndex(functionCount,fi,'wasm-invalid-element-function-index');}
  for(const ds of dataSegments)if(ds.mode==='active')requireIndex(memoryCount,ds.memoryIndex,'wasm-invalid-data-memory-index');
  const binaryId=options.binaryId||'wasm-binary',imageId=createManagedImageId(binaryId),moduleId=createManagedModuleId(imageId,'main');
  return deepFreeze({imageId,moduleId,formatVersion:probe.formatVersion,vmSpecEdition:probe.vmSpecEdition,sections,types,imports,functions,tables,memories,globals,exports,startFunction,elements,codeBodies,dataSegments,dataCount,customSections,rawBytes:u8});
}
