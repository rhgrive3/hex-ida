export const X86_LONG64_INTEGER_DENOMINATOR_SCHEMA = 'x86-long64-integer-denominator/v1';
export const X86_LONG64_INTEGER_DENOMINATOR_ID = 'x86_64:long-64:effect-family:integer:v1';

export const X86_LONG64_INTEGER_MNEMONICS = Object.freeze([
  'mov','movabs','movzx','movsx','movsxd',
  'add','adc','sub','sbb','and','or','xor','cmp','test',
  'inc','dec','neg','not',
  'shl','sal','shr','sar','rol','ror',
  'mul','imul','div','idiv',
  'cbw','cwde','cdqe','cwd','cdq','cqo',
  'seto','setno','setb','setae','sete','setne','setbe','seta','sets','setns','setp','setnp','setl','setge','setle','setg',
  'cmovo','cmovno','cmovb','cmovae','cmove','cmovne','cmovbe','cmova','cmovs','cmovns','cmovp','cmovnp','cmovl','cmovge','cmovle','cmovg',
]);

const WIDTH_FORMS = Object.freeze({
  8:Object.freeze({ widthBits:8, legacy:Object.freeze([]), rexW:false }),
  16:Object.freeze({ widthBits:16, legacy:Object.freeze([0x66]), rexW:false }),
  32:Object.freeze({ widthBits:32, legacy:Object.freeze([]), rexW:false }),
  64:Object.freeze({ widthBits:64, legacy:Object.freeze([]), rexW:true }),
});
const CONDITION_SUFFIXES = Object.freeze(['o','no','b','ae','e','ne','be','a','s','ns','p','np','l','ge','le','g']);
const BINARY_ROWS = Object.freeze([
  Object.freeze({ family:'add', base:0x00, group:0 }),
  Object.freeze({ family:'or',  base:0x08, group:1 }),
  Object.freeze({ family:'adc', base:0x10, group:2 }),
  Object.freeze({ family:'sbb', base:0x18, group:3 }),
  Object.freeze({ family:'and', base:0x20, group:4 }),
  Object.freeze({ family:'sub', base:0x28, group:5 }),
  Object.freeze({ family:'xor', base:0x30, group:6 }),
  Object.freeze({ family:'cmp', base:0x38, group:7 }),
]);
const SHIFT_ROWS = Object.freeze([
  Object.freeze({ family:'rol', group:0, signedness:'bitwise' }),
  Object.freeze({ family:'ror', group:1, signedness:'bitwise' }),
  Object.freeze({ family:'shl', group:4, signedness:'bitwise' }),
  Object.freeze({ family:'shr', group:5, signedness:'unsigned' }),
  Object.freeze({ family:'sal', group:6, signedness:'bitwise' }),
  Object.freeze({ family:'sar', group:7, signedness:'signed' }),
]);

function fail(reason, detail = '') { throw new TypeError(detail ? `${reason}:${detail}` : reason); }
function bytes(...values) { return Uint8Array.from(values.flat()); }
function le(value, size) {
  let current = BigInt(value);
  return Array.from({ length:size }, () => { const out = Number(current & 0xffn); current >>= 8n; return out; });
}
function unique(values) { return [...new Set(values)]; }
function rex({ w = false, r = 0, b = 0, force = false } = {}) {
  if (!force && !w && !r && !b) return [];
  return [0x40 | (w ? 8 : 0) | ((r & 1) << 2) | (b & 1)];
}
function prefix(widthBits, { r = 0, b = 0, forceRex = false } = {}) {
  const form = WIDTH_FORMS[widthBits];
  if (!form) fail('x86-integer-denominator-invalid-width', widthBits);
  return [...form.legacy, ...rex({ w:form.rexW, r, b, force:forceRex || form.rexW || r || b })];
}
function modrm(mod, reg, rm) { return ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7); }
function immediateWitnesses(widthBits, encodedWidthBits = widthBits) {
  if (encodedWidthBits === 8) return Object.freeze([0n,1n,0x7fn,0x80n,0xffn]);
  if (encodedWidthBits === 16) return Object.freeze([0n,1n,0x7fffn,0x8000n,0xffffn]);
  if (encodedWidthBits === 32) return Object.freeze([0n,1n,0x7fffffffn,0x80000000n,0xffffffffn]);
  if (encodedWidthBits === 64) return Object.freeze([0n,1n,0x7fffffffffffffffn,0x8000000000000000n,0xffffffffffffffffn]);
  fail('x86-integer-denominator-invalid-immediate-width', encodedWidthBits);
}
function shiftCountWitnesses(widthBits) {
  return Object.freeze(unique([0,1,2,widthBits - 1,widthBits,widthBits + 1,31,32,63,64,255]).filter((value) => value >= 0 && value <= 255));
}
function item(id, family, encoded, config = {}) {
  return Object.freeze({
    id,
    family,
    bytes:encoded,
    owner:config.owner ?? 'integer',
    form:config.form ?? 'register',
    operandWidthBits:config.operandWidthBits ?? null,
    sourceWidthBits:config.sourceWidthBits ?? null,
    immediateWidthBits:config.immediateWidthBits ?? null,
    implicitReads:Object.freeze(config.implicitReads ?? []),
    implicitWrites:Object.freeze(config.implicitWrites ?? []),
    prefixClass:config.prefixClass ?? 'default',
    countDiscriminator:config.countDiscriminator ?? null,
    signedness:config.signedness ?? null,
    semanticClass:config.semanticClass ?? family,
  });
}
function* regRegOpcodeCases({ family, opcode, widths, direction, semanticClass = family }) {
  for (const widthBits of widths) {
    for (const r of [0,1]) for (const b of [0,1]) {
      const forceRexStates = widthBits === 8 && r === 0 && b === 0 ? [false,true] : [widthBits === 8 && Boolean(r || b)];
      for (const forceRex of forceRexStates) {
        for (let regField = 0; regField < 8; regField++) for (let rmField = 0; rmField < 8; rmField++) {
          yield item(`${family}:${semanticClass}:${direction}:w${widthBits}:r${r}:b${b}:rex${forceRex?1:0}:reg${regField}:rm${rmField}`, family,
            bytes(prefix(widthBits,{r,b,forceRex}), opcode, modrm(3,regField,rmField)),
            { operandWidthBits:widthBits, form:'register-register', prefixClass:widthBits === 64?'rex.w':widthBits === 16?'66':forceRex?'rex':'default', semanticClass });
        }
      }
      yield item(`${family}:${semanticClass}:${direction}:memory:w${widthBits}:r${r}:b${b}`, family,
        bytes(prefix(widthBits,{r,b}), opcode, modrm(0,0,0)),
        { owner:'memory', operandWidthBits:widthBits, form:direction === 'rm-reg'?'memory-destination':'memory-source', prefixClass:widthBits === 64?'rex.w':widthBits === 16?'66':'default', semanticClass });
    }
  }
}
function* groupRegisterCases({ family, opcode, group, widths, semanticClass = family, countDiscriminator = null, immediate = null, signedness = null }) {
  for (const widthBits of widths) {
    for (const b of [0,1]) {
      const forceRexStates = widthBits === 8 && b === 0 ? [false,true] : [widthBits === 8 && b === 1];
      for (const forceRex of forceRexStates) {
        for (let rmField = 0; rmField < 8; rmField++) {
          if (immediate) {
            for (const value of immediate.values(widthBits)) {
              yield item(`${family}:${semanticClass}:group${group}:w${widthBits}:b${b}:rex${forceRex?1:0}:rm${rmField}:i${value.toString(16)}`, family,
                bytes(prefix(widthBits,{b,forceRex}), opcode, modrm(3,group,rmField), le(value,immediate.bytes(widthBits))),
                { operandWidthBits:widthBits, immediateWidthBits:immediate.bits(widthBits), form:'register-immediate', prefixClass:forceRex?'rex':widthBits===16?'66':widthBits===64?'rex.w':'default', countDiscriminator:countDiscriminator?.(value,widthBits) ?? null, signedness, semanticClass });
            }
          } else {
            yield item(`${family}:${semanticClass}:group${group}:w${widthBits}:b${b}:rex${forceRex?1:0}:rm${rmField}`, family,
              bytes(prefix(widthBits,{b,forceRex}), opcode, modrm(3,group,rmField)),
              { operandWidthBits:widthBits, form:'register', prefixClass:forceRex?'rex':widthBits===16?'66':widthBits===64?'rex.w':'default', signedness, semanticClass });
          }
        }
      }
      const tail = immediate ? le(immediate.values(widthBits)[1],immediate.bytes(widthBits)) : [];
      yield item(`${family}:${semanticClass}:group${group}:memory:w${widthBits}:b${b}`, family,
        bytes(prefix(widthBits,{b}), opcode, modrm(0,group,0), tail),
        { owner:'memory', operandWidthBits:widthBits, immediateWidthBits:immediate?.bits(widthBits) ?? null, form:'memory', signedness, semanticClass });
    }
  }
}

export function* x86Long64IntegerEncodingCases() {
  // MOV register/memory directions.
  yield* regRegOpcodeCases({ family:'mov', opcode:0x88, widths:[8], direction:'rm-reg' });
  yield* regRegOpcodeCases({ family:'mov', opcode:0x89, widths:[16,32,64], direction:'rm-reg' });
  yield* regRegOpcodeCases({ family:'mov', opcode:0x8a, widths:[8], direction:'reg-rm' });
  yield* regRegOpcodeCases({ family:'mov', opcode:0x8b, widths:[16,32,64], direction:'reg-rm' });

  // MOV immediate forms. B0/B8 encode the destination register in the opcode.
  for (const widthBits of [8,16,32,64]) {
    const encodedWidthBits = widthBits;
    const size = encodedWidthBits / 8;
    for (const b of [0,1]) for (let low = 0; low < 8; low++) {
      const opcode = (widthBits === 8 ? 0xb0 : 0xb8) + low;
      const forceRexStates = widthBits === 8 && b === 0 ? [false,true] : [widthBits === 8 && b === 1];
      for (const forceRex of forceRexStates) for (const value of immediateWitnesses(widthBits,encodedWidthBits)) {
        yield item(`mov:opcode-reg-imm:w${widthBits}:b${b}:rex${forceRex?1:0}:r${low}:i${value.toString(16)}`, widthBits === 64 ? 'movabs' : 'mov',
          bytes(prefix(widthBits,{b,forceRex}),opcode,le(value,size)),
          { operandWidthBits:widthBits, immediateWidthBits:encodedWidthBits, form:'register-immediate', prefixClass:widthBits===64?'rex.w':widthBits===16?'66':forceRex?'rex':'default', semanticClass:'mov-opcode-register-immediate' });
      }
    }
  }
  for (const [widthBits,opcode,encodedWidthBits] of [[8,0xc6,8],[16,0xc7,16],[32,0xc7,32],[64,0xc7,32]]) {
    for (const b of [0,1]) for (let rmField = 0; rmField < 8; rmField++) for (const value of immediateWitnesses(widthBits,encodedWidthBits)) {
      yield item(`mov:group0-imm:w${widthBits}:b${b}:rm${rmField}:i${value.toString(16)}`, 'mov',
        bytes(prefix(widthBits,{b}),opcode,modrm(3,0,rmField),le(value,encodedWidthBits/8)),
        { operandWidthBits:widthBits, immediateWidthBits:encodedWidthBits, form:'register-immediate', semanticClass:'mov-group-immediate' });
    }
    yield item(`mov:group0-imm:memory:w${widthBits}`, 'mov',
      bytes(prefix(widthBits),opcode,modrm(0,0,0),le(1n,encodedWidthBits/8)),
      { owner:'memory', operandWidthBits:widthBits, immediateWidthBits:encodedWidthBits, form:'memory-immediate', semanticClass:'mov-group-immediate' });
  }

  // MOVZX/MOVSX fixed-source-width opcodes. Capstone 5 intentionally exposes
  // the operand-size=16 same-width forms; the effect is still an exact copy.
  for (const [family,opcode,sourceWidthBits] of [['movzx',0xb6,8],['movzx',0xb7,16],['movsx',0xbe,8],['movsx',0xbf,16]]) {
    for (const widthBits of [16,32,64]) {
      if (widthBits < sourceWidthBits) continue;
      for (const r of [0,1]) for (const b of [0,1]) for (let regField = 0; regField < 8; regField++) for (let rmField = 0; rmField < 8; rmField++) {
        yield item(`${family}:0f${opcode.toString(16)}:w${widthBits}:src${sourceWidthBits}:r${r}:b${b}:reg${regField}:rm${rmField}`, family,
          bytes(prefix(widthBits,{r,b}),0x0f,opcode,modrm(3,regField,rmField)),
          { operandWidthBits:widthBits, sourceWidthBits, form:'register-register', signedness:family==='movsx'?'signed':'unsigned', semanticClass:'extend' });
      }
      yield item(`${family}:0f${opcode.toString(16)}:memory:w${widthBits}:src${sourceWidthBits}`, family,
        bytes(prefix(widthBits),0x0f,opcode,modrm(0,0,0)),
        { owner:'memory', operandWidthBits:widthBits, sourceWidthBits, form:'memory-source', signedness:family==='movsx'?'signed':'unsigned', semanticClass:'extend' });
    }
  }

  // Opcode 63 in long mode is MOVSXD for all operand-size states accepted by
  // the locked decoder. Capstone reports the source register view as r32 even
  // for 66h; architectural operand-size still makes the 16-bit destination a
  // low-16 copy, 32-bit destination a low-32 copy/zeroing GPR write, and REX.W
  // the signed 32->64 extension.
  for (const widthBits of [16,32,64]) {
    for (const r of [0,1]) for (const b of [0,1]) for (let regField = 0; regField < 8; regField++) for (let rmField = 0; rmField < 8; rmField++) {
      yield item(`movsxd:63:w${widthBits}:r${r}:b${b}:reg${regField}:rm${rmField}`, 'movsxd',
        bytes(prefix(widthBits,{r,b}),0x63,modrm(3,regField,rmField)),
        { operandWidthBits:widthBits, sourceWidthBits:32, form:'register-register', signedness:widthBits===64?'signed':'copy-low-bits', semanticClass:'movsxd' });
    }
    yield item(`movsxd:63:memory:w${widthBits}`, 'movsxd', bytes(prefix(widthBits),0x63,modrm(0,0,0)),
      { owner:'memory', operandWidthBits:widthBits, sourceWidthBits:32, form:'memory-source', signedness:widthBits===64?'signed':'copy-low-bits', semanticClass:'movsxd' });
  }

  // ADD/OR/ADC/SBB/AND/SUB/XOR/CMP primary opcode rows and group-immediate rows.
  for (const row of BINARY_ROWS) {
    yield* regRegOpcodeCases({ family:row.family, opcode:row.base, widths:[8], direction:'rm-reg', semanticClass:'primary-rm-reg' });
    yield* regRegOpcodeCases({ family:row.family, opcode:row.base+1, widths:[16,32,64], direction:'rm-reg', semanticClass:'primary-rm-reg' });
    yield* regRegOpcodeCases({ family:row.family, opcode:row.base+2, widths:[8], direction:'reg-rm', semanticClass:'primary-reg-rm' });
    yield* regRegOpcodeCases({ family:row.family, opcode:row.base+3, widths:[16,32,64], direction:'reg-rm', semanticClass:'primary-reg-rm' });
    for (const widthBits of [8,16,32,64]) {
      const opcode = row.base + (widthBits === 8 ? 4 : 5);
      const encodedWidthBits = widthBits === 64 ? 32 : widthBits;
      for (const value of immediateWitnesses(widthBits,encodedWidthBits)) {
        yield item(`${row.family}:acc-imm:w${widthBits}:i${value.toString(16)}`, row.family,
          bytes(prefix(widthBits),opcode,le(value,encodedWidthBits/8)),
          { operandWidthBits:widthBits, immediateWidthBits:encodedWidthBits, form:'register-immediate', semanticClass:'accumulator-immediate' });
      }
    }
    yield* groupRegisterCases({ family:row.family, opcode:0x80, group:row.group, widths:[8], semanticClass:'group-immediate-80', immediate:{ bits:()=>8, bytes:()=>1, values:()=>immediateWitnesses(8,8) } });
    yield* groupRegisterCases({ family:row.family, opcode:0x81, group:row.group, widths:[16,32,64], semanticClass:'group-immediate-81', immediate:{ bits:(w)=>w===64?32:w, bytes:(w)=>(w===64?32:w)/8, values:(w)=>immediateWitnesses(w,w===64?32:w) } });
    yield* groupRegisterCases({ family:row.family, opcode:0x83, group:row.group, widths:[16,32,64], semanticClass:'group-signext-imm8', immediate:{ bits:()=>8, bytes:()=>1, values:()=>immediateWitnesses(8,8) } });
  }

  // TEST explicit register and immediate encodings.
  yield* regRegOpcodeCases({ family:'test', opcode:0x84, widths:[8], direction:'rm-reg', semanticClass:'test-rm-reg' });
  yield* regRegOpcodeCases({ family:'test', opcode:0x85, widths:[16,32,64], direction:'rm-reg', semanticClass:'test-rm-reg' });
  for (const widthBits of [8,16,32,64]) {
    const opcode = widthBits === 8 ? 0xa8 : 0xa9;
    const encodedWidthBits = widthBits === 64 ? 32 : widthBits;
    for (const value of immediateWitnesses(widthBits,encodedWidthBits)) yield item(`test:acc-imm:w${widthBits}:i${value.toString(16)}`, 'test',
      bytes(prefix(widthBits),opcode,le(value,encodedWidthBits/8)), { operandWidthBits:widthBits, immediateWidthBits:encodedWidthBits, form:'register-immediate', semanticClass:'test-accumulator-immediate' });
  }
  yield* groupRegisterCases({ family:'test', opcode:0xf6, group:0, widths:[8], semanticClass:'test-group', immediate:{ bits:()=>8, bytes:()=>1, values:()=>immediateWitnesses(8,8) } });
  yield* groupRegisterCases({ family:'test', opcode:0xf7, group:0, widths:[16,32,64], semanticClass:'test-group', immediate:{ bits:(w)=>w===64?32:w, bytes:(w)=>(w===64?32:w)/8, values:(w)=>immediateWitnesses(w,w===64?32:w) } });

  // Unary INC/DEC and F6/F7 NOT/NEG/MUL/IMUL/DIV/IDIV.
  for (const [family,group] of [['inc',0],['dec',1]]) {
    yield* groupRegisterCases({ family, opcode:0xfe, group, widths:[8], semanticClass:'unary' });
    yield* groupRegisterCases({ family, opcode:0xff, group, widths:[16,32,64], semanticClass:'unary' });
  }
  for (const [family,group,signedness,implicit] of [
    ['not',2,'bitwise',null],['neg',3,'signed',null],
    ['mul',4,'unsigned','multiply'],['imul',5,'signed','multiply'],['div',6,'unsigned','divide'],['idiv',7,'signed','divide'],
  ]) {
    for (const [opcode,widths] of [[0xf6,[8]],[0xf7,[16,32,64]]]) {
      for (const widthBits of widths) {
        const implicitReads = implicit === 'multiply' ? [widthBits===8?'al':widthBits===16?'ax':widthBits===32?'eax':'rax']
          : implicit === 'divide' ? [widthBits===8?'ax':widthBits===16?'ax':widthBits===32?'eax':'rax', ...(widthBits===8?[]:[widthBits===16?'dx':widthBits===32?'edx':'rdx'])] : [];
        const implicitWrites = implicit === 'multiply' ? (widthBits===8?['ax','rflags']:[widthBits===16?'ax':widthBits===32?'eax':'rax',widthBits===16?'dx':widthBits===32?'edx':'rdx','rflags'])
          : implicit === 'divide' ? (widthBits===8?['al','ah','rflags']:[widthBits===16?'ax':widthBits===32?'eax':'rax',widthBits===16?'dx':widthBits===32?'edx':'rdx','rflags']) : [];
        for (const b of [0,1]) for (let rmField = 0; rmField < 8; rmField++) {
          yield item(`${family}:${opcode.toString(16)}:group${group}:w${widthBits}:b${b}:rm${rmField}`, family,
            bytes(prefix(widthBits,{b}),opcode,modrm(3,group,rmField)),
            { operandWidthBits:widthBits, form:'register', signedness, implicitReads, implicitWrites, semanticClass:implicit?`implicit-${implicit}`:'unary' });
        }
        yield item(`${family}:${opcode.toString(16)}:group${group}:memory:w${widthBits}`, family,
          bytes(prefix(widthBits),opcode,modrm(0,group,0)),
          { owner:'memory', operandWidthBits:widthBits, form:'memory', signedness, implicitReads, implicitWrites, semanticClass:implicit?`implicit-${implicit}`:'unary' });
      }
    }
  }

  // IMUL truncated two- and three-operand forms.
  for (const widthBits of [16,32,64]) {
    for (const r of [0,1]) for (const b of [0,1]) for (let regField=0; regField<8; regField++) for (let rmField=0; rmField<8; rmField++) {
      yield item(`imul:0faf:w${widthBits}:r${r}:b${b}:reg${regField}:rm${rmField}`, 'imul',
        bytes(prefix(widthBits,{r,b}),0x0f,0xaf,modrm(3,regField,rmField)),
        { operandWidthBits:widthBits, form:'register-register', signedness:'signed', semanticClass:'imul-two-operand' });
    }
    yield item(`imul:0faf:memory:w${widthBits}`, 'imul', bytes(prefix(widthBits),0x0f,0xaf,modrm(0,0,0)),
      { owner:'memory', operandWidthBits:widthBits, form:'memory-source', signedness:'signed', semanticClass:'imul-two-operand' });
    for (const [opcode,encodedWidthBits] of [[0x69,widthBits===64?32:widthBits],[0x6b,8]]) {
      for (const r of [0,1]) for (const b of [0,1]) for (let regField=0; regField<8; regField++) for (let rmField=0; rmField<8; rmField++) {
        for (const value of immediateWitnesses(widthBits,encodedWidthBits)) yield item(`imul:${opcode.toString(16)}:w${widthBits}:r${r}:b${b}:reg${regField}:rm${rmField}:i${value.toString(16)}`, 'imul',
          bytes(prefix(widthBits,{r,b}),opcode,modrm(3,regField,rmField),le(value,encodedWidthBits/8)),
          { operandWidthBits:widthBits, immediateWidthBits:encodedWidthBits, form:'register-register-immediate', signedness:'signed', semanticClass:'imul-three-operand' });
      }
      yield item(`imul:${opcode.toString(16)}:memory:w${widthBits}`, 'imul', bytes(prefix(widthBits),opcode,modrm(0,0,0),le(1n,encodedWidthBits/8)),
        { owner:'memory', operandWidthBits:widthBits, immediateWidthBits:encodedWidthBits, form:'register-memory-immediate', signedness:'signed', semanticClass:'imul-three-operand' });
    }
  }

  // Shift/rotate count-source discriminators, including SAL's /6 alias.
  for (const row of SHIFT_ROWS) {
    for (const widthBits of [8,16,32,64]) {
      const oneOpcode = widthBits === 8 ? 0xd0 : 0xd1;
      const clOpcode = widthBits === 8 ? 0xd2 : 0xd3;
      const immOpcode = widthBits === 8 ? 0xc0 : 0xc1;
      for (const b of [0,1]) for (let rmField=0; rmField<8; rmField++) {
        yield item(`${row.family}:count1:w${widthBits}:b${b}:rm${rmField}`, row.family,
          bytes(prefix(widthBits,{b}),oneOpcode,modrm(3,row.group,rmField)),
          { operandWidthBits:widthBits, form:'register-immediate', immediateWidthBits:8, countDiscriminator:'one', signedness:row.signedness, semanticClass:'shift-rotate' });
        yield item(`${row.family}:count-cl:w${widthBits}:b${b}:rm${rmField}`, row.family,
          bytes(prefix(widthBits,{b}),clOpcode,modrm(3,row.group,rmField)),
          { operandWidthBits:widthBits, form:'register-cl', sourceWidthBits:8, implicitReads:['cl'], countDiscriminator:'cl-masked', signedness:row.signedness, semanticClass:'shift-rotate' });
        for (const count of shiftCountWitnesses(widthBits)) yield item(`${row.family}:count-imm:w${widthBits}:b${b}:rm${rmField}:c${count}`, row.family,
          bytes(prefix(widthBits,{b}),immOpcode,modrm(3,row.group,rmField),count),
          { operandWidthBits:widthBits, form:'register-immediate', immediateWidthBits:8, countDiscriminator:`imm8:${count}`, signedness:row.signedness, semanticClass:'shift-rotate' });
      }
      yield item(`${row.family}:memory-count1:w${widthBits}`, row.family, bytes(prefix(widthBits),oneOpcode,modrm(0,row.group,0)),
        { owner:'memory', operandWidthBits:widthBits, form:'memory-immediate', countDiscriminator:'one', signedness:row.signedness, semanticClass:'shift-rotate' });
      yield item(`${row.family}:memory-count-cl:w${widthBits}`, row.family, bytes(prefix(widthBits),clOpcode,modrm(0,row.group,0)),
        { owner:'memory', operandWidthBits:widthBits, form:'memory-cl', sourceWidthBits:8, implicitReads:['cl'], countDiscriminator:'cl-masked', signedness:row.signedness, semanticClass:'shift-rotate' });
      yield item(`${row.family}:memory-count-imm:w${widthBits}`, row.family, bytes(prefix(widthBits),immOpcode,modrm(0,row.group,0),2),
        { owner:'memory', operandWidthBits:widthBits, form:'memory-immediate', immediateWidthBits:8, countDiscriminator:'imm8:2', signedness:row.signedness, semanticClass:'shift-rotate' });
    }
  }

  // Implicit sign-extension opcodes 98/99.
  for (const [family,opcode,widthBits,implicitReads,implicitWrites] of [
    ['cbw',0x98,16,['al'],['ax']],['cwde',0x98,32,['ax'],['eax']],['cdqe',0x98,64,['eax'],['rax']],
    ['cwd',0x99,16,['ax'],['ax','dx']],['cdq',0x99,32,['eax'],['eax','edx']],['cqo',0x99,64,['rax'],['rax','rdx']],
  ]) yield item(`${family}:implicit`, family, bytes(prefix(widthBits),opcode),
    { operandWidthBits:widthBits, form:'implicit', implicitReads, implicitWrites, signedness:'signed', semanticClass:'implicit-sign-extension' });

  // SETcc and CMOVcc condition-code opcode discriminators.
  for (let cc=0; cc<16; cc++) {
    const suffix = CONDITION_SUFFIXES[cc];
    const setFamily = `set${suffix}`;
    for (const b of [0,1]) for (let rmField=0; rmField<8; rmField++) yield item(`${setFamily}:cc${cc}:b${b}:rm${rmField}`, setFamily,
      bytes(prefix(8,{b,forceRex:b===1}),0x0f,0x90+cc,modrm(3,0,rmField)),
      { operandWidthBits:8, form:'register', semanticClass:'setcc' });
    yield item(`${setFamily}:cc${cc}:memory`, setFamily, bytes(0x0f,0x90+cc,modrm(0,0,0)),
      { owner:'memory', operandWidthBits:8, form:'memory', semanticClass:'setcc' });

    const cmovFamily = `cmov${suffix}`;
    for (const widthBits of [16,32,64]) {
      for (const r of [0,1]) for (const b of [0,1]) for (let regField=0; regField<8; regField++) for (let rmField=0; rmField<8; rmField++) yield item(`${cmovFamily}:cc${cc}:w${widthBits}:r${r}:b${b}:reg${regField}:rm${rmField}`, cmovFamily,
        bytes(prefix(widthBits,{r,b}),0x0f,0x40+cc,modrm(3,regField,rmField)),
        { operandWidthBits:widthBits, form:'register-register', semanticClass:'cmovcc' });
      yield item(`${cmovFamily}:cc${cc}:memory:w${widthBits}`, cmovFamily, bytes(prefix(widthBits),0x0f,0x40+cc,modrm(0,0,0)),
        { owner:'memory', operandWidthBits:widthBits, form:'memory-source', semanticClass:'cmovcc' });
    }
  }
}

function sameBytes(left, right) {
  return left?.length === right?.length && left.every((value,index) => value === right[index]);
}
function registerName(value) { return typeof value === 'string' ? value.toLowerCase() : String(value?.id ?? value?.registerId ?? '').toLowerCase(); }
function assertImplicit(actual, required, label, itemId) {
  const names = new Set((actual || []).map(registerName));
  for (const name of required) if (!names.has(name)) fail(`x86-integer-denominator-missing-${label}`, `${itemId}:${name}`);
}

export function validateX86Long64IntegerDecodedCase(candidate, decoded) {
  if (!candidate || !decoded) fail('x86-integer-denominator-decoded-case-required');
  if (decoded.detailAvailable !== true || decoded.detailStatus !== 'complete') fail('x86-integer-denominator-structured-detail-required', candidate.id);
  if (decoded.mode !== 'long-64') fail('x86-integer-denominator-mode-drift', candidate.id);
  if (!sameBytes(decoded.rawBytes, candidate.bytes)) fail('x86-integer-denominator-byte-drift', candidate.id);
  if (String(decoded.instructionFamily || '').toLowerCase() !== candidate.family) fail('x86-integer-denominator-family-drift', `${candidate.id}:${decoded.instructionFamily}`);
  const detail = decoded.detail;
  if (!detail || !detail.prefixes || !Array.isArray(detail.operands)) fail('x86-integer-denominator-truncated-detail', candidate.id);
  if (!Array.isArray(detail.implicitReads) || !Array.isArray(detail.implicitWrites)) fail('x86-integer-denominator-truncated-implicit-detail', candidate.id);
  assertImplicit(detail.implicitReads,candidate.implicitReads,'implicit-read',candidate.id);
  assertImplicit(detail.implicitWrites,candidate.implicitWrites,'implicit-write',candidate.id);
  if (candidate.operandWidthBits != null && candidate.form !== 'implicit') {
    const material = detail.operands.filter((operand) => operand?.type === 'register' || operand?.type === 'memory');
    if (material.length === 0) fail('x86-integer-denominator-material-operand-required', candidate.id);
    const destinationWidth = Number(material[0]?.widthBits);
    const widthObserved = candidate.semanticClass === 'extend' || candidate.semanticClass === 'movsxd' || candidate.semanticClass === 'cmovcc'
      ? Number(detail.operands[0]?.widthBits)
      : destinationWidth;
    if (widthObserved !== Number(candidate.operandWidthBits)) fail('x86-integer-denominator-width-drift', `${candidate.id}:${widthObserved}`);
  }
  const legacy = [...(detail.prefixes.legacy || [])];
  if (legacy.some((value) => ![0x66].includes(value))) fail('x86-integer-denominator-malformed-prefix', candidate.id);
  if (detail.prefixes.vector != null) fail('x86-integer-denominator-vector-prefix-not-integer', candidate.id);
  return true;
}

export function validateX86Long64IntegerDenominator() {
  const ids = new Set();
  const families = new Set();
  const owners = new Set();
  const widths = new Set();
  const forms = new Set();
  const prefixes = new Set();
  const counts = new Set();
  const signedness = new Set();
  let encodingCaseCount = 0;
  let integerOwnedCaseCount = 0;
  let memoryDelegationCaseCount = 0;
  for (const candidate of x86Long64IntegerEncodingCases()) {
    if (ids.has(candidate.id)) fail('x86-integer-denominator-case-duplicate', candidate.id);
    ids.add(candidate.id);
    if (!(candidate.bytes instanceof Uint8Array) || candidate.bytes.length < 1 || candidate.bytes.length > 15) fail('x86-integer-denominator-byte-length-invalid', candidate.id);
    if (!X86_LONG64_INTEGER_MNEMONICS.includes(candidate.family)) fail('x86-integer-denominator-unregistered-family', candidate.family);
    if (!['integer','memory'].includes(candidate.owner)) fail('x86-integer-denominator-owner-invalid', candidate.id);
    families.add(candidate.family); owners.add(candidate.owner); forms.add(candidate.form); prefixes.add(candidate.prefixClass);
    if (candidate.operandWidthBits != null) widths.add(candidate.operandWidthBits);
    if (candidate.countDiscriminator != null) counts.add(candidate.countDiscriminator);
    if (candidate.signedness != null) signedness.add(candidate.signedness);
    if (candidate.owner === 'integer') integerOwnedCaseCount++; else memoryDelegationCaseCount++;
    encodingCaseCount++;
  }
  const absent = X86_LONG64_INTEGER_MNEMONICS.filter((family) => !families.has(family));
  if (absent.length) fail('x86-integer-denominator-family-unobserved', absent.join(','));
  for (const required of [8,16,32,64]) if (!widths.has(required)) fail('x86-integer-denominator-width-unobserved', required);
  for (const required of ['register','register-register','register-immediate','register-cl','implicit','memory','memory-source','memory-destination']) if (!forms.has(required)) fail('x86-integer-denominator-form-unobserved', required);
  for (const required of ['signed','unsigned','bitwise','copy-low-bits']) if (!signedness.has(required)) fail('x86-integer-denominator-signedness-unobserved', required);
  return Object.freeze({
    valid:true,
    schemaVersion:X86_LONG64_INTEGER_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_INTEGER_DENOMINATOR_ID,
    profileId:'x86_64:long-64',
    encodingCaseCount,
    integerOwnedCaseCount,
    memoryDelegationCaseCount,
    mnemonicCount:X86_LONG64_INTEGER_MNEMONICS.length,
    operandWidths:Object.freeze([...widths].sort((a,b)=>a-b)),
    operandFormCount:forms.size,
    prefixClassCount:prefixes.size,
    shiftCountDiscriminatorCount:counts.size,
    signednessCount:signedness.size,
    oracleIds:Object.freeze([
      'intel-sdm-vol2-integer-opcode-tables-static-denominator',
      'deployed-capstone-5-x86-long64-detail',
    ]),
  });
}
