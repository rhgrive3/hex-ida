/*
 * 「で、この処理は具体的に何をしているの？」に、命令だけで答える層。
 *
 * このツールの一覧に並ぶのは、ずっとこういう行だった:
 *
 *     sub_100036588
 *     0x100036588
 *     中で数値の計算をしている（45 回の掛け算）
 *
 * 45 回の掛け算をしている関数は、このアプリに何万個もある。読む人は
 * 「関係あるかもしれない」以上のことを 1 つも受け取れない。開いて、
 * 1339 命令を自分で読むしかない。それは半分手作業のままということ。
 *
 * ここが答えるのはその 1 つ下の段:
 *
 *     別のオブジェクトの +0x9f4 の値を掛け算した結果ぶん、
 *     オブジェクトの +0x30（4 バイト）を減らして、同じ場所へ書き戻す。
 *     0 未満にはしない。0x100448f0 にその 5 命令がある。
 *
 * ここまで言えれば、名前が 1 文字も残っていないアプリでも
 * 「これは体力を削る処理だ」と読む人の側で判断できる。しかも書いてあることは
 * 全部、その場で逆アセンブルして確かめられる事実だけになっている。
 *
 * 材料は dataflow.js（どこを書き換えたか・いくらぶんか）と、
 * blocks.js が数えた事実（呼び出し・ループ・比較）だけ。推測はしない。
 *
 * 日本語は 1 文字も作らない。コードと数字を返し、文にするのは narrate.js。
 */
import { findValueUpdates, amountOf, constantComparisons } from './dataflow.js';
import { apiInfo } from './blocks.js';

/*
 * 1 か所の書き換えが「何をしたか」。
 *
 * ここに並べてあるのは **workOf が実際に返すものだけ**。「初期化する」「更新する」
 * のような、命令の形が伴わない言葉は入れない（入れた瞬間に、当てずっぽうを
 * 事実の顔で出すことになる）。関数まるごとの見出しは headlineOf の側。
 */
export const WORK = {
  DRAIN: 'drain',           // 別のオブジェクトの値ぶん減らす（ダメージの適用）
  FEED: 'feed',             // 別のオブジェクトの値ぶん増やす（回復・加算）
  DECREASE: 'decrease',     // 決まった量だけ減らす
  INCREASE: 'increase',     // 決まった量だけ増やす
  SCALE: 'scale',           // 倍率を掛ける
  SHRINK: 'shrink',         // 割り算・右シフトで減らす
  SET: 'set',               // 別の値をそのまま入れる
  CLEAR: 'clear',           // 0 を入れる
  READ: 'read',             // 読んで返すだけ
};

/* steps の演算 → 向き。1 つの更新につき 1 つに決める。 */
const DOWN_OPS = new Set(['sub', 'subs', 'msub', 'fsub']);
const UP_OPS = new Set(['add', 'adds', 'madd', 'fadd']);
const MUL_OPS = new Set(['mul', 'fmul', 'lsl']);
const DIV_OPS = new Set(['sdiv', 'udiv', 'fdiv', 'lsr', 'asr']);
const NON_COMMUTATIVE_OPS = new Set(['sub', 'subs', 'fsub', 'sdiv', 'udiv', 'fdiv', 'lsl', 'lsr', 'asr']);

/**
 * 1 件の更新を「何をしたか」に畳む。
 *
 * 向きは **最後に効いた演算** で決める。`mul` してから `sub` していれば
 * 「倍率を掛けた量を引いた」であって、掛け算の処理ではない。
 */
function workOf(u, amt) {
  if (u.kind === 'read') return WORK.READ;
  if (u.kind === 'write' || u.kind === 'move') {
    const imm = amt.amount && amt.amount.kind === 'imm' ? amt.amount.value : null;
    if (imm != null && (imm === 0 || imm === 0n)) return WORK.CLEAR;
    return WORK.SET;
  }
  const stepEntries = Array.isArray(u.steps) && u.steps.length
    ? u.steps
        .filter((s) => s && s.op && !s.signMaskClampPart)
        .map((s) => ({ op: s.op, sourceOnLeft: s.sourceOnLeft }))
    : (amt.ops || []).map((op) => ({
        op,
        sourceOnLeft: amt.amount && amt.amount.op === op ? amt.amount.sourceOnLeft : null,
      }));
  let dir = null;
  let scaleKind = null;
  for (const { op, sourceOnLeft } of stepEntries) {
    const inverted = NON_COMMUTATIVE_OPS.has(op) &&
      (sourceOnLeft === false || (sourceOnLeft == null && amt.amount && amt.amount.op === op && amt.amount.sourceOnLeft === false));
    if (inverted) continue;
    if (DOWN_OPS.has(op)) dir = 'down';
    else if (UP_OPS.has(op)) dir = 'up';
    else if (MUL_OPS.has(op)) scaleKind = WORK.SCALE;
    else if (DIV_OPS.has(op)) scaleKind = WORK.SHRINK;
  }
  const cross = amt.amount && amt.amount.kind === 'field' &&
    amt.amount.base && amt.amount.base !== u.location.base;
  if (dir === 'down') return cross ? WORK.DRAIN : WORK.DECREASE;
  if (dir === 'up') return cross ? WORK.FEED : WORK.INCREASE;
  if (scaleKind) return scaleKind;
  return WORK.SET;
}

/*
 * 「どれがいちばん言うに値する変更か」の重み。
 *
 * アプリの関数は、まず 20 件くらいスタックの一時置き場を書く。そこを主役にすると
 * 全部の関数が「スタックに値を置く処理」になってしまう。読む人が知りたいのは
 * **アプリが持っているデータのどこが変わったか** で、それは
 * スタックではない場所への読み書きにしか現れない。
 */
const WORK_WEIGHT = {
  [WORK.DRAIN]: 100, [WORK.FEED]: 80,
  [WORK.DECREASE]: 60, [WORK.INCREASE]: 55,
  [WORK.SCALE]: 40, [WORK.SHRINK]: 40, [WORK.CLEAR]: 20, [WORK.SET]: 15, [WORK.READ]: 10,
};

function changeWeight(c) {
  let w = WORK_WEIGHT[c.work] || 5;
  if (c.clamped) w += 25;            // 0 で止めているものは、ほぼ資源
  if (c.cappedBy) w += 30;           // 上限が別の値にある = 「今の値 / 上限」の組
  if (c.scaled) w += 10;
  if (c.amount && c.amount.kind === 'field') w += 15;
  if (c.amount && c.amount.kind === 'call') w += 8;
  if (c.self) w += 5;
  if (c.field) w += 30;              // 名前まで分かっているなら、それがいちばん強い
  /*
   * 大きさで、ゲームの数値と器の管理を分ける。
   *
   *   8 バイトを 1 増やす … ほぼポインタ送り（`p++` が `add x8, x8, #8` になる）
   *   4 バイトを 1 増やす … 数の増減
   *
   * ここを見ないと、6000 命令の関数の見出しがいつも
   * 「+0x3378（8 バイト）を増やす」になる。読む人には何も言っていない。
   */
  if (c.size === 4 || c.size === 2) w += 10;
  else if (c.size >= 8) w -= 25;
  return w;
}

/* 書式文字列。「%d」を埋めて文を組み立てる関数は、値そのものは触らない。 */
const FORMAT_RE = /%(?:[-+#0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|j|z|t|L)?[diouxXeEfFgGaAcspn@]| +[-+#0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|j|z|t|L)?[diouxXeEfFgGaA](?![A-Za-z]))/;

function isFormatString(text) {
  if (typeof text !== 'string' || !text.includes('%')) return false;
  // エスケープ済み %% を取り除き、数値直後の割合表記（50% off 等）や
  // URL 中のパーセントエンコード（%20, %2F 等）を除外してから判定する
  let stripped = text.replace(/%%/g, '');
  stripped = stripped.replace(/(\d)%(?=\s|$|[,.;:!?\)\]）」。、])/g, '$1');
  if (/https?:\/\//i.test(stripped)) {
    stripped = stripped.replace(/%[0-9A-Fa-f]{2}/g, '');
  }
  return FORMAT_RE.test(stripped);
}

function amountKey(a) {
  if (!a) return 'none';
  switch (a.kind) {
    case 'imm': return 'imm:' + String(a.value);
    case 'field': return 'field:' + (a.base || '') + '@' + (a.disp != null ? a.disp.toString() : '');
    case 'call': return 'call:' + (a.name || '');
    case 'arg': return 'arg:' + (a.index != null ? a.index : '');
    case 'stack': return 'stack:' + (a.disp != null ? a.disp.toString() : '');
    case 'global': return 'global:' + (a.addr != null ? a.addr.toString() : '');
    default: return String(a.kind || 'other');
  }
}

/**
 * 関数 1 つが「何をしているか」を、命令から確かめられる形で組み立てる。
 *
 * @param {object} o
 *   model    buildSemanticModel の結果（必須）
 *   fields   FieldIndex（あれば +0x30 を名前に置き換える）
 *   owner    その関数の持ち主クラス（あれば）
 *   addr     関数の先頭アドレス
 *   textAt   アドレス → 文字列。一覧向けの解析は文字列を読み込んでいないので、
 *            呼び出し側が持っている索引を渡す（無いと書式文字列が見えない）
 * @returns {object|null}
 */
export function describePurpose(o) {
  const model = o && o.model;
  if (!model) return null;
  const f = model.facts || {};
  const updates = Array.isArray(o.updates) ? o.updates : findValueUpdates(model);

  const changes = [];
  let locals = 0;
  for (const u of updates) {
    if (u.location.stack) { locals++; continue; }
    if (u.location.disp == null && u.location.indexAddr == null) continue;
    const amt = amountOf(model, u);
    const work = workOf(u, amt);
    const c = {
      work,
      base: u.location.base,
      disp: u.location.disp,
      size: u.location.size,
      self: !!u.location.self,
      indexAddr: u.location.indexAddr,
      field: null,
      amount: amt.amount,
      clamped: amt.clamped,
      cappedBy: amt.cappedBy,
      scaled: amt.scaled,
      ops: amt.ops,
      kind: u.kind,
      row: u.store.row,
      address: u.store.address,
      loadRow: u.from ? u.from.row : null,
      loadAddress: u.from ? u.from.address : null,
      confidence: u.confidence,
    };
    if (o.fields && o.owner) {
      /*
       * dataflow が証明した access provenance（self / 位置変数番地）を
       * そのまま resolver へ渡す。ここで落とすと、証明済み self が
       * ヒューリスティック certain:false に降格し、位置変数の ivar は
       * まったく解けなくなる（fields.js の certainty boundary と食い違う）。
       * また purpose.js は事実のみを扱うため certain === true の解決のみ採用する。
       */
      const resolved = o.fields.resolveAccess({ base: c.base, disp: c.disp, self: c.self, indexAddr: c.indexAddr }, o.owner.className);
      c.field = resolved && resolved.certain === true ? resolved : null;
    }
    changes.push(c);
  }
  /*
   * 同じ場所への同じ変更が何度も出てくる（インライン展開された関数）。
   * 変更量が異なる場合は別件として残し、同じものだけをまとめて回数を残す。
   */
  const merged = new Map();
  for (const c of changes) {
    const key = c.base + '@' + (c.disp != null ? c.disp.toString() : 'iv' + c.indexAddr) +
      '@' + c.work + '@' + amountKey(c.amount);
    const hit = merged.get(key);
    if (!hit) { c.n = 1; merged.set(key, c); continue; }
    hit.n++;
    if (!hit.clamped && c.clamped) hit.clamped = true;
    if (!hit.cappedBy && c.cappedBy) hit.cappedBy = c.cappedBy;
    if (!hit.amount && c.amount) hit.amount = c.amount;
  }
  const list = Array.from(merged.values());
  for (const c of list) c.weight = changeWeight(c) + Math.min(20, (c.n - 1) * 4);
  list.sort((a, b) => b.weight - a.weight);

  const compares = constantComparisons(model).slice(0, 6).map((c) => ({
    value: c.value, float: c.float, row: c.row, address: c.address || null,
  }));

  const callNames = [];
  const seenCallNames = new Set();
  const seenSelectors = new Set();
  const apis = [];
  const seenApis = new Set();
  for (const c of (f.calledNames || [])) {
    if (!c.name || seenCallNames.has(c.name)) continue;
    seenCallNames.add(c.name);
    callNames.push({ name: c.name, row: c.row });
    const api = apiInfo(c.name);
    if (api && !seenApis.has(api.id)) {
      seenApis.add(api.id);
      apis.push({ id: api.id, cat: api.cat });
    }
  }
  for (const c of (model.calls || [])) {
    if (c.selector && !seenSelectors.has(c.selector)) {
      seenSelectors.add(c.selector);
      callNames.push({ selector: c.selector, row: c.row });
    }
  }

  /*
   * 参照している文言。
   *
   * 一覧のために解析するときは文字列まで読み込んでいない（重いので）。
   * その場合は呼び出し側が持っている索引から引く。ここで諦めると、
   * 「%d を埋めて文を作っているだけ」という**いちばん効く見分け**が落ちる。
   */
  const textAt = o.textAt || null;
  const texts = [];
  const seenTexts = new Set();
  const formatTexts = [];
  const seenFormatTexts = new Set();
  let formats = 0;
  for (const s of (f.stringRefs || [])) {
    let text = s.text || null;
    if (!text && textAt && s.addr != null) {
      const hit = textAt(s.addr);
      text = hit ? hit.text : null;
    }
    if (!text) continue;
    if (isFormatString(text)) {
      formats++;
      if (formatTexts.length < 6 && !seenFormatTexts.has(text)) {
        seenFormatTexts.add(text);
        formatTexts.push({ text, addr: s.addr, row: s.row });
      }
    }
    if (texts.length < 6 && !seenTexts.has(text)) {
      seenTexts.add(text);
      texts.push({ text, addr: s.addr, row: s.row });
    }
  }

  const out = {
    addr: o.addr != null ? o.addr : (model.startAddress != null ? model.startAddress : null),
    instructions: f.instructionCount || (model.instructions || []).length,
    loops: f.loops || 0,
    calls: f.calls || 0,
    conditionals: f.conditionals || 0,
    stores: f.stores || 0,
    loads: f.loads || 0,
    changes: list.slice(0, 6),
    allChanges: list,
    locals,
    compares,
    callNames: callNames.slice(0, 8),
    apis,
    texts,
    formatTexts,
    formats,
    headline: null,
  };
  out.headline = headlineOf(out);
  return out;
}

/**
 * 「1 行で言うなら何か」。書けることが無ければ null を返す（埋めない）。
 */
function headlineOf(p) {
  const top = p.changes[0] || null;
  /*
   * 言い切るに足る変更があるか。
   *
   * 8 バイトの器の付け替えしか無い関数を「+0x3378 を増やす処理」と名乗ると、
   * 6000 命令の関数がぜんぶ同じ見出しになる。重みで足切りする。
   */
  const strong = top && top.weight >= 60 ? top : null;
  if (strong && strong.work !== WORK.READ) return { code: 'work-change', change: strong };
  if (top && top.work === WORK.READ && p.instructions <= 12) {
    return { code: 'work-accessor', change: top };
  }
  /*
   * 文言を組み立てる処理。
   *
   * 「攻撃力アップ:%d 基ダ×(100+%d)÷100」を参照している関数は、攻撃力の
   * 計算そのものではなく **説明文を作る処理**であることが多い。そこを
   * 「攻撃力の処理」とだけ言うと、読む人は計算式を探しに行って必ず迷う。
   * 書式文字列を埋めているという事実は命令から確かめられるので、そう言う。
   */
  /*
   * 大きすぎて 1 つの処理として言えない。
   *
   * インライン展開で 6000 命令になった関数に「何をする処理か」を 1 行で
   * 付けるのは、当てずっぽうにしかならない。決定的な変更（strong）が無いなら、
   * 弱い書き込みや繰り返しより先に「大きすぎる」と言う。
   */
  if (p.instructions >= 1200) {
    return { code: 'work-too-big', n: p.instructions, calls: p.calls };
  }
  /*
   * 文言を組み立てる処理。
   * 書式文字列に該当した文言だけを texts へ渡す。
   */
  if (p.formats >= 1 && p.calls >= 1 && !strong) {
    const fmtTexts = Array.isArray(p.formatTexts)
      ? p.formatTexts.slice(0, 2)
      : (p.texts || []).filter((x) => x && isFormatString(x.text)).slice(0, 2);
    return { code: 'work-format', n: p.formats, texts: fmtTexts };
  }
  // ObjC の非脆弱 ivar オフセット変数（indexAddr != null）や解決済み単一フィールドは
  // 配列への詰め込み（work-fill）ではないため除外する。
  const fillChange = p.loops
    ? p.changes.find((c) => c.work === WORK.SET && c.indexAddr == null && !c.field)
    : null;
  if (fillChange) {
    return { code: 'work-fill', change: fillChange, loops: p.loops };
  }
  if (top) return { code: 'work-change', change: top };
  if (!p.changes.length && p.calls >= 1 && p.instructions <= 64) {
    return { code: 'work-dispatch', calls: p.calls, names: p.callNames.slice(0, 3) };
  }
  if (p.compares.length && p.conditionals) {
    return { code: 'work-check', compares: p.compares.slice(0, 2), n: p.conditionals };
  }
  if (p.calls) return { code: 'work-dispatch', calls: p.calls, names: p.callNames.slice(0, 3) };
  return null;
}

/**
 * その関数は、渡された「場所」を書き換えているか。
 * 形から立てた候補（shapes.js）を、命令で裏取りするのに使う。
 *
 * @returns {object|null} 当てはまった変更
 */
export function changeAt(purpose, disp) {
  if (!purpose || disp == null) return null;
  const want = BigInt(disp);
  const list = purpose.allChanges || purpose.changes || [];
  for (const c of list) {
    if (c.disp != null && BigInt(c.disp) === want) return c;
  }
  return null;
}
