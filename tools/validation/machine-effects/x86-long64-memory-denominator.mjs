export const X86_LONG64_MEMORY_DENOMINATOR_SCHEMA = 'x86-long64-memory-denominator/v1';
export const X86_LONG64_MEMORY_DENOMINATOR_ID = 'x86_64:long-64:effect-family:memory:v1';

const SEGMENTS = Object.freeze([
  Object.freeze({ id:'default', prefix:null, space:'memory', baseRule:'default-long-mode' }),
  Object.freeze({ id:'es', prefix:0x26, space:'memory', baseRule:'ignored-base-in-long-mode' }),
  Object.freeze({ id:'cs', prefix:0x2e, space:'memory', baseRule:'ignored-base-in-long-mode' }),
  Object.freeze({ id:'ss', prefix:0x36, space:'memory', baseRule:'ignored-base-in-long-mode' }),
  Object.freeze({ id:'ds', prefix:0x3e, space:'memory', baseRule:'ignored-base-in-long-mode' }),
  Object.freeze({ id:'fs', prefix:0x64, space:'tls', baseRule:'tls-segment-base-unknown' }),
  Object.freeze({ id:'gs', prefix:0x65, space:'tls', baseRule:'tls-segment-base-unknown' }),
]);
const ADDRESS_SIZES = Object.freeze([64,32]);
const WIDTH_PREFIX = Object.freeze({ 8:[], 16:[0x66], 32:[], 64:[0x48] });
const CONDITION_NAMES = Object.freeze([
  'o','no','b','ae','e','ne','be','a','s','ns','p','np','l','ge','le','g',
]);

const forms = [];
function addForm(id, family, bytes, widthBits, access, options = {}) {
  forms.push(Object.freeze({
    id, family, bytes:Object.freeze([...bytes]), widthBits, access,
    explicitMemory:options.explicitMemory !== false,
    lockable:options.lockable === true,
    faultDirections:Object.freeze(options.faultDirections ?? (access === 'read-write' ? ['read-write'] : [access])),
    note:options.note ?? null,
  }));
}
function prefixed(widthBits, bytes) { return [...WIDTH_PREFIX[widthBits], ...bytes]; }
function modrm(extension = 0, rm = 0, mod = 0) { return (mod << 6) | ((extension & 7) << 3) | (rm & 7); }
function immediate(widthBits, value = 0x5a) {
  const encodedBytes = widthBits === 16 ? 2 : 4;
  return Array.from({ length:encodedBytes }, (_, index) => (value >>> (index * 8)) & 0xff);
}

// MOV/MOVABS and extension forms.
for (const widthBits of [8,16,32,64]) {
  const opcodeLoad = widthBits === 8 ? 0x8a : 0x8b;
  const opcodeStore = widthBits === 8 ? 0x88 : 0x89;
  addForm(`mov-load-${widthBits}`, 'mov', prefixed(widthBits,[opcodeLoad,0x00]), widthBits, 'read');
  addForm(`mov-store-register-${widthBits}`, 'mov', prefixed(widthBits,[opcodeStore,0x00]), widthBits, 'write');
  const immBytes = widthBits === 8 ? [0x5a] : immediate(widthBits);
  addForm(`mov-store-immediate-${widthBits}`, 'mov', prefixed(widthBits,[widthBits === 8 ? 0xc6 : 0xc7,0x00,...immBytes]), widthBits, 'write');
}
for (const [id,bytes,widthBits] of [
  ['movzx-8-16',[0x66,0x0f,0xb6,0x00],8],['movzx-8-32',[0x0f,0xb6,0x00],8],['movzx-8-64',[0x48,0x0f,0xb6,0x00],8],
  ['movzx-16-32',[0x0f,0xb7,0x00],16],['movzx-16-64',[0x48,0x0f,0xb7,0x00],16],
  ['movsx-8-16',[0x66,0x0f,0xbe,0x00],8],['movsx-8-32',[0x0f,0xbe,0x00],8],['movsx-8-64',[0x48,0x0f,0xbe,0x00],8],
  ['movsx-16-32',[0x0f,0xbf,0x00],16],['movsx-16-64',[0x48,0x0f,0xbf,0x00],16],
  ['movsxd-16',[0x66,0x63,0x00],16],['movsxd-32',[0x63,0x00],32],['movsxd-64',[0x48,0x63,0x00],32],
]) addForm(id, id.startsWith('movsxd') ? 'movsxd' : id.split('-').slice(0,1)[0], bytes, widthBits, 'read');

// Binary ALU/CMP register and immediate memory encodings.
const ALU = Object.freeze([
  Object.freeze({family:'add',base:0x00,ext:0,rmw:true}), Object.freeze({family:'or',base:0x08,ext:1,rmw:true}),
  Object.freeze({family:'adc',base:0x10,ext:2,rmw:true}), Object.freeze({family:'sbb',base:0x18,ext:3,rmw:true}),
  Object.freeze({family:'and',base:0x20,ext:4,rmw:true}), Object.freeze({family:'sub',base:0x28,ext:5,rmw:true}),
  Object.freeze({family:'xor',base:0x30,ext:6,rmw:true}), Object.freeze({family:'cmp',base:0x38,ext:7,rmw:false}),
]);
for (const spec of ALU) for (const widthBits of [8,16,32,64]) {
  const prefix = WIDTH_PREFIX[widthBits];
  const memoryDestinationOpcode = spec.base + (widthBits === 8 ? 0 : 1);
  const memorySourceOpcode = spec.base + (widthBits === 8 ? 2 : 3);
  addForm(`${spec.family}-memory-register-${widthBits}`,spec.family,[...prefix,memoryDestinationOpcode,0x00],widthBits,spec.rmw?'read-write':'read',{lockable:spec.rmw});
  addForm(`${spec.family}-register-memory-${widthBits}`,spec.family,[...prefix,memorySourceOpcode,0x00],widthBits,'read');
  const groupOpcode = widthBits === 8 ? 0x80 : 0x81;
  const imm = widthBits === 8 ? [0x5a] : immediate(widthBits);
  addForm(`${spec.family}-memory-immediate-full-${widthBits}`,spec.family,[...prefix,groupOpcode,modrm(spec.ext),...imm],widthBits,spec.rmw?'read-write':'read',{lockable:spec.rmw});
  if (widthBits !== 8) addForm(`${spec.family}-memory-immediate-8-${widthBits}`,spec.family,[...prefix,0x83,modrm(spec.ext),0x7f],widthBits,spec.rmw?'read-write':'read',{lockable:spec.rmw});
}

// TEST is read-only; NOT/NEG/INC/DEC are RMW and LOCK-valid for memory destinations.
for (const widthBits of [8,16,32,64]) {
  const prefix = WIDTH_PREFIX[widthBits];
  addForm(`test-memory-register-${widthBits}`,'test',[...prefix,widthBits===8?0x84:0x85,0x00],widthBits,'read');
  addForm(`test-memory-immediate-${widthBits}`,'test',[...prefix,widthBits===8?0xf6:0xf7,modrm(0),...(widthBits===8?[0x5a]:immediate(widthBits))],widthBits,'read');
  addForm(`not-memory-${widthBits}`,'not',[...prefix,widthBits===8?0xf6:0xf7,modrm(2)],widthBits,'read-write',{lockable:true});
  addForm(`neg-memory-${widthBits}`,'neg',[...prefix,widthBits===8?0xf6:0xf7,modrm(3)],widthBits,'read-write',{lockable:true});
  addForm(`inc-memory-${widthBits}`,'inc',[...prefix,widthBits===8?0xfe:0xff,modrm(0)],widthBits,'read-write',{lockable:true});
  addForm(`dec-memory-${widthBits}`,'dec',[...prefix,widthBits===8?0xfe:0xff,modrm(1)],widthBits,'read-write',{lockable:true});
  for (const [family,ext] of [['mul',4],['imul',5],['div',6],['idiv',7]]) {
    addForm(`${family}-implicit-memory-${widthBits}`,family,[...prefix,widthBits===8?0xf6:0xf7,modrm(ext)],widthBits,'read');
  }
}

// Shift/rotate: implicit one, immediate boundaries, and CL (conditional memory write).
for (const [family,ext] of [['rol',0],['ror',1],['shl',4],['shr',5],['sar',7]]) for (const widthBits of [8,16,32,64]) {
  const prefix = WIDTH_PREFIX[widthBits];
  addForm(`${family}-one-${widthBits}`,family,[...prefix,widthBits===8?0xd0:0xd1,modrm(ext)],widthBits,'read-write');
  for (const count of [0,1,Math.max(1,widthBits-1),widthBits,widthBits+1,0xff]) {
    const masked = count & (widthBits === 64 ? 0x3f : 0x1f);
    const effective = family === 'rol' || family === 'ror' ? masked % widthBits : masked;
    const access = effective === 0 ? 'read' : 'read-write';
    addForm(`${family}-imm-${widthBits}-${count}`,family,[...prefix,widthBits===8?0xc0:0xc1,modrm(ext),count&0xff],widthBits,access,{
      faultDirections:[access], note:`effective-count=${effective}`,
    });
  }
  addForm(`${family}-cl-${widthBits}`,family,[...prefix,widthBits===8?0xd2:0xd3,modrm(ext)],widthBits,'read-write',{note:'conditional write when masked count is zero/nonzero'});
}

// IMUL two/three operand memory-source forms.
for (const widthBits of [16,32,64]) {
  const prefix = WIDTH_PREFIX[widthBits];
  addForm(`imul-two-memory-${widthBits}`,'imul',[...prefix,0x0f,0xaf,0x00],widthBits,'read');
  addForm(`imul-three-imm8-memory-${widthBits}`,'imul',[...prefix,0x6b,0x00,0x7f],widthBits,'read');
  addForm(`imul-three-full-memory-${widthBits}`,'imul',[...prefix,0x69,0x00,...immediate(widthBits)],widthBits,'read');
}

// SETcc and CMOVcc cover every condition-code discriminator.
for (let cc=0; cc<16; cc++) {
  addForm(`set${CONDITION_NAMES[cc]}-memory`,`set${CONDITION_NAMES[cc]}`,[0x0f,0x90+cc,0x00],8,'write');
  for (const widthBits of [16,32,64]) {
    addForm(`cmov${CONDITION_NAMES[cc]}-memory-${widthBits}`,`cmov${CONDITION_NAMES[cc]}`,[...WIDTH_PREFIX[widthBits],0x0f,0x40+cc,0x00],widthBits,'read');
  }
}

// Explicit and implicit stack memory state. Long mode has 16- and 64-bit PUSH/POP, not 32-bit forms.
for (const widthBits of [16,64]) {
  const prefix = widthBits === 16 ? [0x66] : [];
  addForm(`push-memory-${widthBits}`,'push',[...prefix,0xff,modrm(6)],widthBits,'read',{faultDirections:['read','write']});
  addForm(`pop-memory-${widthBits}`,'pop',[...prefix,0x8f,modrm(0)],widthBits,'write',{faultDirections:['read','write']});
  addForm(`push-register-${widthBits}`,'push',[...prefix,0x50],widthBits,'write',{explicitMemory:false,faultDirections:['write']});
  addForm(`pop-register-${widthBits}`,'pop',[...prefix,0x58],widthBits,'read',{explicitMemory:false,faultDirections:['read']});
}
addForm('push-immediate-8','push',[0x6a,0x7f],64,'write',{explicitMemory:false,faultDirections:['write']});
addForm('push-immediate-32','push',[0x68,0x78,0x56,0x34,0x12],64,'write',{explicitMemory:false,faultDirections:['write']});
addForm('push-immediate-16','push',[0x66,0x68,0x34,0x12],16,'write',{explicitMemory:false,faultDirections:['write']});
addForm('push-rsp-memory','push',[0xff,0x34,0x24],64,'read',{faultDirections:['read','write'],note:'source address uses pre-decrement RSP'});
addForm('pop-rsp-memory','pop',[0x8f,0x04,0x24],64,'write',{faultDirections:['read','write'],note:'destination address uses post-increment RSP'});

export const X86_LONG64_MEMORY_SEMANTIC_FORMS = Object.freeze(forms);

function prefixExplicitMemoryForm(form, addressSizeBits, segment, locked) {
  const prefixes = [];
  if (segment.prefix != null) prefixes.push(segment.prefix);
  if (addressSizeBits === 32) prefixes.push(0x67);
  if (locked) prefixes.push(0xf0);
  return Uint8Array.from([...prefixes,...form.bytes]);
}

export function* x86Long64MemorySemanticCases() {
  for (const form of X86_LONG64_MEMORY_SEMANTIC_FORMS) {
    if (!form.explicitMemory) {
      yield Object.freeze({ ...form, caseId:form.id, bytes:Uint8Array.from(form.bytes), addressSizeBits:64, segment:SEGMENTS[0], locked:false });
      continue;
    }
    for (const addressSizeBits of ADDRESS_SIZES) for (const segment of SEGMENTS) {
      // Deployed Capstone 5 rejects 67 63 /r for the discouraged non-REX.W
      // MOVSXD forms even though Intel/LLVM accept the bytes. Those encodings
      // therefore do not enter the locked decoder-owned denominator.
      if ((form.id === 'movsxd-16' || form.id === 'movsxd-32') && addressSizeBits === 32) continue;
      for (const locked of form.lockable ? [false,true] : [false]) {
        yield Object.freeze({
          ...form,
          caseId:`${form.id}:a${addressSizeBits}:${segment.id}${locked?':lock':''}`,
          bytes:prefixExplicitMemoryForm(form,addressSizeBits,segment,locked),
          addressSizeBits, segment, locked,
        });
      }
    }
  }
}

function displacementBytes(mod, rm, sib) {
  if (mod === 1) return [0x80];
  if (mod === 2) return [0x80,0xff,0xff,0xff];
  const noBase = rm === 5 || (rm === 4 && (sib & 7) === 5);
  return noBase ? [0x78,0x56,0x34,0x12] : [];
}

/**
 * Exhaustive long-mode ModRM/SIB address discriminator sweep on MOV r64,r/m64.
 * The opcode is deliberately fixed so address proof and operation proof remain
 * separate finite axes rather than a combinatorial product with no extra fact.
 */
export function* x86Long64MemoryAddressCases() {
  for (const addressSizeBits of ADDRESS_SIZES) for (let rexLowBits=0; rexLowBits<8; rexLowBits++) {
    for (let mod=0; mod<3; mod++) for (let reg=0; reg<8; reg++) for (let rm=0; rm<8; rm++) {
      const addressPrefix = addressSizeBits === 32 ? [0x67] : [];
      const rex = 0x48 | rexLowBits;
      if (rm !== 4) {
        const bytes = [...addressPrefix,rex,0x8b,(mod<<6)|(reg<<3)|rm,...displacementBytes(mod,rm,0)];
        yield Object.freeze({ id:`a${addressSizeBits}:rex${rexLowBits}:m${mod}:r${reg}:rm${rm}`, bytes:Uint8Array.from(bytes), addressSizeBits, rexLowBits, mod, reg, rm, sib:null });
        continue;
      }
      for (let sib=0; sib<256; sib++) {
        const bytes = [...addressPrefix,rex,0x8b,(mod<<6)|(reg<<3)|4,sib,...displacementBytes(mod,4,sib)];
        yield Object.freeze({ id:`a${addressSizeBits}:rex${rexLowBits}:m${mod}:r${reg}:sib${sib}`, bytes:Uint8Array.from(bytes), addressSizeBits, rexLowBits, mod, reg, rm:4, sib });
      }
    }
  }
}

function moffsBytes(opcode, widthBits, addressSizeBits, direction) {
  const prefixes = [];
  if (addressSizeBits === 32) prefixes.push(0x67);
  if (widthBits === 16) prefixes.push(0x66);
  if (widthBits === 64) prefixes.push(0x48);
  const offsetBytes = addressSizeBits === 32 ? [0x78,0x56,0x34,0x12] : [0x78,0x56,0x34,0x12,0xef,0xcd,0xab,0x09];
  return Object.freeze({ id:`moffs-${direction}-${widthBits}-a${addressSizeBits}`, family:addressSizeBits===64?'movabs':'mov', bytes:Uint8Array.from([...prefixes,opcode,...offsetBytes]), widthBits, addressSizeBits, direction });
}
export function* x86Long64MemoryMoffsCases() {
  for (const addressSizeBits of ADDRESS_SIZES) {
    yield moffsBytes(0xa0,8,addressSizeBits,'read');
    yield moffsBytes(0xa2,8,addressSizeBits,'write');
    for (const widthBits of [16,32,64]) {
      yield moffsBytes(0xa1,widthBits,addressSizeBits,'read');
      yield moffsBytes(0xa3,widthBits,addressSizeBits,'write');
    }
  }
}

export const X86_LONG64_MEMORY_ATOMIC_EXCLUSIONS = Object.freeze([
  Object.freeze({ id:'xchg', bytes:Uint8Array.of(0x48,0x87,0x00) }),
  Object.freeze({ id:'xadd', bytes:Uint8Array.of(0x48,0x0f,0xc1,0x00) }),
  Object.freeze({ id:'cmpxchg', bytes:Uint8Array.of(0x48,0x0f,0xb1,0x08) }),
  Object.freeze({ id:'cmpxchg8b', bytes:Uint8Array.of(0x0f,0xc7,0x08) }),
  Object.freeze({ id:'cmpxchg16b', bytes:Uint8Array.of(0x48,0x0f,0xc7,0x08) }),
]);

export function x86Long64MemoryDenominatorIdentity() {
  const semanticBaseCount = [...x86Long64MemorySemanticCases()].length;
  return Object.freeze({
    schemaVersion:X86_LONG64_MEMORY_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_MEMORY_DENOMINATOR_ID,
    architecture:'x86_64', mode:'long-64', owner:'memory',
    semanticFormCount:X86_LONG64_MEMORY_SEMANTIC_FORMS.length,
    semanticCaseCount:semanticBaseCount,
    addressEncodingCaseCount:2*8*3*8*(7+256),
    moffsCaseCount:16,
    addressSizeBits:Object.freeze([...ADDRESS_SIZES]),
    segmentClasses:Object.freeze(SEGMENTS.map(({id,space,baseRule})=>Object.freeze({id,space,baseRule}))),
    decoderCanonicalAliases:Object.freeze([Object.freeze({ alias:'sal', canonicalFamily:'shl', opcodeGroup:'D0/D1/D2/D3/C0/C1 /4' })]),
    decoderBoundaryExclusions:Object.freeze([
      Object.freeze({ id:'movsxd-16-a32', bytes:'67 66 63 /r', reason:'deployed-capstone-5-long64-rejects-encoding; Intel SDM and LLVM accept' }),
      Object.freeze({ id:'movsxd-32-a32', bytes:'67 63 /r', reason:'deployed-capstone-5-long64-rejects-encoding; Intel SDM and LLVM accept' }),
    ]),
    ownership:Object.freeze({
      memoryFamilies:Object.freeze(['mov','movabs','movzx','movsx','movsxd','add','sub','and','or','xor','adc','sbb','inc','dec','neg','not','shl','sal','shr','sar','rol','ror','mul','imul','div','idiv','cmp','test','setcc','cmovcc','push','pop']),
      atomicExcludedFamilies:Object.freeze(X86_LONG64_MEMORY_ATOMIC_EXCLUSIONS.map(({id})=>id)),
    }),
    independentOracleIds:Object.freeze([
      'intel-sdm-vol2-instruction-reference-memory-encodings',
      'intel-sdm-vol1-64-bit-addressing-and-segment-rules',
      'amd64-apm-vol3-general-purpose-and-system-instructions',
      'deployed-capstone-5-x86-long64-structured-detail',
      'llvm-objdump-x86-64-independent-disassembly-sample',
      'byte-level-modrm-sib-effective-address-oracle-v1',
    ]),
  });
}
