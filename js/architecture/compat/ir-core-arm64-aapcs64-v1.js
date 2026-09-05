/*
 * ir.js — 解析エンジンの中心にある中間表現（IR）と SSA。
 *
 * これまで arm64.js / blocks.js / expr.js / dataflow.js / decompile.js は、
 * それぞれが命令列を自分なりに読み直して意味を拾っていた。同じ「加算」を
 * 5 か所が別々に見つけ、別々に間違える。ここはその共通の土台になる。
 *
 *     ARM64 命令
 *        ↓  lift        1 命令 → 1 つ以上の IR 命令（推測を入れない）
 *     Instruction IR
 *        ↓  SSA         レジスタに版番号を振り、合流点に φ を置く
 *     SSA
 *        ↓  Memory SSA  メモリの場所ごとに版番号を振る（store → load の辺）
 *     Typed Semantic IR
 *
 * ここで得られるもの:
 *
 *   use-def / def-use   … その値はどこで作られ、どこで使われたか
 *   φ                   … 「if の両方の道から来た値」を 1 つの名前で扱える
 *   Memory SSA          … `self->coins` を読んだ load が、どの store の値かを指す
 *   stack variable      … sp/fp からの固定オフセットをローカル変数として畳む
 *   alias               … 「別の場所」と言い切れるときだけ言い切る
 *   const / range / 符号 … 分かる範囲だけ。分からないものは unknown のまま残す
 *
 * これがあると、
 *
 *     ldr w8, [x19,#0x20]
 *     add w8, w8, w21
 *     cmp w8, w22
 *     csel w8, w22, w8, gt
 *     str w8, [x19,#0x20]
 *
 * を「命令が 5 つ」ではなく
 *
 *     [x19+0x20] = min([x19+0x20] + w21, w22)
 *
 * という 1 つの意味単位として扱える。
 *
 * きまり:
 *   1. 分からないものは unknown にする。埋めない。
 *   2. 名前を作らない。ここは形と辺だけを返す。日本語は narrate.js の仕事。
 *   3. 「たぶん別の場所」は alias 無しとして扱わない。危険側に倒さない。
 */

import { buildCfg } from './cfg.js';
import { analyzeGraph } from './controlflow.js';

/* ── IR の語彙 ──────────────────────────────────────────────── */

export const OP = {
  CONST: 'const',
  MOV: 'mov',
  BIN: 'bin',
  UN: 'un',
  MAC: 'mac',
  BFX: 'bfx',
  BFI: 'bfi',
  CMP: 'cmp',
  SEL: 'sel',
  LOAD: 'load',
  STORE: 'store',
  ADDR: 'addr',
  CALL: 'call',
  RET: 'ret',
  BR: 'br',
  CBR: 'cbr',
  PHI: 'phi',
  CLOBBER: 'clobber',
  UNKNOWN: 'unknown',
};

export const VK = {
  ARG: 'arg',
  CONST: 'const',
  DEF: 'def',
  PHI: 'phi',
  UNDEF: 'undef',
};

export const MK = {
  STACK: 'stack',
  FIELD: 'field',
  GLOBAL: 'global',
  UNKNOWN: 'unknown',
};

const MAX_INSTRUCTIONS = 6000;
const MAX_PHI_ROUNDS = 64;
const M64 = (1n << 64n) - 1n;

function mask(v, bits) {
  if (v == null) return null;
  const m = bits >= 64 ? M64 : (1n << BigInt(bits)) - 1n;
  return BigInt.asUintN(64, v) & m;
}

function signedOf(v, bits) {
  if (v == null) return null;
  return BigInt.asIntN(bits, v);
}

function regKeyOf(op) {
  if (!op || op.k !== 'reg') return null;
  if (op.cls === 'zr') return null;
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return 'x' + op.num;
  if (op.cls === 'fp' || op.cls === 'vec') return 'v' + op.num;
  return null;
}

function regBits(op) {
  if (!op || op.k !== 'reg') return 64;
  return op.bits || 64;
}

const BIN_OF = {
  add: 'add', adds: 'add', sub: 'sub', subs: 'sub',
  mul: 'mul', mneg: 'mul', smull: 'smull', umull: 'umull',
  smulh: 'smulh', umulh: 'umulh', sdiv: 'sdiv', udiv: 'udiv',
  and: 'and', ands: 'and', orr: 'or', eor: 'xor', bic: 'bic', bics: 'bic', orn: 'orn', eon: 'eon',
  lsl: 'shl', lslv: 'shl', lsr: 'lshr', lsrv: 'lshr', asr: 'ashr', asrv: 'ashr',
  ror: 'ror', rorv: 'ror',
  fadd: 'fadd', fsub: 'fsub', fmul: 'fmul', fdiv: 'fdiv',
};

const UN_OF = {
  neg: 'neg', negs: 'neg', mvn: 'not', fneg: 'fneg', fabs: 'fabs', fsqrt: 'fsqrt',
  sxtb: 'sxt8', sxth: 'sxt16', sxtw: 'sxt32',
  uxtb: 'uxt8', uxth: 'uxt16', uxtw: 'uxt32',
  clz: 'clz', rbit: 'rbit', rev: 'rev', rev16: 'rev16', rev32: 'rev32',
  scvtf: 'i2f', ucvtf: 'u2f', fcvtzs: 'f2i', fcvtzu: 'f2u',
  fmov: 'fmov', abs: 'abs',
};

const SEL_OF = { csel: 'sel', fcsel: 'sel', csinc: 'inc', csinv: 'inv', csneg: 'neg', cset: 'set', csetm: 'setm', cinc: 'cinc', cneg: 'cneg', cinv: 'cinv' };

export const COND = {
  eq: { op: '==', signed: null }, ne: { op: '!=', signed: null },
  hs: { op: '>=', signed: false }, cs: { op: '>=', signed: false },
  lo: { op: '<', signed: false }, cc: { op: '<', signed: false },
  hi: { op: '>', signed: false }, ls: { op: '<=', signed: false },
  ge: { op: '>=', signed: true }, lt: { op: '<', signed: true },
  gt: { op: '>', signed: true }, le: { op: '<=', signed: true },
  mi: { op: '<', signed: true, vsZero: true }, pl: { op: '>=', signed: true, vsZero: true },
  vs: null, vc: null, al: null, nv: null,
};

const INVERSE_COND = {
  eq: 'ne', ne: 'eq', hs: 'lo', lo: 'hs', cs: 'cc', cc: 'cs',
  hi: 'ls', ls: 'hi', ge: 'lt', lt: 'ge', gt: 'le', le: 'gt',
  mi: 'pl', pl: 'mi', vs: 'vc', vc: 'vs',
};

export function inverseCondition(c) { return INVERSE_COND[c] || null; }

function opnd(op) {
  if (!op) return null;
  if (op.k === 'reg') {
    if (op.cls === 'zr') return { t: 'imm', value: 0n, zero: true };
    return { t: 'reg', reg: regKeyOf(op), bits: regBits(op), shift: op.shift || null };
  }
  if (op.k === 'imm') {
    if (op.value == null) return op.float != null ? { t:'imm', value:null, float:Number(op.float), constKind:'float', bits:op.bits || 64, shift:op.shift || null } : null;
    return { t:'imm', value:op.value, bits:op.bits || 64, shift:op.shift || null };
  }
  if (op.k === 'cond') return { t: 'cond', cond: op.text };
  return null;
}

function callPrototypeOf(insn, opts) {
  let proto = insn?.callPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn?.callTarget ?? null, insn) || null; } catch { proto = null; }
  }
  return proto;
}

function callParameterList(proto) {
  const list = proto && (proto.args || proto.parameters || proto.params || proto.arguments);
  return Array.isArray(list) ? list : null;
}

function parameterAbiClass(param) {
  const type = String(param?.type || param?.name || '').toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').toLowerCase();
  const pointer = param?.pointer === true || param?.isPointer === true || /\*|pointer|ptr|object|class|block|closure/.test(type + ' ' + cls);
  const hfa = param?.hfa === true || cls.includes('hfa') || cls.includes('homogeneous');
  const vector = cls.includes('vector') || /vector|simd/.test(type);
  const fp = hfa || vector || cls.includes('float') || cls.includes('fp') || /^(float|double|__fp16)/.test(type);
  const abiCount = (value, fallback) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  const members = Math.max(1, Math.min(4, abiCount(param?.members ?? param?.elements ?? param?.count, 1)));
  const bits = Math.max(8, Math.min(128, abiCount(param?.bits ?? param?.sizeBits, fp ? 64 : 64)));
  return { pointer, hfa, vector, fp, members, bits };
}

function abiReturnBits(value, fallback = 64) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

export function classifyCallArguments(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  const params = callParameterList(proto);
  const srcs = [];
  const arguments_ = [];
  const stackArguments = [];
  let gp = 0, fp = 0, stackOffset = 0;
  let stackArgsMayContainPointers = false;
  if (!params) {
    for (let i=0;i<8;i++) { srcs.push({t:'reg',reg:`x${i}`,bits:64}); arguments_.push({index:i,location:'register',reg:`x${i}`,abiClass:'unknown-gp'}); }
    for (let i=0;i<8;i++) { srcs.push({t:'reg',reg:`v${i}`,bits:128}); arguments_.push({index:8+i,location:'register',reg:`v${i}`,abiClass:'unknown-fp-vector'}); }
    return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:true, stackArgsMayContainPointers:false, evidence:'conservative-aapcs64' };
  }
  params.forEach((param,index) => {
    const c=parameterAbiClass(param);
    const regsNeeded=c.hfa ? c.members : 1;
    if (c.fp && fp + regsNeeded <= 8) {
      const regs=[];
      for(let n=0;n<regsNeeded;n++){const reg=`v${fp++}`;regs.push(reg);srcs.push({t:'reg',reg,bits:c.vector?128:c.bits});}
      arguments_.push({index,location:'register',regs,reg:regs[0],abiClass:c.hfa?'hfa':c.vector?'vector':'fp',pointer:c.pointer,bits:c.bits});
      return;
    }
    if (c.fp) fp = 8;
    if (!c.fp && gp < 8) {
      const reg=`x${gp++}`; srcs.push({t:'reg',reg,bits:64});
      arguments_.push({index,location:'register',reg,abiClass:c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits});
      return;
    }
    const slots=Math.max(1,Math.ceil((c.hfa?c.members*c.bits:c.bits)/64));
    const entry={index,location:'stack',offset:stackOffset,bytes:slots*8,abiClass:c.hfa?'hfa':c.vector?'vector':c.fp?'fp':c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits};
    stackArguments.push(entry);arguments_.push(entry);stackOffset+=slots*8;
    if(c.pointer || param?.mayContainPointers === true || param?.containsPointers === true) stackArgsMayContainPointers=true;
  });
  return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:proto?.variadic===true||proto?.varargs===true, stackArgsMayContainPointers, evidence:'prototype-aapcs64' };
}

function callResultLocation(insn, opts) {
  const proto = callPrototypeOf(insn, opts);
  if (!proto) return null;
  const type = String(proto.returnType || proto.ret || proto.result || '').toLowerCase();
  const cls = String(proto.returnClass || proto.abiClass || proto.resultClass || '').toLowerCase();
  if (proto.void === true || type === 'void' || cls === 'void') return null;
  if (proto.indirectResult === true || cls === 'indirect') return null;
  const bits = abiReturnBits(proto.returnBits ?? proto.bits);
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits };
  }
  if (type || cls || proto.returnsValue === true) return { reg:'x0', bits };
  return null;
}

function functionReturnLocation(opts) {
  const proto = opts?.functionPrototype || opts?.prototype || null;
  const type = String(opts?.returnType || proto?.returnType || proto?.ret || proto?.result || '').toLowerCase();
  const cls = String(opts?.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '').toLowerCase();
  if (opts?.returnsValue === false || proto?.returnsValue === false || proto?.void === true || type === 'void' || cls === 'void') return null;
  if (proto?.indirectResult === true || cls === 'indirect') return null;
  const bits = abiReturnBits(proto?.returnBits ?? proto?.bits ?? opts?.returnBits);
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits };
  }
  if (type || cls || opts?.returnsValue === true || proto?.returnsValue === true) {
    return { reg:'x0', bits };
  }
  return null;
}

/* The remainder of this compatibility implementation is intentionally retained
 * byte-for-byte in the canonical source. */
