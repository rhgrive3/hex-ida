// Trusted-runner realm for the phase12 denominator behavior probe of the
// #5216 recognition approval boundary. This is THE canonical harness realm
// for the recognition approval boundary in this repo: the phase12 test
// harness (tests/phase12/knowledge/harness-event-realm.mjs) re-exports it so
// a process can never end up with two different Event stand-ins (the module
// captures whichever realm is installed first; divergent stand-ins would
// disagree about trusted delivery). The probe runs in the Node validation
// runner — the same trust tier as the phase12 test harness — so it runs
// js/knowledge/phase12-recognition.js in a realm whose platform Event API is
// this stand-in: a real user gesture is simulated by delivering a trusted
// Event to the approval surface's listeners with currentTarget set during
// delivery (what a browser does for a UA-dispatched gesture; script dispatch
// in a page can never produce it). This module must be imported BEFORE
// js/knowledge/phase12-recognition.js so the module captures this realm's
// Event at evaluation (static import order in denominator.mjs). Installing
// twice is a no-op. See js/knowledge/phase12-recognition.js for the boundary
// and threat model.

const trustedSlots = new WeakMap();
const listenerSlots = new WeakMap();
const deliveryTargets = new WeakMap();

class ProbeEvent {
  #type;
  constructor(type, { trusted = false } = {}) {
    this.#type = String(type);
    trustedSlots.set(this, trusted === true);
  }
  get type() { return this.#type; }
  get isTrusted() { return trustedSlots.get(this) === true; }
  get currentTarget() { return deliveryTargets.get(this) ?? null; }
}

class ProbeEventTarget {
  constructor() { listenerSlots.set(this, new Map()); }
  addEventListener(type, listener) {
    const listeners = listenerSlots.get(this);
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    listenerSlots.get(this)?.get(type)?.delete(listener);
  }
  dispatchEvent(event) {
    trustedSlots.set(event, false);
    for (const listener of [...(listenerSlots.get(this)?.get(event.type) || [])]) {
      invokeListener(listener, this, event);
    }
    return true;
  }
}

function invokeListener(listener, target, event) {
  deliveryTargets.set(event, target);
  try {
    if (typeof listener === 'function') listener.call(target, event);
    else if (typeof listener?.handleEvent === 'function') listener.handleEvent(event);
  } finally {
    deliveryTargets.delete(event);
  }
}

if (globalThis.Event?.name !== 'ProbeEvent') {
  globalThis.Event = ProbeEvent;
  globalThis.ProbeEventTarget = ProbeEventTarget;
  // Historical alias used by the phase12 test suites (same class).
  globalThis.HarnessEventTarget = ProbeEventTarget;
}

export function fireTrustedApprovalGesture(surface, type = 'click') {
  const listeners = listenerSlots.get(surface)?.get(type);
  if (!listeners?.size) return null;
  const event = new Event(type, { trusted: true });
  for (const listener of [...listeners]) invokeListener(listener, surface, event);
  return event;
}

// A synthetic/dispatched event: real platform instance, isTrusted false —
// what `new Event('click')` / `el.dispatchEvent(...)` yield in a page.
export function syntheticEvent(type = 'click') {
  return new Event(type, { trusted: false });
}

// The trusted runner plays the host bundle: it takes the module-stamped
// host capability from the bootstrap holder (keyed by a Symbol.for the
// module owns) and hands it back on each host configuration call. Page
// importers can read the same holder but NOT mint a capability: the brand
// is a module-private symbol, so a plain {…} or the holder object itself
// fails the module's brand check.
export function hostRecognitionCapability() {
  const holder = globalThis[Symbol.for('hex.recognition.host-capability-holder')];
  if (!holder?.capability) throw new Error('recognition host capability bootstrap holder unavailable — import the recognition module first');
  return holder.capability;
}
