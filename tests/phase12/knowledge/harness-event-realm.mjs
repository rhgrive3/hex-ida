// Node test harness for the #5216 recognition approval boundary: the module
// js/knowledge/phase12-recognition.js binds grant issuance to the platform
// Event of its realm, captured once at module evaluation. The Node test
// harness is the trusted-runner domain, so it runs that module in a realm
// whose Event platform API is this stand-in: a real user gesture is simulated
// by constructing the harness Event with { trusted: true } — exactly what the
// browser does for a UA-dispatched gesture and what script in a page can
// never do. The module must be evaluated AFTER this file installs the
// stand-in, so every test that imports phase12-recognition.js imports this
// module first (static import order). Installing twice is a no-op.
//
// In production (browser) the module captures the real Event at host boot and
// nothing here runs; see the module comment for the threat model.
class HarnessEvent {
  #type;
  #trusted;
  constructor(type, { trusted = false, sourceEvent = null } = {}) {
    this.#type = String(type);
    this.#trusted = trusted === true || sourceEvent?.isTrusted === true;
  }
  get type() { return this.#type; }
  get isTrusted() { return this.#trusted; }
}

if (globalThis.Event?.name !== 'HarnessEvent') globalThis.Event = HarnessEvent;

// A trusted gesture as only the user agent can produce it in production.
export function trustedApprovalGesture(type = 'click') {
  return new globalThis.Event(type, { trusted: true });
}

// A synthetic/dispatched event: real platform instance, isTrusted false —
// what `new Event('click')` / `el.dispatchEvent(...)` yield in a page.
export function syntheticEvent(type = 'click') {
  return new globalThis.Event(type, { trusted: false });
}
