/*
 * "Where does this come from?": shortest caller chains from well-known entry
 * points (app launch, screen display, touch, network, per-frame, purchase)
 * down to one function. Uses only direct call edges; an entry is recognised by
 * its symbol name. Functions without direct callers end a chain as 'root'.
 */

export const ENTRY_KINDS = Object.freeze([
  { kind: 'launch', ja: 'アプリ起動', en: 'App launch', re: /application:didFinishLaunching|applicationDidFinishLaunching|applicationWillEnterForeground|applicationDidBecomeActive|^_?main$|AppDelegate::applicationDidFinishLaunching/ },
  { kind: 'purchase', ja: '課金', en: 'Purchase', re: /paymentQueue:updatedTransactions|productsRequest:didReceiveResponse|purchase(?:d|Completed|Succeeded)/i },
  { kind: 'network', ja: '通信の受信', en: 'Network response', re: /URLSession:.*didReceive|URLSession:.*didComplete|connection:didReceive|connectionDidFinishLoading|onHttpRequestCompleted|onResponse|didReceiveResponse/ },
  { kind: 'touch', ja: 'タッチ・ボタン', en: 'Touch / button', re: /touches(?:Began|Ended|Moved):|onTouch(?:Began|Ended|Moved)|ccTouch(?:Began|Ended)|(?:Button|Btn)(?:Pressed|Tapped|Clicked|Callback)|menuCallback|didSelectRowAtIndexPath|handleTap|gestureRecognizer/ },
  { kind: 'screen', ja: '画面表示', en: 'Screen shown', re: /viewDidLoad|viewWillAppear:|viewDidAppear:|loadView\b|onEnterTransitionDidFinish|::onEnter\(|\bonEnter\b|layoutSubviews/ },
  { kind: 'frame', ja: '毎フレーム', en: 'Every frame', re: /(?:^|[\s:[])update:|::update\(|\bupdate\(float|displayLink|drawFrame|scheduleUpdate|\btick\b/ },
]);

export function entryKindOf(name) {
  if (typeof name !== 'string' || !name || /^sub_[0-9a-f]+$/i.test(name)) return null;
  return ENTRY_KINDS.find((k) => k.re.test(name)) || null;
}

function toBig(value) {
  if (typeof value === 'bigint') return value;
  try { return value == null ? null : BigInt(value); } catch { return null; }
}

/**
 * @param {{callersOf:Function}} program
 * @param {(addr:bigint)=>string|null} nameOf
 * @returns {{paths:Array<{kind:string, ja:string, en:string, nodes:bigint[]}>, complete:boolean}}
 */
export function findEntryPaths(program, nameOf, target, { maxDepth = 8, maxNodes = 4000, maxPaths = 3, callerLimit = 64 } = {}) {
  const start = toBig(target);
  if (start == null || typeof program?.callersOf !== 'function') return { paths: [], complete: false };
  const parent = new Map([[start.toString(), null]]);
  const depth = new Map([[start.toString(), 0]]);
  const queue = [start];
  const hits = [];
  const roots = [];
  let complete = true;
  const ownKind = entryKindOf(nameOf(start));
  if (ownKind) hits.push({ entry: ownKind, addr: start });
  for (let head = 0; head < queue.length && hits.length < maxPaths; head++) {
    const node = queue[head];
    const key = node.toString();
    const d = depth.get(key);
    if (d >= maxDepth) { complete = false; continue; }
    let callers;
    try { callers = program.callersOf(node, callerLimit) || []; } catch { callers = []; complete = false; }
    if (callers.complete === false || callers.truncated) complete = false;
    let seenCaller = false;
    for (const item of callers) {
      const caller = toBig(item?.addr);
      if (caller == null) continue;
      seenCaller = true;
      const ck = caller.toString();
      if (parent.has(ck)) continue;
      if (parent.size >= maxNodes) { complete = false; break; }
      parent.set(ck, key);
      depth.set(ck, d + 1);
      const kind = entryKindOf(nameOf(caller));
      if (kind) { hits.push({ entry: kind, addr: caller }); if (hits.length >= maxPaths) break; continue; }
      queue.push(caller);
    }
    if (!seenCaller && node !== start && roots.length < maxPaths) roots.push(node);
  }
  const chain = (addr) => {
    const out = [];
    let k = addr.toString();
    while (k != null) { out.push(BigInt(k)); k = parent.get(k); }
    return out; // entry first, target last
  };
  const paths = hits.map((h) => ({ kind: h.entry.kind, ja: h.entry.ja, en: h.entry.en, nodes: chain(h.addr) }));
  if (!paths.length) {
    for (const r of roots) paths.push({ kind: 'root', ja: '呼び出し元なし', en: 'No direct caller', nodes: chain(r) });
  }
  return { paths, complete };
}
