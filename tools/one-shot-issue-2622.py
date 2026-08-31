from pathlib import Path
import json
import subprocess

ROOT = Path('.')


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'{path}: anchor drift: {label}')
    p.write_text(s.replace(old, new, 1))


def inject(path, signature, code, label):
    replace_once(path, signature, signature + '\n' + code, label)


# A deterministic static-ESM graph meter is permanent proof for the cold graph.
Path('tools/validation/startup-module-graph.mjs').write_text(r'''import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function localSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?!\()(?:(?:[\w$]+\s*,\s*)?(?:\{[\s\S]*?\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+)?['\"]([^'\"]+)['\"]/g,
    /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s+['\"]([^'\"]+)['\"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith('.')) found.add(match[1]);
    }
  }
  return [...found];
}

function resolveModule(from, specifier) {
  let candidate = path.resolve(path.dirname(from), specifier);
  if (!path.extname(candidate)) candidate += '.js';
  return candidate;
}

export function collectStaticModuleGraph(entry, { root = ROOT } = {}) {
  const absoluteEntry = path.resolve(root, entry);
  const queue = [absoluteEntry];
  const seen = new Set();
  let sourceBytes = 0;
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!file.startsWith(root + path.sep) && file !== root) throw new Error(`module escaped root: ${file}`);
    if (!fs.existsSync(file)) throw new Error(`missing static module: ${path.relative(root, file)}`);
    const source = fs.readFileSync(file, 'utf8');
    seen.add(file);
    sourceBytes += Buffer.byteLength(source);
    for (const specifier of localSpecifiers(source)) {
      const dependency = resolveModule(file, specifier);
      if (dependency.endsWith('.js')) queue.push(dependency);
    }
  }
  const modules = [...seen].map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
  return Object.freeze({ entry: path.relative(root, absoluteEntry).split(path.sep).join('/'), moduleCount: modules.length, sourceBytes, modules });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entry = process.argv[2] || 'js/app.js';
  const result = collectStaticModuleGraph(entry);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else console.log(`${result.entry}: ${result.moduleCount} static modules / ${result.sourceBytes} source bytes`);
}
''')

# Record the exact pre-repair cold graph before changing any production source.
before = subprocess.run(
    ['node', 'tools/validation/startup-module-graph.mjs', 'js/app.js', '--json'],
    check=True, capture_output=True, text=True,
)
baseline = json.loads(before.stdout.strip())
Path('tests/fixtures').mkdir(parents=True, exist_ok=True)
Path('tests/fixtures/issue-2622-startup-baseline.json').write_text(json.dumps({
    'headPurpose': 'pre-issue-2622-current-integration-head',
    'moduleCount': baseline['moduleCount'],
    'sourceBytes': baseline['sourceBytes'],
    'representativeModules': [m for m in baseline['modules'] if m in {
        'js/panels-base.js','js/tools-base.js','js/plugins.js','js/script.js','js/sandbox.js',
        'js/il2cpp.js','js/decompile.js','js/graphview.js','js/types.js','js/linkage.js',
        'js/patch.js','js/rtti.js'
    }],
}, indent=2) + '\n')

# Split name-only demangling from full RTTI/vtable machinery. tools.js keeps sync names
# without pulling the full RTTI scanner into the cold graph.
rtti = Path('js/rtti.js').read_text()
marker = 'export function findCxxClasses'
if marker not in rtti:
    raise SystemExit('rtti split anchor drift')
idx = rtti.index(marker)
name_source = rtti[:idx].rstrip() + '\n'
rest = rtti[idx:]
Path('js/rtti-names.js').write_text(name_source)
Path('js/rtti.js').write_text(
    "import { demangleCxx, readableName } from './rtti-names.js';\n"
    "export { demangleCxx, demangleSwift, readableName, shortName, isMangled } from './rtti-names.js';\n\n"
    + rest
)
replace_once('js/tools.js',
             "import { isMangled, shortName, readableName } from './rtti.js';",
             "import { isMangled, shortName, readableName } from './rtti-names.js';",
             'tools lightweight names')

# Split PatchSet from the assembler. App startup needs the patch ledger, not the ARM64
# assembler/parser dragged in by patch.js.
patch = Path('js/patch.js').read_text()
conds = '\nconst CONDS = '
if conds not in patch:
    raise SystemExit('patch split anchor drift')
head, tail = patch.split(conds, 1)
head = head.replace("import { parseOperands } from './arm64.js';\n", '', 1)
head = head.replace('function integerBigInt(value, name) {', 'export function integerBigInt(value, name) {', 1)
Path('js/patch-set.js').write_text('/* Lightweight patch ledger; assembler dependencies stay demand-loaded. */\n' + head.strip() + '\n')
Path('js/patch.js').write_text(
    "/* Binary patching and the small ARM64 patch assembler. */\n"
    "import { parseOperands } from './arm64.js';\n"
    "import { integerBigInt } from './patch-set.js';\n"
    "export { PatchSet } from './patch-set.js';\n\n"
    "const CONDS = " + tail
)
replace_once('js/app.js', "import { PatchSet } from './patch.js';", "import { PatchSet } from './patch-set.js';", 'app PatchSet boundary')

# Split the persisted PluginHost from plugin UI/platform exports, and demand-load only
# sandbox/script execution when install/run is actually requested.
plugins = Path('js/plugins.js').read_text()
plugin_marker = 'export const EXAMPLE_PLUGIN = '
if plugin_marker not in plugins:
    raise SystemExit('plugin host split anchor drift')
pidx = plugins.index(plugin_marker)
prefix = plugins[:pidx]
remainder = plugins[pidx:]
prefix = prefix.replace("import { createApi } from './script.js';\n", '', 1)
prefix = prefix.replace("import { runInSandbox } from './sandbox.js';\n", '', 1)
old = """    const discovered = await runInSandbox({
      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000,
    });"""
new = """    const { runInSandbox } = await import('./sandbox.js');
    const discovered = await runInSandbox({
      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000,
    });"""
if old not in prefix:
    raise SystemExit('plugin install dynamic import anchor drift')
prefix = prefix.replace(old, new, 1)
old = """    const { api, print } = createApi(this.app, out, options);
    return runInSandbox({ source: p.source, mode: 'plugin', index: p.index, api,"""
new = """    const [{ createApi }, { runInSandbox }] = await Promise.all([
      import('./script.js'), import('./sandbox.js'),
    ]);
    const { api, print } = createApi(this.app, out, options);
    return runInSandbox({ source: p.source, mode: 'plugin', index: p.index, api,"""
if old not in prefix:
    raise SystemExit('plugin run dynamic import anchor drift')
prefix = prefix.replace(old, new, 1)
Path('js/plugin-host.js').write_text(prefix.strip() + '\n')
Path('js/plugins.js').write_text(
    "export { PluginHost, MAX_PLUGIN_SOURCE_BYTES } from './plugin-host.js';\n\n" + remainder
)
replace_once('js/app.js', "import { PluginHost } from './plugins.js';", "import { PluginHost } from './plugin-host.js';", 'app PluginHost boundary')

# Welcome is the only panel intentionally opened during cold startup. Extract it so the
# 300 ms onboarding path does not import panels-base and its analysis graph.
panels_base = Path('js/panels-base.js').read_text()
welcome_start = panels_base.index('const GUIDE_PAGES = [')
welcome_end = panels_base.index('/* ── 学習コース', welcome_start)
welcome_body = panels_base[welcome_start:welcome_end].rstrip() + '\n'
Path('js/ui/panels/welcome.js').write_text(
    "import { Sheet, el, button, para } from '../../ui.js';\n"
    "import { t, isJa, pick } from '../../i18n.js';\n\n" + welcome_body
)

# The facade keeps the exact historical surface, but no longer statically re-exports
# panels-base. Modern panels and Welcome are direct owners; legacy APIs are lazy trampolines.
legacy = [
    'applySemantic','instructionMenu','showAccuracyNotes','showAddressInfo','showAppMap',
    'showBlockDetail','showCallGraph','showCandidateWhy','showChapter','showClass','showDataTable',
    'showDetail','showFeatures','showFunctionReport','showGlossary','showHelp','showInvestigate',
    'showLearn','showPinned','showSampleGuide','showSubsystem','showTerm','showValueFlow',
]
legacy_lines = '\n'.join(f"export const {name} = legacy('{name}');" for name in legacy)
Path('js/panels.js').write_text(f"""/* Demand-loaded public panel boundary. */
import {{ pick }} from './i18n.js';

export {{ showFileInfo, showSections, showStructure }} from './ui/panels/file.js';
export {{ showJump, showStrings, showXrefs }} from './ui/panels/navigation.js';
export {{ showSearch }} from './ui/panels/search.js';
export {{ showSettings }} from './ui/panels/settings.js';
export {{ showFunctions, showFunctionSummary }} from './ui/panels/function-analysis.js';
export {{ showField }} from './ui/panels/field-access.js';
export {{ showDataTables }} from './ui/panels/schema-recovery.js';
export {{ showCandidates, showOverview }} from './ui/panels/investigation.js';
export {{ showWelcome }} from './ui/panels/welcome.js';

export const RELIABILITY = Object.freeze({{ FACT:'fact', INFERRED:'inferred', HINT:'hint' }});
export function reliabilityWord(level) {{
  switch (level) {{
    case RELIABILITY.FACT: return pick('事実', 'fact');
    case RELIABILITY.INFERRED: return pick('推定', 'inferred');
    default: return pick('参考', 'hint');
  }}
}}
export function reliabilityClass(level) {{
  return level === RELIABILITY.FACT ? 'tag-fact'
    : level === RELIABILITY.INFERRED ? 'tag-infer' : 'tag-hint';
}}

function legacy(name) {{
  return (...args) => import('./panels-base.js').then((module) => module[name](...args));
}}
{legacy_lines}
""")

# tools-base remains a compatibility implementation file, but its heavy engines are now
# independently demand-loaded by the action that needs them. This is the key distinction
# from the rejected "one giant tools-base dynamic import" repair.
tools_path = Path('js/tools-base.js')
tools = tools_path.read_text()
advanced_imports = """import { decompile, decompiledText } from './decompile.js';
import { decompilerSourceRows, formatDecompilerSource, fullDecompilerSourceText, hasSingleDecompilerInstruction, primaryDecompilerAddress } from './decompiler/provenance.js';
import { cfgGraph, callGraph, renderGraph, graphLegend } from './graphview.js';
import { inferTypes, recoverStruct, TypeStore, structToC, BASIC_TYPES, typeJa } from './types.js';
import { readableName, shortName, isMangled, findCxxClasses, readVtable } from './rtti.js';
import { importList, importsByFramework, exportList, findGlobals } from './linkage.js';
import { assemble, suggestPatches, parseHexBytes, hexOf, validatePatchRange } from './patch.js';
import { runScript, SAMPLES, makeEmulator } from './script.js';
import { EXAMPLE_PLUGIN, MAX_PLUGIN_SOURCE_BYTES } from './plugins.js';
import { parseMetadataAuto, looksLikeUnity, bindMethodAddresses, MAX_IL2CPP_METADATA_BYTES } from './il2cpp.js';
import { parseMetadataFileInWorker } from './il2cpp-runtime.js';
import { brief } from './arm64.js';
"""
if advanced_imports not in tools:
    raise SystemExit('tools-base advanced import block drift')
tools = tools.replace(advanced_imports, "import { readableName, shortName, isMangled } from './rtti-names.js';\n", 1)
helper_anchor = """function textArea(value, rows) {
  const n = el('textarea', 'code-input');
  n.rows = rows || 8;
  n.spellcheck = false;
  n.autocapitalize = 'off';
  if (value) n.value = value;
  return n;
}
"""
helper = helper_anchor + """
async function optionalFeature(label, loader) {
  try { return await loader(); }
  catch (error) {
    alertDialog('機能を読み込めません', userError(error, `${label} の追加モジュールを読み込めませんでした。ほかの解析機能は引き続き使えます。`));
    return null;
  }
}
"""
if helper_anchor not in tools:
    raise SystemExit('tools-base optional helper anchor drift')
tools = tools.replace(helper_anchor, helper, 1)

def tinject(signature, code, label, make_async=False):
    global tools
    sig = signature
    if make_async:
        if not signature.startswith('export function '):
            raise SystemExit(f'invalid async signature request {signature}')
        async_sig = signature.replace('export function ', 'export async function ', 1)
        if signature not in tools:
            raise SystemExit(f'tools-base signature drift: {label}')
        tools = tools.replace(signature, async_sig, 1)
        sig = async_sig
    if sig not in tools:
        raise SystemExit(f'tools-base inject drift: {label}')
    tools = tools.replace(sig, sig + '\n' + code, 1)

# Each import is isolated and resolves to null on load failure, so one optional feature
# cannot reject out through an ignored click-handler promise.
tinject('export async function showDecompiler(app, addr) {', """  const loaded = await optionalFeature('逆コンパイル', () => Promise.all([
    import('./decompile.js'), import('./decompiler/provenance.js'),
  ]));
  if (!loaded) return null;
  const [{ decompile, decompiledText }, provenance] = loaded;
  const { decompilerSourceRows, formatDecompilerSource, fullDecompilerSourceText, hasSingleDecompilerInstruction, primaryDecompilerAddress } = provenance;""", 'decompiler')
tinject('export async function showCfg(app, addr) {', """  const graph = await optionalFeature('制御フロー図', () => import('./graphview.js'));
  if (!graph) return null;
  const { cfgGraph, renderGraph, graphLegend } = graph;""", 'cfg')
tinject('export async function showCallGraphPanel(app, addr) {', """  const graph = await optionalFeature('呼び出し図', () => import('./graphview.js'));
  if (!graph) return null;
  const { callGraph, renderGraph, graphLegend } = graph;""", 'callgraph')
tinject('export async function showTypes(app, addr) {', """  const types = await optionalFeature('型推定', () => import('./types.js'));
  if (!types) return null;
  const { inferTypes, BASIC_TYPES, typeJa } = types;""", 'types')
tinject('export async function showStructRecover(app, addr) {', """  const types = await optionalFeature('構造体復元', () => import('./types.js'));
  if (!types) return null;
  const { recoverStruct, TypeStore, structToC, typeJa } = types;""", 'struct recover')
tinject('export function showStructs(app) {', """  const types = await optionalFeature('構造体', () => import('./types.js'));
  if (!types) return null;
  const { TypeStore } = types;""", 'structs', True)
tinject('export function showCxxClasses(app) {', """  const rtti = await optionalFeature('C++ クラス', () => import('./rtti.js'));
  if (!rtti) return null;
  const { findCxxClasses, readVtable } = rtti;""", 'cxx', True)
tinject('export async function showLinkage(app) {', """  const linkage = await optionalFeature('外とのつながり', () => import('./linkage.js'));
  if (!linkage) return null;
  const { importList, importsByFramework, exportList } = linkage;""", 'linkage')
tinject('export async function showGlobals(app) {', """  const linkage = await optionalFeature('グローバル変数', () => import('./linkage.js'));
  if (!linkage) return null;
  const { findGlobals } = linkage;""", 'globals')
tinject('export function showPatches(app) {', """  const patch = await optionalFeature('パッチ', () => import('./patch.js'));
  if (!patch) return null;
  const { hexOf, validatePatchRange } = patch;""", 'patches', True)
tinject('export async function showPatchEditor(app, addr, insnArg) {', """  const loaded = await optionalFeature('パッチ編集', () => Promise.all([import('./patch.js'), import('./arm64.js')]));
  if (!loaded) return null;
  const [patch, arm64] = loaded;
  const { assemble, suggestPatches, parseHexBytes, validatePatchRange } = patch;
  const { brief } = arm64;""", 'patch editor')
tinject('export function showDebugger(app, addr) {', """  const script = await optionalFeature('デバッガ', () => import('./script.js'));
  if (!script) return null;
  const { makeEmulator } = script;""", 'debugger', True)
tinject('export function showScript(app) {', """  const loaded = await optionalFeature('スクリプト', () => Promise.all([import('./script.js'), import('./decompile.js')]));
  if (!loaded) return null;
  const [script, decompiler] = loaded;
  const { runScript, SAMPLES } = script;
  const { decompile } = decompiler;""", 'script', True)
tinject('export function showPlugins(app) {', """  const plugins = await optionalFeature('プラグイン', () => import('./plugins.js'));
  if (!plugins) return null;
  const { EXAMPLE_PLUGIN, MAX_PLUGIN_SOURCE_BYTES } = plugins;""", 'plugins', True)
tinject('export function showIl2cpp(app) {', """  const loaded = await optionalFeature('Unity（IL2CPP）', () => Promise.all([import('./il2cpp.js'), import('./il2cpp-runtime.js')]));
  if (!loaded) return null;
  const [il2cpp, runtime] = loaded;
  const { parseMetadataAuto, looksLikeUnity, bindMethodAddresses, MAX_IL2CPP_METADATA_BYTES } = il2cpp;
  const { parseMetadataFileInWorker } = runtime;""", 'il2cpp', True)
tools_path.write_text(tools)

# Deterministic regression for cold graph + first-action boundaries.
Path('tests/issue-2622-startup-boundary.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectStaticModuleGraph } from '../tools/validation/startup-module-graph.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/issue-2622-startup-baseline.json', import.meta.url), 'utf8'));
const cold = collectStaticModuleGraph('js/app.js');
assert.ok(cold.moduleCount < baseline.moduleCount, `cold module count must fall: ${baseline.moduleCount} -> ${cold.moduleCount}`);
assert.ok(cold.sourceBytes < baseline.sourceBytes, `cold JS source bytes must fall: ${baseline.sourceBytes} -> ${cold.sourceBytes}`);

const coldForbidden = [
  'js/panels-base.js','js/tools-base.js','js/plugins.js','js/script.js','js/sandbox.js',
  'js/il2cpp.js','js/decompile.js','js/graphview.js','js/types.js','js/linkage.js','js/patch.js','js/rtti.js',
];
for (const module of coldForbidden) assert.equal(cold.modules.includes(module), false, `${module} must not be in cold app graph`);
assert.ok(cold.modules.includes('js/patch-set.js'), 'cold app keeps only the lightweight patch ledger');
assert.ok(cold.modules.includes('js/plugin-host.js'), 'cold app keeps only the persisted plugin host');
assert.ok(cold.modules.includes('js/rtti-names.js'), 'cold name formatting uses lightweight demangling');

const panels = collectStaticModuleGraph('js/panels.js');
assert.equal(panels.modules.includes('js/panels-base.js'), false, 'panel facade must be a thin lazy compatibility boundary');
assert.ok(panels.modules.includes('js/ui/panels/welcome.js'), 'Welcome must have a dedicated lightweight owner');

const toolsBase = collectStaticModuleGraph('js/tools-base.js');
for (const module of ['js/decompile.js','js/graphview.js','js/types.js','js/rtti.js','js/linkage.js','js/patch.js','js/script.js','js/plugins.js','js/il2cpp.js','js/il2cpp-runtime.js']) {
  assert.equal(toolsBase.modules.includes(module), false, `opening one tools-base action must not statically drag ${module}`);
}
const toolsSource = fs.readFileSync(new URL('../js/tools-base.js', import.meta.url), 'utf8');
for (const specifier of ['./decompile.js','./graphview.js','./types.js','./rtti.js','./linkage.js','./patch.js','./script.js','./plugins.js','./il2cpp.js']) {
  assert.ok(toolsSource.includes(`import('${specifier}')`), `${specifier} must be demand-loaded at action boundary`);
}
const pluginHost = fs.readFileSync(new URL('../js/plugin-host.js', import.meta.url), 'utf8');
assert.doesNotMatch(pluginHost, /^import .*['\"]\.\/(?:script|sandbox)\.js['\"]/m);
assert.match(pluginHost, /import\('\.\/sandbox\.js'\)/);
assert.match(pluginHost, /import\('\.\/script\.js'\)/);
const patchSet = fs.readFileSync(new URL('../js/patch-set.js', import.meta.url), 'utf8');
assert.doesNotMatch(patchSet, /from ['\"]\.\/arm64\.js['\"]/);

console.log(`Issue #2622 startup graph: ${baseline.moduleCount} -> ${cold.moduleCount} modules, ${baseline.sourceBytes} -> ${cold.sourceBytes} source bytes`);
console.log('Issue #2622 startup/action lazy boundary: PASS');
''')

# WebKit evidence: cold Welcome does not request advanced modules; opening Plugins loads
# only its feature code; a failed feature chunk resolves locally instead of rejecting App.
Path('tests/issue-2622-webkit-boundary.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.json':'application/json; charset=utf-8'};
const server=http.createServer((req,res)=>{const rel=decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')||'index.html';const file=path.resolve(ROOT,rel);if(!file.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return;}if(!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':MIME[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});fs.createReadStream(file).pipe(res);});
await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const optional=['panels-base.js','tools-base.js','plugins.js','script.js','sandbox.js','il2cpp.js','decompile.js','graphview.js','types.js','linkage.js','patch.js','rtti.js'];
const browser=await webkit.launch();
try {
  const context=await browser.newContext({locale:'ja-JP'});
  const page=await context.newPage();
  const requested=[]; page.on('request',(req)=>{if(req.url().includes('/js/')) requested.push(req.url());});
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>!!window.__app);
  await page.waitForTimeout(500);
  for(const name of optional) assert.equal(requested.some((u)=>u.endsWith('/js/'+name)),false,`cold Welcome requested ${name}`);
  const timing=await page.evaluate(()=>({dcl:performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd??null,load:performance.getEntriesByType('navigation')[0]?.loadEventEnd??null,resources:performance.getEntriesByType('resource').filter((r)=>r.name.includes('/js/')).length,bytes:performance.getEntriesByType('resource').filter((r)=>r.name.includes('/js/')).reduce((n,r)=>n+(r.transferSize||r.encodedBodySize||0),0)}));
  const before=requested.length;
  const opened=await page.evaluate(async()=>{try{await (await import('/js/tools.js')).showPlugins(window.__app);return true;}catch{return false;}});
  assert.equal(opened,true,'Plugins action must resolve');
  await page.waitForTimeout(100);
  const feature=requested.slice(before);
  assert.ok(feature.some((u)=>u.endsWith('/js/tools-base.js')),'first advanced tool loads compatibility implementation on demand');
  assert.ok(feature.some((u)=>u.endsWith('/js/plugins.js')),'Plugins action loads plugin UI source');
  for(const name of ['script.js','sandbox.js','il2cpp.js','decompile.js','graphview.js','types.js','linkage.js','patch.js','rtti.js']) assert.equal(feature.some((u)=>u.endsWith('/js/'+name)),false,`Plugins action over-fetched ${name}`);
  console.log('Issue #2622 WebKit cold metrics',JSON.stringify(timing));
  await context.close();

  const failContext=await browser.newContext({locale:'ja-JP'});
  const failPage=await failContext.newPage();
  await failPage.route('**/js/plugins.js',route=>route.abort());
  await failPage.goto(url,{waitUntil:'networkidle'}); await failPage.waitForFunction(()=>!!window.__app); await failPage.waitForTimeout(350);
  const isolated=await failPage.evaluate(async()=>{try{await (await import('/js/tools.js')).showPlugins(window.__app);return 'resolved';}catch(e){return `rejected:${e?.message||e}`;}});
  assert.equal(isolated,'resolved','feature import failure must stay isolated from App');
  await failContext.close();
  console.log('Issue #2622 WebKit request boundary: PASS');
} finally { await browser.close(); await new Promise((resolve)=>server.close(resolve)); }
''')

# Add the deterministic graph check to normal UI CI without making browser installation a
# global prerequisite. WebKit evidence is executed by the one-shot materializer workflow.
package = Path('package.json').read_text()
old = '"ui:test": "node tests/panels-compat-surface.mjs && node tests/ux.mjs'
new = '"ui:test": "node tests/issue-2622-startup-boundary.mjs && node tests/test-lazy-tools-panels-boundary.mjs && node tests/panels-compat-surface.mjs && node tests/ux.mjs'
if old not in package:
    raise SystemExit('package ui:test anchor drift')
Path('package.json').write_text(package.replace(old, new, 1))
