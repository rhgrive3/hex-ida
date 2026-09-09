// Regression for #5438: isAppleSystemLibrary() only accepted the unversioned
// framework spelling <Name>.framework/<Name>, so the canonical macOS versioned
// layout <Name>.framework/Versions/<V>/<Name> — the form otool -L actually
// prints — classified as UNKNOWN instead of SYSTEM.
// Contract now: an optional Versions/<V>/ segment is accepted for the
// Foundation/CoreFoundation pair; non-matching framework binaries and impostor
// basenames stay unclassified.
import assert from 'node:assert/strict';
import { applicationCodeScore, classifyFunction } from '../js/recognition/classifier.js';

function classificationOf(owningLibrary) {
  return classifyFunction({}, { owningLibrary }).classification;
}

// 1. The issue's scenarios: versioned macOS framework paths are SYSTEM.
const versionedFoundation = '/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation';
const versionedCoreFoundation = '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation';
assert.equal(classificationOf(versionedFoundation), 'SYSTEM');
assert.equal(classificationOf(versionedCoreFoundation), 'SYSTEM');

// 2. The previously supported spellings keep working.
assert.equal(classificationOf('/System/Library/Frameworks/Foundation.framework/Foundation'), 'SYSTEM');
assert.equal(classificationOf('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'), 'SYSTEM');
assert.equal(classificationOf('Foundation'), 'SYSTEM', 'bare basename keeps the no-path rule');
assert.equal(classificationOf('CoreFoundation'), 'SYSTEM');

// 3. Only the canonical optional Versions/<single-component>/ segment is
//    accepted between the framework bundle and binary. Arbitrary intermediate
//    paths and impostor basenames must not be laundered into SYSTEM evidence.
assert.equal(classificationOf('/tmp/Foundation.framework/not-version/Foundation'), 'UNKNOWN',
  'arbitrary intermediate framework paths stay non-system');
assert.equal(classificationOf('/System/Library/Frameworks/Foundation.framework/Versions/C/Impostor'), 'UNKNOWN');
assert.equal(classificationOf('/App/App.app/Contents/Frameworks/Imaging.framework/Versions/A/Imaging'), 'UNKNOWN',
  'other framework binaries stay outside the special case');

// 4. SYSTEM classification must reach applicationCodeScore() as a hard
//    suppression. These caller hints would score as application-like evidence
//    without the system-library authority, but the canonical versioned paths
//    must still clamp to zero.
const applicationHints = { notKnownVendor: true, calledFromApplication: true };
assert.equal(applicationCodeScore({}, { ...applicationHints, owningLibrary: versionedFoundation }), 0,
  'versioned Foundation receives SYSTEM hard suppression');
assert.equal(applicationCodeScore({}, { ...applicationHints, owningLibrary: versionedCoreFoundation }), 0,
  'versioned CoreFoundation receives SYSTEM hard suppression');

// 5. Case-insensitivity of the layout (Darwin is case-preserving, paths vary).
assert.equal(classificationOf('/System/Library/Frameworks/foundation.framework/versions/c/foundation'), 'SYSTEM');

console.log('issue-5438 versioned apple framework paths classified: ok');
