export const X86_LONG64_LEA_DENOMINATOR_SCHEMA = 'x86-long64-lea-denominator/v1';
export const X86_LONG64_LEA_DENOMINATOR_ID = 'x86_64:long-64:lea-encoding-discriminators:v1';

const OPERAND_FORMS = Object.freeze([
  Object.freeze({ id:'r16', legacy:Object.freeze([0x66]), rexW:false }),
  Object.freeze({ id:'r32', legacy:Object.freeze([]), rexW:false }),
  Object.freeze({ id:'r64', legacy:Object.freeze([]), rexW:true }),
]);
const ADDRESS_FORMS = Object.freeze([
  Object.freeze({ id:'a64', legacy:Object.freeze([]) }),
  Object.freeze({ id:'a32', legacy:Object.freeze([0x67]) }),
]);

function displacementBytes(mod, rm, sib) {
  if (mod === 1) return [0x80];
  if (mod === 2) return [0x80,0xff,0xff,0xff];
  const noBase = rm === 5 || (rm === 4 && (sib & 7) === 5);
  return noBase ? [0x78,0x56,0x34,0x12] : [];
}

function encoding(operand, address, rexLowBits, mod, reg, rm, sib = null) {
  const rex = 0x40 | (operand.rexW ? 8 : 0) | rexLowBits;
  const modrm = (mod << 6) | (reg << 3) | rm;
  return Uint8Array.from([
    ...address.legacy,
    ...operand.legacy,
    rex,
    0x8d,
    modrm,
    ...(sib == null ? [] : [sib]),
    ...displacementBytes(mod, rm, sib ?? 0),
  ]);
}

/**
 * Enumerate every semantic discriminator of the single long-mode LEA opcode:
 * operand/address size, REX.R/X/B, ModRM mod/reg/rm and the complete SIB byte.
 * Displacement values are witnesses; their widths are selected exhaustively
 * by ModRM/SIB state and their arithmetic is independently covered by the
 * addressing tests.
 */
export function* x86Long64LeaEncodingCases() {
  for (const operand of OPERAND_FORMS) {
    for (const address of ADDRESS_FORMS) {
      for (let rexLowBits = 0; rexLowBits < 8; rexLowBits++) {
        for (let mod = 0; mod < 3; mod++) {
          for (let reg = 0; reg < 8; reg++) {
            for (let rm = 0; rm < 8; rm++) {
              if (rm !== 4) {
                yield Object.freeze({
                  id:`${operand.id}:${address.id}:rex${rexLowBits}:m${mod}:r${reg}:rm${rm}`,
                  bytes:encoding(operand, address, rexLowBits, mod, reg, rm),
                });
                continue;
              }
              for (let sib = 0; sib < 256; sib++) {
                yield Object.freeze({
                  id:`${operand.id}:${address.id}:rex${rexLowBits}:m${mod}:r${reg}:sib${sib}`,
                  bytes:encoding(operand, address, rexLowBits, mod, reg, rm, sib),
                });
              }
            }
          }
        }
      }
    }
  }
}

export function x86Long64LeaDenominatorIdentity() {
  return Object.freeze({
    schemaVersion:X86_LONG64_LEA_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_LEA_DENOMINATOR_ID,
    opcode:0x8d,
    operandSizeCount:OPERAND_FORMS.length,
    addressSizeCount:ADDRESS_FORMS.length,
    rexDiscriminatorCount:8,
    modCount:3,
    registerFieldCount:8,
    directRmCount:7,
    sibByteCount:256,
    encodingCaseCount:OPERAND_FORMS.length * ADDRESS_FORMS.length * 8 * 3 * 8 * (7 + 256),
    oracleIds:Object.freeze(['intel-sdm-vol2-lea-8d-r', 'deployed-capstone-5-x86-long64-detail']),
  });
}
