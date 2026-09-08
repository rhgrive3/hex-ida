// Regression for #5438: isAppleSystemLibrary() only accepted the unversioned
// framework spelling <Name>.framework/<Name>, so the canonical macOS versioned
// layout <Name>.framework/Versions/<V>/<Name> — the form otool -L actually
// prints — classified as UNKNOWN instead of SYSTEM.
// Contract now: an optional Versions/<V>/ segment is accepted for the
// Foundation/CoreFoundation pair; non-matching framework binaries and impostor
// basenames stay unclassified.
import assert from 'node:assert/strict';
import { classifyFunction } from '../js/recognition/classifier.js';

function classificationOf(owningLibrary) {
  return classifyFunction({}, { owningLibrary }).classification;
}

// 1. The issue's scenarios: versioned macOS framework paths are SYSTEM.
assert.equal(classificationOf('/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation'), 'SYSTEM');
assert.equal(classificationOf('/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation'), 'SYSTEM');

// 2. The previously supported spellings keep working.
assert.equal(classificationOf('/System/Library/Frameworks/Foundation.framework/Foundation'), 'SYSTEM');
assert.equal(classificationOf('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'), 'SYSTEM');
assert.equal(classificationOf('Foundation'), 'SYSTEM', 'bare basename keeps the no-path rule');
assert.equal(classificationOf('CoreFoundation'), 'SYSTEM');

// 3. The version segment must sit between the framework bundle and the
//    binary; an impostor basename after Versions/ is not laundered.
assert.equal(classificationOf('/System/Library/Frameworks/Foundation.framework/Versions/C/Impostor'), 'UNKNOWN');
assert.equal(classificationOf('/App/App.app/Contents/Frameworks/Imaging.framework/Versions/A/Imaging'), 'UNKNOWN',
  'other framework binaries stay outside the special case');

// 4. Case-insensitivity of the layout (Darwin is case-preserving, paths vary).
assert.equal(classificationOf('/System/Library/Frameworks/foundation.framework/versions/c/foundation'), 'SYSTEM');

console.log('issue-5438 versioned apple framework paths classified: ok');
