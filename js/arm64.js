/*
 * ARM64 命令を「日本語の文」に翻訳するエンジン。
 *
 * 入力は Capstone が出した mnemonic と operand 文字列だけ。
 * 出力は、初心者がそのまま読める説明・擬似コード・部品ごとの意味。
 *
 * 方針:
 *  - 専門用語をいきなり使わない。使うときは用語集 (glossary.js) の id を terms に入れ、
 *    UI 側でタップできるようにする。
 *  - 16進の値には必ず 10進を添える。初心者は 0x20 を見て 32 だと分からない。
 *  - 「レジスタ」には役割がある（x0 は引数、x30 は戻り先…）。それを毎回教える。
 */
import { isJa, pick } from './i18n.js';
// immShort / absHex / memExpr は擬似コードと注釈で使います。以前は
// arm64-operands.js の中に閉じたままで、こちらからは import されていません
// でした。呼び出しは残っていたので、メモリ系や即値系の説明はすべて例外で
// 落ち、空の説明として表示されていました。ここで正規の 1 つの実装を
// 取り込みます（別実装を作り直すと 2 つの真実ができてしまいます）。
import { parseOperands, immText, immShort, absHex, memExpr, opShort, condInfo } from './ui/explain/arm64-operands.js';
import { registerRole } from './abi/aapcs64/presentation.js';

export { parseOperands, immText, opShort, condInfo, registerRole };

function shiftText(sh) {
  if (!sh) return '';
  const n = sh.amount;
  const times = n ? (isJa() ? '、さらに ' + (2 ** n) + ' 倍して' : ' then ×' + (2 ** n)) : '';
  switch (sh.op) {
    case 'lsl': return isJa()
      ? '（左へ ' + n + ' ビットずらす＝ ' + (2 ** n) + ' 倍してから）'
      : ' (shifted left by ' + n + ', i.e. ×' + (2 ** n) + ')';
    case 'lsr': return isJa() ? '（右へ ' + n + ' ビットずらしてから）' : ' (shifted right by ' + n + ')';
    case 'asr': return isJa() ? '（符号を保ったまま右へ ' + n + ' ビットずらしてから）' : ' (arithmetic-shifted right by ' + n + ')';
    case 'ror': return isJa() ? '（' + n + ' ビット回転させてから）' : ' (rotated by ' + n + ')';
    case 'uxtb': case 'uxth': case 'uxtw': case 'uxtx':
      return isJa()
        ? '（下半分だけ取り出して上を 0 で埋め' + times + '）'
        : ' (zero-extended' + times + ')';
    case 'sxtb': case 'sxth': case 'sxtw': case 'sxtx':
      return isJa()
        ? '（下半分だけ取り出して符号を伸ばし' + times + '）'
        : ' (sign-extended' + times + ')';
    default: return '';
  }
}

/** メモリオペランドを日本語で。 */
function memText(m) {
  const base = m.base.text;
  let where;
  // 後置インデックスでは、アクセスするアドレスは base そのもの。
  // 即値はアクセス「後」に base を進めるための値なので、住所には足さない。
  const disp = m.mode === 'post' ? null : m.disp;
  if (m.index) {
    where = isJa()
      ? base + ' と ' + m.index.text + shiftText(m.shift) + ' を足したアドレス'
      : base + ' + ' + m.index.text;
  } else if (disp && disp.value != null && disp.value !== 0n) {
    const v = disp.value;
    const a = v < 0n ? -v : v;
    where = isJa()
      ? base + ' から ' + a.toString(10) + ' バイト' + (v < 0n ? '手前' : '先') + 'のアドレス'
      : base + (v < 0n ? ' − ' : ' + ') + a.toString(10);
  } else {
    where = isJa() ? base + ' が指しているアドレス' : 'the address in ' + base;
  }
  if (m.mode === 'pre') {
    where += isJa()
      ? '（アクセスの前に ' + base + ' 自体もそのアドレスに書き換える）'
      : ' (and ' + base + ' is updated to it first)';
  } else if (m.mode === 'post') {
    const dispObj = m.disp || m.writebackDisp;
    const v = dispObj && dispObj.value != null ? dispObj.value : 0n;
    const a = v < 0n ? -v : v;
    where += isJa()
      ? '（アクセスの後で ' + base + ' を ' + a.toString(10) + ' バイト' + (v < 0n ? '戻す' : '進める') + '）'
      : ' (then ' + base + (v < 0n ? ' moves back ' : ' advances ') + a.toString(10) + ' bytes)';
  }
  return where;
}

/* ────────────────────────────────────────────────────────────
   分岐先 / 参照先
   ──────────────────────────────────────────────────────────── */

const BRANCH_IMM = new Set(['b', 'bl', 'cbz', 'cbnz', 'tbz', 'tbnz']);

/**
 * 同じ 64bit 汎用レジスタか。
 *
 * adrp+add のような「2 行で 1 つの意味」を組み立てるときに、本当に値が
 * つながっているかを確かめるために使います。名前の文字列比較ではなく
 * クラス・番号・幅で見るので、lr / fp のような別名でも取り違えません。
 */
function sameGeneralRegister(a, b) {
  if (!a || !b || a.k !== 'reg' || b.k !== 'reg') return false;
  if (a.cls !== 'gp' || b.cls !== 'gp') return false;
  if (a.bits !== 64 || b.bits !== 64) return false;
  return a.num === b.num;
}

/** 命令が指しているアドレス（BigInt）。ないときは null。 */
export function referenceTarget(mn, opsStr) {
  if (!mn) return null;
  const base = mn.toLowerCase();
  const ops = parseOperands(opsStr);
  const isCond = /^b\.[a-z]{2}$/.test(base);
  // アドレス 0 は「参照なし」の合図ではなく、実在しうる番地です。
  // 存在判定に正の値であることを使うと、0 番地の分岐先/参照先が消えます (#1288)。
  if (BRANCH_IMM.has(base) || isCond || base === 'adr' || base === 'adrp') {
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].k === 'imm' && ops[i].value != null && ops[i].value >= 0n) return ops[i].value;
    }
    return null;
  }
  if (base === 'ldr' && ops.length === 2 && ops[1].k === 'imm' && ops[1].value != null && ops[1].value >= 0n) {
    return ops[1].value;   // リテラルプール読み込み
  }
  return null;
}

/** 分岐命令か。 */
export function isBranch(mn) {
  const b = (mn || '').toLowerCase();
  return BRANCH_IMM.has(b) || /^b\.[a-z]{2}$/.test(b) ||
    b === 'br' || b === 'blr' || b === 'ret' ||
    /^(braa|brab|braaz|brabz|blraa|blrab|blraaz|blrabz|retaa|retab)$/.test(b);
}

export function isCall(mn) {
  const b = (mn || '').toLowerCase();
  return b === 'bl' || b === 'blr' || b === 'blraa' || b === 'blrab' || b === 'blraaz' || b === 'blrabz';
}

export function isReturn(mn) {
  const b = (mn || '').toLowerCase();
  return b === 'ret' || b === 'retaa' || b === 'retab';
}

/* ────────────────────────────────────────────────────────────
   命令の分類（行の色分けにも使う）
   ──────────────────────────────────────────────────────────── */

const CATEGORY = new Map();
function cat(names, c) { for (const n of names.split(' ')) CATEGORY.set(n, c); }

cat('mov movz movn movk mvn fmov dup ins umov smov', 'move');
cat('add adds sub subs adc adcs sbc sbcs neg negs mul madd msub mneg smull umull smaddl umaddl smsubl umsubl smulh umulh sdiv udiv', 'arith');
cat('and ands orr orn eor eon bic bics lsl lsr asr ror lslv lsrv asrv rorv extr ubfm sbfm bfm ubfx sbfx ubfiz sbfiz bfi bfxil bfc rev rev16 rev32 rev64 clz cls rbit sxtb sxth sxtw uxtb uxth', 'logic');
cat('cmp cmn tst ccmp ccmn fcmp fcmpe', 'compare');
cat('csel csinc csinv csneg cset csetm cinc cinv cneg', 'select');
cat('ldr ldrb ldrh ldrsb ldrsh ldrsw ldur ldurb ldurh ldursb ldursh ldursw ldp ldpsw ldnp ldtr ldxr ldaxr ldar ldarb ldarh ld1 ld2 ld3 ld4 prfm', 'load');
cat('str strb strh stur sturb sturh stp stnp sttr stxr stlxr stlr stlrb stlrh st1 st2 st3 st4', 'store');
cat('b bl br blr ret cbz cbnz tbz tbnz braa brab braaz brabz blraa blrab blraaz blrabz retaa retab', 'flow');
cat('adr adrp', 'address');
cat('nop hint bti svc hvc smc brk hlt dmb dsb isb yield wfe wfi sev sevl mrs msr sys eret eretaa eretab clrex paciasp pacibsp pacia pacib pacda pacdb paciza pacizb pacdza pacdzb paciaz pacibz pacia1716 pacib1716 autiasp autibsp autia autib autda autdb autiza autizb autdza autdzb autiaz autibz autia1716 autib1716 xpaci xpacd xpaclri pacga dc ic tlbi', 'system');
cat('fadd fsub fmul fdiv fneg fabs fsqrt fmadd fmsub fnmadd fcvt fcvtzs fcvtzu fcvtas fcvtau fcvtms fcvtmu fcvtns fcvtnu fcvtps fcvtpu scvtf ucvtf frinta frintm frintn frintp frintz fmax fmin fmaxnm fminnm', 'float');
cat('movi mvni orr_v addv uaddlv tbl tbx zip1 zip2 uzp1 uzp2 trn1 trn2 ext rev64_v cmeq cmgt xtn sqxtn', 'simd');
cat('casal cas casa casl swp swpa swpl swpal ldadd ldadda ldaddl ldaddal ldset ldclr ldeor', 'atomic');
cat('udf .byte', 'data');

// Keep the presentation/category surface aligned with the canonical machine-
// effects grammar without changing the established load/store/system categories
// for exclusive operations and barriers. These are the read-modify-write families
// that this facade already classifies as atomic; all ordering/size variants belong
// to the same category (#1827).
const ATOMIC_CATEGORY_RE = /^(?:cas|swp|ld(?:add|set|clr|eor|smax|smin|umax|umin))(?:al|a|l)?(?:b|h)?$/;
// Store-only LSE aliases discard the loaded value, so Arm exposes only the
// relaxed/release spellings plus the byte/halfword size suffixes. They remain
// atomic read-modify-write instructions even though they have no GPR result
// (#4495; operand read/write ownership is a separate #3702 contract).
const STORE_ONLY_ATOMIC_CATEGORY_RE = /^st(?:add|clr|eor|set|smax|smin|umax|umin)l?(?:b|h)?$/;

export function categoryOf(mn) {
  if (!mn) return '';
  const b = mn.toLowerCase();
  if (b.charCodeAt(0) === 46) return 'data';
  const direct = CATEGORY.get(b);
  if (direct) return direct;
  if (ATOMIC_CATEGORY_RE.test(b) || STORE_ONLY_ATOMIC_CATEGORY_RE.test(b)) return 'atomic';
  if (/^b\./.test(b)) return 'flow';
  if (/^f/.test(b)) return 'float';
  return '';
}

/** カテゴリの日本語名（行の左に出すラベル）。 */
export function categoryLabel(c) {
  const T = {
    move: ['代入', 'move'],
    arith: ['計算', 'maths'],
    logic: ['ビット演算', 'bits'],
    compare: ['比較', 'compare'],
    select: ['条件で選ぶ', 'select'],
    load: ['読み込み', 'load'],
    store: ['書き込み', 'store'],
    flow: ['流れを変える', 'flow'],
    address: ['アドレス作り', 'address'],
    system: ['CPU/OS', 'system'],
    float: ['小数の計算', 'float'],
    simd: ['まとめて計算', 'simd'],
    atomic: ['排他アクセス', 'atomic'],
    data: ['データ', 'data'],
  };
  const e = T[c];
  return e ? pick(e[0], e[1]) : '';
}

/* ────────────────────────────────────────────────────────────
   説明の組み立て
   ──────────────────────────────────────────────────────────── */

const LOAD_SIZES = {
  ldrb: [1, false], ldrsb: [1, true], ldrh: [2, false], ldrsh: [2, true], ldrsw: [4, true],
  ldurb: [1, false], ldursb: [1, true], ldurh: [2, false], ldursh: [2, true], ldursw: [4, true],
  strb: [1, false], strh: [2, false], sturb: [1, false], sturh: [2, false],
};

function sizeOfReg(r) {
  if (!r || r.k !== 'reg') return 8;
  return Math.max(1, r.bits / 8);
}

function sizeWord(bytes) {
  if (!isJa()) return bytes + ' bytes';
  const names = { 1: '1 バイト', 2: '2 バイト（16 ビット）', 4: '4 バイト（32 ビット）', 8: '8 バイト（64 ビット）', 16: '16 バイト（128 ビット）' };
  return names[bytes] || bytes + ' バイト';
}

function J(ja, en) { return pick(ja, en); }

/**
 * 1 命令の説明を作る。
 *
 * @param {string} mn        ニーモニック
 * @param {string} opsStr    オペランド文字列
 * @param {BigInt} address   この命令のアドレス
 * @param {object} ctx       { symbolFor(addr), stringAt(addr), prev, next }
 */
export function explain(mn, opsStr, address, ctx) {
  const c = ctx || {};
  const base = (mn || '').toLowerCase();
  const ops = parseOperands(opsStr || '');
  const out = {
    mnemonic: mn || '',
    operands: opsStr || '',
    category: categoryOf(base),
    title: '',
    summary: '',
    pseudo: '',
    detail: [],
    terms: [],
    target: null,
    parsed: ops,
  };

  const h = HANDLERS[base] || familyHandler(base);
  if (h) {
    // 壊れた行でも表示は続けます。ただし黙って握りつぶすと、handler 側の
    // 実装バグ（未定義ヘルパーの呼び出しなど）が「説明がない命令」に見えて
    // しまい、長期間気付けません。失敗したことを出力に残し、テストが機械的に
    // 検出できるようにします。
    try { h(out, ops, base, address, c); } catch (err) { out.handlerError = (err && err.message) || String(err); }
  }
  if (!out.title) {
    out.title = J('この命令', 'Instruction');
    out.summary = J(
      mn ? mn + ' 命令です。この viewer にはまだ日本語の解説が入っていません。' : '',
      mn ? 'The ' + mn + ' instruction. No plain-language description yet.' : '');
    out.pseudo = (mn || '') + (opsStr ? ' ' + opsStr : '');
  }
  if (out.target == null) out.target = referenceTarget(base, opsStr);
  return out;
}

/** 名前解決つきで「ジャンプ先」を文にする。 */
function targetName(addr, c) {
  if (addr == null) return null;
  const sym = c && c.symbolFor ? c.symbolFor(addr) : null;
  const hex = '0x' + addr.toString(16).toUpperCase();
  return sym ? sym + '（' + hex + '）' : hex;
}

function targetNameEn(addr, c) {
  if (addr == null) return null;
  const sym = c && c.symbolFor ? c.symbolFor(addr) : null;
  const hex = '0x' + addr.toString(16).toUpperCase();
  return sym ? sym + ' (' + hex + ')' : hex;
}

function tgt(addr, c) { return isJa() ? targetName(addr, c) : targetNameEn(addr, c); }

/* ── 汎用ビルダー ─────────────────────────────────────────── */

/** Rd = Rn OP Op2 型 */
function arith(sym, titleJa, titleEn, verbJa, verbEn, terms) {
  return (o, ops) => {
    const [d, n, m] = ops;
    o.title = J(titleJa, titleEn);
    o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ' + sym + ' ' + opShort(m);
    o.summary = J(
      opShort(n) + ' と ' + opShort(m) + (m && m.shift ? shiftText(m.shift) : '') + ' を' + verbJa + '、結果を ' + opShort(d) + ' に入れる。',
      verbEn + ' ' + opShort(n) + ' and ' + opShort(m) + ', put the result in ' + opShort(d) + '.');
    o.terms = terms || ['register'];
  };
}

/** フラグも立てる版（adds/subs/ands…）に一言足す。 */
function withFlags(fn) {
  return (o, ops, base, addr, c) => {
    fn(o, ops, base, addr, c);
    o.detail.push(J(
      '末尾の s は「計算結果でフラグも更新する」という意味です。フラグは直後の条件分岐（b.eq など）が見ます。',
      'The trailing “s” also updates the condition flags, which the next conditional branch reads.'));
    o.terms.push('flags');
  };
}

function regList(ops) { return ops.filter((x) => x.k === 'reg').map((x) => x.text); }

/* ── ハンドラ表 ───────────────────────────────────────────── */

const HANDLERS = Object.create(null);

/* 代入 ------------------------------------------------------- */

HANDLERS.mov = (o, ops) => {
  const [d, s] = ops;
  o.title = J('代入', 'Move');
  o.pseudo = opShort(d) + ' = ' + opShort(s);
  if (s && s.k === 'elem') {
    o.summary = J(
      'ベクタレジスタ v' + s.num + ' の ' + s.index + ' 番目の枠だけを取り出して ' + opShort(d) + ' に入れる。',
      'Take lane ' + s.index + ' of v' + s.num + ' into ' + opShort(d) + '.');
    o.detail.push(J(
      'ベクタレジスタは 16 バイトを何個かの「枠」に区切って使います。その中の 1 枠だけを普通のレジスタへ移す命令です。',
      'A vector register is divided into lanes; this moves one lane into a general-purpose register.'));
    o.terms = ['simd'];
    return;
  }
  if (d && d.k === 'elem') {
    o.summary = J(
      opShort(s) + ' を、ベクタレジスタ v' + d.num + ' の ' + d.index + ' 番目の枠に入れる。',
      'Put ' + opShort(s) + ' into lane ' + d.index + ' of v' + d.num + '.');
    o.terms = ['simd'];
    return;
  }
  if (s && s.k === 'imm') {
    o.summary = J(
      opShort(d) + ' に ' + immText(s) + ' を入れる。',
      'Put ' + immText(s) + ' into ' + opShort(d) + '.');
    o.detail.push(J(
      'アセンブリでは「変数に代入する」がこの形になります。# が付いている値は、命令そのものに埋め込まれた定数です。',
      'This is what “assign a constant to a variable” looks like. The # value is baked into the instruction itself.'));
    o.terms = ['register', 'immediate'];
  } else if (d && s && d.cls === 'gp' && d.num === 29 && s.cls === 'sp') {
    o.title = J('この関数の基準点を決める', 'Set up the frame pointer');
    o.summary = J(
      '今のスタックの位置を x29 に控える。ここから先、ローカル変数の場所は x29 を基準に数えられます。',
      'Record the current stack position in x29 — locals are addressed relative to it from here on.');
    o.detail.push(J(
      '関数の入り口で stp のすぐ後にこれが来るのが定番です。この 2 行が見えたら「新しい関数が始まった」と読めます。' +
      'x29 をたどると「どの関数がどの関数を呼んだか」が分かるので、クラッシュログの呼び出し履歴はこれで作られます。',
      'The standard second line of a prologue. Chained x29 values are what a crash log’s backtrace walks.'));
    o.terms = ['framepointer', 'prologue', 'stack'];
  } else {
    o.summary = J(
      opShort(s) + ' の中身を ' + opShort(d) + ' へコピーする。' + opShort(s) + ' は変わらない。',
      'Copy ' + opShort(s) + ' into ' + opShort(d) + '. ' + opShort(s) + ' is unchanged.');
    o.terms = ['register'];
  }
  addRegRoles(o, ops);
};

function moveWideInfo(ops) {
  if (!Array.isArray(ops) || ops.length !== 2) return null;
  const [destination, immediate] = ops;
  const destinationIsGp = destination && destination.k === 'reg' &&
    (destination.cls === 'gp' || destination.cls === 'zr');
  const bits = destinationIsGp && (destination.bits === 32 || destination.bits === 64)
    ? destination.bits
    : null;
  if (bits == null || destination.shift || !immediate || immediate.k !== 'imm' ||
      immediate.value == null || immediate.value < 0n || immediate.value > 0xffffn ||
      /^#-/i.test(immediate.text || '')) return null;

  const shift = immediate.shift;
  if (!shift) return { bits, shift: null };
  if (shift.op !== 'lsl' || !Number.isInteger(shift.amount)) return null;
  const legalShift = bits === 32
    ? shift.amount === 0 || shift.amount === 16
    : shift.amount === 0 || shift.amount === 16 || shift.amount === 32 || shift.amount === 48;
  return legalShift ? { bits, shift: shift.amount } : null;
}

function unknownMoveWide(o, mnemonic) {
  const displayMnemonic = o.mnemonic || mnemonic;
  o.title = J('ワイド即値命令（未解釈）', 'Unknown move-wide form');
  o.pseudo = o.operands ? displayMnemonic + ' ' + o.operands : displayMnemonic;
  o.summary = J(
    displayMnemonic.toUpperCase() + ' のこのオペランド形は解釈できません。無効または未対応の入力では値や宛先幅を推測しません。',
    'This ' + displayMnemonic.toUpperCase() + ' operand form is unknown; invalid or unsupported inputs are not assigned a guessed value or destination width.');
  o.detail.push(J(
    '説明できるのは W/X レジスタ、16 ビット即値、合法な LSL 位置を組み合わせた形だけです。',
    'Only W/X destinations, a 16-bit immediate, and legal move-wide LSL positions are explained.'));
  o.terms = [];
}

function moveWideMask(bits) {
  return bits === 32 ? '0xFFFFFFFF' : '0xFFFFFFFFFFFFFFFF';
}

HANDLERS.movz = (o, ops) => {
  const info = moveWideInfo(ops);
  if (!info) {
    unknownMoveWide(o, 'movz');
    return;
  }
  const [d, s] = ops;
  const { bits, shift: sh } = info;
  o.title = J('代入（上を 0 で埋める）', 'Move with zero');
  o.pseudo = opShort(d) + ' = ' + opShort(s);
  if (sh == null) {
    o.summary = J(
      opShort(d) + ' に ' + immText(s) + ' を入れ、残りのビットは全部 0 にする。',
      'Set ' + opShort(d) + ' to ' + immText(s) + ', zeroing every other bit.');
    o.detail.push(J(
      'ARM64 の命令は 4 バイトしかないので、64 ビットの大きな定数は一度に書き込めません。' +
        'そこで movz で下 16 ビットを置き、movk で 16 ビットずつ足していきます。',
      'An ARM64 instruction is only 4 bytes, so a 64-bit constant is built 16 bits at a time: movz then movk.'));
  } else {
    o.summary = J(
      opShort(d) + ' に ' + immText(s) + ' を ' + sh + ' ビット左へずらした値を入れ、' +
        bits + ' ビット幅の残りは全部 0 にする。',
      'Set ' + opShort(d) + ' to ' + immText(s) + ' shifted left by ' + sh +
        ' bits, zeroing the remaining bits of its ' + bits + '-bit width.');
    o.detail.push(J(
      '16 ビットの即値を ' + sh + ' ビット目から置き、' + bits + ' ビット幅の値にします。' +
        '大きな定数は、後続の movk で別の 16 ビット部分を足して組み立てます。',
      'Place the 16-bit immediate at bit ' + sh + ' in the ' + bits + '-bit result; later movk instructions can fill other 16-bit fields.'));
  }
  o.terms = ['immediate', 'register'];
};

HANDLERS.movk = (o, ops) => {
  const [d, s] = ops;
  const sh = s && s.shift ? s.shift.amount : 0;
  o.title = J('定数を 16 ビットだけ差し替える', 'Move keeping other bits');
  o.pseudo = opShort(d) + '[' + (sh + 15) + ':' + sh + '] = ' + immShort(s);
  o.summary = J(
    opShort(d) + ' の ' + sh + ' ビット目から 16 ビット分だけを ' + immText(s) + ' に書き換える。他のビットはそのまま。',
    'Replace 16 bits of ' + opShort(d) + ' starting at bit ' + sh + ' with ' + immText(s) + '; the rest is kept.');
  o.detail.push(J(
    '大きな定数（アドレスなど）を movz → movk → movk … と 16 ビットずつ組み立てている途中です。' +
    '数行まとめて 1 つの数だと思って読んでください。',
    'Part of building a large constant 16 bits at a time. Read the movz/movk run as one value.'));
  o.terms = ['immediate'];
};

HANDLERS.movn = (o, ops) => {
  const info = moveWideInfo(ops);
  if (!info) {
    unknownMoveWide(o, 'movn');
    return;
  }
  const [d, s] = ops;
  const { bits, shift: sh } = info;
  o.title = J('ビットを反転して代入', 'Move NOT');
  if (sh == null) {
    o.pseudo = opShort(d) + ' = ~' + opShort(s);
    o.summary = J(
      immText(s) + ' の 0 と 1 をすべてひっくり返した値を ' + opShort(d) + ' に入れる。−1 などの負の数を作るのに使います。',
      'Put the bitwise inverse of ' + immText(s) + ' into ' + opShort(d) + ' — how small negative constants are made.');
  } else {
    o.pseudo = opShort(d) + ' = ~(' + opShort(s) + ') & ' + moveWideMask(bits);
    o.summary = J(
      immText(s) + ' を ' + sh + ' ビット左へずらした値を ' + bits + ' ビット幅で反転して ' +
        opShort(d) + ' に入れる。−1 などの負の数を作るのに使います。',
      'Put the bitwise inverse of ' + immText(s) + ' shifted left by ' + sh + ' bits into ' +
        opShort(d) + ', limited to ' + bits + ' bits — how small negative constants are made.');
    o.detail.push(J(
      '反転は ' + bits + ' ビット幅に限ります。W レジスタなら下位 32 ビット、X レジスタなら 64 ビットだけを使います。',
      'The NOT is limited to ' + bits + ' bits: W registers use 32 bits and X registers use 64 bits.'));
  }
  o.terms = ['immediate', 'twoscomplement'];
};

HANDLERS.mvn = (o, ops) => {
  const [d, s] = ops;
  o.title = J('ビット反転', 'Bitwise NOT');
  o.pseudo = opShort(d) + ' = ~' + opShort(s);
  o.summary = J(
    opShort(s) + ' の 0 と 1 をすべて入れ替えて ' + opShort(d) + ' に入れる。',
    'Flip every bit of ' + opShort(s) + ' into ' + opShort(d) + '.');
  o.terms = ['bitwise'];
};

/* 計算 ------------------------------------------------------- */

HANDLERS.add = (o, ops, base, addr, c) => {
  const [d, n, m] = ops;
  o.title = J('足し算', 'Add');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' + ' + opShort(m);
  o.summary = J(
    opShort(n) + ' に ' + (m && m.k === 'imm' ? immText(m) : opShort(m)) + (m && m.shift ? shiftText(m.shift) : '') +
      ' を足して ' + opShort(d) + ' に入れる。',
    'Add ' + opShort(m) + ' to ' + opShort(n) + ', result in ' + opShort(d) + '.');
  o.terms = ['register'];
  if (n && n.cls === 'sp' && d && d.cls === 'gp' && d.num === 29) {
    o.detail.push(J(
      'x29（フレームポインタ）にスタックの位置を控えています。関数の入り口でよく見る形です。',
      'Recording the stack position in x29 (the frame pointer) — a standard function prologue step.'));
    o.terms.push('framepointer');
  }
  if (d && n && d.text === n.text && m && m.k === 'imm') {
    o.detail.push(J(
      '同じレジスタに足し戻しているので、C 言語で書けば ' + opShort(d) + ' += ' + immShort(m) + '; です。',
      'Same register on both sides — in C this is ' + opShort(d) + ' += ' + immShort(m) + ';'));
  }
  // adrp の直後の add はアドレス組み立て。
  // ただし「直前が adrp」だけでは足りません。この add が adrp の書き込み先
  // レジスタを読んでいることまで確かめないと、無関係な 2 行から実在しない
  // 参照先を作ってしまいます (#1289)。
  if (c && c.prev && /^adrp$/i.test(c.prev.mn) && m && m.k === 'imm'
    && sameGeneralRegister(n, parseOperands(c.prev.ops)[0])) {
    const page = referenceTarget('adrp', c.prev.ops);
    if (page != null) {
      const full = page + (m.value || 0n);
      o.target = full;
      o.detail.push(J(
        '1 行上の adrp と組で、' + tgt(full, c) + ' というアドレスを作っています。ARM64 で遠くのデータを指すときの定番の 2 行です。',
        'Together with the adrp above, this builds the address ' + tgt(full, c) + ' — the standard ARM64 pair for reaching distant data.'));
      o.terms.push('adrp');
    }
  }
  addRegRoles(o, ops);
};

HANDLERS.adds = withFlags(HANDLERS.add);

HANDLERS.sub = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('引き算', 'Subtract');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' − ' + opShort(m);
  o.summary = J(
    opShort(n) + ' から ' + (m && m.k === 'imm' ? immText(m) : opShort(m)) + ' を引いて ' + opShort(d) + ' に入れる。',
    'Subtract ' + opShort(m) + ' from ' + opShort(n) + ', result in ' + opShort(d) + '.');
  o.terms = ['register'];
  if (d && n && d.cls === 'sp' && n.cls === 'sp' && m && m.k === 'imm') {
    o.title = J('スタックの場所を確保する', 'Reserve stack space');
    o.summary = J(
      'スタックポインタを ' + (m.value || 0n).toString(10) + ' バイト下げて、その分の作業スペースを確保する。',
      'Lower the stack pointer by ' + m.value + ' bytes to make room for local variables.');
    o.detail.push(J(
      'スタックはアドレスが小さい方へ伸びるので、「引く」＝「場所を取る」です。' +
      '関数の終わりでは同じ量を add sp, sp, #… で返します。',
      'The stack grows downwards, so subtracting reserves space. The epilogue adds the same amount back.'));
    o.terms = ['stack', 'sp'];
  }
  addRegRoles(o, ops);
};

HANDLERS.subs = withFlags(HANDLERS.sub);
HANDLERS.adc = arith('+', '足し算（繰り上がり込み）', 'Add with carry', '繰り上がりも含めて足し', 'Add with carry');
HANDLERS.sbc = arith('−', '引き算（借り込み）', 'Subtract with carry', '借りも含めて引き', 'Subtract with borrow');

HANDLERS.neg = (o, ops) => {
  const [d, s] = ops;
  o.title = J('符号を反転', 'Negate');
  o.pseudo = opShort(d) + ' = −' + opShort(s);
  o.summary = J(
    opShort(s) + ' のプラスマイナスを反転して ' + opShort(d) + ' に入れる。',
    'Flip the sign of ' + opShort(s) + ' into ' + opShort(d) + '.');
  o.terms = ['twoscomplement'];
};

HANDLERS.mul = arith('×', '掛け算', 'Multiply', 'かけ', 'Multiply');
HANDLERS.sdiv = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('割り算（符号あり）', 'Signed divide');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ÷ ' + opShort(m);
  o.summary = J(
    opShort(n) + ' を ' + opShort(m) + ' で割った商（小数は切り捨て）を ' + opShort(d) + ' に入れる。マイナスも扱えます。',
    'Divide ' + opShort(n) + ' by ' + opShort(m) + ' (truncating), signed.');
  o.detail.push(J('0 で割っても例外にはならず、結果は 0 になります。', 'Dividing by zero yields 0 rather than trapping.'));
};
HANDLERS.udiv = (o, ops) => {
  HANDLERS.sdiv(o, ops);
  const [d, n, m] = ops;
  o.title = J('割り算（符号なし）', 'Unsigned divide');
  o.summary = J(
    opShort(n) + ' を ' + opShort(m) + ' で割った商（小数は切り捨て）を ' + opShort(d) + ' に入れる。マイナスは扱いません（全部プラスとして計算）。',
    'Divide ' + opShort(n) + ' by ' + opShort(m) + ' (truncating), unsigned.');
};

HANDLERS.madd = (o, ops) => {
  const [d, n, m, a] = ops;
  o.title = J('掛けて足す', 'Multiply-add');
  o.pseudo = opShort(d) + ' = ' + opShort(a) + ' + ' + opShort(n) + ' × ' + opShort(m);
  o.summary = J(
    opShort(n) + ' × ' + opShort(m) + ' を計算し、それに ' + opShort(a) + ' を足して ' + opShort(d) + ' に入れる。',
    'Multiply then add, all in one instruction.');
  o.detail.push(J('配列の添字計算（base + index × サイズ）でよく出てきます。', 'Common in array index arithmetic.'));
};
HANDLERS.msub = (o, ops) => {
  const [d, n, m, a] = ops;
  o.title = J('掛けて引く', 'Multiply-subtract');
  o.pseudo = opShort(d) + ' = ' + opShort(a) + ' − ' + opShort(n) + ' × ' + opShort(m);
  o.summary = J(
    opShort(a) + ' から ' + opShort(n) + ' × ' + opShort(m) + ' を引いて ' + opShort(d) + ' に入れる。',
    'Multiply then subtract.');
  o.detail.push(J('割り算のあとに「余り」を求める形（a − (a÷b)×b）でよく出ます。', 'Often computes a remainder after a division.'));
};
function hasVectorOperand(ops) {
  return ops.some((op) => op?.k === 'reg' && op.cls === 'vec');
}

function longMultiply(signed) {
  return (o, ops) => {
    const [d, n, m] = ops;
    if (hasVectorOperand(ops)) {
      const operation = signed ? 'signed_lane_widen_mul' : 'unsigned_lane_widen_mul';
      o.title = J(
        signed ? 'ベクタの各レーンを符号付きで拡張して掛ける' : 'ベクタの各レーンを符号なしで拡張して掛ける',
        (signed ? 'Signed' : 'Unsigned') + ' vector long multiply');
      o.pseudo = opShort(d) + ' = ' + operation + '(' + opShort(n) + ', ' + opShort(m) + ')';
      o.summary = J(
        opShort(n) + ' と ' + opShort(m) + ' の対応するレーンを' + (signed ? '符号付き' : '符号なし') +
          'として広いレーンへ拡張してから、レーンごとに掛ける。',
        (signed ? 'Sign-extend' : 'Zero-extend') + ' corresponding lanes of ' +
          opShort(n) + ' and ' + opShort(m) + ', then multiply lane by lane into ' + opShort(d) + '.');
      o.detail.push(J(
        'これは汎用レジスタの 1 個の値ではなく、ベクタレジスタ内の複数レーンを同時に処理します。',
        'This is the SIMD form: it processes multiple vector lanes rather than one general-purpose value.'));
      o.terms = ['simd', 'signedness'];
      return;
    }
    o.title = J(
      signed ? '32ビット符号付き同士を掛けて64ビットに' : '32ビット符号なし同士を掛けて64ビットに',
      (signed ? 'Signed' : 'Unsigned') + ' long multiply');
    o.pseudo = opShort(d) + ' = ' + (signed ? '(signed)' : '(unsigned)') + opShort(n) +
      ' × ' + (signed ? '(signed)' : '(unsigned)') + opShort(m);
    o.summary = J(
      '32 ビットの ' + opShort(n) + ' と ' + opShort(m) + ' を' + (signed ? '符号付き' : '符号なし') +
        'として掛け、あふれないように 64 ビットの ' + opShort(d) + ' に入れる。',
      (signed ? 'Sign-extend' : 'Zero-extend') + ' the 32-bit operands, multiply them, and write the 64-bit result to ' + opShort(d) + '.');
    o.detail.push(J(
      (signed ? 'マイナスの値は符号を保ったまま' : '値は 0 を上位に補って') + '64 ビットに広げてから掛けます。',
      (signed ? 'Negative operands keep their sign when widened.' : 'The operands are widened with zeroes in the upper bits.')));
    o.terms = ['signedness'];
  };
}
HANDLERS.smull = longMultiply(true);
HANDLERS.umull = longMultiply(false);

/* ビット演算 ------------------------------------------------- */

HANDLERS.and = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('ビットの AND', 'Bitwise AND');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' & ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' の両方で 1 のビットだけを残して ' + opShort(d) + ' に入れる。',
    'Keep only the bits set in both, into ' + opShort(d) + '.');
  if (m && m.k === 'imm') {
    o.detail.push(J(
      '定数との AND は「必要な部分だけ取り出す」ためのマスクです。例えば & 0xFF なら下 1 バイトだけを残します。',
      'ANDing with a constant masks out everything but the bits you want.'));
  }
  o.terms = ['bitwise', 'mask'];
};
HANDLERS.ands = withFlags(HANDLERS.and);

HANDLERS.orr = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('ビットの OR', 'Bitwise OR');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' | ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' のどちらかで 1 のビットを 1 にして ' + opShort(d) + ' に入れる。',
    'Set the bits present in either operand.');
  o.detail.push(J('「フラグを立てる」ときの定番です。', 'The usual way to turn flag bits on.'));
  o.terms = ['bitwise'];
};

HANDLERS.eor = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('ビットの XOR', 'Bitwise XOR');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ^ ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' で「片方だけ 1」のビットを 1 にして ' + opShort(d) + ' に入れる。',
    'Set the bits that differ between the two.');
  if (n && m && n.text === m.text) {
    o.detail.push(J(
      '同じ値どうしの XOR は必ず 0 です。つまりこれは ' + opShort(d) + ' を 0 にする書き方です。',
      'XOR with itself is always zero — this is a way of writing ' + opShort(d) + ' = 0.'));
  }
  o.detail.push(J('暗号やハッシュの処理でも頻繁に出てきます。', 'Very common in crypto and hashing code.'));
  o.terms = ['bitwise'];
};

HANDLERS.bic = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('ビットを落とす', 'Bit clear');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' & ~' + opShort(m);
  o.summary = J(
    opShort(m) + ' で 1 になっているビットを ' + opShort(n) + ' から消して ' + opShort(d) + ' に入れる。',
    'Clear the bits of ' + opShort(n) + ' that are set in ' + opShort(m) + '.');
  o.terms = ['bitwise'];
};
HANDLERS.orn = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('反転して OR', 'OR NOT');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' | ~' + opShort(m);
  o.summary = J(opShort(m) + ' を反転してから ' + opShort(n) + ' と OR する。', 'OR with the inverse.');
};
HANDLERS.eon = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('反転して XOR', 'XOR NOT');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ^ ~' + opShort(m);
  o.summary = J(opShort(m) + ' を反転してから XOR する。', 'XOR with the inverse.');
};

function shifter(titleJa, titleEn, verbJa, verbEn, symbol, note) {
  return (o, ops) => {
    const [d, n, m] = ops;
    o.title = J(titleJa, titleEn);
    o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ' + symbol + ' ' + opShort(m);
    const amount = m && m.k === 'imm' ? (m.value == null ? null : m.value) : null;
    const howMany = amount != null ? amount.toString(10) + ' ビット' : opShort(m) + ' ビット';
    o.summary = J(
      opShort(n) + ' のビット全体を ' + howMany + verbJa + '、結果を ' + opShort(d) + ' に入れる。',
      verbEn + ' ' + opShort(n) + ' by ' + opShort(m) + ' into ' + opShort(d) + '.');
    if (amount != null && amount > 0n && amount < 64n && note) o.detail.push(note(amount));
    o.terms = ['bitwise', 'shift'];
  };
}

HANDLERS.lsl = shifter('ビットを左へずらす', 'Shift left', '左へずらして', 'Shift left', '<<', (n) => J(
  '左に ' + n + ' ビットずらすのは、2 の ' + n + ' 乗（' + (2n ** n).toString(10) + '）を掛けるのと同じです。' +
  '掛け算より速いので、コンパイラは「× 2」「× 8」をこの形に置き換えます。',
  'Shifting left by ' + n + ' multiplies by ' + (2n ** n) + ' — cheaper than a multiply, so the compiler prefers it.'));
HANDLERS.lsr = shifter('ビットを右へずらす', 'Shift right', '右へずらして', 'Shift right', '>>', (n) => J(
  '右に ' + n + ' ビットずらすのは、2 の ' + n + ' 乗（' + (2n ** n).toString(10) + '）で割るのと同じです（余りは切り捨て）。' +
  '空いた上位ビットには 0 が入ります。',
  'Shifting right by ' + n + ' divides by ' + (2n ** n) + ', discarding the remainder; zeros fill in at the top.'));
HANDLERS.asr = shifter('ビットを右へずらす（符号を保つ）', 'Arithmetic shift right', '符号を保ったまま右へずらして', 'Arithmetic-shift right', '>>', () => J(
  '空いた上位ビットに、元の符号ビット（一番上のビット）と同じ値を詰めます。' +
  'こうするとマイナスの数もマイナスのまま割り算できます。',
  'The vacated top bits are filled with the sign bit, so negative values divide correctly.'));
HANDLERS.ror = shifter('ビットを回転させる', 'Rotate right', '回転させて', 'Rotate', 'ror', () => J(
  '端からこぼれたビットが反対側から戻ってくる「回転」です。値のビットは 1 つも失われません。' +
  'ハッシュや暗号の計算でよく使われます。',
  'Bits that fall off one end reappear at the other — nothing is lost. Common in hashing and crypto.'));

HANDLERS.ubfx = (o, ops) => {
  const [d, n, lsb, width] = ops;
  o.title = J('ビットを切り出す', 'Extract bit field');
  o.pseudo = opShort(d) + ' = (' + opShort(n) + ' >> ' + immShort(lsb) + ') & ' + (width && width.value != null ? '0x' + ((1n << width.value) - 1n).toString(16).toUpperCase() : '…');
  o.summary = J(
    opShort(n) + ' の ' + immShort(lsb) + ' ビット目から ' + immShort(width) + ' ビット分を抜き出して ' + opShort(d) + ' に入れる。上は 0 で埋める。',
    'Take ' + immShort(width) + ' bits starting at bit ' + immShort(lsb) + ' of ' + opShort(n) + '.');
  o.detail.push(J('1 個の数の中に複数の情報を詰め込んでいるときの取り出しです。', 'Unpacking several fields stored in one word.'));
  o.terms = ['bitfield'];
};
HANDLERS.sbfx = (o, ops) => { HANDLERS.ubfx(o, ops); o.title = J('ビットを切り出す（符号つき）', 'Extract signed bit field'); };
HANDLERS.ubfiz = (o, ops) => {
  const [d, n, lsb, width] = ops;
  o.title = J('切り出して左に置く', 'Insert bit field');
  o.pseudo = opShort(d) + ' = (' + opShort(n) + ' & mask) << ' + immShort(lsb);
  o.summary = J(
    opShort(n) + ' の下 ' + immShort(width) + ' ビットを取り、' + immShort(lsb) + ' ビット目の位置に置いて ' + opShort(d) + ' に入れる。',
    'Take the low bits and place them at bit ' + immShort(lsb) + '.');
  o.terms = ['bitfield'];
};

// These aliases have the same operand shape, but SBFIZ sign-extends its field
// while UBFIZ zero-fills the destination above it (#3612).
function bitfieldSpan(start, width) {
  if (!start || start.value == null || !width || width.value == null || width.value <= 0n) return null;
  return { first: start.value, last: start.value + width.value - 1n, width: width.value };
}

function bitfieldRange(span) {
  if (!span) return '…';
  return span.first.toString(10) + '..' + span.last.toString(10);
}

HANDLERS.sbfiz = (o, ops) => {
  const [d, n, lsb, width] = ops;
  const inserted = bitfieldSpan(lsb, width);
  const source = width && width.value != null ? bitfieldSpan({ value: 0n }, width) : null;
  const destBits = bitfieldRange(inserted);
  const sourceBits = bitfieldRange(source);
  const bits = d && d.bits ? d.bits : '?';
  o.title = J('符号つきビットフィールドを左に置く', 'Signed bitfield insert in zeros');
  o.pseudo = opShort(d) + ' = sign_extend(' + opShort(n) + '[' + sourceBits + '], ' + bits + ') << ' + immShort(lsb);
  o.summary = J(
    opShort(n) + ' の下 ' + immShort(width) + ' ビット（' + sourceBits + '）を取り、最上位ビットの符号を広げて ' + opShort(d) + ' の ' + destBits + ' に置く。下は 0、上は符号ビットで埋める。',
    'Take ' + immShort(width) + ' low bits (' + sourceBits + ') of ' + opShort(n) + ', sign-extend their top bit, and place them in ' + opShort(d) + ' at bits ' + destBits + '. Lower bits are zero; upper bits copy the sign bit.');
  o.detail.push(J(
    'UBFIZ と違い、フィールドの一番上のビットを符号として使います。幅が ' + bits + ' ビットのレジスタ全体に符号が広がります。',
    'Unlike UBFIZ, the field\'s top bit is treated as a sign bit and extended across the ' + bits + '-bit destination.'));
  o.terms = ['bitfield'];
};
HANDLERS.bfi = (o, ops) => {
  const [d, n, lsb, width] = ops;
  o.title = J('ビットを差し込む', 'Bit field insert');
  o.pseudo = opShort(d) + '[' + immShort(lsb) + '…] = ' + opShort(n);
  o.summary = J(
    opShort(n) + ' の下 ' + immShort(width) + ' ビットを、' + opShort(d) + ' の ' + immShort(lsb) + ' ビット目に埋め込む。他はそのまま。',
    'Insert bits of ' + opShort(n) + ' into ' + opShort(d) + ' without touching the rest.');
  o.terms = ['bitfield'];
};
// BFXIL reads from the source lsb and writes at destination bit zero; BFI reads
// the source low bits and writes at the destination lsb (#3612).
HANDLERS.bfxil = (o, ops) => {
  const [d, n, lsb, width] = ops;
  const source = bitfieldSpan(lsb, width);
  const destination = width && width.value != null ? bitfieldSpan({ value: 0n }, width) : null;
  const sourceBits = bitfieldRange(source);
  const destinationBits = bitfieldRange(destination);
  o.title = J('ビットを切り出して下位へ入れる', 'Bitfield extract and insert at low end');
  o.pseudo = opShort(d) + '[' + destinationBits + '] = ' + opShort(n) + '[' + sourceBits + ']';
  o.summary = J(
    opShort(n) + ' の ' + immShort(lsb) + ' ビット目から ' + immShort(width) + ' ビット（' + sourceBits + '）を抜き出し、' + opShort(d) + ' の下位 ' + immShort(width) + ' ビット（' + destinationBits + '）に入れる。それより上のビットはそのまま。',
    'Extract ' + immShort(width) + ' bits (' + sourceBits + ') from ' + opShort(n) + ' and insert them into the low bits (' + destinationBits + ') of ' + opShort(d) + '; higher destination bits stay unchanged.');
  o.detail.push(J(
    'BFI はソースの下位ビットを宛先の指定位置へ入れますが、BFXIL はソースの指定位置から読み、宛先の 0 ビット目から入れます。',
    'Unlike BFI, BFXIL reads from the specified source bit and always writes at destination bit 0.'));
  o.terms = ['bitfield'];
};

HANDLERS.extr = (o, ops) => {
  const [d, n, m, lsb] = ops;
  o.title = J('2 つをつないで切り出す', 'Extract from pair');
  o.pseudo = opShort(d) + ' = concat(' + opShort(n) + ', ' + opShort(m) + ') >> ' + immShort(lsb);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' を横に並べた長いビット列から、' + immShort(lsb) + ' ビット目以降を切り出す。',
    'Concatenate the two registers and take a window out of the middle.');
};

HANDLERS.rev = (o, ops) => {
  const [d, s] = ops;
  o.title = J('バイトの順番を逆に', 'Reverse bytes');
  o.pseudo = opShort(d) + ' = byteswap(' + opShort(s) + ')';
  o.summary = J(
    opShort(s) + ' のバイトの並びを前後ひっくり返して ' + opShort(d) + ' に入れる。',
    'Reverse the byte order of ' + opShort(s) + '.');
  o.detail.push(J(
    'ネットワークのデータは「大きい桁が先」（ビッグエンディアン）、ARM は「小さい桁が先」（リトルエンディアン）なので、変換にこれを使います。',
    'Network data is big-endian while ARM is little-endian, so byte swapping converts between them.'));
  o.terms = ['endian'];
};

function reverseBytesWithin(elementBits) {
  const elementName = elementBits === 16 ? 'halfword' : 'word';
  return (o, ops) => {
    const [d, s] = ops;
    if (hasVectorOperand(ops)) {
      o.title = J(
        elementBits === 16 ? 'ベクタの16ビットレーン内でバイト順を逆に' : 'ベクタの32ビットレーン内でバイト順を逆に',
        'Reverse bytes within ' + elementBits + '-bit vector lanes');
      o.pseudo = opShort(d) + ' = vector_byteswap' + elementBits + '(' + opShort(s) + ')';
      o.summary = J(
        opShort(s) + ' の各 ' + elementBits + ' ビットレーンの中だけバイト順を逆にして ' + opShort(d) + ' に入れる。',
        'Reverse bytes within each ' + elementBits + '-bit lane of ' + opShort(s) + ', writing the result to ' + opShort(d) + '.');
      o.detail.push(J(
        'ベクタレジスタのレーン同士を入れ替えるのではなく、各レーンの中のバイトだけを入れ替えます。',
        'The SIMD form swaps bytes inside each lane without moving data between lanes.'));
      o.terms = ['simd', 'endian'];
      return;
    }
    o.title = J(
      elementBits === 16 ? '16ビット単位でバイト順を逆に' : '32ビット単位でバイト順を逆に',
      'Reverse bytes in ' + elementBits + '-bit ' + elementName + 's');
    o.pseudo = opShort(d) + ' = byteswap' + elementBits + '(' + opShort(s) + ')';
    o.summary = J(
      opShort(s) + ' の各 ' + elementBits + ' ビット' + (elementBits === 16 ? '半ワード' : 'ワード') +
        'の中だけバイト順を逆にして ' + opShort(d) + ' に入れる。',
      'Reverse bytes within each ' + elementBits + '-bit ' + elementName + ' of ' + opShort(s) + ', writing the result to ' + opShort(d) + '.');
    o.detail.push(J(
      'レジスタ全体をひっくり返すのではなく、' + elementBits + ' ビット単位ごとにその中のバイトだけを入れ替えます。',
      'Split the register into ' + elementBits + '-bit ' + elementName + 's and swap bytes only within each one.'));
    o.terms = ['endian'];
  };
}
HANDLERS.rev16 = reverseBytesWithin(16);
HANDLERS.rev32 = reverseBytesWithin(32);

HANDLERS.clz = (o, ops) => {
  const [d, s] = ops;
  o.title = J('先頭に並ぶ 0 を数える', 'Count leading zeros');
  o.pseudo = opShort(d) + ' = clz(' + opShort(s) + ')';
  o.summary = J(
    opShort(s) + ' を 2 進数で書いたとき、頭にいくつ 0 が続くかを数えて ' + opShort(d) + ' に入れる。',
    'Count the zero bits before the first 1.');
  o.detail.push(J('「この数は何桁必要か」を高速に求めるのに使われます。', 'A fast way to ask how many bits a value needs.'));
};
HANDLERS.rbit = (o, ops) => {
  const [d, s] = ops;
  o.title = J('ビットの並びを逆に', 'Reverse bits');
  o.pseudo = opShort(d) + ' = bitreverse(' + opShort(s) + ')';
  o.summary = J(opShort(s) + ' のビットを前後ひっくり返して ' + opShort(d) + ' に入れる。', 'Reverse the bit order.');
};

function extend(bytes, signed) {
  return (o, ops) => {
    const [d, s] = ops;
    o.title = signed ? J('符号を伸ばして拡張', 'Sign extend') : J('0 を詰めて拡張', 'Zero extend');
    o.pseudo = opShort(d) + ' = ' + (signed ? '(signed)' : '(unsigned)') + opShort(s);
    o.summary = signed
      ? J(opShort(s) + ' の下 ' + bytes * 8 + ' ビットを取り出し、マイナスならマイナスのまま大きい幅にして ' + opShort(d) + ' に入れる。',
          'Take the low ' + bytes * 8 + ' bits and widen them, keeping the sign.')
      : J(opShort(s) + ' の下 ' + bytes * 8 + ' ビットを取り出し、上を 0 で埋めて ' + opShort(d) + ' に入れる。',
          'Take the low ' + bytes * 8 + ' bits and zero the rest.');
    o.detail.push(J(
      'C 言語で char や short を int に代入したときに、コンパイラがここを入れます。',
      'What the compiler emits when a char or short is assigned to an int.'));
    o.terms = ['signedness'];
  };
}
HANDLERS.sxtb = extend(1, true);
HANDLERS.sxth = extend(2, true);
HANDLERS.sxtw = extend(4, true);
HANDLERS.uxtb = extend(1, false);
HANDLERS.uxth = extend(2, false);

/* 比較 ------------------------------------------------------- */

HANDLERS.cmp = (o, ops) => {
  const [n, m] = ops;
  o.title = J('比べる', 'Compare');
  o.pseudo = 'flags = ' + opShort(n) + ' − ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + (m && m.k === 'imm' ? immText(m) : opShort(m)) + ' を比べる。結果はレジスタには残らず、フラグにだけ残る。',
    'Compare ' + opShort(n) + ' with ' + opShort(m) + '. The result only updates the flags.');
  o.detail.push(J(
    '実際には引き算をして、答えは捨て、「0 だったか」「マイナスだったか」だけを覚えます。' +
    'その直後の b.eq / b.lt などが、その覚えた結果を見て進む先を決めます。つまり cmp と分岐は必ずセットで読みます。',
    'It subtracts, throws the result away and keeps only the flags. The following b.eq / b.lt reads them — always read the pair together.'));
  o.terms = ['flags', 'branch'];
};
HANDLERS.cmn = (o, ops) => {
  const [n, m] = ops;
  o.title = J('足した結果で比べる', 'Compare negative');
  o.pseudo = 'flags = ' + opShort(n) + ' + ' + opShort(m);
  o.summary = J(
    opShort(n) + ' に ' + opShort(m) + ' を足した結果でフラグを立てる。「−N と比べる」ときに使われます。',
    'Adds instead of subtracting; used to compare against a negative number.');
  o.terms = ['flags'];
};
HANDLERS.tst = (o, ops) => {
  const [n, m] = ops;
  o.title = J('ビットが立っているか調べる', 'Test bits');
  o.pseudo = 'flags = ' + opShort(n) + ' & ' + opShort(m);
  o.summary = J(
    opShort(n) + ' の中で ' + opShort(m) + ' が示すビットが 1 かどうかを調べる。結果はフラグにだけ残る。',
    'AND the two and keep only the flags — “is this bit set?”.');
  o.detail.push(J(
    '直後が b.eq なら「そのビットが 0 だったら飛ぶ」、b.ne なら「1 だったら飛ぶ」です。',
    'A following b.eq means “the bit was clear”; b.ne means “it was set”.'));
  o.terms = ['flags', 'mask'];
};
HANDLERS.ccmp = (o, ops) => {
  const [n, m, nzcv, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件つきで比べる', 'Conditional compare');
  o.pseudo = 'if (' + (cond ? cond.text : '?') + ') flags = ' + opShort(n) + ' − ' + opShort(m) + ' else flags = ' + immShort(nzcv);
  o.summary = J(
    '前の比較が「' + (ci ? ci.ja : '条件を満たしたとき') + '」に当てはまる場合だけ、' +
      opShort(n) + ' と ' + opShort(m) + ' をもう一度比べる。当てはまらなければフラグを ' + immShort(nzcv) + ' に決め打ちする。',
    'Compare again only if the previous condition held; otherwise force the flags to ' + immShort(nzcv) + '.');
  o.detail.push(J(
    'C 言語の && や || を、分岐を増やさずに 1 本にまとめた形です（if (a == 1 && b == 2) など）。',
    'How && and || are compiled without extra branches.'));
  o.terms = ['flags'];
};
HANDLERS.ccmn = (o, ops) => {
  const [n, m, nzcv, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件つきで足して比べる', 'Conditional compare negative');
  o.pseudo = 'if (' + (cond ? cond.text : '?') + ') flags = ' + opShort(n) + ' + ' + opShort(m) + ' else flags = ' + immShort(nzcv);
  o.summary = J(
    '前の比較が「' + (ci ? ci.ja : '条件を満たしたとき') + '」に当てはまる場合だけ、' +
      opShort(n) + ' と ' + opShort(m) + ' を足してフラグを更新する。当てはまらなければフラグを ' + immShort(nzcv) + ' に決め打ちする。',
    'Add ' + opShort(n) + ' and ' + opShort(m) + ' and update the flags only if the previous condition held; otherwise force the flags to ' + immShort(nzcv) + '.');
  o.detail.push(J(
    'C 言語の && や || を、分岐を増やさずに 1 本にまとめた形です（if (a == 1 && b == 2) など）。',
    'How && and || are compiled without extra branches.'));
  o.terms = ['flags'];
};

/* 条件で選ぶ ------------------------------------------------- */

HANDLERS.csel = (o, ops) => {
  const [d, n, m, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件で選ぶ', 'Conditional select');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ' + opShort(n) + ' : ' + opShort(m);
  o.summary = J(
    '直前の比較が「' + (ci ? ci.ja : cond && cond.text) + '」なら ' + opShort(n) + '、そうでなければ ' + opShort(m) + ' を ' + opShort(d) + ' に入れる。',
    'Put ' + opShort(n) + ' in ' + opShort(d) + ' if ' + (ci ? ci.en : '') + ', otherwise ' + opShort(m) + '.');
  o.detail.push(J(
    'C 言語の三項演算子 a = cond ? b : c と同じです。分岐しないので速く、条件によって実行時間が変わらないため暗号処理でも好まれます。',
    'The ternary operator, without a branch.'));
  o.terms = ['flags'];
};
HANDLERS.csinc = (o, ops) => {
  const [d, n, m, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件で選ぶ（片方は +1）', 'Conditional select increment');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ' + opShort(n) + ' : ' + opShort(m) + ' + 1';
  o.summary = J(
    '「' + (ci ? ci.ja : '') + '」なら ' + opShort(n) + '、違えば ' + opShort(m) + ' に 1 を足した値を ' + opShort(d) + ' に入れる。',
    'Select, adding one to the second choice.');
  o.terms = ['flags'];
};
HANDLERS.csinv = (o, ops) => {
  const [d, n, m, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件で選ぶ（片方をビット反転）', 'Conditional select invert');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ' + opShort(n) + ' : ~' + opShort(m);
  o.summary = J(
    '「' + (ci ? ci.ja : '') + '」なら ' + opShort(n) + '、違えば ' + opShort(m) + ' の全ビットを反転した値を ' + opShort(d) + ' に入れる。',
    'Select ' + opShort(n) + ' if the condition holds; otherwise put the bitwise inverse of ' + opShort(m) + ' in ' + opShort(d) + '.');
  o.terms = ['flags'];
};
HANDLERS.csneg = (o, ops) => {
  const [d, n, m, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件で選ぶ（片方を符号反転）', 'Conditional select negate');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ' + opShort(n) + ' : -' + opShort(m);
  o.summary = J(
    '「' + (ci ? ci.ja : '') + '」なら ' + opShort(n) + '、違えば ' + opShort(m) + ' の符号を反転した値を ' + opShort(d) + ' に入れる。',
    'Select ' + opShort(n) + ' if the condition holds; otherwise put the arithmetic negation of ' + opShort(m) + ' in ' + opShort(d) + '.');
  o.terms = ['flags'];
};

HANDLERS.cset = (o, ops) => {
  const [d, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件を 0 か 1 にする', 'Set to 0 or 1');
  o.pseudo = opShort(d) + ' = (' + (ci ? ci.expr : cond && cond.text) + ') ? 1 : 0';
  o.summary = J(
    '直前の比較が「' + (ci ? ci.ja : '') + '」なら ' + opShort(d) + ' に 1、そうでなければ 0 を入れる。',
    'Set ' + opShort(d) + ' to 1 when ' + (ci ? ci.en : '') + ', else 0.');
  o.detail.push(J(
    'C 言語で bool result = (a == b); と書いたときの形です。',
    'What “bool r = (a == b);” compiles to.'));
  o.terms = ['flags'];
};
HANDLERS.csetm = (o, ops) => {
  const [d, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件を 0 か「全ビット 1」にする', 'Set to 0 or all-ones');
  o.pseudo = opShort(d) + ' = (' + (ci ? ci.expr : cond && cond.text) + ') ? -1 : 0';
  o.summary = J(
    '直前の比較が「' + (ci ? ci.ja : '') + '」なら ' + opShort(d) + ' を全ビット 1（＝ −1）に、そうでなければ 0 にする。',
    'Set ' + opShort(d) + ' to all-ones (−1) when ' + (ci ? ci.en : '') + ', else 0.');
  o.detail.push(J(
    '全ビット 1 は、そのあと AND で使う「マスク」として便利なので、分岐なしで値を選ぶ書き方に使われます。',
    'All-ones makes a handy mask for a following AND — a branch-free way to select a value.'));
  o.terms = ['flags', 'mask'];
};
HANDLERS.cinc = (o, ops) => {
  const [d, n, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件が合えば +1', 'Conditional increment');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ' + opShort(n) + ' + 1 : ' + opShort(n);
  o.summary = J(
    '「' + (ci ? ci.ja : '') + '」なら ' + opShort(n) + ' に 1 を足して、違えばそのまま ' + opShort(d) + ' に入れる。',
    'Add one only if the condition holds.');
  o.terms = ['flags'];
};
HANDLERS.cinv = (o, ops) => {
  const [d, n, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件が合えばビット反転', 'Conditional invert');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ~' + opShort(n) + ' : ' + opShort(n);
  o.summary = J(
    '「' + (ci ? ci.ja : '') + '」なら ' + opShort(n) + ' の全ビットを反転して ' + opShort(d) + ' に入れ、違えばそのまま入れる。',
    'Put the bitwise inverse of ' + opShort(n) + ' in ' + opShort(d) + ' if the condition holds; otherwise put ' + opShort(n) + ' in ' + opShort(d) + '.');
  o.terms = ['flags'];
};
HANDLERS.cneg = (o, ops) => {
  const [d, n, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件が合えば符号反転', 'Conditional negate');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? -' + opShort(n) + ' : ' + opShort(n);
  o.summary = J(
    '「' + (ci ? ci.ja : '') + '」なら ' + opShort(n) + ' の符号を反転して ' + opShort(d) + ' に入れ、違えばそのまま入れる。',
    'Put the arithmetic negation of ' + opShort(n) + ' in ' + opShort(d) + ' if the condition holds; otherwise put ' + opShort(n) + ' in ' + opShort(d) + '.');
  o.terms = ['flags'];
};

/* メモリ ----------------------------------------------------- */

function loadStore(isLoad) {
  return (o, ops, base, addr, c) => {
    const dst = ops[0];
    const mem = ops.find((x) => x.k === 'mem');
    const size = LOAD_SIZES[base] ? LOAD_SIZES[base][0] : sizeOfReg(dst);
    const signed = LOAD_SIZES[base] ? LOAD_SIZES[base][1] : false;
    o.title = isLoad ? J('メモリから読む', 'Load from memory') : J('メモリへ書く', 'Store to memory');
    if (!mem) { o.pseudo = (mn2(base) || base) + ' ' + (o.operands || ''); return; }
    o.pseudo = isLoad
      ? opShort(dst) + ' = *(' + cType(size, signed) + '*)(' + memExpr(mem) + ')'
      : '*(' + cType(size, signed) + '*)(' + memExpr(mem) + ') = ' + opShort(dst);
    o.summary = isLoad
      ? J(memText(mem) + 'から ' + sizeWord(size) + ' 読み込み、' + opShort(dst) + ' に入れる。',
          'Read ' + sizeWord(size) + ' from ' + memText(mem) + ' into ' + opShort(dst) + '.')
      : J(opShort(dst) + ' の値（' + sizeWord(size) + '）を、' + memText(mem) + 'へ書き込む。',
          'Write ' + sizeWord(size) + ' from ' + opShort(dst) + ' to ' + memText(mem) + '.');
    o.detail.push(J(
      'レジスタは 31 本しかないので、それより多くのデータはメモリに置きます。' +
      'メモリを使うにはこのように「アドレスを作って、読む／書く」の 2 段構えになります。',
      'There are only 31 registers, so everything else lives in memory: build an address, then load or store.'));
    if (signed) {
      o.detail.push(J(
        's が付いているので、読んだ値がマイナスならマイナスのまま大きい幅に伸ばします。',
        'The “s” means the value is sign-extended as it is widened.'));
      o.terms.push('signedness');
    }
    if (mem.base && mem.base.cls === 'sp') {
      o.detail.push(isLoad
        ? J('sp からの読み込みなので、この関数のローカル変数（一時的な変数）を読んでいます。',
            'Reading from sp — this is a local variable of the current function.')
        : J('sp への書き込みなので、この関数のローカル変数に値をしまっています。',
            'Writing to sp — storing into a local variable.'));
      o.terms.push('stack');
    }
    if (mem.mode === 'pre' || mem.mode === 'post') {
      o.detail.push(J(
        'アドレスを計算するついでに ' + mem.base.text + ' 自体も進める書き方です。配列を 1 つずつ舐めるループでよく出ます。',
        'The base register is updated as a side effect — typical of a loop walking an array.'));
    }
    o.terms.push('memory', 'address');
    addRegRoles(o, ops);
  };
}
function mn2(x) { return x; }
function cType(size, signed) {
  const t = { 1: 'int8', 2: 'int16', 4: 'int32', 8: 'int64', 16: 'int128' }[size] || 'int' + size * 8;
  return (signed ? '' : 'u') + t;
}

for (const n of ['ldr', 'ldrb', 'ldrh', 'ldrsb', 'ldrsh', 'ldrsw', 'ldur', 'ldurb', 'ldurh', 'ldursb', 'ldursh', 'ldursw', 'ldtr', 'ldar', 'ldarb', 'ldarh', 'ldxr', 'ldaxr']) {
  HANDLERS[n] = loadStore(true);
}
for (const n of ['str', 'strb', 'strh', 'stur', 'sturb', 'sturh', 'sttr', 'stlr', 'stlrb', 'stlrh']) {
  HANDLERS[n] = loadStore(false);
}

/* ldr のリテラル形式（ldr x0, #0x…）は別扱い */
const plainLdr = HANDLERS.ldr;
HANDLERS.ldr = (o, ops, base, addr, c) => {
  if (ops.length === 2 && ops[1].k === 'imm' && ops[1].value != null) {
    const at = ops[1].value;
    o.title = J('近くに置かれた定数を読む', 'Load from a literal pool');
    o.pseudo = opShort(ops[0]) + ' = *(uint64*)0x' + at.toString(16).toUpperCase();
    o.summary = J(
      'この命令の近くに埋め込まれている値（' + tgt(at, c) + ' の場所）を読み込んで ' + opShort(ops[0]) + ' に入れる。',
      'Read the constant stored at ' + tgt(at, c) + ' into ' + opShort(ops[0]) + '.');
    o.detail.push(J(
      '命令には大きな数をそのまま書けないので、コンパイラはコードのすぐ近くに数を置いて、こうして読み出します。' +
      'そこは命令ではなくデータなので、逆アセンブルすると意味不明な行に見えます。',
      'Large constants cannot fit in an instruction, so they are parked next to the code and loaded from there. ' +
      'That area is data, not code, and looks like nonsense when disassembled.'));
    o.target = at;
    o.terms = ['literalpool', 'memory'];
    return;
  }
  plainLdr(o, ops, base, addr, c);
};

function pairLoadStore(isLoad) {
  return (o, ops, base, addr, c) => {
    const [a, b] = ops;
    const mem = ops.find((x) => x.k === 'mem');
    const size = sizeOfReg(a);
    o.title = isLoad ? J('2 本まとめて読む', 'Load a pair') : J('2 本まとめて書く', 'Store a pair');
    if (!mem) return;
    o.pseudo = isLoad
      ? opShort(a) + ', ' + opShort(b) + ' = *(pair*)(' + memExpr(mem) + ')'
      : '*(pair*)(' + memExpr(mem) + ') = ' + opShort(a) + ', ' + opShort(b);
    o.summary = isLoad
      ? J(memText(mem) + 'から ' + sizeWord(size) + ' ずつ 2 個読み、' + opShort(a) + ' と ' + opShort(b) + ' に入れる。',
          'Read two values into ' + opShort(a) + ' and ' + opShort(b) + '.')
      : J(opShort(a) + ' と ' + opShort(b) + ' を、' + memText(mem) + 'から順に 2 個ぶん書き込む。',
          'Write ' + opShort(a) + ' and ' + opShort(b) + ' side by side.');
    o.detail.push(J(
      '2 本を 1 命令で扱えるので、関数の入口と出口でレジスタを退避／復元するときの定番です。',
      'Two registers in one instruction — the standard way to save and restore around a function.'));
    // 典型的なプロローグ / エピローグ
    const isFpLr = a && b && a.k === 'reg' && b.k === 'reg'
      && a.cls === 'gp' && b.cls === 'gp'
      && a.bits === 64 && b.bits === 64
      && a.num === 29 && b.num === 30;
    const onStack = mem.base && mem.base.cls === 'sp';
    const dispObj = mem.disp || mem.writebackDisp;
    const dispVal = dispObj && dispObj.value != null ? dispObj.value : 0n;
    if (onStack && mem.mode === 'pre' && dispVal < 0n && !isLoad) {
      o.title = J('スタックへ積む（push）', 'Push onto the stack');
      o.summary = J(
        'スタックを ' + (-dispVal).toString(10) + ' バイト広げて、その先頭に ' + opShort(a) + ' と ' + opShort(b) + ' を置く。',
        'Grow the stack by ' + (-dispVal) + ' bytes and put ' + opShort(a) + ' and ' + opShort(b) + ' there.');
    } else if (onStack && mem.mode === 'post' && dispVal > 0n && isLoad) {
      o.title = J('スタックから降ろす（pop）', 'Pop from the stack');
      o.summary = J(
        'スタックの先頭から ' + opShort(a) + ' と ' + opShort(b) + ' を取り戻し、スタックを ' + dispVal.toString(10) + ' バイト縮める。',
        'Take ' + opShort(a) + ' and ' + opShort(b) + ' back off the stack and shrink it by ' + dispVal + ' bytes.');
    }
    if (isFpLr && !isLoad) {
      o.title = J('関数の入り口（今の場所を保存）', 'Function prologue');
      o.summary = J(
        '戻り先アドレス (x30) と、呼び出し元のフレーム位置 (x29) をスタックに保存する。関数の始まりの合図です。',
        'Save the return address and the caller’s frame pointer — the start of a function.');
      o.detail.push(J(
        'これをやらないと、別の関数を呼んだ瞬間に「どこへ帰ればいいか」を忘れてしまいます。' +
        '関数の終わりでは ldp で逆に取り出します。',
        'Without this, calling another function would destroy the return address. The epilogue restores it with ldp.'));
      o.terms.push('prologue', 'lr', 'stack');
    } else if (isFpLr && isLoad) {
      o.title = J('関数の出口（元に戻す）', 'Function epilogue');
      o.summary = J(
        'スタックに預けておいた戻り先アドレス (x30) とフレーム位置 (x29) を取り戻す。もうすぐ ret で帰ります。',
        'Restore the saved return address and frame pointer — a ret is coming.');
      o.terms.push('epilogue', 'lr', 'stack');
    } else if (a && a.k === 'reg' && a.cls === 'gp' && a.num >= 19 && a.num <= 28) {
      o.detail.push(isLoad
        ? J('x19〜x28 は「呼ばれた側が元に戻す約束」のレジスタです。ここで戻しています。',
            'x19–x28 are callee-saved; this restores them.')
        : J('x19〜x28 は「呼ばれた側が元に戻す約束」のレジスタなので、使う前に預けています。',
            'x19–x28 are callee-saved, so they are stashed before use.'));
      o.terms.push('calleesaved');
    }
    o.terms.push('stack', 'memory');
  };
}
HANDLERS.stp = pairLoadStore(false);
HANDLERS.stnp = pairLoadStore(false);
HANDLERS.ldp = pairLoadStore(true);
HANDLERS.ldnp = pairLoadStore(true);
HANDLERS.ldpsw = pairLoadStore(true);

HANDLERS.prfm = (o, ops) => {
  const mem = ops.find((x) => x.k === 'mem');
  o.title = J('先に読み込ませておく', 'Prefetch');
  o.pseudo = 'prefetch(' + (mem ? memExpr(mem) : '') + ')';
  o.summary = J(
    'あとで使うデータを、CPU に「そろそろ用意しておいて」と伝える。値は何も変わりません。',
    'Hint to the CPU to fetch this memory early. Nothing changes.');
  o.detail.push(J('速度のためだけの命令なので、動きを読むときは無視して構いません。', 'Purely a performance hint — safe to ignore when reading logic.'));
};

/* アドレス作り ----------------------------------------------- */

HANDLERS.adr = (o, ops, base, addr, c) => {
  const [d, imm] = ops;
  const at = imm && imm.value;
  o.title = J('近くのアドレスを作る', 'Address of nearby');
  o.pseudo = opShort(d) + ' = 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
  o.summary = J(
    opShort(d) + ' に ' + tgt(at, c) + ' というアドレスそのものを入れる（中身は読まない）。',
    'Put the address ' + tgt(at, c) + ' itself into ' + opShort(d) + ' (no memory is read).');
  o.target = at;
  o.terms = ['address', 'pcrelative'];
};

HANDLERS.adrp = (o, ops, base, addr, c) => {
  const [d, imm] = ops;
  const at = imm && imm.value;
  o.title = J('遠くのアドレスの「ページ」を作る', 'Address of a 4 KB page');
  o.pseudo = opShort(d) + ' = 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
  o.summary = J(
    opShort(d) + ' に ' + tgt(at, c) + ' を入れる。これは 4096 バイト単位に切り下げた「おおまかな住所」です。',
    'Put ' + tgt(at, c) + ' — a 4 KB-aligned page address — into ' + opShort(d) + '.');
  o.detail.push(J(
    '4 バイトの命令 1 つでは遠い場所を指せないので、まず adrp でおおまかな位置を作り、' +
    '次の行の add または ldr で細かい位置を足します。この 2 行はセットで 1 つのアドレスだと思ってください。',
    'One 4-byte instruction cannot hold a far address, so adrp gives the page and the next add/ldr adds the offset. ' +
    'Read the two lines as one address.'));
  o.target = at;
  o.terms = ['address', 'adrp', 'pcrelative'];
};

/* 分岐 ------------------------------------------------------- */

HANDLERS.b = (o, ops, base, addr, c) => {
  const at = ops[0] && ops[0].value;
  o.title = J('ジャンプ', 'Branch');
  o.pseudo = 'goto 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
  const dir = at != null && addr != null ? (at < addr ? J('前（上）', 'backwards') : J('後ろ（下）', 'forwards')) : '';
  o.summary = J(
    '無条件で ' + tgt(at, c) + ' へ飛ぶ。ここから下の行は（飛んでこない限り）実行されません。',
    'Jump to ' + tgt(at, c) + ' unconditionally.');
  if (at != null && addr != null && at < addr) {
    // 「飛び先が前にある」だけではループの証拠になりません。自然な逆辺は
    // 飛び先がこの行を支配し、両端が同じ強連結成分にあるときだけです
    // (js/controlflow.js analyzeGraph)。1 行だけを見るこの説明器には
    // その情報がないので、向きだけを事実として述べます (#1293)。
    o.detail.push(J(
      '飛び先が今より前（上）です。ループの終わりのこともありますが、'
      + '前に置かれた別のブロックへ飛ぶだけのこともあります。'
      + 'ループかどうかは、関数全体の流れ（制御フローグラフ）を見ないと決まりません。',
      'The target is earlier (above) than this line. That can be the bottom of a loop, '
      + 'but it can also be a jump into an earlier block. Only the function-wide control-flow '
      + 'graph can tell which.'));
  } else {
    o.detail.push(J(
      '飛び先が今より後ろなので、if 文の「else を飛ばす」ような使い方でしょう。',
      'The target is later — typically skipping over an else block.'));
  }
  o.target = at;
  o.terms.push('branch');
};

HANDLERS.bl = (o, ops, base, addr, c) => {
  const at = ops[0] && ops[0].value;
  const sym = at != null && c && c.symbolFor ? c.symbolFor(at) : null;
  o.title = J('関数を呼ぶ', 'Call a function');
  o.pseudo = (sym ? sym : '0x' + (at != null ? at.toString(16).toUpperCase() : '?')) + '()';
  o.summary = sym
    ? J(sym + ' を呼び出す。終わったらこの次の行に戻ってきます。',
        'Call ' + sym + '; execution returns to the next line.')
    : J(tgt(at, c) + ' にある関数を呼び出す。終わったらこの次の行に戻ってきます。',
        'Call the function at ' + tgt(at, c) + '; execution returns to the next line.');
  o.detail.push(J(
    'bl は「飛ぶ前に、次の行のアドレスを x30 (lr) にメモしてから飛ぶ」命令です。' +
    '呼ばれた側は最後に ret でその x30 へ帰ってきます。これが関数呼び出しの正体です。',
    'bl records the address of the following instruction in x30 (lr) before jumping; the callee returns to it with ret. ' +
    'That is all a function call is.'));
  o.detail.push(J(
    '引数は x0、x1、x2… の順に入れて渡し、戻り値は x0 で受け取ります。' +
    'この行の少し上を見ると、x0 などに値を入れている行があるはずです。それが引数です。',
    'Arguments go in x0, x1, x2 … and the result comes back in x0. Look just above for the lines that set them.'));
  o.target = at;
  o.terms = ['call', 'lr', 'abi'];
};

HANDLERS.blr = (o, ops) => {
  const r = ops[0];
  o.title = J('レジスタの指す関数を呼ぶ', 'Call through a register');
  o.pseudo = '(*' + opShort(r) + ')()';
  o.summary = J(
    opShort(r) + ' に入っているアドレスの関数を呼ぶ。どこへ行くかは実行してみないと分かりません。',
    'Call whatever address is in ' + opShort(r) + '. The target is only known at run time.');
  o.detail.push(J(
    '関数ポインタ、Objective-C のメソッド呼び出し、仮想関数などがこの形になります。' +
    '「どの関数か」を知るには、少し上で ' + opShort(r) + ' に何を入れているかを追いかけます。',
    'Function pointers, Objective-C message sends and C++ virtual calls all look like this. Trace what fills ' + opShort(r) + '.'));
  o.terms = ['call', 'indirect'];
};

HANDLERS.br = (o, ops) => {
  const r = ops[0];
  o.title = J('レジスタの指す先へ飛ぶ', 'Jump through a register');
  o.pseudo = 'goto *' + opShort(r);
  o.summary = J(
    opShort(r) + ' の中のアドレスへ飛ぶ。戻ってきません。',
    'Jump to the address in ' + opShort(r) + ' and do not come back.');
  o.detail.push(J(
    'switch 文の飛び先表や、ライブラリ関数への中継（スタブ）でよく出ます。',
    'Common in switch jump tables and in stubs that forward to library functions.'));
  o.terms = ['indirect'];
};

HANDLERS.ret = (o, ops) => {
  const r = ops && ops[0] && ops[0].k === 'reg' ? ops[0].text : 'x30';
  o.title = J('関数から帰る', 'Return');
  o.pseudo = 'return';
  o.summary = J(
    r + (r === 'x30' ? ' (lr)' : '') + ' に入っている「戻り先アドレス」へジャンプして、呼び出し元に帰る。ここでこの関数は終わりです。',
    'Jump to the return address held in ' + r + '. This is the end of the function.');
  o.detail.push(J(
    '戻り値があるなら x0（32 ビットなら w0）に入っています。この行の少し上で x0 に何を入れたかを見てください。',
    'A return value, if any, is already in x0 / w0 — look at the lines just above.'));
  o.terms = ['lr', 'abi', 'epilogue'];
};
HANDLERS.retaa = HANDLERS.ret;
HANDLERS.retab = HANDLERS.ret;

function condBranch(o, ops, base, addr, c) {
  const cond = base.slice(2);
  const ci = condInfo(cond);
  const at = ops[0] && ops[0].value;
  o.title = J('条件つきジャンプ', 'Conditional branch');
  o.pseudo = 'if (' + (ci ? ci.expr : cond) + ') goto 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
  o.summary = J(
    '直前の比較（cmp / tst など）が「' + (ci ? ci.ja : cond) + '」なら ' + tgt(at, c) + ' へ飛ぶ。違えばそのまま次の行へ進む。',
    'If the previous compare was ' + (ci ? ci.en : cond) + ', jump to ' + tgt(at, c) + '; otherwise fall through.');
  o.detail.push(J(
    'これが if 文の正体です。「飛ぶ」「飛ばない」の 2 択で、飛ばなかった場合はすぐ下の行が実行されます。',
    'This is what an if statement becomes: take the jump, or fall through to the next line.'));
  if (at != null && addr != null && at < addr) {
    // 逆向きの条件分岐も、それだけではループの証明になりません (#1293)。
    o.detail.push(J('飛び先が今より前（上）です。while / for の底であることも多いですが、'
      + 'ループかどうかは関数全体の流れ（制御フローグラフ）を見て決まります。',
      'The target is earlier (above). This is often the bottom of a while/for loop, but only the '
      + 'function-wide control-flow graph proves it.'));
  }
  o.target = at;
  o.terms.push('branch', 'flags');
}

function cbzHandler(zero) {
  return (o, ops, base, addr, c) => {
    const [r, immOp] = ops;
    const at = immOp && immOp.value;
    o.title = zero ? J('0 なら飛ぶ', 'Branch if zero') : J('0 でなければ飛ぶ', 'Branch if not zero');
    o.pseudo = 'if (' + opShort(r) + (zero ? ' == 0' : ' != 0') + ') goto 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
    o.summary = J(
      opShort(r) + ' が ' + (zero ? '0 なら' : '0 以外なら') + ' ' + tgt(at, c) + ' へ飛ぶ。違えば次の行へ。',
      'Jump to ' + tgt(at, c) + ' when ' + opShort(r) + (zero ? ' is zero' : ' is not zero') + '.');
    o.detail.push(J(
      'cmp を書かずに、レジスタが 0 かどうかだけをその場で見る短縮形です。' +
      'C 言語の if (p == NULL) や if (n) がよくこの形になります。',
      'A shortcut that tests for zero without a separate compare — “if (p == NULL)” and “if (n)” compile to this.'));
    // cbz/cbnz も、アドレスの前後関係だけでループと断定しません (#1293)。
    o.target = at;
    o.terms.push('branch');
  };
}
HANDLERS.cbz = cbzHandler(true);
HANDLERS.cbnz = cbzHandler(false);

function tbzHandler(zero) {
  return (o, ops, base, addr, c) => {
    const [r, bit, immOp] = ops;
    const at = immOp && immOp.value;
    const n = bit && bit.value != null ? bit.value.toString(10) : '?';
    const nth = bit && bit.value != null ? '（一番下を 0 として数えて ' + (bit.value + 1n).toString(10) + ' 個目）' : '';
    o.title = zero ? J('そのビットが 0 なら飛ぶ', 'Branch if bit clear') : J('そのビットが 1 なら飛ぶ', 'Branch if bit set');
    o.pseudo = 'if ((' + opShort(r) + ' >> ' + n + ' & 1)' + (zero ? ' == 0' : ' == 1') + ') goto 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
    o.summary = J(
      opShort(r) + ' のビット ' + n + nth + ' が ' + (zero ? '0' : '1') + ' なら ' + tgt(at, c) + ' へ飛ぶ。',
      'Jump when bit ' + n + ' of ' + opShort(r) + ' is ' + (zero ? 'clear' : 'set') + '.');
    if (bit && bit.value != null && (bit.value === 63n || bit.value === 31n)) {
      o.detail.push(J(
        '一番上のビットは符号ビットなので、これは実質「マイナスかどうか」の判定です。',
        'The top bit is the sign bit, so this is really a “is it negative?” test.'));
    }
    o.detail.push(J('フラグ（設定のオンオフ）を 1 ビットずつ詰めた値の判定でよく出ます。',
      'Common when several boolean flags are packed into one value.'));
    o.target = at;
    o.terms.push('branch', 'bitwise');
  };
}
HANDLERS.tbz = tbzHandler(true);
HANDLERS.tbnz = tbzHandler(false);

/* システム --------------------------------------------------- */

HANDLERS.nop = (o) => {
  o.title = J('何もしない', 'No operation');
  o.pseudo = '/* 何もしない */';
  o.summary = J(
    '文字どおり何もしません。位置合わせや、後で書き換えるための場所取りに使われます。',
    'Does nothing. Used for alignment or as a placeholder to patch later.');
};

HANDLERS.svc = (o, ops) => {
  o.title = J('OS に仕事を頼む', 'System call');
  o.pseudo = 'syscall()';
  o.summary = J(
    'CPU から OS（カーネル）へ切り替えて、ファイルを開くなどの処理を頼む。',
    'Switch to the kernel and ask the OS to do something — open a file, and so on.');
  o.detail.push(J(
    'アプリが自分だけでできない仕事（ファイル、ネットワーク、画面）は、必ずここを通って OS に頼みます。' +
    'どの仕事を頼むかは x16 に入っている番号で決まります。',
    'Anything an app cannot do alone goes through here; the request number is in x16.'));
  o.terms = ['syscall'];
};

HANDLERS.brk = (o) => {
  o.title = J('わざと止める', 'Breakpoint / trap');
  o.pseudo = 'trap()';
  o.summary = J(
    'その場でプログラムを停止させます。デバッガ用、または「ここには来ないはず」という保険です。',
    'Halts the program — used by debuggers, or as an “unreachable” guard.');
  o.detail.push(J(
    'Swift の配列範囲外アクセスや、整数のあふれ検出で、この命令に飛ばされてクラッシュします。',
    'Swift traps such as array-out-of-bounds land here.'));
};
HANDLERS.udf = (o) => {
  o.title = J('永久に未定義の命令', 'Permanently undefined instruction');
  o.pseudo = 'undefined_instruction_exception()';
  o.summary = J(
    'この命令は永久に未定義です。実行すると未定義命令例外になり、通常の命令実行は続きません。',
    'This instruction is permanently undefined. Executing it raises an Undefined Instruction exception; normal instruction execution does not continue.');
  o.detail.push(J(
    '命令に埋め込まれた #imm16 は、未定義命令のエンコードに含まれる印で、動作を選ぶ値ではありません。これは BRK のデバッガ用ブレークポイントではありません。',
    'The #imm16 field is part of the undefined-instruction encoding, not an operation selector. This is not a debugger breakpoint like BRK.'));
  o.terms = ['immediate'];
};

HANDLERS.bti = (o) => {
  o.title = J('ここへの飛び込みを許可する目印', 'Branch target marker');
  o.pseudo = '/* 飛び込み可 */';
  o.summary = J(
    '「ここは正規のジャンプ先です」という目印。攻撃者が変な場所へ飛ぶのを防ぐ仕組みです。',
    'Marks a legitimate branch target, so an attacker cannot jump into the middle of code.');
  o.terms = ['security'];
};

// HINT is an immediate-selected architectural hint space.  Only the finite
// aliases below are given a specific presentation; an unknown or malformed
// immediate must not be promoted to BTI merely because it uses the HINT
// mnemonic.
const GENERIC_HINT_INFO = new Map([
  [0, {
    titleJa: 'NOP ヒント', titleEn: 'NOP hint',
    summaryJa: 'HINT #0 は何もしない NOP です。BTI の目印ではありません。',
    summaryEn: 'HINT #0 is the NOP hint; it does not mark a branch target.',
    terms: [],
  }],
  [1, {
    titleJa: '実行時間を譲るヒント', titleEn: 'Yield hint',
    summaryJa: 'HINT #1 (YIELD) は、ほかの処理に実行時間を譲るヒントです。BTI ではありません。',
    summaryEn: 'HINT #1 (YIELD) lets another thread or processor run; it is not BTI.',
    terms: ['thread'],
  }],
  [2, {
    titleJa: 'イベント待ち', titleEn: 'Wait for event hint',
    summaryJa: 'HINT #2 (WFE) はイベントが来るまで待つヒントです。',
    summaryEn: 'HINT #2 (WFE) waits for an event.',
    terms: ['thread'],
  }],
  [3, {
    titleJa: '割り込み待ち', titleEn: 'Wait for interrupt hint',
    summaryJa: 'HINT #3 (WFI) は割り込みが来るまで待つヒントです。',
    summaryEn: 'HINT #3 (WFI) waits for an interrupt.',
    terms: [],
  }],
  [4, {
    titleJa: 'イベントを送るヒント', titleEn: 'Send event hint',
    summaryJa: 'HINT #4 (SEV) はシステム全体へイベントを送るヒントです。',
    summaryEn: 'HINT #4 (SEV) sends an event to the system.',
    terms: ['thread'],
  }],
  [5, {
    titleJa: 'ローカルイベントを送るヒント', titleEn: 'Send local event hint',
    summaryJa: 'HINT #5 (SEVL) は現在のプロセッサへイベントを送るヒントです。',
    summaryEn: 'HINT #5 (SEVL) sends a local event on the current processor.',
    terms: [],
  }],
  [16, {
    titleJa: 'エラー同期ヒント', titleEn: 'Error synchronization hint',
    summaryJa: 'HINT #16 (ESB) はエラー同期のためのヒントです。',
    summaryEn: 'HINT #16 (ESB) is an error-synchronization hint.',
    terms: [],
  }],
  [20, {
    titleJa: '投機実行を制約するヒント', titleEn: 'Speculation constraint hint',
    summaryJa: 'HINT #20 (CSDB) は投機的なデータ利用を制約するヒントです。',
    summaryEn: 'HINT #20 (CSDB) constrains speculative data use.',
    terms: ['security'],
  }],
]);

const BTI_HINT_NAMES = new Map([
  [32, 'BTI'],
  [34, 'BTI c'],
  [36, 'BTI j'],
  [38, 'BTI jc'],
]);

function hintOperandText(ops) {
  if (!Array.isArray(ops)) return '';
  return ops.map((op) => typeof op?.text === 'string' ? op.text.trim() : opShort(op)).join(', ');
}

function hintImmediate(ops) {
  if (!Array.isArray(ops) || ops.length !== 1) return null;
  const operand = ops[0];
  // parseOperands folds a trailing shift/extend token into the preceding
  // operand.  HINT's selector is a plain imm7; treating that decorated shape
  // as the selector would turn malformed text such as "#32, lsl #1" into BTI.
  if (operand?.k !== 'imm' || typeof operand.value !== 'bigint' || operand.shift) return null;
  if (operand.value < 0n || operand.value > 0x7fn) return null;
  return Number(operand.value);
}

HANDLERS.hint = (o, ops) => {
  const raw = hintOperandText(ops);
  const display = raw || '<immediate unavailable>';
  const immediate = hintImmediate(ops);
  const btiName = immediate == null ? null : BTI_HINT_NAMES.get(immediate);
  o.pseudo = 'hint(' + raw + ')';

  if (btiName) {
    o.title = J('分岐先を示す目印（' + btiName + '）', 'Branch target marker (' + btiName + ')');
    o.summary = J(
      'HINT #' + immediate + ' は ' + btiName + ' のエンコーディングで、正規の分岐先を示す目印です。',
      'HINT #' + immediate + ' is the ' + btiName + ' encoding, marking a legitimate branch target.');
    o.terms = ['security'];
    return;
  }

  const known = immediate == null ? null : GENERIC_HINT_INFO.get(immediate);
  if (known) {
    o.title = J(known.titleJa, known.titleEn);
    o.summary = J(known.summaryJa, known.summaryEn);
    o.terms = known.terms.slice();
    return;
  }

  o.title = J('アーキテクチャのヒント', 'Architectural hint');
  o.summary = J(
    'HINT ' + display + ' はアーキテクチャのヒントです。具体的な割り当ては解釈せず、BTI と決めつけません。',
    'HINT ' + display + ' is an architectural hint; its allocation is not interpreted here, so it is not assumed to be BTI.');
  o.detail.push(J(
    'HINT の即値には複数の割り当てと未割り当て値があります。即値が解釈できないときは、特定の動作を断定しません。',
    'The HINT immediate has multiple allocated meanings and unallocated values; when it is not interpreted here, no specific behavior is asserted.'));
  o.terms = ['immediate'];
};

for (const n of ['paciasp', 'pacibsp']) {
  HANDLERS[n] = (o) => {
    o.title = J('戻り先アドレスに封をする', 'Sign the return address');
    o.pseudo = 'lr = sign(lr, sp)';
    o.summary = J('戻り先アドレス (x30) を SP を使って署名し、書き換えを検出できるようにする。', 'Sign the return address in x30 using SP as the modifier.');
    o.terms = ['pac', 'security', 'lr'];
  };
}
for (const n of ['pacia', 'pacib', 'pacda', 'pacdb']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]); const modifier = opShort(ops[1]);
    o.title = J('ポインタに認証コードを付ける', 'Sign a pointer');
    o.pseudo = destination + ' = sign(' + destination + ', ' + modifier + ')';
    o.summary = J(destination + ' のポインタを ' + modifier + ' を修飾値として署名し、結果を同じレジスタへ戻す。', 'Sign the pointer in ' + destination + ' using ' + modifier + ' as the modifier, writing the result back.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['paciza', 'pacizb', 'pacdza', 'pacdzb']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]);
    o.title = J('ゼロ修飾値でポインタに封をする', 'Sign a pointer with zero modifier');
    o.pseudo = destination + ' = sign(' + destination + ', 0)';
    o.summary = J(destination + ' のポインタを修飾値 0 で署名し、結果を同じレジスタへ戻す。', 'Sign the pointer in ' + destination + ' with a zero modifier and write it back.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['pacia1716', 'pacib1716']) {
  HANDLERS[n] = (o) => {
    o.title = J('x17 のポインタに封をする', 'Sign the pointer in x17');
    o.pseudo = 'x17 = sign(x17, x16)';
    o.summary = J('x17 のポインタを x16 を修飾値として署名する。', 'Sign the pointer in x17 using x16 as the modifier.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['paciaz', 'pacibz']) {
  HANDLERS[n] = (o) => {
    o.title = J('戻り先アドレスにゼロ修飾値で封をする', 'Sign the return address with zero modifier');
    o.pseudo = 'lr = sign(lr, 0)';
    o.summary = J('戻り先アドレス (x30) を修飾値 0 で署名し、書き換えを検出できるようにする。', 'Sign the return address in x30 with a zero modifier.');
    o.terms = ['pac', 'security', 'lr'];
  };
}
for (const n of ['autiasp', 'autibsp']) {
  HANDLERS[n] = (o) => {
    o.title = J('戻り先アドレスの封を確かめる', 'Authenticate the return address');
    o.pseudo = 'lr = authenticate(lr, sp)';
    o.summary = J('SP を修飾値として戻り先アドレス (x30) の署名を検証する。', 'Authenticate the return address in x30 using SP as the modifier.');
    o.terms = ['pac', 'security', 'lr'];
  };
}
for (const n of ['autia', 'autib', 'autda', 'autdb']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]); const modifier = opShort(ops[1]);
    o.title = J('ポインタの署名を確かめる', 'Authenticate a pointer');
    o.pseudo = destination + ' = authenticate(' + destination + ', ' + modifier + ')';
    o.summary = J(destination + ' のポインタを ' + modifier + ' を修飾値として認証し、結果を同じレジスタへ戻す。', 'Authenticate the pointer in ' + destination + ' using ' + modifier + ' as the modifier, writing the result back.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['autiza', 'autizb', 'autdza', 'autdzb']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]);
    o.title = J('ゼロ修飾値でポインタを認証する', 'Authenticate a pointer with zero modifier');
    o.pseudo = destination + ' = authenticate(' + destination + ', 0)';
    o.summary = J(destination + ' のポインタを修飾値 0 で認証し、結果を同じレジスタへ戻す。', 'Authenticate the pointer in ' + destination + ' with a zero modifier and write it back.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['autia1716', 'autib1716']) {
  HANDLERS[n] = (o) => {
    o.title = J('x17 のポインタの封を確かめる', 'Authenticate the pointer in x17');
    o.pseudo = 'x17 = authenticate(x17, x16)';
    o.summary = J('x17 のポインタを x16 を修飾値として認証する。', 'Authenticate the pointer in x17 using x16 as the modifier.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['autiaz', 'autibz']) {
  HANDLERS[n] = (o) => {
    o.title = J('戻り先アドレスの封をゼロ修飾値で確かめる', 'Authenticate the return address with zero modifier');
    o.pseudo = 'lr = authenticate(lr, 0)';
    o.summary = J('修飾値 0 で戻り先アドレス (x30) の署名を検証する。', 'Authenticate the return address in x30 with a zero modifier.');
    o.terms = ['pac', 'security', 'lr'];
  };
}
for (const n of ['xpaci', 'xpacd']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]);
    o.title = J('ポインタ認証コードを取り除く', 'Strip pointer authentication code');
    o.pseudo = destination + ' = strip_pac(' + destination + ')';
    o.summary = J(destination + ' からポインタ認証コードを取り除く。', 'Strip the pointer authentication code from ' + destination + '.');
    o.terms = ['pac', 'security'];
  };
}
HANDLERS.xpaclri = (o) => {
  o.title = J('戻り先アドレスの認証コードを取り除く', 'Strip the return-address authentication code');
  o.pseudo = 'lr = strip_pac(lr)';
  o.summary = J('x30 (LR) からポインタ認証コードを取り除く。', 'Strip the pointer authentication code from x30 (LR).');
  o.terms = ['pac', 'security', 'lr'];
};
HANDLERS.pacga = (o, ops) => {
  const destination = opShort(ops[0]); const source = opShort(ops[1]); const modifier = opShort(ops[2]);
  o.title = J('汎用ポインタ認証コードを作る', 'Generate a generic pointer authentication code');
  o.pseudo = destination + ' = pacga(' + source + ', ' + modifier + ')';
  o.summary = J(source + ' と ' + modifier + ' から汎用認証コードを作り、' + destination + ' に入れる。', 'Generate a generic authentication code from ' + source + ' and ' + modifier + ', storing it in ' + destination + '.');
  o.terms = ['pac', 'security'];
};

const DATA_BARRIER_OPTION_INFO = Object.freeze({
  sy: Object.freeze({ ja: 'sy（システム全体の読み書き）', en: 'sy (full-system loads/stores)' }),
  st: Object.freeze({ ja: 'st（システム全体のストア）', en: 'st (full-system stores)' }),
  ld: Object.freeze({ ja: 'ld（システム全体のロード）', en: 'ld (full-system loads)' }),
  ish: Object.freeze({ ja: 'ish（Inner Shareable の読み書き）', en: 'ish (inner-shareable loads/stores)' }),
  ishst: Object.freeze({ ja: 'ishst（Inner Shareable のストア）', en: 'ishst (inner-shareable stores)' }),
  ishld: Object.freeze({ ja: 'ishld（Inner Shareable のロード）', en: 'ishld (inner-shareable loads)' }),
  nsh: Object.freeze({ ja: 'nsh（Non-shareable の読み書き）', en: 'nsh (non-shareable loads/stores)' }),
  nshst: Object.freeze({ ja: 'nshst（Non-shareable のストア）', en: 'nshst (non-shareable stores)' }),
  nshld: Object.freeze({ ja: 'nshld（Non-shareable のロード）', en: 'nshld (non-shareable loads)' }),
  osh: Object.freeze({ ja: 'osh（Outer Shareable の読み書き）', en: 'osh (outer-shareable loads/stores)' }),
  oshst: Object.freeze({ ja: 'oshst（Outer Shareable のストア）', en: 'oshst (outer-shareable stores)' }),
  oshld: Object.freeze({ ja: 'oshld（Outer Shareable のロード）', en: 'oshld (outer-shareable loads)' }),
});

const DSB_OPTION_INFO = Object.freeze({
  ...DATA_BARRIER_OPTION_INFO,
  ssbb: Object.freeze({ kind: 'speculation', ja: 'ssbb（ストアバイパス投機の抑制）', en: 'ssbb (store-bypass speculation barrier)' }),
  pssbb: Object.freeze({ kind: 'speculation', ja: 'pssbb（特権ストアバイパス投機の抑制）', en: 'pssbb (privileged store-bypass speculation barrier)' }),
  oshnxs: Object.freeze({ ja: 'oshnxs（Outer Shareable の nXS アクセス）', en: 'oshnxs (outer-shareable nXS accesses)' }),
  nshnxs: Object.freeze({ ja: 'nshnxs（Non-shareable の nXS アクセス）', en: 'nshnxs (non-shareable nXS accesses)' }),
  ishnxs: Object.freeze({ ja: 'ishnxs（Inner Shareable の nXS アクセス）', en: 'ishnxs (inner-shareable nXS accesses)' }),
  synxs: Object.freeze({ ja: 'synxs（システム全体の nXS アクセス）', en: 'synxs (full-system nXS accesses)' }),
});

const BARRIER_OPTION_INFO = Object.freeze({
  dmb: DATA_BARRIER_OPTION_INFO,
  dsb: DSB_OPTION_INFO,
  isb: Object.freeze({
    sy: Object.freeze({ ja: 'sy（命令同期の指定）', en: 'sy (instruction-synchronization option)' }),
  }),
});

function barrierOptionInfo(mnemonic, ops) {
  const operands = Array.isArray(ops) ? ops : [];
  if (operands.length === 0) {
    return {
      raw: '',
      known: true,
      defaulted: true,
      kind: 'data',
      ja: 'オプション省略（AArch64 の既定値 sy）',
      en: 'option omitted (AArch64 architectural default: sy)',
    };
  }
  const raw = operands.map((operand) => typeof operand?.text === 'string' ? operand.text.trim() : '').join(', ');
  const optionTable = BARRIER_OPTION_INFO[mnemonic];
  const optionKey = raw.toLowerCase();
  const descriptor = operands.length === 1 && optionTable &&
    Object.prototype.hasOwnProperty.call(optionTable, optionKey)
    ? optionTable[optionKey]
    : null;
  if (descriptor) {
    return {
      raw,
      known: true,
      defaulted: false,
      kind: descriptor.kind || 'data',
      ja: 'オプション ' + descriptor.ja,
      en: 'option ' + descriptor.en,
    };
  }
  const display = raw || '<unparsed>';
  return {
    raw: display,
    known: false,
    defaulted: false,
    kind: 'unknown',
    ja: 'オプション ' + display + ' は未解釈（範囲・種別は不明）',
    en: 'option ' + display + ' is not interpreted (scope/type unknown)',
  };
}

for (const mnemonic of ['dmb', 'dsb', 'isb']) {
  HANDLERS[mnemonic] = (o, ops) => {
    const option = barrierOptionInfo(mnemonic, ops);
    const optionNote = J(option.ja, option.en);
    const pseudo = mnemonic + '(' + option.raw + ')';
    o.pseudo = pseudo;

    if (mnemonic === 'dmb') {
      o.title = J('データメモリアクセスの順序付けバリア', 'Data memory ordering barrier');
      o.summary = J(
        'DMB はデータメモリアクセスの順序をこの地点の前後で保つ。アクセスの完了を待つ命令ではない。' + optionNote + '。',
        'DMB orders data-memory accesses across this point; it does not wait for those accesses to complete. ' + optionNote + '.');
      o.detail.push(J(
        'DMB は指定されたデータアクセスを順序付けする。DSB のような完了待ちや、ISB のような命令取得の同期は行わない。' + optionNote + '。',
        'DMB orders the selected data accesses; unlike DSB it does not add completion/wait semantics, and unlike ISB it does not synchronize instruction fetch. ' + optionNote + '.'));
      o.terms = ['thread'];
      return;
    }

    if (mnemonic === 'dsb' && option.kind === 'speculation') {
      o.title = J('ストアバイパス投機を抑える同期バリア', 'Store-bypass speculation barrier');
      o.summary = J(
        'DSB の ' + option.raw + ' はストアバイパス投機を抑える特殊な指定で、通常のデータアクセス範囲や完了待ちとしては解釈しない。' + optionNote + '。',
        'DSB ' + option.raw + ' is a specialized store-bypass speculation barrier; its data-access scope and completion behavior are not interpreted here. ' + optionNote + '.');
      o.detail.push(J(
        'この特殊な指定は通常の DSB のデータアクセス範囲と同じものとして扱わない。' + optionNote + '。',
        'Do not treat this specialized option as the ordinary DSB data-access scope. ' + optionNote + '.'));
      o.terms = [];
      return;
    }

    if (mnemonic === 'dsb') {
      o.title = J('データ同期バリア', 'Data synchronization barrier');
      o.summary = J(
        'DSB はデータメモリアクセスの順序を保ち、対象アクセスの完了を待ってから後続命令を進める。' + optionNote + '。',
        'DSB orders data-memory accesses and waits for covered accesses to complete before later instructions proceed. ' + optionNote + '.');
      o.detail.push(J(
        'DSB は DMB の順序付けに加えて、指定されたアクセスなどの完了を待つ。ISB のような命令取得の同期ではない。' + optionNote + '。',
        'DSB adds completion/wait semantics to DMB-style ordering for the selected accesses; it is not ISB instruction-fetch synchronization. ' + optionNote + '.'));
      o.terms = ['thread'];
      return;
    }

    o.title = J('命令ストリーム同期バリア', 'Instruction synchronization barrier');
    o.summary = J(
      'ISB は前のコンテキスト変更の効果を後続命令の取得・実行に反映させるため、命令ストリームを同期する。データメモリアクセスの順序付けを行う命令ではない。' + optionNote + '。',
      'ISB synchronizes the instruction stream so later instruction fetch and execution observe earlier context-changing operations; it is not a data-memory ordering barrier. ' + optionNote + '.');
    o.detail.push(J(
      'ISB はシステムレジスタ更新などの後で、後続命令を新しい実行コンテキストから取得・実行する境界を作る。スレッド間のデータ順序付けとして説明しない。' + optionNote + '。',
      'ISB synchronizes instruction fetch and execution after a context-changing operation such as a system-register update; it is not thread data-memory ordering. ' + optionNote + '.'));
    o.terms = [];
  };
}
HANDLERS.mrs = (o, ops) => {
  o.title = J('CPU の特別なレジスタを読む', 'Read a system register');
  o.pseudo = opShort(ops[0]) + ' = ' + (ops[1] ? ops[1].text : '');
  o.summary = J(
    'CPU 内部の特別な値（スレッド固有の領域、時刻など）を読み出して ' + opShort(ops[0]) + ' に入れる。',
    'Read a special CPU register into ' + opShort(ops[0]) + '.');
};
HANDLERS.msr = (o, ops) => {
  o.title = J('CPU の特別なレジスタに書く', 'Write a system register');
  o.pseudo = (ops[0] ? ops[0].text : '') + ' = ' + opShort(ops[1]);
  o.summary = J('CPU 内部の特別な設定を書き換える。', 'Write a special CPU register.');
};

/* 小数 ------------------------------------------------------- */

HANDLERS.fmov = (o, ops) => {
  const [d, s] = ops;
  o.title = J('小数レジスタへの代入', 'Move (floating point)');
  o.pseudo = opShort(d) + ' = ' + opShort(s);
  o.summary = J(
    opShort(s) + ' を ' + opShort(d) + ' へそのままコピーする（値の形は変えない）。',
    'Copy the bits from ' + opShort(s) + ' to ' + opShort(d) + ' unchanged.');
  o.detail.push(J(
    'd0〜d31 や s0〜s31 は、小数（浮動小数点数）専用のレジスタです。x0 などとは別に用意されています。',
    'd0–d31 and s0–s31 are separate registers used for floating-point values.'));
  o.terms = ['float'];
};
function fbin(sym, ja, en) {
  return (o, ops) => {
    const [d, n, m] = ops;
    o.title = J('小数の' + ja, en);
    o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ' + sym + ' ' + opShort(m);
    o.summary = J(
      opShort(n) + ' と ' + opShort(m) + ' を小数として' + ja + '、' + opShort(d) + ' に入れる。',
      en + ' as floating point.');
    o.terms = ['float'];
  };
}
HANDLERS.fadd = fbin('+', '足し算', 'Float add');
HANDLERS.fsub = fbin('−', '引き算', 'Float subtract');
HANDLERS.fmul = fbin('×', '掛け算', 'Float multiply');
HANDLERS.fdiv = fbin('÷', '割り算', 'Float divide');
HANDLERS.fcmp = (o, ops) => {
  const [n, m] = ops;
  o.title = J('小数を比べる', 'Float compare');
  o.pseudo = 'flags = ' + opShort(n) + ' ⋛ ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' を小数として比べ、結果をフラグに残す。',
    'Compare two floating-point values, updating the flags.');
  o.terms = ['float', 'flags'];
};
const FCVT_FLOAT_TO_INTEGER_INFO = Object.freeze({
  fcvtzs: Object.freeze({
    signed: true,
    functionName: 'round_toward_zero',
    roundingJa: '0 方向（切り捨て）',
    roundingEn: 'toward zero (truncate)',
    exampleJa: '1.9 → 1、−1.9 → −1',
    exampleEn: '1.9 → 1, −1.9 → −1',
  }),
  fcvtzu: Object.freeze({
    signed: false,
    functionName: 'round_toward_zero',
    roundingJa: '0 方向（切り捨て）',
    roundingEn: 'toward zero (truncate)',
    exampleJa: '1.9 → 1',
    exampleEn: '1.9 → 1',
  }),
  fcvtas: Object.freeze({
    signed: true,
    functionName: 'round_nearest_ties_away',
    roundingJa: '最近接、ちょうど中間は 0 から遠い方',
    roundingEn: 'nearest, ties away from zero',
    exampleJa: '1.5 → 2、−1.5 → −2',
    exampleEn: '1.5 → 2, −1.5 → −2',
  }),
  fcvtau: Object.freeze({
    signed: false,
    functionName: 'round_nearest_ties_away',
    roundingJa: '最近接、ちょうど中間は 0 から遠い方',
    roundingEn: 'nearest, ties away from zero',
    exampleJa: '1.5 → 2',
    exampleEn: '1.5 → 2',
  }),
  fcvtms: Object.freeze({
    signed: true,
    functionName: 'round_toward_minus_infinity',
    roundingJa: '−∞ 方向',
    roundingEn: 'toward -infinity (toward minus infinity)',
    exampleJa: '1.9 → 1、−1.1 → −2',
    exampleEn: '1.9 → 1, −1.1 → −2',
  }),
  fcvtmu: Object.freeze({
    signed: false,
    functionName: 'round_toward_minus_infinity',
    roundingJa: '−∞ 方向',
    roundingEn: 'toward -infinity (toward minus infinity)',
    exampleJa: '1.9 → 1',
    exampleEn: '1.9 → 1',
  }),
  fcvtns: Object.freeze({
    signed: true,
    functionName: 'round_nearest_ties_even',
    roundingJa: '最近接、ちょうど中間は偶数',
    roundingEn: 'nearest, ties to even',
    exampleJa: '1.5 → 2、2.5 → 2',
    exampleEn: '1.5 → 2, 2.5 → 2',
  }),
  fcvtnu: Object.freeze({
    signed: false,
    functionName: 'round_nearest_ties_even',
    roundingJa: '最近接、ちょうど中間は偶数',
    roundingEn: 'nearest, ties to even',
    exampleJa: '1.5 → 2、2.5 → 2',
    exampleEn: '1.5 → 2, 2.5 → 2',
  }),
  fcvtps: Object.freeze({
    signed: true,
    functionName: 'round_toward_plus_infinity',
    roundingJa: '+∞ 方向',
    roundingEn: 'toward +infinity (toward plus infinity)',
    exampleJa: '1.1 → 2、−1.9 → −1',
    exampleEn: '1.1 → 2, −1.9 → −1',
  }),
  fcvtpu: Object.freeze({
    signed: false,
    functionName: 'round_toward_plus_infinity',
    roundingJa: '+∞ 方向',
    roundingEn: 'toward +infinity (toward plus infinity)',
    exampleJa: '1.1 → 2',
    exampleEn: '1.1 → 2',
  }),
});

function scalarFcvtFloatToIntegerInfo(ops) {
  if (!Array.isArray(ops) || ops.length !== 2) return null;
  const [destination, source] = ops;
  const destinationIsGp = destination?.k === 'reg' &&
    (destination.cls === 'gp' || destination.cls === 'zr');
  const sourceIsScalarFloat = source?.k === 'reg' && source.cls === 'fp' &&
    /^[sd]\d+$/i.test(source.text || '');
  if (!destinationIsGp || ![32, 64].includes(destination.bits) || destination.shift ||
      !sourceIsScalarFloat || ![32, 64].includes(source.bits) || source.shift) {
    return null;
  }
  return { destination, source };
}

function unknownFcvtFloatToInteger(o, mnemonic) {
  const displayMnemonic = o.mnemonic || mnemonic;
  o.title = J('小数→整数（未解釈）', 'Unknown float-to-integer form');
  o.pseudo = o.operands ? displayMnemonic + ' ' + o.operands : displayMnemonic;
  o.summary = J(
    displayMnemonic.toUpperCase() + ' のこのオペランド形は解釈できません。無効または未対応の入力では、丸め方・符号・幅を推測しません。',
    'This ' + displayMnemonic.toUpperCase() + ' operand form is unknown; invalid or unsupported inputs do not guess rounding, signedness, or width.');
  o.detail.push(J(
    '説明できるのは、スカラーの W/X 宛先と S/D 浮動小数点ソースを 2 個だけ使う形です。固定小数点の #fbits、SIMD レーン、余分なオペランドは解釈しません。',
    'Only the two-operand scalar form with a W/X destination and S/D floating-point source is explained. Fixed-point #fbits, SIMD lanes, and extra operands are not interpreted.'));
  o.terms = [];
}

function fcvtFloatToIntegerHandler(mnemonic) {
  return (o, ops) => {
    const info = FCVT_FLOAT_TO_INTEGER_INFO[mnemonic];
    const shape = scalarFcvtFloatToIntegerInfo(ops);
    if (!info || !shape) {
      unknownFcvtFloatToInteger(o, mnemonic);
      return;
    }
    const { destination, source } = shape;
    const destinationText = opShort(destination);
    const sourceText = opShort(source);
    const destinationType = (info.signed ? 'int' : 'uint') + destination.bits + '_t';
    const sourcePrecisionJa = source.bits === 64 ? '倍精度' : '単精度';
    const sourcePrecisionEn = source.bits === 64 ? 'double-precision' : 'single-precision';
    const signedJa = info.signed ? '符号付き' : '符号なし';
    const signedEn = info.signed ? 'signed' : 'unsigned';
    const integerArticleEn = info.signed ? 'a' : 'an';
    const roundingClauseEn = info.roundingEn.startsWith('nearest')
      ? 'to the nearest integer (' + info.roundingEn + ')'
      : info.roundingEn;

    o.title = J(
      '小数を' + signedJa + '整数にする（' + info.roundingJa + '）',
      'Float to ' + signedEn + ' integer (' + info.roundingEn + ')');
    o.pseudo = destinationText + ' = (' + destinationType + ')' + info.functionName + '(' + sourceText + ')';
    o.summary = J(
      sourceText + ' の' + sourcePrecisionJa + '（' + source.bits + ' ビット）値を' + info.roundingJa + 'に丸め、' +
        signedJa + '整数（' + destination.bits + ' ビット、' + destinationType + '）として ' + destinationText + ' に入れる。',
      'Round the ' + sourcePrecisionEn + ' (' + source.bits + '-bit) value in ' + sourceText + ' ' + roundingClauseEn +
        ', then store it as ' + integerArticleEn + ' ' + signedEn + ' integer (' + destination.bits + '-bit, ' + destinationType + ') in ' + destinationText + '.');
    o.detail.push(J(
      'この丸め方は命令名で固定されます。例: ' + info.exampleJa + '。',
      'The mnemonic fixes this rounding rule. For example: ' + info.exampleEn + '.'));
    o.terms = ['float'];
  };
}
for (const mnemonic of Object.keys(FCVT_FLOAT_TO_INTEGER_INFO)) {
  HANDLERS[mnemonic] = fcvtFloatToIntegerHandler(mnemonic);
}
const INT_FLOAT_VECTOR_SHAPES = Object.freeze({
  '4h': Object.freeze({ lanes: 4, bits: 16, precision: 'half' }),
  '8h': Object.freeze({ lanes: 8, bits: 16, precision: 'half' }),
  '2s': Object.freeze({ lanes: 2, bits: 32, precision: 'float' }),
  '4s': Object.freeze({ lanes: 4, bits: 32, precision: 'float' }),
  '2d': Object.freeze({ lanes: 2, bits: 64, precision: 'double' }),
});

function intFloatRegister(op) {
  return op?.k === 'reg' && Number.isInteger(op.num) && op.num >= 0 && op.num < 32;
}

function intFloatScalarFpRegister(op) {
  return intFloatRegister(op) && op.cls === 'fp' && (op.bits === 32 || op.bits === 64);
}

function intFloatScalarIntegerRegister(op) {
  if (!intFloatRegister(op) || !['gp', 'zr'].includes(op.cls) || ![32, 64].includes(op.bits)) return false;
  return op.cls !== 'gp' || op.num < 31;
}

function intFloatVectorShape(op) {
  if (!intFloatRegister(op) || op.cls !== 'vec' || op.bits !== 128 || typeof op.arr !== 'string') return null;
  const arrangement = op.arr.toLowerCase();
  const shape = INT_FLOAT_VECTOR_SHAPES[arrangement];
  return shape ? { ...shape, arrangement } : null;
}

function intFloatScale(op, maximum) {
  if (op?.k !== 'imm' || op.shift != null || typeof op.value !== 'bigint') return null;
  if (op.value < 1n || op.value > BigInt(maximum)) return null;
  return Number(op.value);
}

function intFloatShape(ops) {
  if (!Array.isArray(ops) || ops.length < 2 || ops.some((op) => op?.shift != null || op?.extend != null)) return null;
  const [d, s] = ops;
  const destinationVector = intFloatVectorShape(d);
  const sourceVector = intFloatVectorShape(s);
  if (destinationVector && sourceVector && destinationVector.arrangement === sourceVector.arrangement) {
    if (ops.length === 2) return { kind: 'vector', d, s, ...destinationVector, scale: null };
    if (ops.length === 3) {
      const scale = intFloatScale(ops[2], destinationVector.bits);
      return scale == null ? null : { kind: 'vector', d, s, ...destinationVector, scale };
    }
    return null;
  }

  if (intFloatScalarFpRegister(d) && intFloatScalarFpRegister(s) && d.bits === s.bits) {
    const scalarShape = { kind: 'scalar-simd', d, s, bits: d.bits, precision: d.bits === 64 ? 'double' : 'float' };
    if (ops.length === 2) return { ...scalarShape, scale: null };
    if (ops.length !== 3) return null;
    const scale = intFloatScale(ops[2], d.bits);
    return scale == null ? null : { ...scalarShape, scale };
  }

  if (!intFloatScalarFpRegister(d) || !intFloatScalarIntegerRegister(s)) return null;
  if (ops.length === 2) return { kind: 'scalar-integer', d, s, bits: s.bits, precision: d.bits === 64 ? 'double' : 'float', scale: null };
  if (ops.length !== 3) return null;
  const scale = intFloatScale(ops[2], s.bits);
  return scale == null ? null : { kind: 'scalar-integer', d, s, bits: s.bits, precision: d.bits === 64 ? 'double' : 'float', scale };
}

function intFloatPrecision(precision) {
  return precision === 'double'
    ? { ja: '倍精度の小数', en: 'double-precision floating point' }
    : precision === 'half'
      ? { ja: '半精度の小数', en: 'half-precision floating point' }
      : { ja: '単精度の小数', en: 'single-precision floating point' };
}

function intFloatUnknown(o, mnemonic, ops) {
  const shown = typeof o.operands === 'string' && o.operands.trim()
    ? o.operands.trim()
    : ops.map((op) => opShort(op) || '?').join(', ') || '(missing operands)';
  o.title = J('整数→小数（オペランド形状不明）', 'Integer to float (operand shape unknown)');
  o.pseudo = mnemonic.toUpperCase() + '(' + shown + ')';
  o.summary = J(
    mnemonic.toUpperCase() + ' のこのオペランド形状は未解釈です。符号・幅・精度を推測していません。',
    'The operand shape for ' + mnemonic.toUpperCase() + ' is not interpreted; signedness, width, and precision are left unknown.');
  o.detail.push(J(
    '対応している W/X から S/D、または SIMD の同じレーン形状ではないため、整数の型変換を断定しません。',
    'This is not a supported W/X-to-S/D or same-shape SIMD form, so no integer cast is asserted.'));
  o.terms = ['float'];
}

function intToFloatHandler(mnemonic, signed) {
  return (o, ops) => {
    const shape = intFloatShape(ops);
    if (!shape) {
      intFloatUnknown(o, mnemonic, ops);
      return;
    }

    const signedLabelJa = signed ? '符号付き' : '符号なし';
    const signedLabelEn = signed ? 'signed' : 'unsigned';
    const precision = intFloatPrecision(shape.precision);
    const scaleNoteJa = shape.scale == null ? '' : '。固定小数点の小数部は ' + shape.scale + ' ビット（2^' + shape.scale + ' で割る）';
    const scaleNoteEn = shape.scale == null ? '' : ' Fixed-point scale #' + shape.scale + ' divides the value by 2^' + shape.scale + '.';

    o.title = J('整数を小数にする', 'Integer to float');
    if (shape.kind === 'scalar-integer') {
      const sourceType = (signed ? 'int' : 'uint') + shape.bits + '_t';
      o.pseudo = shape.scale == null
        ? shape.d.text + ' = (' + shape.precision + ')(' + sourceType + ')' + shape.s.text
        : shape.d.text + ' = ((' + shape.precision + ')(' + sourceType + ')' + shape.s.text + ') / 2^' + shape.scale;
      o.summary = J(
        shape.s.text + ' の' + signedLabelJa + '整数（' + sourceType + '）を' + precision.ja + 'に変換して ' + shape.d.text + ' に入れる' + scaleNoteJa + '。',
        'Convert the ' + signedLabelEn + ' integer (' + sourceType + ') in ' + shape.s.text + ' to ' + precision.en + ' and store it in ' + shape.d.text + '.' + scaleNoteEn);
      o.terms = ['float'];
      return;
    }

    const lane = shape.bits + '-bit';
    if (shape.kind === 'scalar-simd') {
      const operation = 'simd_' + (signed ? 'signed' : 'unsigned') + '_lane_to_' + shape.precision;
      o.pseudo = shape.d.text + ' = ' + operation + '(' + shape.s.text + (shape.scale == null ? '' : ', fbits=' + shape.scale) + ')';
      o.summary = J(
        'SIMD スカラー ' + shape.s.text + ' の' + signedLabelJa + ' ' + lane + 'レーンを' + precision.ja + 'に変換して ' + shape.d.text + ' に入れる' + scaleNoteJa + '。',
        'Convert the ' + signedLabelEn + ' ' + lane + ' SIMD scalar lane in ' + shape.s.text + ' to ' + precision.en + ' and store it in ' + shape.d.text + '.' + scaleNoteEn,
      );
      o.terms = ['float', 'simd'];
      return;
    }

    const operation = 'simd_' + (signed ? 'signed' : 'unsigned') + '_lanes_to_' + shape.precision;
    o.pseudo = shape.d.text + ' = ' + operation + '(' + shape.s.text + (shape.scale == null ? '' : ', fbits=' + shape.scale) + ')';
    o.summary = J(
      shape.d.text + ' の各レーンを、' + shape.s.text + ' の' + signedLabelJa + ' ' + lane + '整数レーンから' + precision.ja + 'へ変換する' + scaleNoteJa + '。',
      'Convert each ' + signedLabelEn + ' ' + lane + ' integer lane in ' + shape.s.text + ' to ' + precision.en + ' lanes in ' + shape.d.text + '.' + scaleNoteEn);
    o.terms = ['float', 'simd'];
  };
}
HANDLERS.scvtf = intToFloatHandler('scvtf', true);
HANDLERS.ucvtf = intToFloatHandler('ucvtf', false);
HANDLERS.fcvt = (o, ops) => {
  o.title = J('小数の精度を変える', 'Convert float precision');
  o.pseudo = opShort(ops[0]) + ' = (' + (ops[0] && ops[0].bits === 64 ? 'double' : 'float') + ')' + opShort(ops[1]);
  o.summary = J('小数の桁数（精度）を変換する。', 'Change between float and double precision.');
  o.terms = ['float'];
};

/* SIMD ------------------------------------------------------- */

HANDLERS.movi = (o, ops) => {
  o.title = J('まとめて同じ値を入れる', 'Fill a vector');
  o.pseudo = opShort(ops[0]) + ' = { ' + immShort(ops[1]) + ', … }';
  o.summary = J(
    'ベクタレジスタ ' + opShort(ops[0]) + ' の全部の枠に ' + immText(ops[1]) + ' を入れる。',
    'Set every lane of ' + opShort(ops[0]) + ' to ' + immText(ops[1]) + '.');
  o.detail.push(J(
    'v0〜v31 は 16 バイトを一度に扱えるレジスタです。memset や画像処理でまとめて処理するのに使われます。',
    'v0–v31 hold 16 bytes at once; used for memset, image and audio work.'));
  o.terms = ['simd'];
};
HANDLERS.dup = (o, ops) => {
  o.title = J('同じ値を並べる', 'Duplicate into all lanes');
  o.pseudo = opShort(ops[0]) + ' = { ' + opShort(ops[1]) + ' × n }';
  o.summary = J(
    opShort(ops[1]) + ' の値を ' + opShort(ops[0]) + ' の全部の枠にコピーする。',
    'Copy ' + opShort(ops[1]) + ' into every lane.');
  o.terms = ['simd'];
};
/**
 * ベクタレジスタの並び（16b / 8h / 4s / 2d …）が何バイト分かを返す。
 * 分からないときは null。
 */
function arrangementBytes(arr) {
  const m = /^(\d+)([bhsd])$/i.exec(String(arr || ''));
  if (!m) return null;
  const lanes = Number(m[1]);
  const elem = { b: 1, h: 2, s: 4, d: 8 }[m[2].toLowerCase()];
  if (!Number.isSafeInteger(lanes) || lanes <= 0 || !elem) return null;
  return lanes * elem;
}

/**
 * `{v0.16b, v1.16b, v2.16b, v3.16b}` のようなレジスタリストが運ぶ総バイト数。
 *
 * ld2/ld3/ld4 と st2/st3/st4 は複数のベクタを一度に埋めます。
 * これを常に「16 バイト」と言ってしまうと、扱うデータ量を実際より
 * 小さく説明してしまいます (#1294)。総量が確定できないときは null を返し、
 * 呼び出し側はバイト数を言わない説明にします。
 */
function registerListBytes(ops) {
  const list = ops.find((x) => x && x.k === 'list');
  if (!list || !Array.isArray(list.regs) || !list.regs.length) return null;
  let total = 0;
  for (const reg of list.regs) {
    if (!reg || reg.k !== 'reg') return null;
    const bytes = reg.cls === 'vec'
      ? arrangementBytes(reg.arr)
      : (Number.isSafeInteger(reg.bits) && reg.bits > 0 ? reg.bits / 8 : null);
    if (bytes == null) return null;
    total += bytes;
  }
  return { total, count: list.regs.length, text: list.text };
}

function vectorListTitle(load, info) {
  if (!info) return load ? J('まとめて読む', 'Vector load') : J('まとめて書く', 'Vector store');
  const unit = info.count === 1 ? '' : '（' + info.count + ' 本のベクタ）';
  const unitEn = info.count === 1 ? '' : ' (' + info.count + ' vectors)';
  return load
    ? J('まとめて読む' + unit, 'Vector load' + unitEn)
    : J('まとめて書く' + unit, 'Vector store' + unitEn);
}

for (const n of ['ld1', 'ld2', 'ld3', 'ld4']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    const info = registerListBytes(ops);
    o.title = vectorListTitle(true, info);
    o.pseudo = (ops[0] ? ops[0].text : '') + ' = *(vector*)(' + (mem ? memExpr(mem) : '') + ')';
    const amountJa = info ? '合計 ' + info.total + ' バイト（' + info.count + ' 本のベクタ）' : '複数のベクタ';
    const amountEn = info ? info.total + ' bytes in total across ' + info.count + ' vector register(s)' : 'the listed vector registers';
    o.summary = J(
      (mem ? memText(mem) + 'から' : '') + amountJa + 'をまとめて読み込む。',
      'Load ' + amountEn + ' at once' + (mem ? ' from ' + memExpr(mem) : '') + '.');
    if (info && info.count > 1) {
      o.detail.push(J(
        n + ' は ' + info.count + ' 本のレジスタを同時に埋めます。'
        + 'メモリ上で交互に並んだデータを、レジスタごとに分けて取り出す命令です。',
        n + ' fills ' + info.count + ' registers at once, de-interleaving structures held in memory.'));
    }
    o.terms = ['simd', 'memory'];
  };
}
for (const n of ['st1', 'st2', 'st3', 'st4']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    const info = registerListBytes(ops);
    o.title = vectorListTitle(false, info);
    o.pseudo = '*(vector*)(' + (mem ? memExpr(mem) : '') + ') = ' + (ops[0] ? ops[0].text : '');
    const amountJa = info ? '合計 ' + info.total + ' バイト（' + info.count + ' 本のベクタ）' : '複数のベクタ';
    const amountEn = info ? info.total + ' bytes in total across ' + info.count + ' vector register(s)' : 'the listed vector registers';
    o.summary = J(
      (mem ? memText(mem) + 'へ' : '') + amountJa + 'をまとめて書き込む。',
      'Store ' + amountEn + ' at once' + (mem ? ' to ' + memExpr(mem) : '') + '.');
    if (info && info.count > 1) {
      o.detail.push(J(
        n + ' は ' + info.count + ' 本のレジスタを同時に書き出します。'
        + 'レジスタごとの値を、メモリ上で交互に並べ直して置く命令です。',
        n + ' writes ' + info.count + ' registers at once, interleaving them into memory.'));
    }
    o.terms = ['simd', 'memory'];
  };
}

/* 排他アクセス ----------------------------------------------- */

for (const n of ['ldxr', 'ldaxr']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    o.title = J('横取りされないように読む', 'Exclusive load');
    o.pseudo = opShort(ops[0]) + ' = *(' + (mem ? memExpr(mem) : '') + ') /* 監視開始 */';
    o.summary = J(
      'メモリを読むと同時に「ここを見張る」と CPU に宣言する。他のスレッドが書き換えたら、次の stxr が失敗します。',
      'Load and start watching the address; a matching stxr fails if anyone else writes it.');
    o.detail.push(J(
      '複数のスレッドが同じ値を同時に増やそうとしても壊れないように、read → 変更 → write を「誰にも割り込まれずに」行うための仕組みです。',
      'The building block of atomic read-modify-write across threads.'));
    o.terms = ['thread', 'atomic'];
  };
}
for (const n of ['stxr', 'stlxr']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    o.title = J('横取りされていなければ書く', 'Exclusive store');
    o.pseudo = opShort(ops[0]) + ' = try_store(' + (mem ? memExpr(mem) : '') + ', ' + opShort(ops[1]) + ')';
    o.summary = J(
      '見張っていた間に誰も書き換えていなければ書き込み、' + opShort(ops[0]) + ' に 0（成功）を入れる。失敗なら 1 が入り、ふつうは上に戻ってやり直します。',
      'Store only if nothing else wrote the address; ' + opShort(ops[0]) + ' gets 0 on success, 1 on failure.');
    o.terms = ['thread', 'atomic'];
  };
}
for (const n of ['casal', 'cas', 'casa', 'casl']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    o.title = J('比べて、合っていれば入れ替える', 'Compare and swap');
    o.pseudo = 'if (*' + (mem ? memExpr(mem) : '') + ' == ' + opShort(ops[0]) + ') *… = ' + opShort(ops[1]);
    o.summary = J(
      'メモリの中身が期待どおりならすげ替える。1 命令で安全に行える「読んで書く」です。',
      'Atomically swap the value only if it still matches what was expected.');
    o.terms = ['thread', 'atomic'];
  };
}
for (const n of ['ldadd', 'ldadda', 'ldaddl', 'ldaddal', 'ldset', 'ldclr', 'ldeor', 'swp', 'swpa', 'swpl', 'swpal']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    o.title = J('割り込まれずに読み書きする', 'Atomic read-modify-write');
    o.pseudo = opShort(ops[1]) + ' = atomic(' + (mem ? memExpr(mem) : '') + ', ' + opShort(ops[0]) + ')';
    o.summary = J(
      '他のスレッドに邪魔されずに、メモリの値を読んで書き換える。参照カウントの増減などで使われます。',
      'Read and update memory without another thread getting in between — reference counting, for example.');
    o.terms = ['thread', 'atomic'];
  };
}

/* データ ----------------------------------------------------- */

HANDLERS['.byte'] = (o, ops, base, addr, c) => {
  o.title = J('命令ではなくデータ', 'Data, not code');
  o.pseudo = '/* ' + (o.operands || '') + ' */';
  o.summary = J(
    'この 4 バイトは CPU の命令として意味を持ちません。文字列、数値、アドレスなどのデータが置かれている場所です。',
    'These 4 bytes are not a valid instruction — this is data: a string, a number or an address.');
  o.detail.push(J(
    'プログラムの中には、コードとデータが混ざって置かれています。ここを「16進」タブで見ると、' +
    '右側に文字として読める部分があるかもしれません。',
    'Code and data are interleaved. Switch to the Hex tab — the ASCII column may show readable text.'));
  o.category = 'data';
  o.terms = ['data'];
};

/* ── 名前で拾いきれないものを、接頭辞で拾う ─────────────── */

function familyHandler(base) {
  if (/^b\.[a-z]{2}$/.test(base)) return condBranch;
  if (/^(braa|brab|braaz|brabz)$/.test(base)) return HANDLERS.br;
  if (/^(blraa|blrab|blraaz|blrabz)$/.test(base)) return HANDLERS.blr;
  if (/^ld/.test(base)) return loadStore(true);
  if (/^st/.test(base)) return loadStore(false);
  if (/^f/.test(base)) {
    return (o, ops) => {
      o.title = J('小数の計算', 'Floating-point operation');
      o.pseudo = opShort(ops[0]) + ' = ' + base + '(' + ops.slice(1).map(opShort).join(', ') + ')';
      o.summary = J(
        '浮動小数点（小数）を扱う計算です。d/s/q で始まるレジスタは小数専用です。',
        'A floating-point operation; d/s/q registers hold floating-point values.');
      o.terms = ['float'];
    };
  }
  return null;
}

/* ── レジスタの役割を detail に足す ─────────────────────── */

function addRegRoles(o, ops) {
  const seen = new Set();
  for (const op of ops) {
    const regs = op.k === 'reg' ? [op] : (op.k === 'mem' ? [op.base, op.index].filter(Boolean) : []);
    for (const r of regs) {
      if (!r || r.cls === 'fp' || r.cls === 'vec') continue;
      if (seen.has(r.text)) continue;
      seen.add(r.text);
      const role = registerRole(r.num, r.cls === 'sp', r.cls === 'zr');
      if (role.id === 'lr') o.terms.push('lr');
      if (role.id === 'fp') o.terms.push('framepointer');
      if (role.id === 'sp') o.terms.push('sp');
    }
  }
}

/* ────────────────────────────────────────────────────────────
   部品ごとの意味（詳細画面で使う）
   ──────────────────────────────────────────────────────────── */

export function operandNotes(mn, opsStr) {
  const ops = parseOperands(opsStr || '');
  const notes = [];
  const seen = new Set();
  for (const op of ops) {
    // 同じレジスタが読み書き両方に出ることは多い。説明は 1 回で足りる。
    if (op.k === 'reg') {
      if (seen.has(op.text)) continue;
      seen.add(op.text);
    }
    if (op.k === 'reg') {
      const role = registerRole(op.num, op.cls === 'sp', op.cls === 'zr');
      const width = op.cls === 'fp' || op.cls === 'vec'
        ? J(op.bits + ' ビットの小数／ベクタ用', op.bits + '-bit vector/float register')
        : J(op.bits + ' ビット分を使う', op.bits + ' bits wide');
      notes.push({
        name: op.text,
        text: pick(role.ja, role.en) + '。' + width + (op.shift ? shiftText(op.shift) : ''),
        kind: 'reg',
      });
    } else if (op.k === 'imm') {
      if (op.float != null) {
        notes.push({ name: op.text, text: J('小数の定数 ' + op.float, 'the constant ' + op.float), kind: 'imm' });
      } else if (op.value != null) {
        const v = op.value;
        const extra = [];
        extra.push(J('10進で ' + v.toString(10), 'decimal ' + v.toString(10)));
        extra.push(J('16進で 0x' + absHex(v), 'hex 0x' + absHex(v)));
        if (v >= 0n && v <= 0xffffn) extra.push(J('2進で ' + v.toString(2), 'binary ' + v.toString(2)));
        if (v >= 0x20n && v < 0x7fn) extra.push(J('文字なら "' + String.fromCharCode(Number(v)) + '"', 'as a character "' + String.fromCharCode(Number(v)) + '"'));
        notes.push({ name: op.text, text: extra.join(' / '), kind: 'imm', value: v });
      }
    } else if (op.k === 'mem') {
      notes.push({ name: op.text, text: memText(op), kind: 'mem' });
    } else if (op.k === 'cond') {
      const ci = condInfo(op.text);
      notes.push({ name: op.text, text: ci ? J(ci.ja + '（フラグを見て決める）', ci.en) : op.text, kind: 'cond' });
    } else if (op.k === 'list') {
      notes.push({ name: op.text, text: J('ベクタレジスタのまとまり', 'a set of vector registers'), kind: 'list' });
    } else {
      notes.push({ name: op.text, text: '', kind: 'other' });
    }
  }
  return notes;
}

/* ────────────────────────────────────────────────────────────
   行に添える短い一言（一覧表示用・キャッシュあり）
   ──────────────────────────────────────────────────────────── */

const briefCache = new Map();
const BRIEF_CACHE_MAX = 4000;

/**
 * @param {string} style 'ja' | 'pseudo' | 'both'
 */
export function brief(mn, ops, style, ctx) {
  if (!mn) return '';
  const gen = (ctx && ctx.gen) || 0;
  const key = gen + '\0' + style + '\0' + (ctx && ctx.lang ? ctx.lang : '') + '\0' + mn + '\0' + (ops || '');
  const hit = briefCache.get(key);
  if (hit !== undefined) return hit;

  const e = explain(mn, ops, null, ctx);
  let text;
  if (style === 'pseudo') text = e.pseudo;
  else if (style === 'both') text = e.pseudo + (e.title ? '   — ' + e.title : '');
  else text = e.summary || e.title;
  text = (text || '').replace(/\s+/g, ' ').trim();

  if (briefCache.size > BRIEF_CACHE_MAX) briefCache.clear();
  briefCache.set(key, text);
  return text;
}

export function clearBriefCache() { briefCache.clear(); }
