from pathlib import Path

# ---- app.js: preserve current-main producer/cancellation work, apply only residuals ----
p = Path('js/app.js')
s = p.read_text()
old = """import {
  showFileInfo, showSections, showJump, showSearch, showDetail, showSettings,
  instructionMenu, showFunctions, showStrings, showStructure, showHelp,
  showLearn, showGlossary, showWelcome, showSampleGuide, showFunctionSummary,
  showFeatures, showInvestigate, showOverview, showFunctionReport, showAccuracyNotes,
} from './panels.js';
"""
if s.count(old) != 1:
    raise SystemExit(f'app panels import precondition count={s.count(old)}')
s = s.replace(old, '', 1)
old = "import { NoteStore, noteKeyFor, legacyV2NoteKeyFor, legacyNoteKeyForSlice, EMPTY_NOTES } from './names.js';"
new = "import { NoteStore, noteKeyFromBinaryId, findLegacyV3NoteKey, legacyV2NoteKeyFor, legacyNoteKeyForSlice, EMPTY_NOTES } from './names.js';"
if s.count(old) != 1:
    raise SystemExit(f'app names import precondition count={s.count(old)}')
s = s.replace(old, new, 1)
anchor = "import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from './analysis/query/index.js';\n"
lazy = """

let _panelsModulePromise = null;
function panelsModule() { return _panelsModulePromise ||= import('./panels.js'); }
function lazyPanel(name) {
  return (...args) => panelsModule().then((module) => module[name](...args));
}
const showFileInfo = lazyPanel('showFileInfo');
const showSections = lazyPanel('showSections');
const showJump = lazyPanel('showJump');
const showSearch = lazyPanel('showSearch');
const showDetail = lazyPanel('showDetail');
const showSettings = lazyPanel('showSettings');
const instructionMenu = lazyPanel('instructionMenu');
const showFunctions = lazyPanel('showFunctions');
const showStrings = lazyPanel('showStrings');
const showStructure = lazyPanel('showStructure');
const showHelp = lazyPanel('showHelp');
const showLearn = lazyPanel('showLearn');
const showGlossary = lazyPanel('showGlossary');
const showWelcome = lazyPanel('showWelcome');
const showSampleGuide = lazyPanel('showSampleGuide');
const showFunctionSummary = lazyPanel('showFunctionSummary');
const showFeatures = lazyPanel('showFeatures');
const showInvestigate = lazyPanel('showInvestigate');
const showOverview = lazyPanel('showOverview');
const showFunctionReport = lazyPanel('showFunctionReport');
const showAccuracyNotes = lazyPanel('showAccuracyNotes');
"""
if s.count(anchor) != 1:
    raise SystemExit(f'app lazy anchor count={s.count(anchor)}')
s = s.replace(anchor, anchor + lazy, 1)
old = """      const [id, legacyV2] = await Promise.all([
        noteKeyFor(file,info,sliceIndex,{signal:controller.signal}),
        legacyV2NoteKeyFor(file,info,sliceIndex),
      ]);
      if (controller.signal.aborted || epoch !== this.backend.gen || this.store.get('file') !== file || this.store.get('sliceIndex') !== sliceIndex) return null;
      const notes=new NoteStore(id,[legacyV2,legacyNoteKeyForSlice(file,info,sliceIndex)]);
"""
new = """      const [binaryId, legacyV2] = await Promise.all([
        this.backend.ensureBinaryId({ signal:controller.signal }),
        legacyV2NoteKeyFor(file,info,sliceIndex),
      ]);
      if (controller.signal.aborted || epoch !== this.backend.gen || this.store.get('file') !== file || this.store.get('sliceIndex') !== sliceIndex) return null;
      const id=noteKeyFromBinaryId(file,info,sliceIndex,binaryId);
      // Discover an existing v3 namespace cheaply; do not re-hash the active slice
      // on every cold open merely to learn whether migration data exists.
      const legacyV3=findLegacyV3NoteKey(file,info,sliceIndex);
      const notes=new NoteStore(id,[legacyV3,legacyV2,legacyNoteKeyForSlice(file,info,sliceIndex)]);
"""
if s.count(old) != 1:
    raise SystemExit(f'app attachNotes precondition count={s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

# ---- demand-driven-runtime.js: retain current-main localRegionPlan fixes and add
# explicit truncationReason contract required by typed callers/callees/xrefs ----
p = Path('js/analysis/demand-driven-runtime.js')
s = p.read_text()
old = """      const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:source?.incompleteReason ?? reason ?? null, scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds });
"""
new = """      const relationReason=source?.incompleteReason ?? reason ?? null;
      const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:relationReason, truncationReason:relationReason, scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds });
"""
if s.count(old) != 1:
    raise SystemExit(f'demand callers precondition count={s.count(old)}')
s = s.replace(old, new, 1)
old = """      const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:source?.incompleteReason ?? reason ?? null, scope:'active-function', scannedRegionIds, unscannedRegionIds });
"""
new = """      const relationReason=source?.incompleteReason ?? reason ?? null;
      const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:relationReason, truncationReason:relationReason, scope:'active-function', scannedRegionIds, unscannedRegionIds });
"""
if s.count(old) != 1:
    raise SystemExit(f'demand callees precondition count={s.count(old)}')
s = s.replace(old, new, 1)
old = """      return paged(rows, page, refs.complete === false || calls.complete === false || reason ? 'partial' : 'complete', { reason:refs.incompleteReason ?? calls.incompleteReason ?? reason ?? null, scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds });
"""
new = """      const relationReason=refs.incompleteReason ?? calls.incompleteReason ?? reason ?? null;
      return paged(rows, page, refs.complete === false || calls.complete === false || reason ? 'partial' : 'complete', { reason:relationReason, truncationReason:relationReason, scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds });
"""
if s.count(old) != 1:
    raise SystemExit(f'demand xrefs precondition count={s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)
print('rebased overlap residuals applied')
