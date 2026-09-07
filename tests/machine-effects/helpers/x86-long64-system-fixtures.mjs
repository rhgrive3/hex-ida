export const X86_SYSTEM_NEGATIVE_FIXTURES = Object.freeze([
  Object.freeze({ id:'lock-cpuid-rejected', bytes:Uint8Array.of(0xf0,0x0f,0xa2), expectedFamily:null, reason:'malformed-prefix' }),
  Object.freeze({ id:'lock-pause-decoded-but-undefined', bytes:Uint8Array.of(0xf0,0xf3,0x90), expectedFamily:'pause', reason:'same-group-lock+rep-prefix-is-not-cross-vendor-exact' }),
  Object.freeze({ id:'f3-mfence-is-umonitor', bytes:Uint8Array.of(0xf3,0x0f,0xae,0xf0), expectedFamily:'umonitor', reason:'prefix-selects-different-opcode-family' }),
  Object.freeze({ id:'f2-mfence-is-umwait', bytes:Uint8Array.of(0xf2,0x0f,0xae,0xf0), expectedFamily:'umwait', reason:'prefix-selects-different-opcode-family' }),
  Object.freeze({ id:'66-mfence-is-tpause', bytes:Uint8Array.of(0x66,0x0f,0xae,0xf0), expectedFamily:'tpause', reason:'prefix-selects-different-opcode-family' }),
  Object.freeze({ id:'f3-wbinvd-is-wbnoinvd', bytes:Uint8Array.of(0xf3,0x0f,0x09), expectedFamily:'wbnoinvd', reason:'prefix-selects-different-opcode-family' }),
  Object.freeze({ id:'lgdt-register-form-not-lgdt', bytes:Uint8Array.of(0x0f,0x01,0xd0), expectedFamily:'xgetbv', reason:'modrm-discriminator' }),
  Object.freeze({ id:'mov-cr0-shared-alias', bytes:Uint8Array.of(0x0f,0x20,0xc0), expectedFamily:'mov', reason:'shared-family-alias' }),
  Object.freeze({ id:'mov-dr0-shared-alias', bytes:Uint8Array.of(0x0f,0x21,0xc0), expectedFamily:'mov', reason:'shared-family-alias' }),
]);

export const X86_SYSTEM_PREFIX_QUOTIENT_FIXTURES = Object.freeze([
  Object.freeze({ id:'cpuid-rex-ignored', bytes:Uint8Array.of(0x40,0x0f,0xa2), expectedFamily:'cpuid' }),
  Object.freeze({ id:'sysretq-rexw-selects-64-bit-form', bytes:Uint8Array.of(0x48,0x0f,0x07), expectedFamily:'sysretq' }),
  Object.freeze({ id:'mfence-rex-ignored', bytes:Uint8Array.of(0x40,0x0f,0xae,0xf0), expectedFamily:'mfence' }),
  Object.freeze({ id:'lgdt-address-size-override', bytes:Uint8Array.of(0x67,0x0f,0x01,0x10), expectedFamily:'lgdt' }),
  Object.freeze({ id:'lgdt-fs-segment-override', bytes:Uint8Array.of(0x64,0x0f,0x01,0x10), expectedFamily:'lgdt' }),
]);

export const X86_SYSTEM_REQUIRED_FAULT_FAMILIES = Object.freeze([
  'rdtsc','rdtscp','syscall','sysret','sysretq','cli','sti','hlt','invd','wbinvd','swapgs','lgdt','lidt','lldt','ltr',
]);

export const X86_SYSTEM_ENVIRONMENT_OUTPUT_FAMILIES = Object.freeze(['cpuid','rdtsc','rdtscp']);
export const X86_SYSTEM_FENCE_FAMILIES = Object.freeze(['lfence','sfence','mfence']);
export const X86_SYSTEM_SIMPLE_FLAG_FAMILIES = Object.freeze(['clc','stc','cmc','cld','std']);
