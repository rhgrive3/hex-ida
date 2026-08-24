(function installHexX86Registers(root) {
  'use strict';

  const descriptors = new Map();
  const physical = new Map();

  function addPhysical(id, bits, kind, views) {
    const record = Object.freeze({ id, bits, kind, views:Object.freeze(views.slice()) });
    physical.set(id, record);
    return record;
  }

  function addView(name, physicalId, viewBits, lsb, writePolicy, kind = 'gp', extra = {}) {
    const storage = physical.get(physicalId);
    if (!storage) throw new TypeError(`x86-register-physical-state-missing:${physicalId}`);
    const descriptor = Object.freeze({
      id:name,
      physicalId,
      physicalBits:storage.bits,
      viewBits,
      lsb,
      writePolicy,
      kind,
      ...extra,
    });
    descriptors.set(name, descriptor);
    return descriptor;
  }

  function addCompositeView(name, viewBits, parts, writePolicy, kind = 'vector') {
    const normalizedParts = parts.map((part) => {
      const storage = physical.get(part.physicalId);
      if (!storage) throw new TypeError(`x86-register-physical-state-missing:${part.physicalId}`);
      if (storage.bits !== part.bits) throw new TypeError(`x86-register-composite-width-mismatch:${part.physicalId}`);
      return Object.freeze({ physicalId:part.physicalId, bits:part.bits, lsb:part.lsb });
    });
    const covered = normalizedParts.reduce((sum, part) => sum + part.bits, 0);
    if (covered !== viewBits) throw new TypeError(`x86-register-composite-width-mismatch:${name}`);
    const descriptor = Object.freeze({
      id:name,
      physicalId:name,
      physicalBits:viewBits,
      viewBits,
      lsb:0,
      writePolicy,
      kind,
      compositeParts:Object.freeze(normalizedParts),
    });
    descriptors.set(name, descriptor);
    return descriptor;
  }

  const legacyFamilies = [
    ['rax','eax','ax','al','ah'],
    ['rbx','ebx','bx','bl','bh'],
    ['rcx','ecx','cx','cl','ch'],
    ['rdx','edx','dx','dl','dh'],
  ];
  for (const [full,dword,word,low,high] of legacyFamilies) {
    addPhysical(full, 64, 'gp', [full,dword,word,low,high]);
    addView(full, full, 64, 0, 'replace');
    addView(dword, full, 32, 0, 'zero-extend-32');
    addView(word, full, 16, 0, 'preserve-unaffected');
    addView(low, full, 8, 0, 'preserve-unaffected');
    addView(high, full, 8, 8, 'preserve-unaffected');
  }

  const lowByteFamilies = [
    ['rsi','esi','si','sil'],
    ['rdi','edi','di','dil'],
    ['rbp','ebp','bp','bpl'],
    ['rsp','esp','sp','spl'],
  ];
  for (const [full,dword,word,low] of lowByteFamilies) {
    const kind = full === 'rsp' ? 'stack-pointer' : 'gp';
    addPhysical(full, 64, kind, [full,dword,word,low]);
    addView(full, full, 64, 0, 'replace', kind);
    addView(dword, full, 32, 0, 'zero-extend-32', kind);
    addView(word, full, 16, 0, 'preserve-unaffected', kind);
    addView(low, full, 8, 0, 'preserve-unaffected', kind);
  }

  for (let index = 8; index <= 15; index++) {
    const full = `r${index}`;
    const views = [full, `${full}d`, `${full}w`, `${full}b`];
    addPhysical(full, 64, 'gp', views);
    addView(full, full, 64, 0, 'replace');
    addView(`${full}d`, full, 32, 0, 'zero-extend-32');
    addView(`${full}w`, full, 16, 0, 'preserve-unaffected');
    addView(`${full}b`, full, 8, 0, 'preserve-unaffected');
  }

  addPhysical('rip', 64, 'program-counter', ['rip','eip','ip']);
  addView('rip', 'rip', 64, 0, 'replace', 'program-counter');
  addView('eip', 'rip', 32, 0, 'zero-extend-32', 'program-counter');
  addView('ip', 'rip', 16, 0, 'preserve-unaffected', 'program-counter');

  addPhysical('rflags', 64, 'flags', ['rflags','eflags','flags']);
  addView('rflags', 'rflags', 64, 0, 'replace', 'flags');
  addView('eflags', 'rflags', 32, 0, 'preserve-unaffected', 'flags');
  addView('flags', 'rflags', 16, 0, 'preserve-unaffected', 'flags');

  addPhysical('mxcsr', 32, 'fp-environment', ['mxcsr']);
  addView('mxcsr', 'mxcsr', 32, 0, 'replace', 'fp-environment');

  // Keep the historical low-256 physical identities (`ymmN`) stable so
  // existing SSA/data-flow consumers do not need a migration.  AVX-512
  // extends each architectural ZMM register with a distinct upper 256-bit
  // physical cell.  A ZMM descriptor is therefore a composite architectural
  // view over the low YMM cell and the high ZMM cell.
  for (let index = 0; index < 32; index++) {
    const lowPhysicalId = `ymm${index}`;
    const highPhysicalId = `zmmh${index}`;
    const lowViews = index < 16 ? [`xmm${index}`, lowPhysicalId, `zmm${index}`] : [`zmm${index}`];
    addPhysical(lowPhysicalId, 256, 'vector', lowViews);
    addPhysical(highPhysicalId, 256, 'vector-upper', [`zmm${index}`]);
    // Keep XMM/YMM16-31 decoder-only until the EVEX integration lane can
    // enforce their encoding constraints.  ZMM itself is necessarily EVEX
    // and is safe to expose as a composite architectural view here.
    if (index < 16) {
      addView(`xmm${index}`, lowPhysicalId, 128, 0, 'encoding-dependent-upper-lanes', 'vector');
      addView(lowPhysicalId, lowPhysicalId, 256, 0, 'replace', 'vector');
    }
    addCompositeView(`zmm${index}`, 512, [
      { physicalId:lowPhysicalId, bits:256, lsb:0 },
      { physicalId:highPhysicalId, bits:256, lsb:256 },
    ], 'replace-composite', 'vector');
  }

  for (let index = 0; index < 8; index++) {
    const id = `k${index}`;
    addPhysical(id, 64, 'opmask', [id]);
    addView(id, id, 64, 0, 'replace', 'opmask');
  }

  // x87 data registers are eight fixed 80-bit physical slots.  The x87 ST(i)
  // names are logical TOP-relative views; MMX aliases the low 64 bits of the
  // fixed physical slots.  Packing the eight slots into one physical state
  // cell makes both relationships explicit without pretending ST(i) is a
  // fixed offset.
  const x87Views = [];
  for (let index = 0; index < 8; index++) x87Views.push(`x87r${index}`, `mm${index}`, `st(${index})`);
  addPhysical('x87-stack', 640, 'x87-stack', ['x87-stack', ...x87Views]);
  addView('x87-stack', 'x87-stack', 640, 0, 'replace', 'x87-stack');
  addPhysical('fpcw', 16, 'x87-control', ['fpcw']);
  addPhysical('fpsw', 16, 'x87-status', ['fpsw']);
  addPhysical('fptw', 16, 'x87-tag', ['fptw']);
  addPhysical('fop', 16, 'x87-opcode', ['fop']);
  addPhysical('fip', 64, 'x87-pointer', ['fip']);
  addPhysical('fdp', 64, 'x87-pointer', ['fdp']);
  addView('fpcw', 'fpcw', 16, 0, 'replace', 'x87-control');
  addView('fpsw', 'fpsw', 16, 0, 'replace', 'x87-status');
  addView('fptw', 'fptw', 16, 0, 'replace', 'x87-tag');
  addView('fop', 'fop', 16, 0, 'replace', 'x87-opcode');
  addView('fip', 'fip', 64, 0, 'replace', 'x87-pointer');
  addView('fdp', 'fdp', 64, 0, 'replace', 'x87-pointer');
  for (let index = 0; index < 8; index++) {
    addView(`x87r${index}`, 'x87-stack', 80, index * 80, 'preserve-unaffected', 'x87-physical');
    addView(`mm${index}`, 'x87-stack', 64, index * 80, 'preserve-unaffected', 'mmx');
    addView(`st(${index})`, 'x87-stack', 80, 0, 'x87-top-relative', 'x87', {
      dynamicView:Object.freeze({
        kind:'x87-top-relative', logicalIndex:index, topRegister:'fpsw', topLsb:11, topBits:3,
        slotWidthBits:80, slotCount:8,
      }),
    });
  }

  function normalizeName(value) {
    return String(value ?? '').trim().toLowerCase().replace(/^%/, '');
  }

  function registerDescriptor(value) {
    const name = normalizeName(typeof value === 'object'
      ? (value.registerId ?? value.id ?? value.name ?? value.text)
      : value);
    return descriptors.get(name) || null;
  }

  function registerFile() {
    return Object.freeze([...physical.values()].map((entry) => Object.freeze({ ...entry })));
  }

  const api = Object.freeze({
    contractVersion:'x86-physical-state/v2',
    normalizeName,
    registerDescriptor,
    registerFile,
    descriptors:Object.freeze([...descriptors.values()]),
    physicalRegisters:Object.freeze([...physical.values()]),
    modeledFlags:Object.freeze(['CF','PF','AF','ZF','SF','OF','DF']),
    unsupportedVectorFamilies:Object.freeze(['xmm16-31','ymm16-31']),
  });
  root.HexX86Registers = api;
})(globalThis);
