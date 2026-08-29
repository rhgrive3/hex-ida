import { architecturePluginV2 } from '../../targets/architecture/index.js';
import { abiPlugin as registeredABIPlugin } from '../../targets/abi/index.js';

const ARCH_META_CACHE = new Map();
const REGISTER_CANDIDATE_CACHE = new Map();
const STACK_LAYOUT_CACHE = new Map();

function tname(t, fallback = 'unknown') { return t?.name || t?.type || fallback; }
function used(v) { return (v?.uses || []).some((u) => u && !u.clobbered); }
function bitsOf(t) { return Number(t?.bits || (t?.size ? Number(t.size) * 8 : 0) || 0); }
function kindOf(t) { return String(t?.kind || t?.class || t?.abiClass || '').toLowerCase(); }
function stringValue(value) { return typeof value === 'string' && value.length ? value : null; }

function abiContext(opts = {}) {
  const adapter = opts.abiAdapter || null;
  let plugin = opts.abiPlugin || null;
  if (!plugin && adapter?.id) {
    try { plugin = registeredABIPlugin(adapter.id); } catch { plugin = null; }
  }
  const supported = !!adapter && !!plugin && plugin.supported !== false && String(adapter.id || plugin.id || '') !== 'unknown';
  const cacheKey = supported ? String(plugin.semanticIdentity || `${plugin.id}@${plugin.semanticVersion || '1'}`) : 'unknown';
  let meta = ARCH_META_CACHE.get(cacheKey) || null;
  if (!meta) {
    let architecture = null;
    try { if (supported) architecture = architecturePluginV2(plugin.architectureId); } catch { architecture = null; }
    let registers = [];
    try { registers = architecture?.registerFile?.() || []; } catch { registers = []; }
    const aliases = new Map();
    for (const descriptor of registers) {
      const canonicalReg = stringValue(descriptor?.physicalId) || stringValue(descriptor?.id);
      if (!canonicalReg) continue;
      for (const name of [descriptor?.id, descriptor?.physicalId, descriptor?.abiName, ...(Array.isArray(descriptor?.views) ? descriptor.views : [])]) {
        const value = stringValue(name);
        if (value) aliases.set(value.toLowerCase(), canonicalReg);
      }
    }
    const canonicalReg = (reg) => aliases.get(String(reg || '').toLowerCase()) || String(reg || '');
    const stackPointers = new Set();
    for (const descriptor of registers) {
      if (descriptor?.kind !== 'stack-pointer' && descriptor?.role !== 'stack-pointer') continue;
      for (const name of [descriptor?.id, descriptor?.physicalId, descriptor?.abiName]) {
        const value = stringValue(name);
        if (value) stackPointers.add(canonicalReg(value));
      }
    }
    meta = { aliases, stackPointers };
    ARCH_META_CACHE.set(cacheKey, meta);
  }
  const canonical = (reg) => meta.aliases.get(String(reg || '').toLowerCase()) || String(reg || '');
  return { adapter, plugin, supported, canonical, stackPointers:meta.stackPointers, cacheKey };
}

function classifyArguments(plugin, functionPrototype) {
  if (!plugin || !functionPrototype) return null;
  try {
    return plugin.classifyArguments({ callPrototype:functionPrototype }, { callPrototype:functionPrototype }) || null;
  } catch { return null; }
}

function registerCandidates(ctx) {
  if (!ctx.supported) return new Map();
  const cached = REGISTER_CANDIDATE_CACHE.get(ctx.cacheKey);
  if (cached) return cached;
  const out = new Map();
  const add = (reg, entry = {}) => {
    const canonical = ctx.canonical(reg);
    if (!canonical || out.has(canonical)) return;
    out.set(canonical, {
      reg:canonical,
      bankIndex:Number.isInteger(Number(entry.index)) ? Number(entry.index) : null,
      abiClass:entry.abiClass ?? null,
    });
  };
  const probes = [
    { type:'int64', bits:64, abiClass:'integer' },
    { type:'double', bits:64, abiClass:'fp' },
    { type:'void *', bits:64, pointer:true, abiClass:'pointer' },
  ];
  for (const parameter of probes) {
    const functionPrototype = { parameters:Array.from({ length:16 }, () => ({ ...parameter })) };
    const classified = classifyArguments(ctx.plugin, functionPrototype);
    for (const entry of classified?.arguments || []) {
      if (!entry || !['register','registers'].includes(entry.location)) continue;
      const regs = Array.isArray(entry.regs) ? entry.regs : [entry.reg];
      for (const reg of regs) if (typeof reg === 'string') add(reg, entry);
    }
  }
  REGISTER_CANDIDATE_CACHE.set(ctx.cacheKey, out);
  return out;
}

function registerArguments(ir, types, opts, ctx) {
  if (!ctx.supported) return [];
  const candidates = registerCandidates(ctx);
  const out = [];
  const seen = new Set();
  for (const [rawReg, value] of ir?.args?.entries?.() || []) {
    if (!value || !used(value)) continue;
    const reg = ctx.canonical(rawReg);
    let classified = null;
    try { classified = ctx.plugin.classifyEntryRegister?.(reg) || null; } catch { classified = null; }
    const candidate = classified?.kind === 'argument'
      ? { reg, bankIndex:Number.isInteger(Number(classified.index)) ? Number(classified.index) : null, abiClass:classified.abiClass ?? null }
      : candidates.get(reg) || null;
    if (!candidate || seen.has(reg)) continue;
    seen.add(reg);
    const recovered = types?.values?.get?.(value.id) || null;
    const abiClass = String(candidate.abiClass || '').toLowerCase();
    const bank = /fp|float|sse|vector/.test(abiClass) ? 'fp' : 'integer';
    const fallbackIndex = candidate.bankIndex == null ? out.length : candidate.bankIndex;
    out.push({
      index:null, bankIndex:candidate.bankIndex, reg, abiClass:candidate.abiClass || bank,
      name:opts.argNames?.[reg] || opts.argNames?.[fallbackIndex] || `${bank === 'fp' ? 'fpArg' : 'arg'}${fallbackIndex + 1}`,
      type:tname(recovered), confidence:recovered?.confidence || 0.45,
      valueId:value.id ?? null, used:true, sourceOrderKnown:false,
      evidence:`entry SSA use classified by ABI ${ctx.adapter.id}`,
    });
  }
  return out;
}

function stackLayout(ctx) {
  if (!ctx.supported || !ctx.stackPointers.size) return null;
  if (STACK_LAYOUT_CACHE.has(ctx.cacheKey)) return STACK_LAYOUT_CACHE.get(ctx.cacheKey);
  let rules = {};
  try { rules = ctx.plugin.stackRules?.() || {}; } catch { rules = {}; }
  if (rules.unknown === true) { STACK_LAYOUT_CACHE.set(ctx.cacheKey, null); return null; }
  const explicit = Number(rules.firstStackArgumentOffset);
  const derived = Number(rules.returnAddressBytes || 0) + Number(rules.shadowSpaceBytes || 0);
  const firstStackArgumentOffset = Number.isSafeInteger(explicit) && explicit >= 0 ? explicit
    : Number.isSafeInteger(derived) && derived >= 0 ? derived : 0;
  const layout = {
    firstStackArgumentOffset:BigInt(firstStackArgumentOffset),
    argumentSlotBytes:Number.isSafeInteger(Number(rules.argumentSlotBytes)) ? Number(rules.argumentSlotBytes) : null,
    returnAddressBytes:Number(rules.returnAddressBytes || 0),
    shadowSpaceBytes:Number(rules.shadowSpaceBytes || 0),
  };
  STACK_LAYOUT_CACHE.set(ctx.cacheKey, layout);
  return layout;
}

function entryValueForBase(ir, ctx, canonicalBase) {
  for (const [rawReg, value] of ir?.args?.entries?.() || []) {
    if (ctx.canonical(rawReg) === canonicalBase) return value;
  }
  return null;
}

function entryStackArguments(ir, types, ctx) {
  const layout = stackLayout(ctx);
  if (!layout) return [];
  const byKey = new Map();
  for (const inst of ir?.instructions || []) {
    if (inst?.op !== 'load' || inst.loc?.kind !== 'stack') continue;
    const baseReg = ctx.canonical(inst.loc?.baseReg);
    if (!ctx.stackPointers.has(baseReg)) continue;
    const entrySp = entryValueForBase(ir, ctx, baseReg);
    if (!entrySp || inst.loc.frameEpoch !== entrySp.id || inst.loc.disp == null) continue;
    const disp = BigInt(inst.loc.disp);
    if (disp < layout.firstStackArgumentOffset || inst.memUse?.kind !== 'entry') continue;
    const key = inst.loc.key || `${baseReg}:${disp}`;
    if (byKey.has(key)) continue;
    const recovered = inst.dst ? types?.values?.get?.(inst.dst.id) : null;
    byKey.set(key, {
      index:null, reg:null, abiClass:'stack', stackOffset:disp,
      abiStackOffset:disp - layout.firstStackArgumentOffset,
      stackBaseRegister:baseReg, stackCoordinate:'callee-entry-sp',
      name:`stackArg_${disp.toString(16)}`, type:tname(recovered),
      confidence:recovered?.confidence || 0.5, valueId:inst.dst?.id ?? null, used:true,
      sourceOrderKnown:false, evidence:'load from ABI-proven entry stack base Memory-SSA version with no reaching store',
    });
  }
  return [...byKey.values()].sort((a,b) => a.stackOffset < b.stackOffset ? -1 : a.stackOffset > b.stackOffset ? 1 : 0);
}

function returnPrototype(ret, opts = {}) {
  const returnType = tname(ret, opts.returnType || '');
  const returnClass = kindOf(ret) || String(opts.returnClass || '').toLowerCase();
  const returnBits = bitsOf(ret) || Number(opts.returnBits || 0);
  return {
    returnType, returnClass, returnBits,
    aggregate:ret?.aggregate === true || /aggregate|struct|union|record|array|composite/.test(`${returnType} ${returnClass}`.toLowerCase()),
    hfaCount:Number(ret?.hfaCount || ret?.hvaCount || opts.hfaCount || 0),
    returnsValue:returnType !== 'void' && returnClass !== 'void',
  };
}

function classifyReturn(ctx, ret, opts = {}) {
  if (!ctx.supported) return null;
  const functionPrototype = returnPrototype(ret, opts);
  if (!ret && !opts.returnType && !opts.returnClass && !opts.returnBits) return null;
  try {
    return ctx.plugin.classifyFunctionReturn({
      functionPrototype, prototype:functionPrototype,
      returnType:functionPrototype.returnType,
      returnClass:functionPrototype.returnClass,
      returnBits:functionPrototype.returnBits,
      returnsValue:functionPrototype.returnsValue,
    }) || null;
  } catch { return null; }
}

function hiddenResultRegisterFrom(classified, ctx) {
  const hidden = classified?.hiddenResultPointer;
  const raw = typeof hidden === 'string' ? hidden : hidden?.input;
  return raw ? ctx.canonical(raw) : null;
}

function indirectResultCandidate(ctx) {
  if (!ctx.supported) return null;
  const probes = [
    { returnType:'struct aggregate', returnClass:'aggregate', returnBits:256, aggregate:true, returnsValue:true },
    { returnType:'struct aggregate', returnClass:'indirect', returnBits:256, aggregate:true, indirectResult:true, returnsValue:true },
  ];
  for (const functionPrototype of probes) {
    let classified = null;
    try { classified = ctx.plugin.classifyFunctionReturn({ functionPrototype, prototype:functionPrototype, ...functionPrototype }) || null; } catch { classified = null; }
    const reg = hiddenResultRegisterFrom(classified, ctx);
    if (reg) return reg;
  }
  return null;
}

function returnLocations(classified, indirectRegister, ctx) {
  if (indirectRegister) return [{ kind:'indirect', reg:indirectRegister, role:'result-address' }];
  if (!classified) return [];
  const regs = Array.isArray(classified.regs) && classified.regs.length
    ? classified.regs
    : Array.isArray(classified.pieces) && classified.pieces.length
      ? classified.pieces.map((piece) => piece?.reg).filter(Boolean)
      : classified.reg ? [classified.reg] : [];
  return [...new Set(regs.map((reg) => ctx.canonical(reg)).filter(Boolean))].map((reg) => ({
    kind:'register', reg, abiClass:classified.abiClass ?? null,
  }));
}

export function recoverFunctionPrototype(ir, types, opts = {}) {
  const ctx = abiContext(opts);
  const registerArgs = registerArguments(ir, types, opts, ctx);
  const integerArgs = registerArgs.filter((arg) => !/fp|float|sse|vector/.test(String(arg.abiClass || '').toLowerCase()));
  const fpArgs = registerArgs.filter((arg) => /fp|float|sse|vector/.test(String(arg.abiClass || '').toLowerCase()));
  const stackArgs = entryStackArguments(ir, types, ctx);
  const args = [...registerArgs, ...stackArgs];
  const ret = types?.ret || null;
  const classifiedReturn = classifyReturn(ctx, ret, opts);
  let indirectRegister = classifiedReturn?.indirect === true ? hiddenResultRegisterFrom(classifiedReturn, ctx) : null;
  if (!indirectRegister) {
    const candidate = indirectResultCandidate(ctx);
    if (candidate) {
      const entry = entryValueForBase(ir, ctx, candidate);
      const recovered = entry ? types?.values?.get?.(entry.id) : null;
      if (entry && used(entry) && (recovered?.kind === 'pointer' || opts.indirectResult === true)) indirectRegister = candidate;
    }
  }
  const locations = returnLocations(classifiedReturn, indirectRegister, ctx);
  const retType = tname(ret, opts.returnType || 'unknown');
  return {
    convention:ctx.supported ? String(ctx.adapter.id || ctx.plugin.id) : 'unknown',
    conventionKnown:ctx.supported,
    arguments:args,
    argumentBanks:{ integer:integerArgs, fp:fpArgs, stack:stackArgs },
    returnType:retType, returnConfidence:ret?.confidence || (locations.length ? 0.35 : 0),
    returnLocations:locations,
    returnLocationKnown:ctx.supported && (indirectRegister != null || classifiedReturn != null),
    indirectResult:indirectRegister != null,
    indirectResultRegister:indirectRegister,
    variadic:opts.variadic === true,
    completeness:ctx.supported ? 'partial' : 'unknown',
    evidence:[
      ...(registerArgs.length ? [`entry SSA register uses classified by ABI ${ctx.adapter.id}`] : []),
      ...(stackArgs.length ? [`entry stack loads classified by ABI ${ctx.adapter.id} stack rules`] : []),
      ...(indirectRegister ? [`ABI ${ctx.adapter.id} indirect-result register evidence`] : []),
      ...(ret ? ['semantic return-type evidence classified by ABI plugin'] : []),
      ...(!ctx.supported ? ['ABI unknown: no calling-convention facts fabricated'] : []),
    ],
  };
}
