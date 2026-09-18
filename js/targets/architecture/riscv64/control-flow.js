const RETURN_ADDRESS_HINT_REGISTERS = Object.freeze(['x1', 'x5']);

/**
 * RISC-V JAL/JALR return-address-stack hints are prediction metadata, not
 * calling-convention proof. Keep that authority separate from semantic return
 * classification so an alternate link register or a displaced JALR cannot be
 * promoted to a procedure return merely because it carries a RAS pop hint.
 */
export function riscv64HasReturnAddressStackPopHint(fields) {
  return fields?.op === 'jalr'
    && fields.rd === 'x0'
    && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rs1);
}

/** Standard LP64 return sequence represented by the frozen RV64 profile. */
export function riscv64IsStandardReturn(fields) {
  return riscv64HasReturnAddressStackPopHint(fields)
    && fields.rs1 === 'x1'
    && fields.imm === 0n;
}
