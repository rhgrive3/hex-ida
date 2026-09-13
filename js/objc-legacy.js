import { objcIvarRangeWithinInstance } from './objc-ivar-layout.js';

/*
 * Objective-C のクラス表を読んで、関数に本当の名前を戻す。
 *
 * 配布用のアプリは自作の関数名を削ってあるので、関数一覧は sub_100123456 だらけになる。
 * ところが Objective-C のメソッドは、実行時にクラス名とメソッド名で探せる必要があるため、
 * **名前と実装アドレスの対応表がバイナリの中に必ず残っている**。これを読めば
 *
 *   sub_100123456  →  -[LoginViewController loginButtonTapped:]
 *
 * まで戻せる。「この関数はアプリの何をしているのか」に対する、いちばん強い答え。
 *
 * ここは読み取りだけを担当し、ファイルへの実際のアクセスは呼び出し側から
 * read(addr, len) として渡してもらう（worker でも node のテストでも動くように）。
 *
 * 読めなかったものは、いっさい名前を付けずに黙って飛ばす。
 * 表の形が想定と違うときに、でたらめな名前を付けるのがいちばん困るため。
 */

/* ── 構造体の中の位置（64 ビット） ────────────────────────── */

const PTR = 8;
const CLASS_ISA = 0;
const CLASS_SUPER = 8;          // class_t.superclass
const CLASS_DATA = 32;          // class_t.data — 下位ビットはフラグ
const RO_INSTANCE_SIZE = 8;     // class_ro_t.instanceSize
const RO_NAME = 24;             // class_ro_t.name
const RO_METHODS = 32;          // class_ro_t.baseMethods
const RO_IVARS = 48;            // class_ro_t.ivars ← ここが「フィールドの名前」の在り処
const RO_PROPS = 64;            // class_ro_t.baseProperties ← 宣言された名前と型
const RO_SIZE = 72;             // baseProperties まで読むのに必要な長さ
const CLASS_SIZE = 40;

const PROP_STRIDE = 16;         // property_t = name* + attributes*
const MAX_PROPS = 400;
const MAX_PROTOCOLS = 400;

const IVAR_STRIDE_MIN = 32;     // ivar_t = offset* + name* + type* + alignment + size
const MAX_IVARS = 400;

/* ── ポインタ幅（pointer ABI）────────────────────────────
 *
 * arm64_32（watchOS）は AArch64 命令セットのまま ILP32 ポインタ ABI を使う。
 * Mach-O のファイルクラスは 64 ビットでも、Objective-C ランタイム構造体の
 * ポインタは 4 バイトで、ポインタ表の 1 エントリも 4 バイトになる。
 *
 * ここを 8 バイト固定で読むと、正しい 1 エントリの __objc_classlist が
 * 「declared 0 件 + 4 バイト端数」になり、クラス・プロトコル・カテゴリが
 * 丸ごと消える（#8280）。明示された幅が最優先、無ければ宣言された
 * アーキテクチャ、どちらも無いときだけ LP64 を既定にする。宣言済みで
 * 未知の ABI は 8 バイトへ黙って広げず fail-closed にする。
 */
const OBJC_ARCH_POINTER_BYTES = new Map([
  ['arm64', 8], ['arm64e', 8], ['x86_64', 8], ['x86_64h', 8], ['ppc64', 8],
  ['arm64_32', 4], ['arm', 4], ['armv6', 4], ['armv7', 4], ['armv7s', 4], ['armv7k', 4],
  ['i386', 4], ['x86', 4], ['ppc', 4],
]);

export function resolveObjcPointerBytes(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const raw = source.pointerBytes ?? source.pointerSize;
    if (raw == null) continue;
    return raw === 4 || raw === 8
      ? { bytes:raw, provenance:'explicit' }
      : { bytes:null, reason:'objc-pointer-abi-invalid' };
  }
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const architecture = source.architecture ?? source.arch ?? null;
    if (architecture == null || architecture === '') continue;
    const key = String(architecture).trim().toLowerCase();
    const bytes = OBJC_ARCH_POINTER_BYTES.get(key);
    return bytes == null
      ? { bytes:null, reason:'objc-pointer-abi-unsupported', architecture:key }
      : { bytes, provenance:'architecture', architecture:key };
  }
  return { bytes:PTR, provenance:'default-lp64' };
}

function pointerBytesOf(get) { return get?.pointerBytes === 4 ? 4 : PTR; }

// A pointer field inside an already-read structure is a native word: 4 bytes on
// ILP32, 8 on LP64. Wide reads must never span two 4-byte components.
function readWord(get, buffer, offset) {
  return pointerBytesOf(get) === 4 ? BigInt(u32(buffer, offset)) : u64(buffer, offset);
}

// Objective-C runtime structure layout for a native pointer width.
function legacyLayout(pointerBytes) {
  const ilp32 = pointerBytes === 4;
  return {
    pointerBytes,
    alignmentMask:~(BigInt(pointerBytes) - 1n),
    classIsa:0,
    classSuper:pointerBytes,
    classData:pointerBytes * 4,
    classSize:pointerBytes * 5,
    roInstanceSize:8,
    roName:ilp32 ? 16 : 24,
    roMethods:ilp32 ? 20 : 32,
    roProtocols:ilp32 ? 24 : 40,
    roIvars:ilp32 ? 28 : 48,
    roProps:ilp32 ? 36 : 64,
    roSize:ilp32 ? 40 : 72,
    propStride:ilp32 ? 8 : 16,
    ivarStrideMin:ilp32 ? 20 : 32,
    ivarTypeOffset:pointerBytes * 2,
    ivarSizeOffset:ilp32 ? 16 : 28,
  };
}

const REL_FLAG = 0x80000000;    // relative/small method entries
const DIRECT_SEL_FLAG = 0x40000000; // selector field points directly at cstring
const ENTSIZE_MASK = 0xfffc;
export function decodeMethodListHeader(rawEntsize) {
  const raw=Number(rawEntsize)>>>0;
  return { relative:!!(raw&REL_FLAG), directSelector:!!(raw&DIRECT_SEL_FLAG), stride:raw&ENTSIZE_MASK };
}

/**
 * Resolve the selector-address representation declared by a relative
 * method-list header. Indirect entries are never reinterpreted as
 * direct C strings when pointer resolution fails (#2392).
 */
export async function resolveRelativeMethodSelectorAddress(directSelector, nameTarget, dereference) {
  if (directSelector) return nameTarget;
  if (typeof dereference !== 'function') return null;
  try {
    const resolved = await dereference(nameTarget);
    return resolved == null ? null : BigInt(resolved);
  } catch {
    return null;
  }
}

const MAX_CLASSES = 20000;
const MAX_METHODS = 60000;
const MAX_NAME = 512;

/**
 * ポインタとして読む。
 *
 * iOS 15 以降のアプリは、ポインタをそのままの形では持っていない。
 * 起動時に dyld が埋める形（chained fixups）で書いてあって、1 個の 64 ビットが
 * こうなっている:
 *
 *     bit 63     … 1 なら「他のライブラリの記号を入れる」（bind）
 *     bit 51-62  … 次のポインタまでの距離
 *     bit 36-43  … アドレスの上位 8 ビット
 *     bit  0-35  … **イメージの先頭からの距離**（アドレスそのものではない）
 *
 * つまり下位 36 ビットを取り出しただけでは、イメージの先頭（ふつう 0x100000000）が
 * 抜け落ちる。0x1018a13a8 のつもりが 0x18a13a8 になり、そこには何も無いので
 * クラス表が 1 個も読めない。ここを取り違えると、このツールでいちばん効く
 * 「値の名前が残っている表」がまるごと失われる。
 *
 * @param {BigInt} v      その 8 バイトをそのまま読んだ値
 * @param {BigInt} [base] イメージの先頭（__TEXT の vmaddr）。無ければ足さない。
 */
export function sanitizePointer(v, base, pointerFormat = null) {
  if (v === 0n) return null;
  const format = pointerFormat == null ? null : Number(pointerFormat);
  if (format === 2 || format === 6) {
    if (((v >> 63n) & 1n) !== 0n) return null;
    const target = v & 0xfffffffffn;
    if (format === 6) return base == null ? null : BigInt(base) + target;
    const high8 = (v >> 36n) & 0xffn;
    return target | (high8 << 56n);
  }
  /* ARM64E chained fixup formats (dyld_chained_ptr_arm64e_*). They share auth /
     bind bit placement with each other, not with format 2/6: bind = bit 62,
     and an authenticated rebase carries a 32-bit runtime offset instead of a
     vmaddr. Formats 7/9/12 rebase by image offset; 1/10 carry a preferred
     vmaddr in target:43 + high8. Without this branch every arm64e metadata
     pointer collapsed to `null` (#2198). */
  if (format === 1 || format === 7 || format === 9 || format === 10 || format === 12) {
    const auth = ((v >> 63n) & 1n) !== 0n;
    if (((v >> 62n) & 1n) !== 0n) return null;    // bind ordinal, not an address
    if (auth) {
      // dyld chains "diversity+addr" authentication on bits 32..61 — no address.
      if (base == null) return null;
      return BigInt(base) + (v & 0xffffffffn);
    }
    const target = v & 0x7ffffffffffn;
    if (target === 0n) return null;
    const high8 = (v >> 43n) & 0xffn;
    const reconstructed = target | (high8 << 56n);
    if (format === 7 || format === 9 || format === 12) {
      if (base == null) return null;
      return BigInt(base) + reconstructed;
    }
    return reconstructed;
  }
  if (format != null) return null;
  /* Some modern Mach-O metadata fields contain a bare image-relative offset
     without the chained-pointer next/high bits.  When the image base is known,
     a non-zero value below that base cannot be a valid in-image VM address;
     interpret it as the same image-relative form instead of trying to read
     page zero.  Plain legacy VM pointers remain unchanged because they are
     already >= base. */
  if (base != null && v < BigInt(base)) return BigInt(base) + v;
  if (v < 0x0001000000000000n) return v;          // 素のポインタ（古い形式）
  const low = v & 0x0000000fffffffffn;
  if (low === 0n) return null;

  /*
   * 最上位ビットは「他のライブラリの記号を入れる」印（bind）。
   * そこに書いてあるのはアドレスではなく取り込み表の番号なので、
   * このファイルの中を指しているようには見えないなら、読めたことにしない。
   * （親クラスが NSObject のときにここへ来る。番号をアドレスと取り違えると、
   *   たまたま同じ値だった別のクラスを親として拾ってしまう。）
   */
  if (v & 0x8000000000000000n) {
    return (base == null || low >= base) ? low : null;
  }

  /*
   * 形式が 2 つある。target にアドレスそのものが入っているもの（DYLD_CHAINED_PTR_64）と、
   * イメージ先頭からの距離が入っているもの（同 _64_OFFSET）。
   * 距離のほうは必ずイメージ先頭より小さいので、そこで見分けられる。
   */
  if (base != null && low < base) return base + low;
  return low;
}

function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o) { return u32(b, o) | 0; }
function u64(b, o) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

/**
 * read(addr, len) を、64 KiB ごとにまとめて読むように包む。
 * クラス表は飛び飛びに読むので、素直に呼ぶと往復が多くなりすぎる。
 */
function pagedBudgetInteger(value, fallback, min) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min) return value;
  return fallback;
}

export function pagedReader(read, pageBytes = 65536, maxPages = 96, options = {}) {
  pageBytes = pagedBudgetInteger(pageBytes, 65536, 1);
  maxPages = pagedBudgetInteger(maxPages, 96, 0);
  const signal = options?.signal ?? null;
  const pages = new Map();
  const direct = async (addr, len, soft) => {
    if (signal?.aborted) return null;
    const got = await read(addr, len);
    if (signal?.aborted) return null;
    if (!got || !got.length) return null;
    // soft: 短くても受け取る（0 で終わる文字列は、区画の端に置かれていることがある）
    if (got.length >= len) return got.subarray(0, len);
    if (soft) return got;
    if (got.length < len) {
      const rest = await direct(BigInt(addr) + BigInt(got.length), len - got.length, soft);
      if (rest && rest.length >= len - got.length) {
        const combined = new Uint8Array(len);
        combined.set(got, 0);
        combined.set(rest.subarray(0, len - got.length), got.length);
        return combined;
      }
    }
    return null;
  };
  return async function get(addr, len, soft) {
    if (signal?.aborted) return null;
    if (addr == null || len <= 0) return null;
    const page = (addr / BigInt(pageBytes)) * BigInt(pageBytes);
    const off = Number(addr - page);
    if (off + len <= pageBytes) {
      const key = page.toString();
      let buf = pages.get(key);
      if (buf === undefined) {
        if (signal?.aborted) return null;
        buf = await read(page, pageBytes);
        if (signal?.aborted) return null;
        if (pages.size >= maxPages) pages.delete(pages.keys().next().value);
        pages.set(key, buf || null);
      }
      if (buf && off + len <= buf.length) return buf.subarray(off, off + len);
      if (soft && buf && off < buf.length) return buf.subarray(off);
      /*
       * まとめ読みが途中で切れることがある（区画の境目をまたいだとき）。
       * クラス表は区画をまたいで散らばっているので、その場合は
       * 必要なぶんだけ読み直す。ここで諦めると、名前がまるごと取れなくなる。
       */
      return direct(addr, len, soft);
    }
    return direct(addr, len, soft);
  };
}

/** 0 で終わる文字列を読む。読めなければ null。 */
async function cstring(get, addr) {
  if (addr == null) return null;
  // 区画の端に置かれた名前も読めるように、短い読み取りも受け取る。
  // Objective-C identifiers/selectors are UTF-8, not ASCII-only (#2373).
  const buf = await get(addr, MAX_NAME, true);
  if (!buf || !buf.length) return null;
  const end = buf.indexOf(0);
  if (end <= 0) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, end));
    return /[\u0000-\u001f\u007f]/u.test(text) ? null : text;
  } catch {
    return null;
  }
}

function newLegacyCompleteness(present, declared = 0) {
  return {
    present: !!present, declared, scanned: 0, parsed: 0, capped: false,
    unreadableSlots: 0, invalidEntries: 0, invalidIvars: 0, invalidProtocols: 0, incompleteMethodLists: 0,
    misalignedBytes: 0, sizeValid: true, reasons: [], complete: !present,
  };
}

function markLegacyPartial(status, reason, field = null) {
  if (!status) return;
  status.complete = false;
  if (field) status[field] = (status[field] || 0) + 1;
  if (reason && !status.reasons.includes(reason)) status.reasons.push(reason);
}

function cleanPointer(get, value) { return sanitizePointer(value, get.base, get.pointerFormat); }

async function pointer(get, addr) {
  const b = await get(addr, pointerBytesOf(get));
  return b ? cleanPointer(get, readWord(get, b, 0)) : null;
}

/**
 * メソッド一覧を読む。
 *
 * 形式が 2 つある。
 *   従来型: 1 件 24 バイト（名前・型・実装のポインタが 3 本）
 *   相対型: 1 件 12 バイト（それぞれの位置からの差で書く。iOS 14 以降はこちら）
 * 相対型の selector 表現は method-list header の directSelector flag が決める。
 * indirect form は selector-reference を 1 段たどれた場合だけ採用し、解決失敗時に
 * storage 自身を direct C string として読み替えない。
 */
async function readMethods(get, listAddr, out, className, prefix, budget, completeness = null) {
  if (listAddr == null) return;
  const head = await get(listAddr, 8);
  if (!head || head.length < 8) { markLegacyPartial(completeness, 'method-list-unreadable', 'incompleteMethodLists'); return; }
  const entsize = u32(head, 0);
  const count = u32(head, 4);
  if (!count) return;
  if (count > 20000) { markLegacyPartial(completeness, 'method-list-count-invalid', 'incompleteMethodLists'); return; }
  const { relative, directSelector, stride } = decodeMethodListHeader(entsize);
  // A non-relative entry is three native pointers; ILP32 therefore accepts the
  // 12-byte layout that a fixed 24-byte minimum rejected (#8280).
  const pointerBytes = pointerBytesOf(get);
  const entryWidth = relative ? 12 : pointerBytes * 3;
  if (stride < entryWidth) { markLegacyPartial(completeness, 'method-list-stride-invalid', 'incompleteMethodLists'); return; }

  let scanned = 0;
  for (let i = 0; i < count && out.length < budget; i++) {
    const entry = listAddr + 8n + BigInt(i) * BigInt(stride);
    const width = entryWidth;
    const b = await get(entry, width);
    if (!b || b.length < width) { markLegacyPartial(completeness, 'method-entry-unreadable', 'incompleteMethodLists'); return; }
    scanned++;

    let nameAddr = null;
    let imp = null;
    if (relative) {
      const nameField = entry + 0n;
      const impField = entry + 8n;
      const nameTarget = nameField + BigInt(i32(b, 0));
      imp = impField + BigInt(i32(b, 8));
      nameAddr = await resolveRelativeMethodSelectorAddress(
        directSelector,
        nameTarget,
        (addr) => pointer(get, addr),
      );
      if (nameAddr == null) {
        markLegacyPartial(completeness, 'method-selector-unresolved', 'incompleteMethodLists');
        continue;
      }
    } else {
      nameAddr = cleanPointer(get, readWord(get, b, 0));
      imp = cleanPointer(get, readWord(get, b, pointerBytes * 2));
    }
    if (imp == null) { markLegacyPartial(completeness, 'method-imp-unresolved', 'incompleteMethodLists'); continue; }
    let implementationProven=!get.requireImplementationProof,implementationValidationReason=null;
    if(typeof get.validateImplementation==='function'){try{const proof=await get.validateImplementation(imp);implementationProven=proof===true||proof?.ok===true;if(!implementationProven)implementationValidationReason=proof?.reason||'method-imp-not-executable';}catch{implementationProven=false;implementationValidationReason='method-imp-validation-error';}}
    if(get.requireImplementationProof&&!implementationProven)markLegacyPartial(completeness,implementationValidationReason||'method-imp-unproven','incompleteMethodLists');
    const sel = await cstring(get, nameAddr);
    if (!sel) { markLegacyPartial(completeness, 'method-selector-invalid', 'incompleteMethodLists'); continue; }
    out.push({
      addr: imp,
      name: prefix + '[' + className + ' ' + sel + ']',
      sel, kind: prefix, className, implementationProven, implementationValidationReason,
    });
  }
  if (scanned < count) markLegacyPartial(completeness, 'method-budget', 'incompleteMethodLists');
}

/* ── フィールド（ivar）──────────────────────────────────────
 *
 * ここがこのファイルでいちばん価値のある部分。
 *
 * Objective-C のクラスには、**メンバ変数の名前・型・位置**の表が必ず残っている。
 * これを読むと、逆アセンブルに出てくる
 *
 *     ldr w8, [x0, #0x20]
 *
 * が「self の _hp（4 バイトの整数）を読み込む」に変わる。
 * 「x0 + 0x20 の値」と言われても初心者には何のことか分からないが、
 * 「HP を読み込んでいる」なら誰にでも分かる。この差はとても大きい。
 */

/**
 * 型エンコーディング（"i" や "@\"NSString\"" など）を、意味の分かる形にする。
 * 読めなければ kind:'unknown'。適当な名前は付けない。
 */
export function decodeTypeEncoding(enc) {
  const s = String(enc || '').trim();
  if (!s) return { kind: 'unknown', enc: s };
  const c = s[0];
  switch (c) {
    case 'c': return { kind: 'int', bytes: 1, signed: true, enc: s };
    case 'C': return { kind: 'int', bytes: 1, signed: false, enc: s };
    case 'B': return { kind: 'bool', bytes: 1, enc: s };
    case 's': return { kind: 'int', bytes: 2, signed: true, enc: s };
    case 'S': return { kind: 'int', bytes: 2, signed: false, enc: s };
    case 'i': return { kind: 'int', bytes: 4, signed: true, enc: s };
    case 'I': return { kind: 'int', bytes: 4, signed: false, enc: s };
    case 'l': return { kind: 'int', bytes: 4, signed: true, enc: s };
    case 'L': return { kind: 'int', bytes: 4, signed: false, enc: s };
    case 'q': return { kind: 'int', bytes: 8, signed: true, enc: s };
    case 'Q': return { kind: 'int', bytes: 8, signed: false, enc: s };
    case 'f': return { kind: 'float', bytes: 4, enc: s };
    case 'd': return { kind: 'float', bytes: 8, enc: s };
    case '*': return { kind: 'cstring', bytes: 8, enc: s };
    case '#': return { kind: 'class', bytes: 8, enc: s };
    case ':': return { kind: 'selector', bytes: 8, enc: s };
    case '^': return { kind: 'pointer', bytes: 8, enc: s, to: s.slice(1) };
    case '{': {
      const name = /^\{([^=}]*)/.exec(s);
      return { kind: 'struct', enc: s, name: name ? name[1] : null };
    }
    case '[': return { kind: 'array', enc: s };
    case '@': {
      const m = /^@"([^"]+)"/.exec(s);
      if (m) return { kind: 'object', bytes: 8, enc: s, className: m[1] };
      if (s === '@?') return { kind: 'block', bytes: 8, enc: s };
      return { kind: 'object', bytes: 8, enc: s, className: null };
    }
    default: return { kind: 'unknown', enc: s };
  }
}

/** ivar のオフセットは、__objc_ivar に置かれた変数の中身。1 段たどって読む。 */
async function ivarOffset(get, slotAddr) {
  if (slotAddr == null) return null;
  const b = await get(slotAddr, 4);
  if (!b) return null;
  // 実体は 32 ビットだが、8 バイト確保されていることがある。下位 32 ビットを読む。
  const v = u32(b, 0);
  if (v > 0x100000) return null;              // クラスの大きさとしてありえない
  return v;
}

/** ivar_list_t を読む。読めない項目は黙って飛ばす。 */
async function readIvars(get, listAddr, instanceSize, completeness = null) {
  const out = [];
  if (listAddr == null) return out;
  const head = await get(listAddr, 8);
  if (!head) return out;
  const entsize = u32(head, 0);
  const count = u32(head, 4);
  if (!count || count > MAX_IVARS) return out;
  const layout = legacyLayout(pointerBytesOf(get));
  const stride = entsize & 0xffff;
  if (stride < layout.ivarStrideMin) return out;

  for (let i = 0; i < count; i++) {
    const entry = listAddr + 8n + BigInt(i) * BigInt(stride);
    const b = await get(entry, layout.ivarStrideMin);
    if (!b) break;
    /*
     * 位置そのものではなく「位置が書いてある場所」も覚えておく。
     *
     * いまの Objective-C は、フィールドの位置を命令に埋め込まない:
     *
     *     adrp x8, _OBJC_IVAR_$_SceneDelegate._window@PAGE
     *     ldr  w8, [x8, …]          ← ここに +0x20 が入っている
     *     ldr  x0, [x0, x8]         ← self の中を、その位置で読む
     *
     * 命令には `#0x20` がどこにも出てこないので、ずらし幅だけを見ていると
     * 「self の何を読んでいるか」が永久に分からない。分かるのは
     * **どの位置変数を読んだか**で、それはこのアドレスで引ける。
     */
    const offsetVar = cleanPointer(get, readWord(get, b, 0));
    const offset = await ivarOffset(get, offsetVar);
    const name = await cstring(get, cleanPointer(get, readWord(get, b, layout.pointerBytes)));
    if (!name) continue;                      // 名前が読めないものだけ採らない
    const typeEnc = await cstring(get, cleanPointer(get, readWord(get, b, layout.ivarTypeOffset)));
    const rawSize = u32(b, layout.ivarSizeOffset);
    const size = rawSize > 0 && rawSize <= 4096 ? rawSize : null;
    if (offset == null) {
      markLegacyPartial(completeness, 'ivar-offset-unresolved', 'invalidIvars');
    } else if (!objcIvarRangeWithinInstance(offset, rawSize > 0 ? rawSize : null, instanceSize)) {
      markLegacyPartial(completeness, 'ivar-layout-out-of-bounds', 'invalidIvars');
      continue;
    }
    out.push({
      name,
      offset,
      offsetVar,
      size,
      type: decodeTypeEncoding(typeEnc),
    });
  }
  out.sort((a, b2) => {
    if (a.offset == null) return b2.offset == null ? 0 : 1;
    if (b2.offset == null) return -1;
    return a.offset - b2.offset;
  });
  return out;
}

/* ── プロパティ（@property）────────────────────────────────
 *
 * ivar の表と並んで、クラスには **宣言されたプロパティ** の表も残っている。
 * これが効くのは、ivar だけでは分からないことが 2 つ分かるため。
 *
 *   1. 人が書いた名前そのもの。ivar は `_hp` だが、プロパティは `hp`。
 *      さらに `_a1` のように潰された ivar でも、プロパティ名は残ることがある。
 *   2. 宣言された型。ivar の型エンコーディングより詳しいことが多く、
 *      `@"NSNumber"` なのか `i` なのかがはっきりする。
 *
 * 属性の文字列は `Ti,N,V_hp` のような形で、
 *   T… 型エンコーディング / V… 裏で使っている ivar の名前 /
 *   R 読み取り専用 / N nonatomic / & strong / C copy / W weak / G,S 別名のアクセサ
 * が並ぶ。V があれば「プロパティ名 ↔ ivar」の対応がそのまま取れる。
 */

/** `Ti,N,V_hp` をほどく。読めないものは黙って飛ばす。 */
export function parsePropertyAttributes(attr) {
  const out = { type: null, ivar: null, readonly: false, weak: false, getter: null, setter: null };
  const s = String(attr || '');
  if (!s) return out;
  // 型エンコーディングにはカンマが入らない（構造体は {..} の中に入る）ので、
  // 素直に区切ってよい。ただし {} と "" の中の区切りは守る。
  const parts = [];
  let depth = 0, quote = false, cur = '';
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    else if (!quote && (ch === '{' || ch === '(' || ch === '[')) depth++;
    else if (!quote && (ch === '}' || ch === ')' || ch === ']')) depth--;
    if (ch === ',' && depth === 0 && !quote) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);

  for (const p of parts) {
    const k = p[0];
    const v = p.slice(1);
    switch (k) {
      case 'T': out.type = v; break;
      case 'V': out.ivar = v; break;
      case 'R': out.readonly = true; break;
      case 'W': out.weak = true; break;
      case 'G': out.getter = v; break;
      case 'S': out.setter = v; break;
      default: break;
    }
  }
  return out;
}

/** property_list_t を読む。読めない項目は黙って飛ばす。 */
async function readProperties(get, listAddr) {
  const out = [];
  if (listAddr == null) return out;
  const head = await get(listAddr, 8);
  if (!head) return out;
  const entsize = u32(head, 0);
  const count = u32(head, 4);
  if (!count || count > MAX_PROPS) return out;
  const layout = legacyLayout(pointerBytesOf(get));
  const stride = entsize & 0xffff;
  if (stride < layout.propStride) return out;

  for (let i = 0; i < count; i++) {
    const entry = listAddr + 8n + BigInt(i) * BigInt(stride);
    const b = await get(entry, layout.propStride);
    if (!b) break;
    const name = await cstring(get, cleanPointer(get, readWord(get, b, 0)));
    if (!name) continue;
    const attrText = await cstring(get, cleanPointer(get, readWord(get, b, layout.pointerBytes)));
    const attrs = parsePropertyAttributes(attrText);
    out.push({
      name,
      ivar: attrs.ivar,
      readonly: attrs.readonly,
      weak: attrs.weak,
      getter: attrs.getter || name,
      setter: attrs.setter || ('set' + name.charAt(0).toUpperCase() + name.slice(1) + ':'),
      type: attrs.type ? decodeTypeEncoding(attrs.type) : null,
      attributes: attrText || null,
    });
  }
  return out;
}

async function readProtocolList(get, listAddr, completeness = null) {
  const out = [];
  if (listAddr == null) return out;
  const pointerBytes = pointerBytesOf(get);
  const head = await get(listAddr, pointerBytes);
  if (!head || head.length < pointerBytes) { markLegacyPartial(completeness, 'protocol-list-unreadable', 'invalidProtocols'); return out; }
  const declared = readWord(get, head, 0);
  if (declared === 0n) return out;
  if (declared > BigInt(MAX_PROTOCOLS)) { markLegacyPartial(completeness, 'protocol-list-capped', 'invalidProtocols'); return out; }
  for (let i = 0; i < Number(declared); i++) {
    const slot = listAddr + BigInt(pointerBytes) + BigInt(i * pointerBytes);
    const raw = await get(slot, pointerBytes);
    if (!raw || raw.length < pointerBytes) { markLegacyPartial(completeness, 'protocol-entry-unreadable', 'invalidProtocols'); continue; }
    const address = cleanPointer(get, readWord(get, raw, 0));
    if (address == null) { markLegacyPartial(completeness, 'protocol-pointer-unresolved', 'invalidProtocols'); continue; }
    const nameCell = await get(address, pointerBytes * 2);
    const name = nameCell ? await cstring(get, cleanPointer(get, readWord(get, nameCell, pointerBytes))) : null;
    if (!name) { markLegacyPartial(completeness, 'protocol-name-invalid', 'invalidProtocols'); continue; }
    out.push({ name, address });
  }
  if (out.length !== Number(declared)) markLegacyPartial(completeness, 'protocol-list-incomplete', 'invalidProtocols');
  return out;
}

/** クラス 1 つぶん（インスタンスメソッドとクラスメソッドの両方）。 */
async function readClass(get, classAddr, out, seen, meta, completeness = null) {
  if (classAddr == null || seen.has(classAddr.toString())) return null;
  seen.add(classAddr.toString());

  const layout = legacyLayout(pointerBytesOf(get));
  const cls = await get(classAddr, layout.classSize);
  if (!cls || cls.length < layout.classSize) { markLegacyPartial(completeness, 'class-unreadable'); return null; }
  const roAddr = cleanPointer(get, readWord(get, cls, layout.classData) & layout.alignmentMask);
  if (roAddr == null) { markLegacyPartial(completeness, 'class-ro-unresolved'); return null; }
  /*
   * 短くても受け取る。baseProperties まで読めるとうれしいが、そこまで
   * 載っていない表もある。「プロパティが読めない」を理由にクラスごと
   * 捨ててしまうと、いちばん大事な ivar の名前まで失う。
   */
  const ro = await get(roAddr, layout.roSize, true);
  if (!ro || ro.length < layout.roIvars + layout.pointerBytes) { markLegacyPartial(completeness, 'class-ro-unreadable'); return null; }

  const name = await cstring(get, cleanPointer(get, readWord(get, ro, layout.roName)));
  if (!name) { markLegacyPartial(completeness, 'class-name-invalid'); return null; }

  const before = out.length;
  await readMethods(get, cleanPointer(get, readWord(get, ro, layout.roMethods)), out, name,
    meta ? '+' : '-', MAX_METHODS, completeness);
  const methods = out.slice(before);

  const info = {
    name,
    addr: classAddr,
    meta: !!meta,
    superAddr: cleanPointer(get, readWord(get, cls, layout.classSuper)),
    instanceSize: u32(ro, layout.roInstanceSize),
    methods,
    ivars: [],
    properties: [],
  };

  // ivar とプロパティはインスタンス側にしかない（クラスメソッド側には持たせない）
  if (!meta) {
    try {
      info.ivars = await readIvars(get, cleanPointer(get, readWord(get, ro, layout.roIvars)), info.instanceSize, completeness);
    } catch { info.ivars = []; }
    try {
      // 表が短くて baseProperties まで届かないことがある。届かなければ空のまま。
      if (ro.length >= layout.roProps + layout.pointerBytes) {
        info.properties = await readProperties(get, cleanPointer(get, readWord(get, ro, layout.roProps)));
      }
    } catch { info.properties = []; }
    try {
      if (ro.length >= layout.roProtocols + layout.pointerBytes) {
        info.protocols = await readProtocolList(get, cleanPointer(get, readWord(get, ro, layout.roProtocols)), completeness);
      }
    } catch { info.protocols = []; }
  }

  // isa はメタクラス。そちらにクラスメソッド（+）が入っている。
  if (!meta) {
    const isa = cleanPointer(get, readWord(get, cls, layout.classIsa));
    if (isa != null) {
      const metaInfo = await readClass(get, isa, out, seen, true, completeness);
      if (metaInfo && metaInfo.methods) info.classMethods = metaInfo.methods;
    }
  }
  return info;
}

/**
 * __objc_classlist をたどって、クラスの一覧をまるごと作る。
 *
 * 返すのは「アプリがどんな部品でできているか」そのもの。
 * 関数を数万個並べる代わりに、この単位で見せるのがこのツールの入口になる。
 *
 * @param {function} read  async (addr:BigInt, len:number) => Uint8Array|null
 * @param {{vmAddr:BigInt, size:BigInt}} classList  __objc_classlist の範囲
 * @param {function} [onProgress]
 * @param {BigInt} [imageBase] イメージの先頭（__TEXT の vmaddr）。
 *   chained fixups のポインタを組み立てるのに要る。渡されなければ
 *   クラス表の位置から推定する（iOS のアプリは 4 GiB 境界に置かれる）。
 */
export async function buildObjcModel(read, classList, onProgress, imageBase, pointerFormat, options = {}) {
  const names = [];
  const classes = [];
  const seen = new Set();
  if (!classList || !classList.size) {
    const classesCompleteness = newLegacyCompleteness(false, 0);
    classesCompleteness.complete = true;
    return { classes, names, count: 0, completeness: { classes: classesCompleteness, complete: true } };
  }

  const pointerAbi = resolveObjcPointerBytes(options, classList);
  if (pointerAbi.bytes == null) {
    // A declared but unsupported pointer ABI must not be silently read as LP64.
    const classesCompleteness = newLegacyCompleteness(true, 0);
    classesCompleteness.complete = false;
    classesCompleteness.sizeValid = false;
    classesCompleteness.misalignedBytes = null;
    classesCompleteness.reasons.push(pointerAbi.reason);
    return { classes: [], names: [], count: 0, pointerBytes: null,
      pointerAbiReason: pointerAbi.reason,
      completeness: { classes: classesCompleteness, complete: false } };
  }
  const PTR = pointerAbi.bytes;
  const size = BigInt(classList.size);
  const sizeValid = size >= 0n && size <= BigInt(Number.MAX_SAFE_INTEGER);
  const declared = sizeValid ? Number(size / BigInt(PTR)) : 0;
  const classesCompleteness = newLegacyCompleteness(true, declared);
  classesCompleteness.sizeValid = sizeValid;
  classesCompleteness.misalignedBytes = sizeValid ? Number(size % BigInt(PTR)) : null;
  classesCompleteness.capped = declared > MAX_CLASSES;
  classesCompleteness.complete = sizeValid && classesCompleteness.misalignedBytes === 0 && !classesCompleteness.capped;
  if (!sizeValid) markLegacyPartial(classesCompleteness, 'class-list-size-invalid');
  if (classesCompleteness.misalignedBytes) markLegacyPartial(classesCompleteness, 'class-list-size-misaligned');
  if (classesCompleteness.capped) markLegacyPartial(classesCompleteness, 'class-budget');

  const get = pagedReader(read, 65536, 96, { signal: options?.signal });
  get.pointerBytes = PTR;
  get.base = imageBase != null
    ? BigInt(imageBase)
    : (classList.vmAddr / 0x100000000n) * 0x100000000n;
  get.pointerFormat = pointerFormat ?? classList.pointerFormat ?? classList.pointer_format ?? null;
  get.validateImplementation = typeof options.validateImplementation === 'function' ? options.validateImplementation : null;
  get.requireImplementationProof = options.requireImplementationProof === true;
  const total = Math.min(declared, MAX_CLASSES);

  for (let i = 0; i < total && names.length < MAX_METHODS; i++) {
    if (options?.signal?.aborted) {
      markLegacyPartial(classesCompleteness, 'cancelled');
      break;
    }
    if ((i & 63) === 0 && i > 0) {
      await new Promise((r) => setTimeout(r, 0));
      if (options?.signal?.aborted) {
        markLegacyPartial(classesCompleteness, 'cancelled');
        break;
      }
    }
    const slot = classList.vmAddr + BigInt(i) * BigInt(PTR);
    let ptr;
    try { ptr = await pointer(get, slot); }
    catch { markLegacyPartial(classesCompleteness, 'class-slot-unreadable', 'unreadableSlots'); break; }
    classesCompleteness.scanned++;
    if (ptr == null) { markLegacyPartial(classesCompleteness, 'class-pointer-unresolved', 'invalidEntries'); continue; }
    try {
      const info = await readClass(get, ptr, names, seen, false, classesCompleteness);
      if (info) classes.push(info);
      else markLegacyPartial(classesCompleteness, 'class-invalid', 'invalidEntries');
    } catch { markLegacyPartial(classesCompleteness, 'class-parse-error', 'invalidEntries'); }
    if (onProgress && (i & 63) === 0) onProgress(total ? i / total : 1);
  }
  if (names.length >= MAX_METHODS && classesCompleteness.scanned < total) {
    markLegacyPartial(classesCompleteness, 'method-budget');
  }
  classesCompleteness.parsed = classes.length;
  if (classesCompleteness.scanned < total) markLegacyPartial(classesCompleteness, 'class-scan-incomplete');
  if (onProgress) onProgress(1);

  // 親クラスの名前を解決しておく（部品の系統が見えるようにする）
  const byAddr = new Map(classes.map((c) => [c.addr.toString(), c]));
  for (const c of classes) {
    const parent = c.superAddr != null ? byAddr.get(c.superAddr.toString()) : null;
    c.superName = parent ? parent.name : null;
  }
  return {
    classes, names, count: classes.length, pointerBytes: PTR,
    completeness: { classes: classesCompleteness, complete: classesCompleteness.complete === true },
  };
}

/**
 * 実装アドレス → 名前 の一覧だけが欲しいとき（既存の呼び出し元向け）。
 */
export async function buildObjcNames(read, classList, onProgress, imageBase, pointerFormat) {
  const model = await buildObjcModel(read, classList, onProgress, imageBase, pointerFormat);
  return { names: model.names, classes: model.count };
}
