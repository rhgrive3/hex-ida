from pathlib import Path

p = Path('js/appmap.js')
s = p.read_text()
old = "export function classifyClassName(name) {\n  const s = String(name || '');\n  const out = [];"
new = "export function classifyClassName(name) {\n  if (typeof name !== 'string') return [];\n  const s = name;\n  const out = [];"
if old not in s:
    raise SystemExit('appmap classifyClassName anchor not found')
p.write_text(s.replace(old, new, 1))

Path('tests/remaining-runtime-closure-20260831.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyClassName } from '../js/appmap.js';

const src = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// #2784: identity boundary must not coerce structured values into class names.
assert.deepEqual(classifyClassName(['BattleManager']), []);
assert.deepEqual(classifyClassName({ toString(){ return 'BattleManager'; } }), []);
assert.ok(classifyClassName('BattleManager').some((x) => x.id === 'battle'));

// #2507/#2522: first-party Investigation routes through the shared cancellable
// service, not the historical serial prepare() implementation.
const panels = src('js/panels.js');
assert.match(panels, /showCandidates, showOverview[^\n]+ui\/panels\/investigation\.js/);
const investigation = src('js/ui/panels/investigation.js');
assert.match(investigation, /onClose:\(\) => controller\.abort\('candidate-sheet-closed'\)/);
assert.match(investigation, /onClose:\(\) => controller\.abort\('overview-sheet-closed'\)/);
assert.match(investigation, /investigationServiceFor\(app\)\.investigate\(goal,[\s\S]*signal:controller\.signal/);
assert.match(investigation, /investigationServiceFor\(app\)\.overview\(\{[\s\S]*signal:controller\.signal/);
const service = src('js/analysis/investigation-service.js');
assert.match(service, /if \(!entry\.settled && entry\.waiters === 0\) entry\.controller\.abort\('investigation-no-consumers'\)/);
assert.match(service, /const stringsP = this\.collectStrings\(options\);[\s\S]*const shapesP = shapeNeeded \? this\.collectShapes\(options\)[\s\S]*const metadataP = shapeNeeded \? this\.ensureMetadata\(options\)[\s\S]*const programP = metadataP\.then\(\(\) => this\.buildProgram\(options\)\);[\s\S]*Promise\.all\(\[stringsP, programP, shapesP\]\)/);
assert.match(service, /request\.cancel\?\.\(\)/);
assert.match(service, /priority:priorityOf\(options\)[\s\S]*budget:options\.budget/);

// #2518: production bootstrap replaces the compatibility browser-side BinaryId
// producer with one background, ref-counted worker-backed full-content producer.
const ux = src('js/ux.js');
assert.match(ux, /installSharedWorkerBinaryIdentity\(window\.__app\)/);
const identity = src('js/analysis/shared-binary-identity.js');
assert.match(identity, /priority:'background'/);
assert.match(identity, /this\.ensureContentHash\(options\.onProgress, controller\.signal\)/);
assert.match(identity, /if \(!entry\.settled && entry\.waiters === 0\) entry\.controller\.abort\('binary-identity-no-consumers'\)/);
assert.match(identity, /createBinaryIdFromDigest\(hash\)/);

// #2540: baseline work is route/request scoped and cancellation reaches the
// owned backend pipeline while stale publication guards remain in place.
const product = src('js/ui/product.js');
assert.match(product, /createChildTaskScope\(routeSignal\)/);
assert.match(product, /compareScope\.spawn\('diff-baseline-replaced'\)/);
assert.match(product, /workspace\.loadBaseline\(file,\{signal\}\)/);
assert.match(product, /dispose:\(\)=>\{compareScope\.abort\('diff-route-disposed'\)/);
const workspace = src('js/workspace.js');
assert.match(workspace, /async loadBaseline\(file,\{backend=null,signal=null\}=\{\}\)/);
assert.match(workspace, /ensureContentHash\(null,signal\)/);
assert.match(workspace, /analyze\(sliceIndex,\{signal\}\)/);
assert.match(workspace, /createCompactFunctionSet\(/);
assert.match(workspace, /if\(owned\)other\.dispose\(\)/);
assert.match(workspace, /baselineSequence/);

console.log('remaining runtime closure 20260831: PASS');
''')
