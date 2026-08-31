from pathlib import Path

p=Path('js/platform/worker.js')
s=p.read_text()
anchor="""function cooperativeYield() { return new Promise((resolve) => setTimeout(resolve, 0)); }
"""
helper=anchor+"""
function selectedFatSliceIndex(binaryImage) {
  const fat = binaryImage?.metadata?.fat;
  const selected = fat?.selected;
  const slices = fat?.slices;
  if (!selected || !Array.isArray(slices)) return -1;
  return slices.findIndex((slice) =>
    BigInt(slice.offset) === BigInt(selected.offset)
    && BigInt(slice.size) === BigInt(selected.size)
    && slice.cpu === selected.cpu
    && slice.subtype === selected.subtype);
}
"""
if anchor not in s: raise SystemExit('worker helper anchor drift')
s=s.replace(anchor,helper,1)
old="""    pointerImages = new Map();
    if (previousSource && previousSource !== candidateSource) previousSource.clear?.();
    return candidateDescriptor;"""
new="""    pointerImages = new Map();
    const selectedSliceIndex = selectedFatSliceIndex(candidateImage);
    if (selectedSliceIndex >= 0) {
      pointerImages.set(selectedSliceIndex, candidateImage);
      candidateDescriptor.platform.selectedSliceIndex = selectedSliceIndex;
      candidateDescriptor.platform.selectedSliceParseReused = true;
    }
    if (previousSource && previousSource !== candidateSource) previousSource.clear?.();
    return candidateDescriptor;"""
if old not in s: raise SystemExit('worker open cache anchor drift')
s=s.replace(old,new,1)
old="""  if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {
    selected = await parseMachOSource(source, {
      sliceIndex: msg.sliceIndex,
      signal,
      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
    });
  }"""
new="""  if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {
    selected = await pointerImageForSlice(msg.sliceIndex, signal);
    if (!selected) return emptyAnalysis();
  }"""
if old not in s: raise SystemExit('worker analyze anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('js/backend.js')
s=p.read_text()
old="""        normalizedDyldTruth:!!normalized, duplicateUniversalParseAvoided:false,
        ...(platformError ? { normalizedDyldError: platformError.message } : {}),"""
new="""        normalizedDyldTruth:!!normalized, duplicateUniversalParseAvoided:false,
        platformSelectedSliceReparseAvoided:normalized?.platform?.selectedSliceParseReused === true,
        legacyCompatibilityParseRequired:true,
        ...(platformError ? { normalizedDyldError: platformError.message } : {}),"""
if old not in s: raise SystemExit('backend measurement anchor drift')
p.write_text(s.replace(old,new,1))

Path('tests/phase4/integration/issue-2516-macho-selected-slice-reuse.test.mjs').write_text(r'''import assert from 'node:assert/strict';
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
''')
