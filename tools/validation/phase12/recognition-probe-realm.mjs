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

// The trusted runner plays the host bundle: it registers the module's
// consume-once bootstrap hook BEFORE the recognition module evaluates and
// keeps the delivered host capability in this module's closure (never in
// globalThis — the R2-round-4 theft path). Page importers can neither read
// the capability (no global holder) nor mint one (module-private brand).
const HOST_BOOTSTRAP_KEY = Symbol.for('hex.recognition.host-bootstrap');
let hostCapability = null;
if (typeof globalThis[HOST_BOOTSTRAP_KEY] !== 'object' || globalThis[HOST_BOOTSTRAP_KEY] === null) {
  globalThis[HOST_BOOTSTRAP_KEY] = {
    deliver(capability) { hostCapability = capability; },
  };
} else if (typeof globalThis[HOST_BOOTSTRAP_KEY].deliver !== 'function') {
  globalThis[HOST_BOOTSTRAP_KEY].deliver = (capability) => { hostCapability = capability; };
}

export function hostRecognitionCapability() {
  if (!hostCapability) throw new Error('recognition host capability was not delivered: import this realm before the recognition module (host bootstrap order)');
  return hostCapability;
}
