import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker=fs.readFileSync(new URL('../../../js/platform/worker.js',import.meta.url),'utf8');
const backend=fs.readFileSync(new URL('../../../js/backend.js',import.meta.url),'utf8');
assert.match(worker,/function selectedFatSliceIndex\(/);
assert.match(worker,/pointerImages\.set\(selectedSliceIndex, candidateImage\)/,'open must seed the already parsed FAT selected image');
assert.match(worker,/async function analyzeImage[\s\S]*selected = await pointerImageForSlice\(msg\.sliceIndex, signal\)/,'analysis must reuse the shared slice image cache');
const analyze=worker.slice(worker.indexOf('async function analyzeImage'),worker.indexOf('function genericFunctionSeeds'));
assert.doesNotMatch(analyze,/parseMachOSource\(/,'first analysis must not independently reparse the selected slice');
assert.match(worker,/async function resolvePointer[\s\S]*pointerImageForSlice\(msg\.sliceIndex, signal\)/,'pointer resolution must use the same slice image cache');
assert.match(backend,/platformSelectedSliceReparseAvoided:normalized\?\.platform\?\.selectedSliceParseReused === true/);
assert.match(backend,/legacyCompatibilityParseRequired:true/,'remaining legacy compatibility parser work must remain measurable and explicit');
assert.match(backend,/duplicateUniversalParseAvoided:false/,'legacy\/normalized differential work must not be falsely claimed eliminated');
console.log('issue-2516-macho-selected-slice-reuse: PASS');
