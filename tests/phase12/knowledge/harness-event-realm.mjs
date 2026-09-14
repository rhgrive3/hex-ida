// Node test harness for the #5216 recognition approval boundary: re-exports
// the CANONICAL trusted-runner realm
// (tools/validation/phase12/recognition-probe-realm.mjs) so the phase12
// tests and the denominator behavior probe always share one Event stand-in
// per process — the module js/knowledge/phase12-recognition.js captures
// whichever realm is installed first, and two divergent stand-ins would
// disagree about trusted delivery. Import this (or the canonical realm)
// BEFORE importing js/knowledge/phase12-recognition.js (static import
// order); installing twice is a no-op.
//
// The stand-in models the platform exactly where the #5216 boundary reads
// it: a real user gesture is simulated by `fireTrustedApprovalGesture(
// surface)`, which delivers a trusted Event to the surface's listeners with
// currentTarget set during delivery — what a browser does when the user
// activates a rendered control and what script in a page can never do
// (dispatchEvent()/element.click() always deliver isTrusted:false). Script
// dispatch (`target.dispatchEvent(ev)`) mirrors the platform: the event is
// untrusted and currentTarget is the target only during delivery.
//
// In production (browser) the module captures the real Event at host boot
// and nothing here runs; see the module comment for the threat model.
import {
  fireTrustedApprovalGesture,
  syntheticEvent,
  hostRecognitionCapability,
} from '../../../tools/validation/phase12/recognition-probe-realm.mjs';

export { fireTrustedApprovalGesture, syntheticEvent, hostRecognitionCapability };
