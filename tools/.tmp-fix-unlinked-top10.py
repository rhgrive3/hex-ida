from pathlib import Path
import re

ROOT = Path('.')

def load(path): return (ROOT / path).read_text()
def save(path, text): (ROOT / path).write_text(text)
def must_replace(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)
def brace_block(text, marker):
    i=text.find(marker)
    if i<0: raise RuntimeError(f'marker not found: {marker}')
    b=text.find('{', i)
    if b<0: raise RuntimeError('opening brace not found')
    depth=0; quote=None; esc=False; line=False; block=False
    for k in range(b, len(text)):
        c=text[k]; n=text[k+1] if k+1<len(text) else ''
        if line:
            if c=='\n': line=False
            continue
        if block:
            if c=='*' and n=='/': block=False
            continue
        if quote:
            if esc: esc=False
            elif c=='\\': esc=True
            elif c==quote: quote=None
            continue
        if c=='/' and n=='/': line=True; continue
        if c=='/' and n=='*': block=True; continue
        if c in "'\"`": quote=c; continue
        if c=='{': depth+=1
        elif c=='}':
            depth-=1
            if depth==0: return i,k+1,text[i:k+1]
    raise RuntimeError('unclosed block')
def replace_block(text, marker, new_block, label):
    i,j,_=brace_block(text,marker)
    return text[:i]+new_block+text[j:]

# #2541 — arbitrary function targets bind to their owning executable region.
p='js/ui/pinpoint-runtime.js'; s=load(p)
if 'function executableRegionFor(app, addr, fallback = null)' not in s:
    s=must_replace(s, 'function fixedInstructionSize(app) {', """function executableRegionFor(app, addr, fallback = null) {
  let target = null;
  try { target = BigInt(addr); } catch { return null; }
  const resolved = typeof app?.executableRegionFor === 'function' ? app.executableRegionFor(target) : null;
  if (resolved) return resolved;
  if (fallback && target >= fallback.vmAddr && target < fallback.vmAddr + fallback.size) return fallback;
  return null;
}

function fixedInstructionSize(app) {""", 'pinpoint region helper')
new_analyzer="""export function makePinpointAnalyzer(app, region = null, parentSignal = null, analyze = analyzeFunctionCached) {
  if (!app?.store?.get?.('canDisassemble')) return null;
  const legacyArm64 = isLegacyArm64Candidate(app);
  return async (addr, end, options = {}) => {
    const linked = combineSignals(parentSignal, options?.signal || null);
    try {
      if (linked.signal?.aborted) throw abortError(linked.signal);
      const canonical = await canonicalPinpointModel(app, addr, linked.signal, options);
      if (canonical !== undefined) return canonical;
      if (!legacyArm64) return null;
      const target = BigInt(addr);
      const targetRegion = executableRegionFor(app, target, region);
      if (!targetRegion) return null;
      const totalRows = Number(targetRegion.size / 4n);
      const startRow = Number((target - targetRegion.vmAddr) / 4n);
      if (!(startRow >= 0) || startRow >= totalRows) return null;
      const stop = end != null ? BigInt(end) : app.symbols?.functionWindowBound?.(target) ?? null;
      const regionEnd = targetRegion.vmAddr + targetRegion.size;
      if (stop != null && (stop <= target || stop > regionEnd)) return null;
      const endRow = stop != null
        ? Math.min(totalRows - 1, Number((stop - targetRegion.vmAddr) / 4n) - 1)
        : Math.min(totalRows - 1, startRow + 512);
      if (endRow < startRow) return null;
      const res = await analyze(app.backend, targetRegion, startRow, endRow,
        app.symbols, null, { ...(options || {}), texts: false, signal: linked.signal });
      return res?.model || null;
    } finally {
      linked.dispose();
    }
  };
}"""
s=replace_block(s, 'export function makePinpointAnalyzer(', new_analyzer, 'pinpoint analyzer')
save(p,s)

# #2522, #2541, #2549, #2530 — legacy panels wiring.
p='js/panels-base.js'; s=load(p)
new_prepare="""async function prepare(app, box) {
  const stringsPromise = app.ensureStrings((p) => {
    if (box) { box.set(p); box.say(pick('アプリの中の言葉を集めています…', 'Collecting text…')); }
  });
  const shapesPromise = app.ensureShapes((p) => {
    if (box) { box.set(p); box.say(pick('値の増減のしかたを調べています…', 'Watching how values change…')); }
  });
  if (box) box.say(pick('クラスと、その中の値の名前を読んでいます…', 'Reading classes and their fields…'));
  await app.ensureObjc();
  const programPromise = app.ensureProgram((p) => {
    if (box) {
      box.set(p);
      box.say(p.phase === 'functions'
        ? pick('関数の切れ目を調べています…', 'Finding function boundaries…')
        : pick('呼び出し関係とデータ参照を調べています…', 'Mapping calls and data references…'));
    }
  });
  const [strings, program, shapes] = await Promise.all([stringsPromise, programPromise, shapesPromise]);
  return { strings, program, shapes };
}"""
s=replace_block(s,'async function prepare(app, box)',new_prepare,'prepare')

new_tables="""export function showDataTables(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const controller = new AbortController();
  const sheet = new Sheet(pick('データの表', 'Data tables'), { onClose: () => controller.abort('data-tables-closed') });
  const body = sheet.body;
  body.append(para(pick(
    'ゲームの数値は、アプリの中ではなく CSV や JSON に入っています。' +
    'その読み込み処理を読んで、「何列目がどこに置かれるか」を取り出しました。',
    'Game numbers live in CSV/JSON files, not in the code. ' +
    'These tables were recovered by reading the loader instructions.')));
  const box = progressBox(body, pick('読み込み処理を調べています…', 'Reading the loaders…'));
  const out = el('div');
  body.append(out);
  app.ensureSchemas({ signal: controller.signal, onProgress: (p) => box.set(p) }).then((schemas) => {
    box.done();
    if (!sheet.root.isConnected) return;
    if (!schemas || !schemas.length) {
      out.append(para(pick('データファイルを読み込んでいるところが見つかりませんでした。', 'No data-file loader was found.'), 'sub'));
      return;
    }
    const sure = schemas.filter((entry) => entry.best?.consistent === true);
    const rest = schemas.filter((entry) => entry.best?.consistent !== true);
    if (sure.length) {
      const ul = list();
      ul.append(groupRow(pick('形まで確かめられた表', 'Tables whose shape checks out')));
      for (const entry of sure) ul.append(schemaRow(app, sheet, entry));
      out.append(ul);
    }
    if (rest.length) {
      out.append(disclosure(pick(`そこまで確かめられなかった表（${rest.length} 件）`, `${rest.length} tables that could not be fully checked`), {
        build: (holder) => {
          const ul = list();
          for (const entry of rest) ul.append(schemaRow(app, sheet, entry));
          holder.append(ul);
        },
      }));
    }
  }).catch((err) => {
    box.done();
    if (err?.name === 'AbortError' || controller.signal.aborted) return;
    if (sheet.root.isConnected) beginnerFailure(out, err);
  });
}"""
s=replace_block(s,'export function showDataTables(app)',new_tables,'showDataTables')

new_report="""export function showFunctionReport(app, addr, goal) {
  const sym = app.symbols;
  const fn = sym.functionCount ? sym.functionAt(addr) : null;
  const start = fn ? fn.start : BigInt(addr);
  const verified = app.validatedFunctionRange?.(start);
  const region = verified?.ok ? verified.region : app.executableRegionFor?.(start);
  if (!region) { toast(pick('この場所は実行可能な関数として確認できませんでした。', 'This address is not inside a verified executable region.')); return; }
  const regionEnd = region.vmAddr + region.size;
  const stop = verified?.ok ? verified.end : (fn?.end != null ? BigInt(fn.end) : null);
  if (stop != null && (stop <= start || stop > regionEnd)) {
    toast(pick('この関数の範囲を安全に確認できませんでした。', 'This function range could not be verified safely.'));
    return;
  }
  const totalRows = Number(region.size / 4n);
  const startRow = Number((start - region.vmAddr) / 4n);
  const endRow = stop != null
    ? Math.min(totalRows - 1, Number((stop - region.vmAddr) / 4n) - 1)
    : Math.min(totalRows - 1, startRow + 2048);
  if (!(startRow >= 0) || startRow >= totalRows || endRow < startRow) {
    toast(pick('この場所は関数として読めませんでした。', 'This place could not be read as a function.'));
    return;
  }
  const name = sym.nameAt(start);
  const sheet = new Sheet(pick('この関数について', 'About this function'), { size: 'wide' });
  sheet.root.classList.add('function-report-sheet');
  const body = sheet.body;
  const box = progressBox(body, t('functions.analyzing'));
  const later = el('div');
  body.append(later);
  const programPromise = Promise.resolve().then(() => app.ensureProgram()).catch(() => null);
  analyzeFunctionCached(app.backend, region, startRow, endRow, sym, (p) => box.set({ done: p, all: 1 }))
    .then((res) => {
      box.done();
      if (!sheet.root.isConnected) return;
      applySemantic(app, region, res);
      const render = (program) => {
        if (!sheet.root.isConnected) return;
        later.replaceChildren();
        const report = buildFunctionReport({
          model: res.model, region, symbols: sym, program, goal, name,
          fields: app.fields, owner: app.ownerOf(start),
        });
        report.role = roleFromReport(report, { apis: res.model.facts.apis });
        renderFunctionReport(app, sheet, later, report, res, region, goal);
      };
      render(null);
      programPromise.then((program) => { if (program && sheet.root.isConnected) render(program); });
    }).catch((err) => {
      box.done();
      if (sheet.root.isConnected) beginnerFailure(later, err, {
        actionLabel: pick('逆アセンブリを見る', 'Show disassembly'),
        onAction: () => { sheet.close(); app.goToAddress(start, { announce: true }); },
      });
    });
}"""
s=replace_block(s,'export function showFunctionReport(app, addr, goal)',new_report,'showFunctionReport')
i,j,block=brace_block(s,'async function attachIrFlow(')
block2=block.replace('const region = app.codeRegion();','const region = app.executableRegionFor?.(addr) || null;',1)
if block2==block: raise RuntimeError('attachIrFlow region replacement not found')
s=s[:i]+block2+s[j:]
save(p,s)

# #2530, #2524 — consumer cancellation and incremental string pages.
p='js/app.js'; s=load(p)
import_line="import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from './analysis/query/index.js';\n"
if "./cache/artifact-orchestration.js" not in s:
    s=must_replace(s,import_line,import_line+"import { awaitCancellableProducer } from './cache/artifact-orchestration.js';\n",'app abort import')
if 'this.schemasBusyController = null;' not in s:
    s=must_replace(s,"    this.schemasBusyEpoch = -1;\n    this.stringsBusy = null;", "    this.schemasBusyEpoch = -1;\n    this.schemasBusyController = null;\n    this.schemasConsumers = 0;\n    this.stringsBusy = null;\n    this.stringPartialListeners = new Set();",'app consumer state')
i,j,program_block=brace_block(s,'  async ensureProgram(onProgress)')
program_block=program_block.replace("    const progressFn = typeof onProgress === 'function' ? onProgress : (typeof onProgress === 'object' && typeof onProgress?.onProgress === 'function' ? onProgress.onProgress : null);", "    const progressFn = typeof onProgress === 'function' ? onProgress : (typeof onProgress === 'object' && typeof onProgress?.onProgress === 'function' ? onProgress.onProgress : null);\n    const signal = typeof onProgress === 'object' ? onProgress?.signal || null : null;\n    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name:'AbortError' });",1)
program_block=program_block.replace('if(this.programBusy&&this.programBusyEpoch===epoch)return this.programBusy;','if(this.programBusy&&this.programBusyEpoch===epoch)return awaitCancellableProducer(this.programBusy, signal);',1)
pos=program_block.rfind('return this.programBusy;')
if pos<0: raise RuntimeError('ensureProgram final return not found')
program_block=program_block[:pos]+'return awaitCancellableProducer(this.programBusy, signal);'+program_block[pos+len('return this.programBusy;'):]
s=s[:i]+program_block+s[j:]
new_schemas="""  async ensureSchemas(options) {
    const opts = typeof options === 'function' ? { onProgress: options } : (options || {});
    const progressFn = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const signal = opts.signal || null;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name:'AbortError' });
    if (this.schemas) return this.schemas;
    const epoch = this.backend.gen;
    this.schemasConsumers++;
    const waitFor = async (promise) => {
      try { return await awaitCancellableProducer(promise, signal); }
      finally {
        this.schemasConsumers = Math.max(0, this.schemasConsumers - 1);
        if (!this.schemasConsumers && this.schemasBusy && this.schemasBusyEpoch === epoch) this.schemasBusyController?.abort('no-schema-consumers');
      }
    };
    if (this.schemasBusy && this.schemasBusyEpoch === epoch) return waitFor(this.schemasBusy);
    this.schemasBusyEpoch = epoch;
    const controller = new AbortController();
    this.schemasBusyController = controller;
    this.schemasBusy = (async () => {
      try {
        const strings = await this.ensureStrings({ onProgress: progressFn, signal: controller.signal });
        const program = await this.ensureProgram({ onProgress: progressFn, signal: controller.signal });
        if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name:'AbortError' });
        if (epoch !== this.backend.gen) return null;
        if (!program) { this.schemas = []; return this.schemas; }
        const read = (addr, len) => this.backend.readAt(addr, len)
          .then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
        const arch = this.store.get('architecture') || this.currentSlice?.()?.capability?.architecture;
        const schemas = await recoverSchemas({ strings, program, read, onProgress: progressFn, architecture: arch,
          isCancelled: () => controller.signal.aborted || epoch !== this.backend.gen });
        if (!controller.signal.aborted && epoch === this.backend.gen) this.schemas = schemas;
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) throw (error?.name === 'AbortError' ? error : Object.assign(new Error('Aborted'), { name:'AbortError' }));
        if (epoch === this.backend.gen) this.schemas = [];
      } finally {
        if (this.schemasBusyEpoch === epoch) {
          this.schemasBusy = null;
          this.schemasBusyEpoch = -1;
          this.schemasBusyController = null;
        }
      }
      return epoch === this.backend.gen ? this.schemas : null;
    })();
    return waitFor(this.schemasBusy);
  }"""
s=replace_block(s,'  async ensureSchemas(',new_schemas,'ensureSchemas')
i,j,string_block=brace_block(s,'  async ensureStrings(onProgress)')
string_block=string_block.replace('  async ensureStrings(onProgress) {', "  async ensureStrings(onProgress) {\n    const opts = typeof onProgress === 'function' ? { onProgress } : (onProgress || {});\n    const progressFn = typeof opts.onProgress === 'function' ? opts.onProgress : null;\n    const signal = opts.signal || null;\n    const onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : null;\n    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name:'AbortError' });")
string_block=string_block.replace('    if (this.stringIndex) return this.stringIndex;','    if (this.stringIndex) return this.stringIndex;\n    if (onPartial) this.stringPartialListeners.add(onPartial);',1)
string_block=string_block.replace('    if (this.stringsBusy && this.stringsBusyEpoch === epoch) return this.stringsBusy;', "    const waitFor = async (promise) => {\n      try { return await awaitCancellableProducer(promise, signal); }\n      finally { if (onPartial) this.stringPartialListeners.delete(onPartial); }\n    };\n    if (this.stringsBusy && this.stringsBusyEpoch === epoch) return waitFor(this.stringsBusy);",1)
string_block=string_block.replace("          onProgress && ((p) => onProgress({ phase: 'strings', done: p.done, all: p.all, region: r.id })));", "          progressFn && ((p) => progressFn({ phase: 'strings', done: p.done, all: p.all, region: r.id })));",1)
needle="""        for (const s of res.results || []) {
          if (!collectionBudget.accept(s.text)) break;
          out.push({ addr: s.addr, text: s.text, region: r });
        }
"""
replacement=needle+"""        if (this.stringPartialListeners.size && out.length) {
          const partial = out.slice();
          partial.complete = false;
          partial.truncated = true;
          partial.truncationReason = 'producer-in-progress';
          for (const listener of [...this.stringPartialListeners]) {
            try { listener(partial); } catch { /* UI listener isolation */ }
          }
        }
"""
if needle not in string_block: raise RuntimeError('ensureStrings result loop not found')
string_block=string_block.replace(needle,replacement,1)
pos=string_block.rfind('return this.stringsBusy;')
if pos<0: raise RuntimeError('ensureStrings final return not found')
string_block=string_block[:pos]+'return waitFor(this.stringsBusy);'+string_block[pos+len('return this.stringsBusy;'):]
s=s[:i]+string_block+s[j:]
s=s.replace('  async loadDiffBaseline(file){return this.workspace.loadBaseline(file);}', '  async loadDiffBaseline(file,options={}){return this.workspace.loadBaseline(file,options);}',1)
save(p,s)

# #2545 — build global-reference aggregation once on ProgramIndex producer.
p='js/program.js'; s=load(p)
if 'this.referenceTargetStats = null;' not in s:
    s=must_replace(s,'    this._byCallTo = null;\n    this._byRefTo = null;', '    this._byCallTo = null;\n    this._byRefTo = null;\n    this.referenceTargetStats = null;\n    this.referenceTargetCounts = null;', 'program stats state')
insert_marker='  get callCount() { return this.callFrom.length; }'
if 'prepareReferenceTargetStats(regions)' not in s:
    method="""  prepareReferenceTargetStats(regions) {
    if (this.referenceTargetStats && this.referenceTargetCounts) return this.referenceTargetStats;
    const ranges = (regions || []).filter((r) => r && !r.exec && (r.declaredSize ?? r.size ?? 0n) > 0n)
      .map((r) => ({ region:r, lo:BigInt(r.vmAddr), hi:BigInt(r.vmAddr) + BigInt(r.declaredSize ?? r.size ?? 0n) }))
      .filter((entry) => entry.hi > entry.lo)
      .sort((a,b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
    const locate = (addr) => {
      let lo=0, hi=ranges.length-1;
      while (lo<=hi) {
        const mid=(lo+hi)>>1, entry=ranges[mid];
        if (addr<entry.lo) hi=mid-1;
        else if (addr>=entry.hi) lo=mid+1;
        else return entry.region;
      }
      return null;
    };
    const counts = new Map();
    for (let i=0;i<this.refCount;i++) {
      const addr=this.refTo[i]; if (addr==null) continue;
      const region=locate(addr); if (!region) continue;
      const key=addr.toString(); const old=counts.get(key);
      if (old) old.refs++;
      else counts.set(key,{addr,refs:1,region:region.name || region.section || region.id || '',regionId:region.id || null});
    }
    this.referenceTargetCounts = counts;
    this.referenceTargetStats = [...counts.values()].sort((a,b)=>b.refs-a.refs || (a.addr<b.addr?-1:a.addr>b.addr?1:0));
    return this.referenceTargetStats;
  }
  referenceCountTo(addr) {
    return this.referenceTargetCounts?.get?.(BigInt(addr).toString())?.refs ?? 0;
  }

"""
    s=must_replace(s,insert_marker,method+insert_marker,'program stats methods')
save(p,s)
p='js/app.js'; s=load(p)
i,j,program_block=brace_block(s,'  async ensureProgram(onProgress)')
needle="this.programScan=merged;this.programKey=key;this.program=new ProgramIndex(merged,this.symbols,primary);\n      return this.program;"
repl="this.programScan=merged;this.programKey=key;this.program=new ProgramIndex(merged,this.symbols,primary);\n      this.program.prepareReferenceTargetStats?.(this.store.get('regions') || []);\n      return this.program;"
if needle not in program_block: raise RuntimeError('ensureProgram ProgramIndex construction not found')
program_block=program_block.replace(needle,repl,1)
s=s[:i]+program_block+s[j:]
save(p,s)
p='js/linkage.js'; s=load(p)
s=s.replace('refs: program ? program.refSitesTo(s.addr, 8n, 200).length : 0,','refs: program ? (program.referenceCountTo?.(s.addr) ?? program.refSitesTo(s.addr, 8n, 200).length) : 0,',1)
new_hot="""function hotDataAddresses(program, dataRegions, limit, minRefs) {
  const stats = program?.referenceTargetStats;
  if (!Array.isArray(stats)) return [];
  const ranges = dataRegions.map((r) => ({ r, lo:r.vmAddr, hi:r.vmAddr + (r.declaredSize ?? r.size ?? 0n) }));
  const owns = (entry) => ranges.find((range) => entry.addr >= range.lo && entry.addr < range.hi)?.r || null;
  return stats.filter((entry) => entry.refs >= minRefs && owns(entry)).slice(0, limit)
    .map((entry) => ({ ...entry, region: owns(entry)?.name || entry.region }));
}"""
s=replace_block(s,'function hotDataAddresses(program, dataRegions, limit, minRefs)',new_hot,'hotDataAddresses')
save(p,s)
p='js/tools-base.js'; s=load(p)
new_globals="""export async function showGlobals(app) {
  const sheet = new Sheet('グローバル変数');
  const intro = el('div', 'hint',
    'どこからでも触れる置き場です。所持金・ログイン状態・設定などは、\\n' +
    'たいていここに置かれています。よく参照されているものほど上に出ます。');
  const status = el('div', 'hint', '参照関係を調べています…');
  const host = el('div');
  sheet.body.append(intro, status, host);
  const regions = app.store.get('regions') || [];
  const render = (globals) => {
    host.replaceChildren();
    if (!globals.length) return;
    const l = list();
    for (const g of globals.slice(0, 300)) {
      l.append(tapRow(g.readable, {
        sub: addrHex(g.addr) + '  ·  ' + g.region + '  ·  ' + g.refs + ' か所から参照' +
          (g.named ? '' : '\\n（名前は残っていません。参照の多さから見つけました）'),
        onTap: () => { sheet.close(); app.goToAddress(g.addr, { announce: true }); },
      }));
    }
    host.append(l);
  };
  render(findGlobals(app.symbols, null, regions, { limit: 400 }));
  const program = await app.ensureProgram().catch(() => null);
  if (!sheet.root.isConnected) return;
  status.remove();
  const globals = findGlobals(app.symbols, program, regions, { limit: 400 });
  render(globals);
  if (!globals.length) host.append(noteBox('見つかりませんでした（データのセクションが無いか、参照が拾えていません）。'));
}"""
s=replace_block(s,'export async function showGlobals(app)',new_globals,'showGlobals')
save(p,s)

# #2540 + #2543 — cancellable baseline lifecycle and symmetric matcher inputs.
p='js/workspace.js'; s=load(p)
if "./cache/artifact-orchestration.js" not in s:
    s=must_replace(s,"import { stripSecrets } from './ai/session-core/index.js';\n", "import { stripSecrets } from './ai/session-core/index.js';\nimport { awaitCancellableProducer } from './cache/artifact-orchestration.js';\n",'workspace abort import')
if 'this.baselineAbortController=null;' not in s:
    s=must_replace(s,'this.bindingRevision=0;this.bindSequence=0;this.baselineSequence=0;', 'this.bindingRevision=0;this.bindSequence=0;this.baselineSequence=0;this.baselineAbortController=null;', 'workspace baseline controller')
s=s.replace('  _resetBoundState(){const previous=this.baseline;this.bindingRevision++;this.baselineSequence++;', "  _resetBoundState(){const previous=this.baseline;this.baselineAbortController?.abort('workspace-binding-changed');this.baselineAbortController=null;this.bindingRevision++;this.baselineSequence++;",1)
s=must_replace(s,'function currentDiffFunctions(app){\n  const records=app?.recognition?.records||[];', 'function currentDiffFunctions(app,{symmetric=false}={}){\n  if(symmetric)return functionsFromSymbols(app?.symbols);\n  const records=app?.recognition?.records||[];','symmetric current diff')
if 'async function functionsFromSymbolsAsync' not in s:
    marker='function currentDiffFunctions(app,{symmetric=false}={}){'
    helper="""async function functionsFromSymbolsAsync(symbols,limit=MAX_DIFF_FUNCTIONS,signal=null){
  const funcs=symbols?.funcs||[];const out=[];const n=Math.min(funcs.length,limit);
  for(let i=0;i<n;i++){
    if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:Object.assign(new Error('Aborted'),{name:'AbortError'});
    const address=funcs[i],next=i+1<funcs.length?funcs[i+1]:null;
    out.push({address,name:symbols.nameAt?.(address)||null,size:next!=null&&next>address?Number(next-address):0,strings:[],calls:[],imports:[],semantic:{writes:[],thresholds:[]},fieldAccessShape:[]});
    if((i&4095)===4095)await new Promise((resolve)=>setTimeout(resolve,0));
  }
  out.complete=n===funcs.length&&symbols?.functionStartsComplete===true;out.total=funcs.length;out.scanned=n;out.truncationReason=n<funcs.length?'function-budget':symbols?.functionStartsComplete===true?null:'function-discovery-incomplete';return out;
}

"""
    s=must_replace(s,marker,helper+marker,'async baseline functions')
new_load="""  async loadBaseline(file,{backend=null,signal=null}={}){
    if(!file)throw new Error('baseline-file-required');
    if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:Object.assign(new Error('Aborted'),{name:'AbortError'});
    if(!this.identity)await this.bind();
    if(!this.identity)throw staleWorkspaceError();
    this.baselineAbortController?.abort('baseline-superseded');
    const controller=new AbortController();this.baselineAbortController=controller;
    const relay=()=>{if(!controller.signal.aborted)controller.abort(signal?.reason??'cancelled');};
    if(signal){if(signal.aborted)relay();else signal.addEventListener('abort',relay,{once:true});}
    const revision=this.bindingRevision,request=++this.baselineSequence;
    const assertCurrent=()=>{this._assertBinding(revision);if(request!==this.baselineSequence)throw staleWorkspaceError();if(controller.signal.aborted)throw controller.signal.reason instanceof Error?controller.signal.reason:Object.assign(new Error('Aborted'),{name:'AbortError'});};
    const ownedBackend=!backend,other=backend||this.backendFactory();
    try{
      const info=await awaitCancellableProducer(other.open(file),controller.signal);assertCurrent();
      const currentArch=this.identity?.metadata?.architecture||null;const sliceIndex=chooseSlice(info,currentArch);
      if(sliceIndex<0)throw new Error('baseline-slice-unavailable');
      const slice=info.slices[sliceIndex];const arch=slice?.capability?.architecture||slice?.info?.architecture||slice?.info?.cpu||null;
      if(currentArch&&arch&&currentArch!==arch){const error=new Error(`architecture mismatch: ${currentArch} vs ${arch}`);error.code='DIFF_ARCH_MISMATCH';throw error;}
      const hash=await other.ensureContentHash(null,controller.signal);assertCurrent();
      const result=await other.analyze(sliceIndex,{signal:controller.signal});assertCurrent();
      const symbols=new SymbolIndex({...result,regions:slice?.regions||[]});
      const functions=await functionsFromSymbolsAsync(symbols,MAX_DIFF_FUNCTIONS,controller.signal);assertCurrent();
      const previous=this.baseline;
      this.baseline={file,backend:other,ownedBackend,info,sliceIndex,slice,architecture:arch,hash,symbols,functions,complete:functions.complete===true};
      if(previous?.ownedBackend&&previous.backend!==other)previous.backend?.dispose?.();
      this.diffState=null;this.busy=null;return this.baseline;
    }catch(error){if(ownedBackend)other?.dispose?.();throw error;}
    finally{if(signal)signal.removeEventListener('abort',relay);if(this.baselineAbortController===controller)this.baselineAbortController=null;}
  }"""
s=replace_block(s,'  async loadBaseline(',new_load,'loadBaseline')
s=s.replace('      const current=currentDiffFunctions(this.app), before=baseline.functions;', "      const current=currentDiffFunctions(this.app,{symmetric:true}), before=baseline.functions;\n      const currentRich=currentDiffFunctions(this.app);",1)
s=s.replace('this.diffState={...result,provenance:{baselineHash:baseline.hash,currentHash:this.identity?.hash||null,architecture:baseline.architecture}};', "this.diffState={...result,provenance:{baselineHash:baseline.hash,currentHash:this.identity?.hash||null,architecture:baseline.architecture,matchingProjection:'symmetric-symbol-function-v1',currentRichEvidenceAvailable:currentRich!==current}};",1)
save(p,s)

# #2524, #2528, #2529, #2540 — Product UI query and lifecycle wiring.
p='js/ui/product.js'; s=load(p)
new_string="""async function stringItems(app, query, options = {}) {
  const limit = Math.max(1, Number(options.limit) || 200);
  let settled = false;
  let finish;
  const early = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const onPartial = (rows) => {
    if (settled || options.signal?.aborted) return;
    try {
      const items = queryStrings((rows || []).slice(), query, options);
      if (Number(items?.length || 0) >= limit) {
        settled = true;
        items.complete = false;
        items.truncated = true;
        items.truncationReason = 'string-producer-in-progress';
        finish.resolve(items);
      }
    } catch (error) { settled = true; finish.reject(error); }
  };
  app.ensureStrings({ signal: options.signal, onProgress: options.onProgress, onPartial }).then((rows) => {
    if (settled) return;
    settled = true;
    finish.resolve(queryStrings(rows || [], query, options));
  }, (error) => { if (!settled) { settled = true; finish.reject(error); } });
  return early;
}"""
s=replace_block(s,'async function stringItems(app, query, options)',new_string,'stringItems')
if 'function canonicalRecognitionFor(' not in s:
    marker='function evidenceStatus(item) { return genericEvidenceStatus(item); }'
    helper="""function canonicalRecognitionFor(app, addr, input) {
  const records=app?.recognition?.records;
  const record=Array.isArray(records)?records.find((entry)=>{try{return BigInt(entry?.address)===BigInt(addr);}catch{return false;}}):null;
  if(record){
    return { classification:record.classification||'UNKNOWN', confidence:Number(record.confidence??record.score??0), evidence:record.evidence||record.reasons||record.fingerprint?.evidence||[], provisional:false, provenance:'recognition/index' };
  }
  const local=classifyFunction(input);
  return { ...local, provisional:true, provenance:'function-local-provisional' };
}

"""
    s=must_replace(s,marker,helper+marker,'canonical recognition helper')
s=s.replace('    const recognition = classifyFunction(recognitionInput(app, addr, res));\n    const subsystems = discoverSubsystems(recognitionInput(app, addr, res));', "    const input = recognitionInput(app, addr, res);\n    const recognition = canonicalRecognitionFor(app, addr, input);\n    const subsystems = discoverSubsystems(input);",1)
s=s.replace("badge: evidenceBadge(recognition.classification === 'UNKNOWN' ? 'unverified' : 'likely'),", "badge: evidenceBadge(recognition.provisional || recognition.classification === 'UNKNOWN' ? 'unverified' : 'likely'),",1)
needle='    content.replaceChildren(grid);\n  };'
repl="""    content.replaceChildren(grid);
    if (recognition.provisional && app.ensureRecognition) {
      void app.ensureRecognition({ maxFunctions:350000 }).then(() => {
        if (viewCurrent() && !disposed && tab === 'overview') {
          const canonical = canonicalRecognitionFor(app, addr, input);
          if (!canonical.provisional) renderOverview(res);
        }
      }).catch(() => {});
    }
  };"""
if needle not in s: raise RuntimeError('renderOverview tail not found')
s=s.replace(needle,repl,1)
new_results="""function renderResults(app, router) {
  const s = screen(text('結果', 'Results'), { id: 'results', subtitle: text('確認した答え、根拠、履歴、ピンをここへ集めます。', 'Confirmed answers, evidence, history and pins live here.') });
  const controller = new AbortController();
  s.body.append(loadingState(text('結果を読み込んでいます…', 'Loading results…')));
  const renderFinding = (item) => {
    const title = item?.title || item?.label || item?.claim || item?.reason || item?.kind || item?.type || text('解析結果', 'Finding');
    const address = item?.addr ?? item?.address ?? item?.functionAddr ?? item?.functionId ?? item?.function;
    let nav = null;
    try { if (address != null) nav = () => router.navigate('/function/' + BigInt(address).toString() + '/overview'); } catch { nav = null; }
    return listRow({ title:String(title), subtitle:address != null ? addressText(address) : '', badge:evidenceBadge(evidenceStatus(item)), onClick:nav });
  };
  (async()=>{
    try {
      const queries=app.analysisQueries;
      if(!queries) throw new Error('analysis-query-api-unavailable');
      const snapshot=await queries.snapshot({signal:controller.signal});
      const result=await queries.evidence(snapshot,{scope:'results'},{offset:0,limit:5000},{signal:controller.signal});
      if(controller.signal.aborted)return;
      const findings=Array.isArray(result?.value)?result.value:[];
      s.body.replaceChildren();
      if(!findings.length){
        s.body.append(emptyState(text('まだ確定した結果がありません', 'No confirmed results yet'), text('「調べる」で目的を入力すると、答えと根拠をここから辿れるようになります。', 'Investigate a goal to create results you can revisit.'), uiButton(text('調べるへ', 'Go to Investigate'), { cls:'ui-primary-action', onClick:()=>router.navigate('/investigate') })));
        return;
      }
      if(findings.length>80)s.body.append(new VirtualList({items:findings,rowHeight:64,ariaLabel:text('解析結果','Analysis results'),renderRow:renderFinding}).root);
      else{const list=h('div','ui-list');for(const item of findings)list.append(renderFinding(item));s.body.append(list);}
      if(result?.status?.completeness && result.status.completeness!=='complete')s.body.prepend(h('p','ui-partial-note',text('結果は一部です。未走査部分を否定証拠にはしません。','Results are partial; unscanned data is not treated as negative evidence.')));
    }catch(error){
      if(controller.signal.aborted)return;
      s.body.replaceChildren(errorState(text('結果を読み込めませんでした','Could not load results'),String(error?.message||error)));
    }
  })();
  return { root:s.root, dispose:()=>controller.abort('results-view-disposed') };
}"""
s=replace_block(s,'function renderResults(app, router)',new_results,'renderResults')
new_diff="""function renderDiff(app,router) {
  const s=screen(text('バイナリ差分','Binary Diff'),{id:'diff',subtitle:text('前のバージョンと現在のバージョンを関数単位で比較します。','Compare a previous version with the current binary at function granularity.')});
  const host=h('div','ui-stack');s.body.append(host);
  let operation=null;
  const nextSignal=()=>{operation?.abort('diff-operation-superseded');operation=new AbortController();return operation.signal;};
  if(!app.store.get('fileInfo')){host.append(emptyState(text('先に現在のバイナリを開いてください','Open the current binary first'),'',uiButton(text('コードへ','Go to Code'),{onClick:()=>router.navigate('/code')})));return {root:s.root,dispose:()=>operation?.abort('diff-view-disposed')};}
  const state=app.getBinaryDiff?.(); const baseline=app.workspace?.baseline;
  const controls=h('div','ui-actions');
  controls.append(uiButton(baseline?text('比較元を変更','Change baseline'):text('前のバージョンを選ぶ','Choose previous version'),{cls:'ui-primary-action',onClick:async()=>{
    const file=await pickOneFile();if(!file)return;const signal=nextSignal();host.replaceChildren(loadingState(text('比較元を解析しています…','Analysing baseline…')));
    try{await app.loadDiffBaseline(file,{signal});await app.runBinaryDiff({signal});if(!signal.aborted)router.navigate('/diff',{replace:true});}
    catch(error){if(error?.name!=='AbortError'&&!signal.aborted)host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}
  }}));
  if(baseline)controls.append(uiButton(text('再比較','Compare again'),{onClick:async()=>{const signal=nextSignal();host.replaceChildren(loadingState(text('比較しています…','Comparing…')));try{await app.runBinaryDiff({signal});if(!signal.aborted)router.navigate('/diff',{replace:true});}catch(error){if(error?.name!=='AbortError'&&!signal.aborted)host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}}}));
  host.append(controls);
  if(!state){host.append(emptyState(text('比較元を選ぶと変更された関数を抽出します','Choose a baseline to find changed functions'),text('同一CPU/スライスだけを比較し、不完全な探索では new/deleted を断定しません。','Only matching architectures/slices are compared; incomplete matching never invents new/deleted certainty.')));return {root:s.root,dispose:()=>operation?.abort('diff-view-disposed')};}
  const counts={same:0,moved:0,changed:0,rewritten:0,new:0,deleted:0,unresolved:0};for(const c of state.changes||[])counts[c.changeType]=(counts[c.changeType]||0)+1;
  const summary=card(text('比較結果','Diff summary'));summary.body.append(h('p','ui-body',`${counts.changed||0} changed · ${counts.rewritten||0} rewritten · ${counts.moved||0} moved · ${counts.new||0} new · ${counts.deleted||0} deleted · ${counts.unresolved||0} unresolved`));summary.body.append(h('p',state.completeness?.complete?'ui-sub':'ui-warning',state.completeness?.complete?text('関数集合とmatchingは完全です。','Function sets and matching are complete.'):text('部分結果です: ','Partial result: ')+(state.completeness?.reasons||[]).join(', ')));host.append(summary.root);
  const interesting=(state.changes||[]).filter((c)=>c.changeType!=='same').slice(0,5000);const render=(c)=>{const current=c.after?.address??null;const previous=c.before?.address??null;const title=c.after?.name||c.before?.name||(current!=null?functionName(app,current):text('削除された関数','Deleted function'));const tags=c.semanticChange?.tags?.join(', ')||'';return listRow({title,subtitle:[c.changeType,current!=null?addressText(current):previous!=null?'old '+addressText(previous):'',tags].filter(Boolean).join(' · '),badge:evidenceBadge(c.changeType==='unresolved'?'unverified':c.confidence>=0.82?'confirmed':'likely'),onClick:current!=null?()=>router.navigate('/function/'+BigInt(current).toString()+'/overview'):null});};
  if(interesting.length>100)host.append(new VirtualList({items:interesting,rowHeight:64,ariaLabel:text('変更関数','Changed functions'),renderRow:render}).root);else{const list=h('div','ui-list');for(const c of interesting)list.append(render(c));host.append(list);}return {root:s.root,dispose:()=>operation?.abort('diff-view-disposed')};
}"""
s=replace_block(s,'function renderDiff(app,router)',new_diff,'renderDiff')
save(p,s)

# Focused regression contract.
test=Path('tests/unlinked-top10-wiring-regression.mjs')
test.write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ProgramIndex } from '../js/program.js';
import { makePinpointAnalyzer } from '../js/ui/pinpoint-runtime.js';

const source=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
{
  const A={id:'A',vmAddr:0x1000n,size:0x1000n,exec:true};
  const B={id:'B',vmAddr:0x5000n,size:0x1000n,exec:true};
  let observed=null;
  const app={store:{get:(k)=>k==='canDisassemble'?true:k==='architecture'?'arm64':k==='capability'?{architecture:'arm64',fixedInstructionSize:4}:null},executableRegionFor:(addr)=>addr>=B.vmAddr&&addr<B.vmAddr+B.size?B:addr>=A.vmAddr&&addr<A.vmAddr+A.size?A:null,symbols:{functionWindowBound:()=>0x5180n},backend:{},analysisQueries:null};
  const analyze=async(_backend,region,startRow,endRow)=>{observed={region,startRow,endRow};return {model:{ok:true}};};
  const run=makePinpointAnalyzer(app,A,null,analyze);
  assert.deepEqual(await run(0x5100n,0x5180n),{ok:true});
  assert.equal(observed.region,B);assert.equal(observed.startRow,0x40);
  observed=null;assert.equal(await run(0x9000n,null),null);assert.equal(observed,null);
}
{
  const scan={refFrom:new BigUint64Array([1n,2n,3n,4n]),refTo:new BigUint64Array([0x8000n,0x8000n,0x8008n,0x1000n]),refKind:new Uint8Array(4),refCount:4};
  const p=new ProgramIndex(scan,null,null);p.prepareReferenceTargetStats([{id:'D',name:'__data',vmAddr:0x8000n,size:0x100n,exec:false}]);
  assert.equal(p.referenceCountTo(0x8000n),2);assert.equal(p.referenceTargetStats[0].addr,0x8000n);
}
const panels=source('js/panels-base.js');
assert.match(panels,/const stringsPromise = app\.ensureStrings/);
assert.match(panels,/validatedFunctionRange\?\.\(start\)/);
assert.match(panels,/render\(null\);[\s\S]*programPromise\.then/);
assert.match(panels,/new AbortController\(\)[\s\S]*ensureSchemas\(\{ signal:/);
const app=source('js/app.js');
assert.match(app,/schemasConsumers/);assert.match(app,/stringPartialListeners/);
const workspace=source('js/workspace.js');
assert.match(workspace,/baselineAbortController/);
assert.match(workspace,/currentDiffFunctions\(this\.app,\{symmetric:true\}\)/);
const product=source('js/ui/product.js');
assert.match(product,/onPartial/);
assert.match(product,/queries\.evidence/);assert.doesNotMatch(product,/item\.confidence > 0\.7/);
assert.match(product,/canonicalRecognitionFor/);
assert.match(product,/loadDiffBaseline\(file,\{signal\}\)/);
console.log('unlinked top-10 wiring regression: ok');
''')

print('patched 10 unlinked issues')
