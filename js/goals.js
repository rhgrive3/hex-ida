/*
 * 「何を調べたいですか？」 — 目的から入るための語彙。
 *
 * 初心者は関数名を知らない。知っているのは「攻撃力を増やしたい」「コインを調べたい」
 * という目的だけ。そこでまず目的を受け取り、それをバイナリの中で探せる形
 * （語の並び ＋ 期待される命令の形）に翻訳する。
 *
 * ここは語彙だけを持ち、点数付けはしない（点数は rank.js）。
 * 日本語で書かれたアプリと英語で書かれたアプリの両方を想定して、
 * どちらの語も入れてある。
 *
 * 大事な注意: ここに並んでいるのは「手がかりの語」であって「正解」ではない。
 * 語が一致しただけでは何も証明しない。証明の材料は参照関係と命令の実在（rank.js）。
 */
import { pick } from './i18n.js';

/*
 * 目的 1 つぶん。
 *   terms   … 手がかりの語。strong は具体的な語、weak はよくある一般語。
 *   expects … その目的の処理なら「命令の形として」何が出るはずか。
 *             numeric: 数値計算がある / store: 値を書き換える /
 *             compare: しきい値と比べる / call: ほかを呼ぶ
 */
export const GOALS = [
  {
    id: 'hp', ja: 'HP・体力', en: 'HP / health', icon: '❤️',
    strong: [/\bhp\b/i, /health/i, /\blife\b/i, /体力/, /ライフ/, /耐久/],
    weak: [/damage/i, /ダメージ/, /heal/i, /revive/i, /回復/, /死亡/, /\bdie\b/i],
    /*
     * health は体力とは限らない。広告 SDK の死活監視（healthCheck）や
     * 端末情報（healthPercentile）まで拾うと、HP を探した人に
     * IronSource の通信設定が並ぶ。同じことが lifecycle / lifetime にも起きる。
     */
    avoid: [
      /health[\s_-]*(check|monitor|status|state|report|percentile|kit|store|data|probe|endpoint)/i,
      /life[\s_-]*(cycle|time|span|line)/i,
      /battery[\s_-]*(?:health|life)/i,
      /(?:half|shelf)[\s_-]*life/i,
      /(?:hp|health)[\s_-]*(bar|label|gauge|view|icon|meter|slider|text|ui)\b/i,
    ],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'attack', ja: '攻撃力', en: 'Attack power', icon: '⚔️',
    strong: [/attack/i, /\batk\b/i, /power/i, /strength/i, /攻撃/, /こうげき/, /威力/],
    weak: [/damage/i, /weapon/i, /skill/i, /武器/, /スキル/],
    avoid: [
      /power[\s_-]*(?:info|state|mode|sav(?:e|ing)|supply|management|battery|adapter|source|of[\s_-]*(?:2|two|10|ten)|consumption|usage|budget|button|key|off|on|thermal|up[\s_-]*self[\s_-]*test)/i,
      /(?:signal|wifi|password|encryption|blur|shadow)[\s_-]*strength/i,
      /\b(?:(?:c|name)[\s_-]*)?str[\s_-]*(?:len|size|buf|ptr|cpy|cmp)\b/i,
    ],
    expects: { numeric: true, store: true },
  },
  {
    id: 'defense', ja: '防御力', en: 'Defence', icon: '🛡️',
    strong: [/defen[cs]e/i, /\bdef\b/i, /armor|armour/i, /resist/i, /防御/, /ぼうぎょ/, /耐性/],
    weak: [/guard/i, /shield/i, /盾/],
    avoid: [
      /(?:scope|raii|unlock|lock)[\s_-]*guard/i,
      /driver[\s_-]*shield/i,
      /(?:body|fixture|shape|type)[\s_-]*def/i,
      /(?:completion|callback|handler|memory|code|cipher)[\s_-]*block/i,
      /block[\s_-]*(?:size|count|index|offset)/i,
      /irresistible/i,
    ],
    expects: { numeric: true, store: true },
  },
  {
    id: 'damage', ja: 'ダメージ計算', en: 'Damage calculation', icon: '💥',
    strong: [/damage/i, /\bdmg\b/i, /ダメージ/, /被弾/],
    weak: [/critical/i, /hit/i, /attack/i, /クリティカル/, /命中/],
    avoid: [
      /hit[\s_-]*(?:test|slop)/i,
      /white|hitch|match[\s_-]*iterator/i,
      /cache[\s_-]*hit/i,
      /critical[\s_-]*(?:section|error|log|alert|failure|level)/i,
    ],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'money', ja: '所持金・コイン', en: 'Money and coins', icon: '🪙',
    strong: [/\bcoin/i, /\bgold\b/i, /\bgems?\b/i, /diamond/i, /crystal/i, /jewel/i, /money/i, /currency/i, /wallet/i,
      /コイン/, /ゴールド/, /所持金/, /ジェム/, /石/, /通貨/],
    weak: [/balance/i, /amount/i, /price/i, /cost/i, /残高/, /金額/],
    /*
     * `currency` は `concurrency` の中にも入っている。これを外さないと
     * 所持金を探した人の首位が IronSource の
     * `useWaterfallLifecycleHolderConcurrency` になる（実際になっていた）。
     * `bid_floor_currency` のほうは綴りは正しいが、広告の入札下限額であって
     * ゲームの所持金ではないので、語ごと外す。
     */
    avoid: [
      /(?:multi[\s_-]*)?concurren(cy|t)/i,
      /\bbid[\s_-]*floor(?:[\s_-]*(?:currency|price|amount|usd|cpm|ecpm|value|rate)\b|\w*)/i,
      /\blocale\b|\bnslocale\b|currency[\s_-]*(?:identifier|code|symbol|formatter)|number[\s_-]*formatter/i,
      /price[\s_-]*floor(?:[\s_-]*(?:currency|price|amount|usd|cpm|ecpm|value|rate)\b|\w*)/i,
      /costume|acoustic|coincid(?:e|ent|ence)/i,
      /(?:white|load|audio|stereo|color|channel)[\s_-]*balance/i,
    ],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'gacha', ja: 'ガチャ・抽選', en: 'Gacha / loot', icon: '🎰',
    strong: [/gacha/i, /lottery/i, /\bdraw\b/i, /summon/i, /ガチャ/, /抽選/, /召喚/],
    weak: [/rate/i, /probability/i, /rare/i, /reward/i, /確率/, /レア/, /排出/],
    avoid: [
      /generat(?:e|ed|es|or)|iterat(?:e|ed|es|or)|operat(?:e|ed|es|or)|separat(?:e|ed|es)|accelerat(?:e|ed|es)|migrat(?:e|ed|es)|integrat(?:e|ed|es)|accurate|strategy|infrared|rarely/i,
      /(?:frame|sample|bit|refresh|baud|heart|tick|error|hit|miss|deceleration|data|sampling|polling)[\s_-]*rate/i,
      /enumerate[\s_-]*interfaces/i,
      /draw[\s_-]*(?:call|rect|in[\s_-]*rect|mesh|sprite|text|image|line|path|layer|buffer|pass|order|mode|index(?:ed)?|array|element|primitive|vertex|quad|triangle|canvas|context|surface|texture|shadow|view|node|gizmo|batch)/i,
      /(?:MarketingAd|AdUnit|AdView|AdBanner|AdInterstitial|AdRewarded)\w*.*draw\b/i,
    ],
    expects: { numeric: true, call: true },
  },
  {
    id: 'purchase', ja: '購入・課金', en: 'Purchases', icon: '💳',
    strong: [/purchase/i, /payment/i, /billing/i, /receipt/i, /storekit/i, /\biap\b/i,
      /in[\s_-]?app/i, /\bsku\b/i, /entitlement/i, /transaction/i,
      /subscrib\w*/i, /subscription/i, /premium/i, /\bvip\b/i,
      /課金/, /購入/, /決済/, /レシート/, /プレミアム/, /サブスク/],
    weak: [/price/i, /product/i, /restore/i, /価格/, /商品/],
    avoid: [
      /(?:ca|sql|sqlite|db|database|realm|core[\s_-]*data|begin|commit|rollback|write|read)[\s_-]*transaction/i,
      /restore[\s_-]*(?:g[\s_-]*state|state|context|window|view|frame|layout|focus|graphics|matrix|transform)/i,
      /(?:event|topic|channel|pub[\s_-]*sub|observable|stream|notification|signal|redis|mqtt)[\s_-]*subscrib\w*/i,
      /subscrib\w*[\s_-]*(?:event|topic|channel|observer|listener|callback)/i,
    ],
    expects: { call: true, compare: true },
  },
  {
    id: 'login', ja: 'ログイン・認証', en: 'Login', icon: '🔑',
    strong: [/login/i, /logout/i, /sign_?in/i, /auth/i, /credential/i, /password/i, /token/i,
      /ログイン/, /認証/, /パスワード/],
    weak: [/account/i, /session/i, /user_?id/i, /アカウント/, /会員/],
    avoid: [
      /author(?:s|ed|ing|ship|itative)?/i,
      /(?:tokeniz\w*|lexer|parser|syntax|json|xml|ast)[\s_-]*token/i,
      /token[\s_-]*(?:izer|ize|type|kind|stream)/i,
      /(?:url|audio|capture|media|playback)[\s_-]*session/i,
      /\b(?:ar|vr|wc)[\s_-]*session/i,
    ],
    expects: { call: true, compare: true },
  },
  {
    id: 'ads', ja: '広告', en: 'Advertising', icon: '📺',
    strong: [/remove[\s_-]*ads?/i, /no[\s_-]*ads?/i, /ad[\s_-]*free/i, /hide[\s_-]*ads?/i, /disable[\s_-]*ads?/i,
      /広告(?:を)?(?:消|非表示|削除|オフ|除去|なし)/,
      /interstitial/i, /rewarded/i, /banner_?ad/i, /広告/,
      /admob/i, /unityads/i, /applovin/i, /ironsource/i, /vungle/i, /tapjoy/i],
    weak: [/\bads?\b/i, /impression/i, /campaign/i],
    avoid: [/\bad[\s_-]*hoc\b/i],
    expects: { call: true },
  },
  {
    id: 'save', ja: 'セーブ・保存', en: 'Save data', icon: '💾',
    strong: [/save_?data/i, /savefile/i, /autosave/i, /userdefault/i, /nskeyedarchiv/i,
      /セーブ/, /保存/, /記録/],
    weak: [/write/i, /store/i, /persist/i, /progress/i, /進行/],
    avoid: [
      /restore|store[\s_-]*kit|store[\s_-]*front|store[\s_-]*view/i,
      /(?:app|play)[\s_-]*store/i,
      /(?:power|battery|energy)[\s_-]*sav(?:e|ing)/i,
      /save[\s_-]*(?:g[\s_-]*state|graphics|context|matrix|transform)/i,
    ],
    expects: { call: true, store: true },
  },
  {
    id: 'network', ja: '通信', en: 'Server communication', icon: '🌐',
    strong: [/https?:\/\//i, /nsurlsession/i, /endpoint/i, /\/api\//i, /\/v\d\//i,
      /websocket/i, /request/i, /通信/, /サーバー/],
    weak: [/response/i, /json/i, /header/i, /timeout/i, /接続/],
    avoid: [
      /request[\s_-]*(?:animation[\s_-]*frame|layout|focus|redraw|render|review|permission)/i,
      /(?:table|section|file|mach|elf|zip|png|wav)[\s_-]*header/i,
      /(?:audio|capture|media)[\s_-]*session/i,
      /\b(?:ar|vr|wc)[\s_-]*session/i,
    ],
    expects: { call: true },
  },
  {
    id: 'score', ja: 'スコア', en: 'Score', icon: '🏆',
    strong: [/\bscore\b/i, /ranking/i, /leaderboard/i, /highscore/i, /スコア/, /得点/, /ランキング/],
    weak: [/point/i, /result/i, /record/i, /順位/],
    avoid: [
      /pointer|null[\s_-]*ptr|appoint/i,
      /(?:end|break|check|entry|floating|code|mid|cg|focal|touch)[\s_-]*point/i,
      /(?:audio|video|voice|screen|dns)[\s_-]*record/i,
    ],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'level', ja: 'レベル・経験値', en: 'Level and EXP', icon: '⬆️',
    strong: [/level_?up/i, /\blevel\b/i, /\bexp\b/i, /experience/i, /レベル/, /経験値/, /ランクアップ/],
    weak: [/upgrade/i, /grow/i, /rank/i, /強化/, /育成/],
    avoid: [
      /(?:log|verbosity|battery|zoom|compression|mip(?:map)?|window|api|feature|debug|error|warning|trace|severity|nesting|indent|low)[\s_-]*level/i,
      /(?:MarketingAd|Ad|Log|Logger|Trace|Debug|Console|Severity)\w*Error.*level\b/i,
      /\b(?:alloc(?:ator)?|prev->levels|even one level|level\s*>=\s*1|skiplist\w*)\b|lla_skiplist\w*/i,
      /(?:crank|frank|prank|drank|shrank)/i,
      /^_*(?:exp|exp2|exp10|expm1|frexp|ldexp)$/i,
      /\b(?:exp10|exp2|expm1|frexp|ldexp|exponent|expect|expand|export|explicit|expression|exception)\b/i,
    ],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'stamina', ja: 'スタミナ', en: 'Stamina', icon: '⚡',
    strong: [/stamina/i, /energy/i, /\bap\b/i, /スタミナ/, /行動力/],
    weak: [/recover/i, /consume/i, /回復/, /消費/],
    avoid: [
      /low[\s_-]*energy/i,
      /energy[\s_-]*(?:impact|usage|saving|efficiency|consumption|mode|budget|state)/i,
    ],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'item', ja: 'アイテム・所持品', en: 'Items', icon: '🎒',
    strong: [/inventory/i, /item_?id/i, /equipment/i, /アイテム/, /所持品/, /装備/],
    weak: [/count/i, /quantity/i, /material/i, /個数/, /素材/],
    avoid: [
      /account|country|discount|encounter/i,
      /(?:menu|tab[\s_-]*bar|bar[\s_-]*button|nav(?:igation)?|tool[\s_-]*bar|list|collection[\s_-]*view|status|accessibility)[\s_-]*items?/i,
      /material[\s_-]*(?:design|shader|texture|pbr|diffuse|specular|albedo|metallic|roughness)/i,
      /\bad[\s_-]*inventory\b/i,
      /(?:MarketingAd|AdUnit|AdUser|AdSlot|AdRequest|AdPlacement)\w*.*inventory/i,
    ],
    expects: { numeric: true, store: true },
  },
  {
    id: 'anticheat', ja: 'チート対策・改造検知', en: 'Anti-cheat', icon: '🚨',
    strong: [/jailbreak|jailbroken/i, /cydia/i, /frida(?!y)/i, /substrate/i, /tamper/i,
      /\b(?:rooted|rooting|root[\s_-]*(?:detect|check|guard|jail|access|device|bypass))\b/i, /magisk/i, /ptrace/i, /ssl[\s_-]*pinning/i,
      /integrity/i, /debugger/i, /cheat/i, /改造/, /不正/],
    weak: [/detect/i, /verify/i, /signature/i, /検知/],
    avoid: [
      /secure[\s_-]*(?:text[\s_-]*entry|coding|enclave|connection|socket|transport|cookie|channel)/i,
      /(?:method|type|function|selector|block)[\s_-]*signature/i,
    ],
    expects: { compare: true, call: true },
  },
  {
    id: 'speed', ja: '移動速度・スピード', en: 'Speed / movement', icon: '💨',
    strong: [/\bspeed\b/i, /speed[\s_-]*up/i, /move[\s_-]*speed/i, /velocity/i, /移動速度/, /スピード/, /速度/, /素早さ/],
    weak: [/accel/i, /\bpace\b/i, /\btempo\b/i, /\bwalk\b/i, /\brun\b/i, /敏捷/],
    avoid: [
      /white[\s_-]*space|coordinate[\s_-]*space|name[\s_-]*space|work[\s_-]*space|drag[\s_-]*gesture|minimum[\s_-]*distance|run[\s_-]*loop|run[\s_-]*on[\s_-]*(?:shared|main|background|ui)?[\s_-]*thread/i,
      /(?:download|upload|network|transfer|connection|playback|scroll|fan|clock|baud|cpu|gpu|link|write|read|disk|bit)[\s_-]*speed/i,
      /speed[\s_-]*(?:test|dial|limit|bump)/i,
      /(?:angular|scroll|swipe|pan|drag|flick|fling|scroll[\s_-]*view)[\s_-]*velocity/i,
      /velocity[\s_-]*(?:tracker|in[\s_-]*view)/i,
    ],
    expects: { numeric: true, store: true },
  },
  {
    id: 'cooldown', ja: 'クールダウン・CT', en: 'Cooldown', icon: '⏱️',
    strong: [/cool[\s_-]*down/i, /\brecast\b/i, /\bcd\b/i, /クールダウン/, /再使用/],
    weak: [/reload/i, /interval/i, /delay/i, /timer/i, /待機時間/],
    avoid: [
      /\bcd[\s_-]*(?:rom|key|drive|player|track|audio|image|dir|path)\b/i,
      /\b(?:device|type|user|item|error|err|status|state|area|country|lang|shop|store|stage|event|char|unit|card|kind|group|category|mode|result|ret|http|zip|postal|pref|currency|client|server|app|os|platform|model|vendor|media|ad|campaign|promo|coupon|serial|product|order)[\s_-]*cd\b/i,
      /(?:gcd|lcd|bcd|mcd|acd|icd|rcd|ucd)\b/i,
      /(?:retry|reconnect|poll|polling|flush|heartbeat|sync|refresh|ping|animation|debounce|throttle|timeout|date|reload|update|location|banner)[\s_-]*(?:interval|delay)/i,
      /scheduleUpdateAfterInterval|onReloadInterval|viewability[\w\s-]*|anime[\s_-]*interval|animation[\s_-]*interval|cmtime\w*|repeatable[\s_-]*timer|block[\s_-]*queue|url[\s_-]*request|cache[\s_-]*policy/i,
      /reload[\s_-]*(?:data|table|section|row|view|page|url|webview|config|script)|\bpreload\b|package\.preload/i,
    ],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'crypto', ja: '暗号化・ライセンス', en: 'Crypto / license', icon: '🔐',
    strong: [/encrypt\w*/i, /decrypt\w*/i, /cipher/i, /\baes\b/i, /\brsa\b/i, /licen[cs]e/i,
      /暗号化?/, /復号/, /ライセンス/, /鍵/, /キー/],
    weak: [/\bcrypto\b/i, /\bhmac\b/i, /\bsha(?:1|256|512)\b/i, /\bkey\b/i, /serial/i, /activation/i, /署名/],
    avoid: [
      /(?:key[\s_-]*(?:board|code|down|up|press|event|pad|chain|frame|path|window|word|value|binding|map|name|index|id|set|list|store|storage)|primary[\s_-]*key|foreign[\s_-]*key|sort[\s_-]*key|cache[\s_-]*key|hot[\s_-]*key|shortcut[\s_-]*key|enter[\s_-]*key|escape[\s_-]*key|arrow[\s_-]*key|meta[\s_-]*key|shift[\s_-]*key|ctrl[\s_-]*key)/i,
      /(?:キー(?:ボード|入力|操作|バインド|コード|フレーム|ワード)|ホットキー|ショートカットキー)/,
      /(?:mit|apache|bsd|gpl|lgpl|mpl|isc|zlib|open[\s_-]*source|third[\s_-]*party|copyright|notice|spdx)[\s_-]*licen[cs]e/i,
      /licen[cs]e[\s_-]*(?:text|file|notice|header|agreement|url|link|page|view|dialog)/i,
    ],
    expects: { call: true, compare: true, crypto: true },
  },
];

/* ── 値（フィールド）の名前をあてるための語彙 ────────────────
 *
 * 上の strong / weak は「画面に出る文言」を想定して書いてある。ところが
 * メンバ変数の名前はそれとは書き方がまるで違う。
 *
 *     文言:   「HP が足りません」「ダメージ %d」
 *     変数名:  _hp  _currentHP  m_hitPoint  hpMax
 *
 * さらに厄介なのは `\bhp\b` が `_hp` に当たらないこと（`_` は単語の文字なので
 * 単語の境目にならない）。これを直さないと、いちばん効くはずの
 * 「クラス表に書いてある名前」がまるごと素通りしてしまう。
 *
 * そこで名前を正規化してから当てる。`_currentHP` → `current hp`。
 * ついでに「今の値なのか、上限なのか、初期値なのか」（役割）も見る。
 * HP を増やしたい人が触りたいのは `hp` であって `maxHp` ではないので、
 * ここを見分けられるかどうかで「1 位が正解かどうか」が変わる。
 */

/** `_currentHP` → `current hp`。当てはめはすべてこの形に対してやる。 */
export function normalizeFieldName(name) {
  if (typeof name !== 'string') return '';
  let s = name;
  s = s.replace(/^_+/, '').replace(/^m_/i, '').replace(/^s_/i, '').replace(/^g_/i, '');
  // camelCase / PascalCase を分ける。HPValue → HP Value のように連続大文字も守る。
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 基本的な英語の単数形・複数形ゆれ（coin/coins, gem/gems, item/items, point/points 等）を吸収する。 */
function singularizeToken(w) {
  if (!w || w.length < 4 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith('ies') && w.length >= 5) return w.slice(0, -3) + 'y';
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (/(?:ch|sh|x|z)es$/.test(w) && w.length >= 5) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/** 開いた名前 haystack の中に、開いた語の並び needle がそのまま入っている全位置を返す。 */
function wordSequenceMatches(haystack, needle) {
  const h = ' ' + haystack + ' ';
  const n = ' ' + needle + ' ';
  const out = [];
  let pos = 0;
  while (pos <= h.length - n.length) {
    const idx = h.indexOf(n, pos);
    if (idx < 0) break;
    out.push(idx);
    pos = idx + 1;
    if (out.length >= 8) break;
  }
  if (out.length) return out;
  const needleTokens = needle.split(' ').filter(Boolean);
  if (!needleTokens.length) return out;
  const needleStems = needleTokens.map(singularizeToken);
  const hTokens = [];
  for (const m of haystack.matchAll(/\S+/g)) {
    hTokens.push({ start: m.index, stem: singularizeToken(m[0]) });
  }
  if (hTokens.length < needleStems.length) return out;
  for (let i = 0; i <= hTokens.length - needleStems.length; i++) {
    let ok = true;
    for (let j = 0; j < needleStems.length; j++) {
      if (hTokens[i + j].stem !== needleStems[j]) { ok = false; break; }
    }
    if (ok) {
      out.push(hTokens[i].start);
      if (out.length >= 8) break;
    }
  }
  return out;
}

/** needle の語のうち、avoid 範囲の外で何割が haystack に入っているか。 */
function wordCoverage(haystack, needle, blocked = []) {
  const words = needle.split(' ').filter((w) => w.length >= 2);
  if (!words.length) return 0;
  const have = new Set();
  for (const match of haystack.matchAll(/\S+/g)) {
    if (!overlaps(blocked, match.index, match[0].length)) {
      have.add(match[0]);
      const stem = singularizeToken(match[0]);
      if (stem !== match[0]) have.add(stem);
    }
  }
  let hit = 0;
  for (const w of words) {
    if (have.has(w) || have.has(singularizeToken(w))) hit++;
  }
  return hit / words.length;
}

/* 値の役割。同じ「hp」でも、今の値・上限・初期値では意味がまるで違う。 */
const ROLE_RULES = [
  { role: 'max', re: /(?:\b(?:max|maximum|limit|cap|upper|full)\b|総|最大)/ },
  { role: 'min', re: /(?:\b(?:min|minimum|lower)\b|最小)/ },
  { role: 'base', re: /(?:\b(?:base|(?<!\buser\s)default|initial|init|origin|original|start|starting)\b|素|基本|初期)/ },
  { role: 'delta', re: /(?:\b(?:delta|diff|add|bonus|buff|modifier|mod|rate|ratio|percent)\b|倍率|補正)/ },
  { role: 'count', re: /(?:\b(?:count|num|number|times|total|len|length|size)\b|回数|個数)/ },
  { role: 'flag', re: /\b(?:is|has|can|should|enabled|flag)\b/ },
  { role: 'current', re: /(?:\b(?:cur|current|now|present)\b|現在|今)/ },
];

/**
 * その名前が「今の値」なのか「上限」なのかを見分ける。
 * 何も付いていなければ 'plain'（＝素の値。たいていこれが本命）。
 */
export function fieldRole(name) {
  const s = normalizeFieldName(name);
  for (const r of ROLE_RULES) if (r.re.test(s)) return r.role;
  return 'plain';
}

/*
 * 目的ごとの、変数名としての語彙と、期待される型。
 *
 *   strong  … その目的の値なら、まずこの語が入っている
 *   weak    … 入っていることもある、程度
 *   type    … 'number'（整数か小数）/ 'bool' / 'text' / 'any'
 *   prefer  … 望ましい役割。ここが合うと上がり、外れると下がる。
 */
const FIELD_VOCAB = {
  hp: {
    strong: [/\bhp\b/, /\bhps\b/, /\bhealth\b/, /\bhit ?points?\b/, /\blife\b/, /\blives\b/,
      /体力/, /ライフ/, /耐久/],
    weak: [/\bvitality\b/, /\bvit\b/, /\bdurability\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  attack: {
    strong: [/\battack\b/, /\batk\b/, /\bpower\b/, /\bstrength\b/, /\bstr\b/, /\boffen[cs]e\b/,
      /攻撃/, /威力/],
    weak: [/\bdamage\b/, /\bdmg\b/, /\bweapon\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  defense: {
    strong: [/\bdefen[cs]e\b/, /\bdef\b/, /\barmou?r\b/, /\bresist(ance)?\b/, /\bguard\b/,
      /防御/, /耐性/],
    weak: [/\bshield\b/, /\bblock\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  damage: {
    strong: [/\bdamage\b/, /\bdmg\b/, /ダメージ/],
    weak: [/\bcritical\b/, /\bcrit\b/, /\bhit\b/],
    type: 'number', prefer: ['plain', 'delta'],
  },
  money: {
    strong: [/\bcoins?\b/, /\bgold\b/, /\bgems?\b/, /\bdiamonds?\b/, /\bcrystals?\b/, /\bjewels?\b/, /\bmoney\b/, /\bcurrency\b/,
      /\bwallet\b/, /\bcash\b/, /\bcredits?\b/, /\bbalance\b/,
      /コイン/, /ゴールド/, /所持金/, /ジェム/, /通貨/],
    weak: [/\bamount\b/, /\bprice\b/, /\bcost\b/, /\bstone\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  gacha: {
    strong: [/\bgacha\b/, /\blottery\b/, /\bsummon\b/, /\bdraw\b/, /ガチャ/, /抽選/],
    weak: [/\brate\b/, /\bprobability\b/, /\bchance\b/, /\brarity\b/, /\bweight\b/],
    type: 'number', prefer: ['plain'],
  },
  purchase: {
    strong: [/\bpurchase\b/, /\bpayment\b/, /\bbilling\b/, /\breceipt\b/, /\bstore ?kit\b/,
      /\biap\b/, /\bin ?app\b/, /\bsku\b/, /\bentitlements?\b/, /\btransaction\b/,
      /\bproduct\b/, /\bsubscrib\w*\b/, /\bsubscription\b/, /\bpremium\b/, /\bvip\b/,
      /課金/, /購入/, /プレミアム/, /サブスク/],
    weak: [/\bprice\b/, /\bstore\b/, /\bpaid\b/],
    type: 'any', prefer: ['plain'],
  },
  login: {
    strong: [/\blogin\b/, /\bauth\b/, /\btoken\b/, /\bpassword\b/, /\bcredential\b/,
      /\bsession\b/, /\baccount\b/, /ログイン/, /認証/],
    weak: [/\buser\b/, /\buid\b/, /\bprofile\b/],
    type: 'any', prefer: ['plain'],
  },
  ads: {
    strong: [/\bno ?ads?\b/, /\bremove ?ads?\b/, /\bad ?free\b/, /\bhide ?ads?\b/, /\bdisable ?ads?\b/,
      /\bads?\b/, /\binterstitial\b/, /\brewarded\b/, /\bbanner\b/, /\badmob\b/, /広告/],
    weak: [/\bimpression\b/, /\bplacement\b/],
    type: 'any', prefer: ['plain'],
  },
  save: {
    strong: [/\bsave\b/, /\bsave ?data\b/, /\bpersist\b/, /\barchive\b/, /\buser ?defaults?\b/,
      /セーブ/, /保存/],
    weak: [/\bstorage\b/, /\bcache\b/, /\bfile\b/],
    type: 'any', prefer: ['plain'],
  },
  network: {
    strong: [/\burl\b/, /\bendpoint\b/, /\brequest\b/, /\bresponse\b/, /\bhost\b/, /\bapi\b/,
      /\bsession\b/, /通信/],
    weak: [/\btimeout\b/, /\bretry\b/, /\bheader\b/],
    type: 'any', prefer: ['plain'],
  },
  score: {
    strong: [/\bscore\b/, /\bhigh ?score\b/, /\branking\b/, /\brank\b/, /スコア/, /得点/],
    weak: [/\bpoints?\b/, /\brecord\b/, /\bresult\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  level: {
    strong: [/\blevel\b/, /\blv\b/, /\blvl\b/, /\bexp\b/, /\bexperience\b/, /レベル/, /経験値/],
    weak: [/\brank\b/, /\bgrade\b/, /\bstage\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  stamina: {
    strong: [/\bstamina\b/, /\benergy\b/, /\bap\b/, /\bsp\b/, /\bfuel\b/, /スタミナ/, /行動力/],
    weak: [/\brecover\b/, /\bconsume\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  item: {
    strong: [/\bitems?\b/, /\binventory\b/, /\bequip(ment)?\b/, /\bbag\b/, /アイテム/, /所持品/, /装備/],
    weak: [/\bcount\b/, /\bquantity\b/, /\bstock\b/, /\bmaterial\b/],
    type: 'any', prefer: ['plain'],
  },
  anticheat: {
    strong: [/\bjailbreak\b/, /\bjailbroken?\b/, /\bfrida\b/, /\btamper(ed)?\b/, /\b(?:rooted|rooting|root[\s_-]*(?:detect|check|guard|jail|access|device|bypass))\b/i,
      /\bmagisk\b/, /\bptrace\b/, /\bssl ?pinning\b/, /\bintegrity\b/, /\bcheat(ing)?\b/,
      /\bdebugger\b/, /改造/, /不正/],
    weak: [/\bdetect(ed)?\b/, /\bverified\b/, /\bvalid\b/],
    type: 'bool', prefer: ['flag', 'plain'],
  },
  speed: {
    strong: [/\bspeed\b/, /\bmove ?speed\b/, /\bvelocity\b/, /\bvel\b/, /\bagility\b/, /\bagi\b/,
      /移動速度/, /スピード/, /速度/, /素早さ/],
    weak: [/\baccel(eration)?\b/, /\bpace\b/, /\bwalk ?speed\b/, /\brun ?speed\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  cooldown: {
    strong: [/\bcool ?down\b/, /\brecast\b/, /\bcd\b/, /クールダウン/, /再使用/],
    weak: [/\breload\b/, /\binterval\b/, /\bdelay\b/, /\btimer\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  crypto: {
    strong: [/\bencrypt\w*\b/, /\bdecrypt\w*\b/, /\bcipher\b/, /\baes\b/, /\brsa\b/, /\blicen[cs]e\b/,
      /\bcrypto\b/, /暗号/, /復号/, /ライセンス/, /鍵/, /キー/],
    weak: [/\bhmac\b/, /\bsha\d+\b/, /\bkey\b/, /\biv\b/, /\bsalt\b/, /\bserial\b/, /\bactivation\b/],
    type: 'any', prefer: ['plain'],
  },
};

export function fieldVocab(goalId) { return Object.hasOwn(FIELD_VOCAB, goalId) ? FIELD_VOCAB[goalId] : null; }

/**
 * 変数の名前が、その目的にどれだけ当てはまるか。
 *
 * @returns {{score:number, term:string, exact:boolean, role:string}|null}
 */
export function matchField(goal, name) {
  if (!goal || !name) return null;
  const norm = normalizeFieldName(name);
  if (!norm) return null;
  const role = fieldRole(name);
  const vocab = Object.hasOwn(FIELD_VOCAB, goal.id) ? FIELD_VOCAB[goal.id] : null;
  let best = null;
  /*
   * 変数名にも「同じつづりの別の言葉」は出る。normalizeFieldName が
   * `_lifeCycleHolder` を「life cycle holder」に開くので、文字列と同じ物差しで外せる。
   * ここを素通しにすると、HP を探した人に IronSource の
   * `waterfallLifeCycleHolder` が出る（実際に出ていた）。
   */
  const blocked = avoidSpans(goal, norm);
  const consider = (score, term, exact, literal, sequence, at, words, matchLength = null) => {
    if (at != null && overlaps(blocked, at, matchLength ?? String(term).length)) return;
    if (!best || score > best.score) {
      best = { score, term, exact: !!exact, role, literal: !!literal, sequence: !!sequence, words: !!words };
    }
  };

  if (vocab) {
    for (const re of vocab.strong) {
      for (const m of allMatches(re, norm, blocked.length)) {
        // 名前がその語だけでできている（`_hp` → `hp`）なら、これ以上ない一致
        const whole = norm === m.text.trim();
        consider(whole ? 1 : 0.75, m.text, whole, false, false, m.at);
      }
    }
    for (const re of vocab.weak) {
      for (const m of allMatches(re, norm, blocked.length)) {
        consider(0.4, m.text, false, false, false, m.at);
      }
    }
  }
  /*
   * 打ち込まれた言葉そのもの。
   *
   * これが無いと、`adController` と打った人に `_adController` を返せない
   * — それどころか語彙に「request」が入っているせいで、
   * `allowConcurrentAssetResourceLoadingRequests` を探しているのに
   * `_requestTimeout` を「確定」と言い切る、という最悪の外し方をする。
   * 名前がそのまま一致しているなら、それ以上の証拠は無い。
   *
   * 比較は normalizeFieldName どうしで行う。`adController` は
   * 「ad controller」に開かれるので、文字列のまま比べても永久に一致しない。
   */
  const asked = goal.isPreset ? '' : normalizeFieldName(goal.text);
  if (asked && asked.length >= 2) {
    if (norm === asked) consider(1.2, goal.text, true, true, false, 0, false, asked.length);
    else {
      let matchedSeq = false;
      for (const askedAt of wordSequenceMatches(norm, asked)) {
        if (overlaps(blocked, askedAt, asked.length)) continue;
        consider(1.0, goal.text, false, true, true, askedAt, false, asked.length);
        matchedSeq = true;
        break;
      }
      if (!matchedSeq) {
        const cover = wordCoverage(norm, asked, blocked);
        if (cover >= 0.99) consider(0.95, goal.text, false, true, false, null, true);
        else if (cover >= 0.6) consider(0.45 * cover, goal.text, false, true);
      }
    }
  }

  // 自由入力（プリセットにない目的）は、入力から開いた語で当てる
  for (const term of goal.extraTerms || []) {
    const w = normalizeFieldName(term.word);
    if (!w || (w.length < 2 && !SINGLE_CHAR_CJK_CONCEPTS.has(w))) continue;
    for (const at of wordSequenceMatches(norm, w)) {
      if (overlaps(blocked, at, w.length)) continue;
      consider((norm === w ? 0.95 : 0.7) * (term.weight || 1), term.word, norm === w, false, false, at, false, w.length);
      break;
    }
  }
  if (!best && !vocab) {
    // プリセットの文言用の語彙でも一応見る（日本語名の変数など）
    const m = matchText(goal, norm);
    if (m) consider(m.score * 0.6, m.term, false);
  }
  if (!best) return null;

  /*
   * 役割による上下。「今の値」が本命で、「上限」「初期値」は別物。
   * ただし打ち込まれた名前そのものが一致しているなら、上下しない
   * （`maxHp` を探している人に、`maxHp` を「上限だから」と下げる意味はない）。
   */
  if (!best.literal) {
    const prefer = (vocab && vocab.prefer) || ['plain'];
    if (prefer.includes(best.role)) best.score *= 1;
    else if (best.role === 'max' || best.role === 'base' || best.role === 'min') best.score *= 0.45;
    else if (best.role === 'delta' || best.role === 'count') best.score *= 0.7;
    else best.score *= 0.85;
  }
  best.score = Math.min(1, best.score);
  return best;
}

/**
 * 目的が期待している型に、その値の型が合っているか。
 * @returns {'fit'|'conflict'|'unknown'}
 */
export function typeFits(goal, type) {
  if (!goal || !type) return 'unknown';
  const want = (Object.hasOwn(FIELD_VOCAB, goal.id) ? FIELD_VOCAB[goal.id].type : null) || 'any';
  if (want === 'any') return 'unknown';
  const kind = type.kind;
  if (want === 'number') {
    if (kind === 'int' || kind === 'float') {
      // BOOL（1 バイトの char）は数値ではあるが、HP や所持金ではない
      if (type.bool && type.bytes === 1) return 'conflict';
      return 'fit';
    }
    if (kind === 'bool' || kind === 'object' || kind === 'cstring' || kind === 'class' ||
        kind === 'selector' || kind === 'block' || kind === 'pointer') return 'conflict';
    return 'unknown';
  }
  if (want === 'bool') {
    if (kind === 'bool' || (kind === 'int' && type.bytes === 1)) return 'fit';
    if (kind === 'object' || kind === 'float' || kind === 'cstring' || kind === 'class' ||
        kind === 'selector' || kind === 'block' || kind === 'pointer') return 'conflict';
    return 'unknown';
  }
  if (want === 'text') {
    if (kind === 'object' && (!type.className || /String/i.test(type.className))) return 'fit';
    if (kind === 'cstring') return 'fit';
    if (kind === 'int' || kind === 'float') return 'conflict';
  }
  return 'unknown';
}

/**
 * セレクタ（メソッド名）が、その値のアクセサかどうか。
 *   hp / isHp        → getter
 *   setHp:           → setter
 */
export function accessorKind(sel, fieldName) {
  if (!sel || !fieldName) return null;
  const plain = String(fieldName).replace(/^_+/, '');
  const s = String(sel).replace(/:$/, '');
  if (s === plain) return 'getter';
  if (s.toLowerCase() === plain.toLowerCase()) return 'getter';
  const setter = 'set' + plain.charAt(0).toUpperCase() + plain.slice(1);
  if (s === setter || s.toLowerCase() === setter.toLowerCase()) return 'setter';
  if (s === 'is' + plain.charAt(0).toUpperCase() + plain.slice(1)) return 'getter';
  return null;
}

export function goalById(id) { return GOALS.find((g) => g.id === id) || null; }

export function goalLabel(goal) {
  if (!goal) return '';
  if (goal.free) return goal.text;
  return pick(goal.ja, goal.en);
}

/*
 * 自由入力を手がかりの語に開く辞書。
 * 「敵にダメージを与える処理」と書かれても、バイナリの中にあるのは damage / dmg。
 * 日本語 → 実際に埋まっていそうな語、の橋渡しをする。
 */
export const SINGLE_CHAR_CJK_CONCEPTS = new Set(['鍵', '石', '金', '敵']);

const JA_VERB_SUFFIX_RE = /(?:したい|見たい|知りたい|探したい|増やす|増える|減らす|減る|消す|消える|変える|変わる|上げる|上がる|下げる|下がる|見る|探す|調べる|する|される|できる|なる|ある|いる|ない|ます|です|場所|処理|関数|方法|ところ)$/;

const SYNONYMS = [
  [/ダメージ|damage|だめーじ/i, ['damage', 'dmg', 'hurt', 'ダメージ']],
  [/攻撃|こうげき|attack|\batk\b/i, ['attack', 'atk', 'attk', '攻撃']],
  [/防御|ぼうぎょ|defense|defence/i, ['defense', 'defence', 'def', '防御']],
  [/体力|\bhp\b|ヒットポイント|health/i, ['hp', 'health', 'life', '体力']],
  [/所持金|お金|資金|通貨|コイン|\bcoins?\b|money|gold|wallet|(?:^|[\s、。])金(?:$|[\s、。をがはにのでへ])/i, ['coin', 'coins', 'gold', 'money', 'currency', 'wallet', '所持金']],
  [/ジェム|(?:課金|魔法|魔晶|聖晶|有償|無償|ガチャ)石|(?:^|[\s、。])石(?:$|[\s、。をがはにのでへ])|\bgems?\b|jewel|diamond|crystal/i, ['gem', 'jewel', 'diamond', 'crystal', 'ジェム']],
  [/ガチャ|gacha|抽選|召喚/i, ['gacha', 'lottery', 'draw', 'summon', 'ガチャ']],
  [/プレミアム|サブスク|premium|\bvip\b|subscrib\w*|subscription/i, ['premium', 'vip', 'subscription', 'subscribe', 'entitlement', 'purchase', 'プレミアム']],
  [/課金|購入|買|purchase|payment|iap|in-?app|sku|entitlement|storekit|receipt/i, ['purchase', 'payment', 'billing', 'receipt', 'iap', 'inapp', 'sku', 'entitlement', 'storekit', '購入']],
  [/チート|改造|不正|cheat|jailbreak|frida(?!y)|tamper|\b(?:rooted|rooting|root[\s_-]*(?:detect|check|guard|jail|access|device|bypass))\b|magisk|ptrace|sslpinning/i, ['jailbreak', 'frida', 'tamper', 'cheat', 'rooted', 'rooting', 'magisk', 'ptrace', 'sslpinning', '改造', '不正']],
  [/ログイン|login|認証|\bauth(?:enticat\w*|oriz\w*|n|z)?\b/i, ['login', 'auth', 'signin', 'ログイン']],
  [/広告(?:を)?(?:消|非表示|削除|オフ|除去|なし|カット|ブロック)|remove[\s_-]*ads?|no[\s_-]*ads?|ad[\s_-]*free/i, ['noAds', 'removeAds', 'adFree', 'ad', 'ads', '広告']],
  [/広告|\bads?\b/i, ['ad', 'ads', 'interstitial', 'rewarded', '広告']],
  [/セーブ|保存|save/i, ['save', 'store', 'persist', 'セーブ']],
  [/通信|サーバ|server|network|\bapi\b/i, ['http', 'api', 'request', 'session', '通信']],
  [/スコア|score|得点/i, ['score', 'point', 'スコア']],
  [/レベル|level|経験値|\bexp\b/i, ['level', 'exp', 'experience', 'レベル']],
  [/スタミナ|stamina|行動力/i, ['stamina', 'energy', 'スタミナ']],
  [/アイテム|item|装備/i, ['item', 'inventory', 'equip', 'アイテム']],
  [/敵|enemy|モンスター|monster/i, ['enemy', 'monster', 'mob', '敵']],
  [/味方|player|プレイヤー|自分/i, ['player', 'user', 'hero', 'プレイヤー']],
  [/時間|time|タイマー|timer/i, ['time', 'timer', 'duration']],
  [/回数|\bcounts?\b|カウント/i, ['count', 'num', 'times']],
  [/移動速度|速度|素早さ|\bspeed\b|スピード|velocity/i, ['speed', 'moveSpeed', 'velocity', '速度', 'スピード']],
  [/クールダウン|再使用|cool[\s_-]*down|\bcd\b|recast/i, ['cooldown', 'recast', 'cd', 'クールダウン']],
  [/暗号化?|復号|ライセンス|鍵|(?:^|[\s、。])キー(?:$|[\s、。をがはにのでへ])|encrypt\w*|decrypt\w*|cipher|\baes\b|\brsa\b|licen[cs]e|\bcrypto\b/i, ['encrypt', 'decrypt', 'cipher', 'aes', 'rsa', 'license', 'crypto', 'key', '暗号', '復号', '鍵']],
  [/確率|probability|\brates?\b/i, ['rate', 'probability', 'chance', '確率']],
];

/** 目的を表す文字を、実際に探す語の並びに開く。 */
export function expandTerms(text) {
  const raw = String(text || '').trim();
  const terms = [];
  const push = (word, weight) => {
    const w = String(word).trim();
    if (w.length < 2 && !SINGLE_CHAR_CJK_CONCEPTS.has(w)) return;
    if (terms.some((x) => x.word.toLowerCase() === w.toLowerCase())) return;
    terms.push({ word: w, weight });
  };

  for (const [re, words] of SYNONYMS) {
    if (re.test(raw)) for (const w of words) push(w, 1);
  }
  // 入力そのものに含まれる単語も、そのまま手がかりにする（弱め）
  for (const token of raw.split(/[\s、。,.:;（）()「」"'/\\|+*]+/)) {
    if (!token || /^[はがのをにでとやもへ]+$/.test(token)) continue;
    if (token.length >= 2 || SINGLE_CHAR_CJK_CONCEPTS.has(token)) push(token, 0.6);
    if (/[ぁ-んァ-ヶ一-龥]/.test(token)) {
      for (const part of token.split(/[はがのをにでとへも]+/)) {
        const cleaned = part.replace(JA_VERB_SUFFIX_RE, '').trim();
        if (cleaned && cleaned !== token && (cleaned.length >= 2 || SINGLE_CHAR_CJK_CONCEPTS.has(cleaned)) && !/^[ぁ-ん]+$/.test(cleaned)) {
          push(cleaned, 0.6);
        } else if (part && part !== token && (part.length >= 2 || SINGLE_CHAR_CJK_CONCEPTS.has(part)) && !/^[ぁ-ん]+$/.test(part)) {
          push(part, 0.6);
        }
      }
    }
  }
  return terms;
}

/**
 * 入力がコード上の識別子（CamelCase / snake_case / _prefix / 複数語）らしいか。
 * 単一の汎用概念語（"coin", "hp", "gold", "score" 等）がプリセットに当たった場合は false とし、
 * SDK 抑制の回避（askedByName）や複数形・同義語の切り落としを防ぐ。
 */
export function isIdentifierLikeQuery(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s) return false;
  if (/^_/.test(s)) return true;
  if (/[_.:/-]/.test(s)) return true;
  if (/[a-z0-9][A-Z]/.test(s) || /[A-Z]{2,}[a-z]/.test(s)) return true;
  if (/\s+/.test(s)) return true;
  return false;
}

/**
 * 自由入力から目的を組み立てる。
 * 既存のプリセットに強く当てはまるならそれを使い、なければ自由目的として扱う。
 */
export function parseGoal(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // プリセットの語が入っていれば、その目的として扱う（期待する命令の形まで使える）
  let best = null;
  for (const g of GOALS) {
    const blocked = avoidSpans(g, raw);
    const unblocked = (re) => allMatches(re, raw, blocked.length)
      .some((m) => !overlaps(blocked, m.at, m.text.length));
    let hit = 0;
    for (const re of g.strong) if (unblocked(re)) hit += 2;
    for (const re of g.weak) if (unblocked(re)) hit += 1;
    if (hit > 0 && (!best || hit > best.hit)) best = { goal: g, hit };
  }
  const terms = expandTerms(raw);
  if (best && best.hit >= 2) {
    return Object.assign({}, best.goal, {
      text: raw,
      extraTerms: terms,
      free: false,
      isPreset: !isIdentifierLikeQuery(raw),
    });
  }
  return {
    id: 'free', free: true, text: raw,
    ja: raw, en: raw,
    strong: [], weak: [], extraTerms: terms,
    // 自由入力では「どんな命令が出るはず」とは決めつけない
    expects: {},
  };
}

/** プリセットを、自由入力と同じ形に整える。 */
export function goalFromPreset(id) {
  const g = goalById(id);
  if (!g) return null;
  return Object.assign({}, g, { text: pick(g.ja, g.en), extraTerms: [], free: false, isPreset: true });
}

/* ── 「同じつづりだが、別の言葉」を外す ──────────────────────
 *
 * `health` は体力だが、`healthCheck`（サーバの死活監視）の health は体力ではない。
 * 名前としては完璧に一致するので、点の付け方をどう変えても上がってくる。
 * 目的の avoid に当たった範囲を先に取っておき、そこに重なった一致だけを捨てる。
 * 「attack と healthcheck が両方書いてある文字列」の attack までは捨てない。 */

const GLOBAL_RE_CACHE = new WeakMap();
function globalRegExp(re) {
  let g = GLOBAL_RE_CACHE.get(re);
  if (!g) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    g = new RegExp(re.source, flags);
    GLOBAL_RE_CACHE.set(re, g);
  }
  g.lastIndex = 0;
  return g;
}

function avoidSpans(goal, s) {
  const spans = [];
  for (const re of (goal && goal.avoid) || []) {
    const g = globalRegExp(re);
    let m;
    while ((m = g.exec(s)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return spans;
}

function overlaps(spans, at, len) {
  for (const [lo, hi] of spans) if (at < hi && at + len > lo) return true;
  return false;
}

/*
 * 外す範囲があるときだけ、2 個目以降の一致も見る。
 * `healthcheck then health` の後ろの health を取りこぼさないため。
 * 外す範囲が無いふつうの目的では、これまでどおり最初の 1 個で止める。
 */
function allMatches(re, s, hasAvoid) {
  if (!hasAvoid) {
    const m = s.match(re);
    return m ? [{ text: m[0], at: m.index }] : [];
  }
  const g = globalRegExp(re);
  const out = [];
  let m;
  while ((m = g.exec(s)) !== null) {
    out.push({ text: m[0], at: m.index });
    if (m[0].length === 0) g.lastIndex++;
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 文字列 1 本が、その目的にどれだけ当てはまるか。
 *
 * @returns {{score:number, term:string}|null} 当てはまらなければ null
 */
export function normalizeIdentifierBoundaries(text) {
  if (typeof text !== 'string' || text.length < 2) return text;
  if (!/[_]|[a-z0-9][A-Z]|[A-Z]{2}[a-z]/.test(text)) return text;
  return text
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function mapAvoidSpansToNormalized(s, rawSpans) {
  if (!rawSpans || !rawSpans.length) return [];
  const posMap = new Array(s.length);
  let outLen = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (i > 0 && c >= 65 && c <= 90) {
      const prev = s.charCodeAt(i - 1);
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      const prevLowerOrDigit = (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57);
      const prevUpper = prev >= 65 && prev <= 90;
      const nextLower = next >= 97 && next <= 122;
      if (prevLowerOrDigit || (prevUpper && nextLower)) outLen++;
    }
    posMap[i] = outLen;
    outLen++;
  }
  const mapped = [];
  for (const [lo, hi] of rawSpans) {
    if (lo < hi && lo >= 0 && hi <= s.length) {
      mapped.push([posMap[lo], posMap[hi - 1] + 1]);
    }
  }
  return mapped;
}

function matchTextSingle(goal, s, extraBlocked = null, precomputedBlocked = null) {
  let best = null;
  const blocked = precomputedBlocked ? precomputedBlocked : avoidSpans(goal, s);
  if (extraBlocked && extraBlocked.length) {
    for (const span of extraBlocked) blocked.push(span);
  }
  const consider = (score, term, at) => {
    if (at != null && overlaps(blocked, at, term.length)) return;
    if (!best || score > best.score) best = { score, term };
  };
  for (const re of goal.strong || []) {
    for (const m of allMatches(re, s, blocked.length)) consider(1, m.text, m.at);
  }
  for (const re of goal.weak || []) {
    for (const m of allMatches(re, s, blocked.length)) consider(0.5, m.text, m.at);
  }
  for (const term of goal.extraTerms || []) {
    for (const i of findExtraTermMatches(s, term.word)) {
      consider(0.85 * term.weight, term.word, i);
    }
  }
  return best;
}

const OBFUSCATED_OR_TABLE_RE = /aAbBcCdDeFgG|\$[^\s$]{8,}\$/;
const ASSET_OR_UI_PATH_RE = /\.(?:png|jpe?g|webp|gif|svg|dat|maanim|mamodel|plist|fnt|ttf|otf|wav|mp3|ogg|m4a|mp4|tsv|csv|prefab|shader)\b|\\(?:レイヤー|digit\b)|(?:win_dialog|win_number|win_percent|win_plus|number_data_|fukidashi|createUI|detailview::|pz_ui_|btn_eff_|all_num_|all_text_)/i;
const DIALOGUE_PROSE_RE = /<[A-Za-z][^>]*>.*<\/[A-Za-z]+>|(?:ですよ|ますよ|ますね|ですか[？?]|ましたね|しましょう|ください[。！!]|んです[。！!])/;

/**
 * Detect binary data misdecoded as UTF-16LE/UTF-8 (random multi-script soup within a single token,
 * unpaired surrogates, non-characters, or C1 controls) while preserving legitimate Japanese,
 * Chinese, Korean, multilingual UI lists, emoji surrogate pairs, and icon-font PUA UI strings.
 */
export function isGarbledBinaryString(text) {
  if (typeof text !== 'string' || text.length < 4) return false;
  if (!/[^\x00-\x7f]/.test(text)) return false; // ASCII fast path
  let broken = 0;
  let nonAscii = 0;
  let tokScripts = 0;
  let tokPua = 0;
  let tokLen = 0;

  const isSep = (c) => (
    c <= 0x20 || c === 0x2d || c === 0x2f || c === 0x7c || c === 0x2c || c === 0x3b
    || c === 0x3a || c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d
    || c === 0x3000 || c === 0x3001 || c === 0x3002 || c === 0x30fb
    || c === 0xff0c || c === 0xff0f || c === 0xff5c
  );

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isSep(c)) {
      if (tokPua >= 3 && tokPua * 3 >= tokLen) return true;
      tokScripts = 0;
      tokPua = 0;
      tokLen = 0;
      continue;
    }
    tokLen++;
    if (c < 0x80) continue;
    nonAscii++;

    // Valid UTF-16 surrogate pair (e.g. emoji): advance past low surrogate cleanly
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      broken++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      broken++;
    } else if ((c >= 0x0080 && c <= 0x009f) || (c >= 0xfdd0 && c <= 0xfdef) || c >= 0xfffd) {
      broken++;
    } else if (c >= 0xe000 && c <= 0xf8ff) {
      tokPua++;
    } else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) {
      tokScripts |= 1; // CJK Unified
    } else if (c >= 0xac00 && c <= 0xd7af) {
      tokScripts |= 2; // Hangul
    } else if (c >= 0x0600 && c <= 0x07bf) {
      tokScripts |= 4; // Arabic / Syriac / Thaana
    } else if (c >= 0x0900 && c <= 0x0dff) {
      tokScripts |= 8; // Indic
    } else if (c >= 0x0400 && c <= 0x052f) {
      tokScripts |= 16; // Cyrillic
    } else if (c >= 0x0590 && c <= 0x05ff) {
      tokScripts |= 32; // Hebrew
    } else if ((c >= 0x0e00 && c <= 0x109f) || (c >= 0x1780 && c <= 0x17ff)) {
      tokScripts |= 64; // Thai / Lao / Tibetan / Myanmar / Khmer
    } else if ((c >= 0x1200 && c <= 0x16ff) || (c >= 0xa000 && c <= 0xabff)) {
      tokScripts |= 128; // Ethiopic / Cherokee / Yi / Javanese / etc.
    }

    if (broken >= 2 || (broken >= 1 && nonAscii >= 3)) return true;
    if (tokScripts) {
      let sc = 0;
      for (let m = tokScripts; m; m &= m - 1) sc++;
      if (sc >= 3) return true;
      if (sc >= 2 && tokPua >= 1) return true;
    }
  }
  if (tokPua >= 3 && tokPua * 3 >= tokLen) return true;
  return false;
}

export function matchText(goal, text) {
  if (!goal || typeof text !== 'string') return null;
  const s = text;
  if (s.length < 2) return null;
  if (OBFUSCATED_OR_TABLE_RE.test(s) || isGarbledBinaryString(s)) return null;
  if (s.length >= 12 && (s.match(/[{}~^`$|&]/g) || []).length >= 4 && !/\b(?:function|return|if|for|while)\b/.test(s)) return null;
  const rawBlocked = avoidSpans(goal, s);
  const rawBest = matchTextSingle(goal, s, null, rawBlocked);
  const norm = normalizeIdentifierBoundaries(s);
  const normBest = norm !== s
    ? matchTextSingle(goal, norm, rawBlocked.length ? mapAvoidSpansToNormalized(s, rawBlocked) : null)
    : null;
  let best = rawBest && normBest
    ? (normBest.score > rawBest.score ? normBest : rawBest)
    : (rawBest || normBest);
  if (!best) return null;

  /*
   * 手がかりとしての「濃さ」を掛ける。
   * 人が読む文言ほど当たりやすく、記号だらけや極端に長いものは外れやすい。
   */
  let quality = 1;
  if (s.length > 160) quality -= 0.4;
  if (/^[\-_./\\%@#$*+0-9]+$/.test(s)) quality -= 0.5;
  if (DIALOGUE_PROSE_RE.test(s)) quality *= 0.25;
  else if (ASSET_OR_UI_PATH_RE.test(s)) quality *= 0.35;
  else if (/[ぁ-んァ-ヶ一-龥]/.test(s)) quality += 0.1;
  best.score *= Math.max(0.15, Math.min(1.1, quality));
  return best;
}

function isAsciiAlnum(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAsciiUpper(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= 65 && c <= 90;
}
function isAsciiLowerOrDigit(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 122);
}
function isTokenBoundaryStart(s, i) {
  if (i <= 0) return true;
  const prev = s[i - 1], cur = s[i];
  if (!isAsciiAlnum(prev)) return true;
  if (isAsciiLowerOrDigit(prev) && isAsciiUpper(cur)) return true;
  if (isAsciiUpper(prev) && isAsciiUpper(cur) && i + 1 < s.length && isAsciiLowerOrDigit(s[i + 1])) return true;
  return false;
}
function isTokenBoundaryEnd(s, end) {
  if (end >= s.length) return true;
  const prev = s[end - 1], next = s[end];
  if (!isAsciiAlnum(next)) return true;
  if (isAsciiLowerOrDigit(prev) && isAsciiUpper(next)) return true;
  if (isAsciiUpper(prev) && isAsciiUpper(next) && end + 1 < s.length && isAsciiLowerOrDigit(s[end + 1])) return true;
  return false;
}
function findExtraTermMatches(s, word) {
  if (typeof word !== 'string' || !word.length) return [];
  const lower = s.toLowerCase();
  const needle = word.toLowerCase();
  const asciiWord = /^[a-z0-9]+$/i.test(word);
  const requireEnd = asciiWord && word.length <= 4;
  const out = [];
  let pos = 0;
  while (pos <= lower.length - needle.length) {
    const i = lower.indexOf(needle, pos);
    if (i < 0) break;
    pos = i + 1;
    if (asciiWord) {
      if (!isTokenBoundaryStart(s, i)) continue;
      if (requireEnd && !isTokenBoundaryEnd(s, i + needle.length)) continue;
    }
    out.push(i);
    if (out.length >= 8) break;
  }
  return out;
}

const ACCESSOR_PREFIX_RE = /^(?:get|set|calc|calculate|compute|estimate|base|current|cur|total|effective|final|raw|actual|real|mod|modify|update|add|sub|subtract|inc|increment|dec|decrement|apply|consume|spend|earn|gain|take|give|grant|award|deduct|battle)\s+/;
const PREDICATE_HEAD_RE = /^(?:is|can|has|should|was)$/;
const UI_LOG_TEST_HEAD_RE = /^(?:format|render|draw|show|paint|print|log|dump|debug|trace|visit|serialize|deserialize|animate|layout)$/;
const NON_VALUE_ROLE_TOKEN_RE = /^(?:animation|animator|animate|panel|dialog|window|icon|tooltip|label|widget|controller|keyboard|visitor|hex|hexes|direction|projectile|climax|frame|swipe|cursor|click|log|logger|logging|logcat|configurator|hud|bar|gauge|button|sprite|shader|audio|sound|test|tests|mock|debug|serializer|deserializer|serialization|layout)$/;
const MUTATOR_HEAD_RE = /^(?:set|add|sub|subtract|inc|increment|dec|decrement|apply|consume|spend|earn|gain|take|modify|mod|update|give|grant|award|deduct|change|reset|restore|refill|charge)$/;
const GETTER_HEAD_RE = /^(?:get|read|fetch|peek|query|current|cur)$/;
const DIAGNOSTIC_PREFIX_RE = /^(?:error|warning|warn|assert|assertion|fatal|debug|info|trace|undefined|invalid|failed|cannot|unable)\b/i;

/**
 * 関数シンボル（ObjC / Itanium C++ / 通常関数）から末尾のメソッド名（葉）を取り出す。
 * @returns {{ leaf: string, owner: string|null, isConst: boolean, isCtorOrDtor: boolean }}
 */
function skipItaniumTemplateArgs(body, start) {
  let i = start + 1;
  let depth = 1;
  while (i < body.length && depth > 0) {
    const ch = body[i];
    if (ch === 'E') {
      depth--;
      i++;
      continue;
    }
    if (ch === 'I' || ch === 'N' || ch === 'F' || ch === 'X' || ch === 'J' || ch === 'Z') {
      depth++;
      i++;
      continue;
    }
    if (ch === 'L') {
      if (/^[abchijlmstxyfde]/.test(body.slice(i + 1))) {
        const end = body.indexOf('E', i + 2);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      depth++;
      i++;
      continue;
    }
    if (ch === 'B') {
      const tm = /^(\d+)/.exec(body.slice(i + 1));
      if (tm) {
        const tlen = Number(tm[1]);
        const next = i + 1 + tm[1].length + tlen;
        if (tlen > 0 && next <= body.length) {
          i = next;
          continue;
        }
      }
      i++;
      continue;
    }
    if (ch === 'S') {
      const sm = /^S(?:[0-9A-Z]*_|[tabsoid])/.exec(body.slice(i));
      if (sm) {
        i += sm[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (ch === 'T') {
      const tm = /^T[0-9A-Z]*_/.exec(body.slice(i));
      if (tm) {
        i += tm[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (ch >= '1' && ch <= '9') {
      const dm = /^(\d+)/.exec(body.slice(i));
      const len = Number(dm[1]);
      const next = i + dm[1].length + len;
      if (len > 0 && next <= body.length) {
        i = next;
        continue;
      }
      i += dm[1].length;
      continue;
    }
    i++;
  }
  return depth === 0 ? i : -1;
}

export function extractCallableLeaf(name) {
  if (typeof name !== 'string' || !name) {
    return { leaf: '', owner: null, isConst: false, isCtorOrDtor: false, isStdGlue: false };
  }
  const objc = /^[-+]\[([^\s\]]+)\s+([^\]]+)\]$/.exec(name);
  if (objc) {
    return { leaf: objc[2].split(':')[0], owner: objc[1], isConst: false, isCtorOrDtor: false, isStdGlue: false };
  }
  const cxx = /^_?_Z(N?)(K?)(.*)$/.exec(name);
  if (cxx) {
    const nested = cxx[1] === 'N';
    let isConst = cxx[2] === 'K';
    const body = cxx[3];
    const isStdGlue = nested && /^[VKrRO]*St/.test(body);
    if (nested) {
      const parts = [];
      let i = 0;
      let isCtorOrDtor = false;
      while (i < body.length && body[i] !== 'E') {
        if (body[i] === 'K') { isConst = true; i++; continue; }
        if (body[i] === 'V' || body[i] === 'r' || body[i] === 'R' || body[i] === 'O' || body[i] === 'L') {
          i++;
          continue;
        }
        if (body[i] === 'B') {
          const tm = /^(\d+)/.exec(body.slice(i + 1));
          if (!tm) break;
          const tlen = Number(tm[1]);
          const next = i + 1 + tm[1].length + tlen;
          if (!(tlen > 0) || next > body.length) break;
          i = next;
          continue;
        }
        if (body[i] === 'I') {
          const next = skipItaniumTemplateArgs(body, i);
          if (next < 0) break;
          i = next;
          continue;
        }
        if ((body[i] === 'C' || body[i] === 'D') && /[0-5]/.test(body[i + 1] || '')) {
          isCtorOrDtor = true;
          i += 2;
          continue;
        }
        // Itanium copy/move assignment operator (aS) right after class name
        if (parts.length && body.slice(i, i + 2) === 'aS' && body[i + 2] === 'E') {
          isCtorOrDtor = true;
          i += 2;
          continue;
        }
        const dm = /^(\d+)/.exec(body.slice(i));
        if (!dm) break;
        const len = Number(dm[1]);
        i += dm[1].length;
        if (!(len > 0) || i + len > body.length) break;
        parts.push(body.slice(i, i + len));
        i += len;
      }
      if (parts.length) {
        return {
          leaf: parts[parts.length - 1],
          owner: parts.length >= 2 ? parts[parts.length - 2] : null,
          isConst,
          isCtorOrDtor,
          isStdGlue: isStdGlue || parts[0] === 'std',
        };
      }
    } else {
      const lm = /^L?(\d+)/.exec(body);
      if (lm) {
        const len = Number(lm[1]);
        const start = lm[0].length;
        if (len > 0 && start + len <= body.length) {
          return { leaf: body.slice(start, start + len), owner: null, isConst, isCtorOrDtor: false, isStdGlue: false };
        }
      }
    }
    if (isStdGlue) {
      return { leaf: '', owner: 'std', isConst, isCtorOrDtor: false, isStdGlue: true };
    }
  }
  return { leaf: name.replace(/^_+/, ''), owner: null, isConst: false, isCtorOrDtor: false, isStdGlue: false };
}

/**
 * 関数シンボル（ObjC / Itanium C++ / 通常関数）を検索・照合用の正規化文字列に開く。
 * 例: `__ZN6Player7addCoinEi` → `player add coin`
 */
export function normalizeCallableName(name) {
  if (typeof name !== 'string' || !name) return '';
  const info = extractCallableLeaf(name);
  const parts = [];
  if (info.owner) {
    const o = normalizeFieldName(info.owner.replace(/::+/g, ' '));
    if (o) parts.push(o);
  }
  if (info.leaf) {
    const l = normalizeFieldName(info.leaf.replace(/::+/g, ' '));
    if (l) parts.push(l);
  }
  return parts.join(' ').trim();
}

/**
 * 関数シンボルが値を書き換えるミューテータか const ゲッタかを判定する。
 * @returns {{ kind: 'mutator'|'const-getter'|'getter'|'other', isConst: boolean, leafLen: number }}
 */
export function symbolMutationKind(name) {
  if (typeof name !== 'string' || !name) {
    return { kind: 'other', isConst: false, leafLen: 0 };
  }
  const info = extractCallableLeaf(name);
  const leafNorm = normalizeFieldName(info.leaf);
  const firstTok = leafNorm ? leafNorm.split(' ')[0] : '';
  const leafLen = leafNorm ? leafNorm.length : name.length;
  if (!info.isConst && MUTATOR_HEAD_RE.test(firstTok)) {
    return { kind: 'mutator', isConst: false, leafLen };
  }
  if (info.isConst) {
    return { kind: 'const-getter', isConst: true, leafLen };
  }
  if (GETTER_HEAD_RE.test(firstTok)) {
    return { kind: 'getter', isConst: false, leafLen };
  }
  return { kind: 'other', isConst: false, leafLen };
}

/**
 * 関数シンボルの役割分類。
 * std:: グルー、コンストラクタ/デストラクタ、UI・描画・ログ・テスト・シリアライズ補助は
 * 非数値ゴールや自由入力ゴールでも 'non-value' として降格する。
 * @returns {'value'|'non-value'|'neutral'}
 */
export function numericSymbolRole(goal, name) {
  if (!goal || typeof name !== 'string' || !name) return 'neutral';
  const info = extractCallableLeaf(name);
  if (info.isStdGlue) return 'non-value';
  const isNumeric = !!(goal.expects && goal.expects.numeric);
  const leafNorm = normalizeFieldName(info.leaf);
  if (!leafNorm) return info.isCtorOrDtor ? 'non-value' : 'neutral';
  const leafTokens = leafNorm.split(' ');
  const ownerTokens = info.owner ? normalizeFieldName(info.owner).split(' ') : [];
  const askedTokens = new Set(normalizeFieldName(goal.text || '').split(' ').filter(Boolean));

  const isNonValueToken = (tok) => NON_VALUE_ROLE_TOKEN_RE.test(tok) && !askedTokens.has(tok);
  const isUiLogTestHead = (tok) => (
    UI_LOG_TEST_HEAD_RE.test(tok)
    && !askedTokens.has(tok)
    && !(goal.id === 'gacha' && tok === 'draw')
  );
  const isToFromJson = /\b(?:to|from) json\b/.test(leafNorm) && !askedTokens.has('json');

  if (isUiLogTestHead(leafTokens[0]) || isToFromJson) return 'non-value';
  if (isNumeric) {
    if (PREDICATE_HEAD_RE.test(leafTokens[0]) && !askedTokens.has(leafTokens[0])) return 'non-value';
    if (leafTokens.length >= 2 && /^(?:is|can|has|should)$/.test(leafTokens[1]) && !askedTokens.has(leafTokens[1])) {
      return 'non-value';
    }
  }

  let core = leafNorm;
  for (let i = 0; i < 3; i++) {
    const next = core.replace(ACCESSOR_PREFIX_RE, '');
    if (next === core) break;
    core = next;
  }
  const coreHit = core ? matchField(goal, core) : null;
  if (ownerTokens.some(isNonValueToken)) return 'non-value';
  const hasLeafNonValue = leafTokens.some(isNonValueToken);
  if (hasLeafNonValue && !(coreHit && coreHit.exact)) return 'non-value';
  if (info.isCtorOrDtor) return 'non-value';
  if (isNumeric && coreHit && (coreHit.exact || coreHit.score >= 0.7)) return 'value';
  return 'neutral';
}

/** 文字列がエラー・アサートログまたは純粋なコード識別子かどうか（汎用判定）。 */
export function isDiagnosticString(text) {
  if (typeof text !== 'string' || !text) return false;
  const s = text.trim();
  if (!s) return false;
  if (DIAGNOSTIC_PREFIX_RE.test(s) && !/[×÷]/.test(s)) return true;
  if (/^[A-Za-z_][\w.]*\[[^\]]+\]$/.test(s)) return true;
  if (!/[\s%]/.test(s) && !/[ぁ-んァ-ヶ一-龥]/.test(s) && /^[A-Za-z0-9_.:/$+-]+$/.test(s)) return true;
  return false;
}

/** 名前（シンボル・Objective-C / Itanium C++ メソッド）との当てはまり。 */
export function matchName(goal, name) {
  if (!goal || typeof name !== 'string') return null;
  const norm = normalizeCallableName(name);
  const mNorm = norm && norm !== name ? matchText(goal, norm) : null;
  const mRaw = matchText(goal, name);
  if (mNorm && mRaw) return mNorm.score >= mRaw.score ? mNorm : mRaw;
  return mNorm || mRaw;
}
