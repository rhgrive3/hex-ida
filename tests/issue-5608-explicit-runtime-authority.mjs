import assert from 'node:assert/strict';
import { resolveAppleCall } from '../js/apple/runtime.js';

// Issue #5608: resolveAppleCall() promoted any call with IMP-address evidence
// into the ObjC path, even when call.runtime explicitly declared a different
// runtime (swift/rust/c). The in-function guard only allows IMP evidence to
// infer the origin when origin === 'unknown'; the ObjC branch's unconditional
// `imp?.candidates?.length` disjunct bypassed it and erased the explicit
// runtime.

const index = {
  objc: {
    completeness: { complete: true },
    classes: new Map([['C', { name: 'C', superName: null }]]),
    methodsByIMP: new Map([
      ['4096', [{ className: 'C', selector: 'm', classMethod: false, imp: 0x1000n }]],
    ]),
  },
};

// An explicit non-objc runtime stays authoritative: no objc reclassification,
// no IMP resolution, the runtime's own resolution shape is preserved.
for (const runtime of ['swift', 'rust', 'c']) {
  const result = resolveAppleCall(index, {
    runtime,
    kind: 'function-pointer',
    target: 0x1000n,
    name: 'plain_fn',
  });
  assert.equal(result.runtime, runtime, `explicit runtime '${runtime}' is preserved`);
  assert.notEqual(result.kind, 'imp', 'explicit runtime is not reclassified as an ObjC IMP call');
  assert.equal(result.resolved?.className, undefined, 'no ObjC method is attached to an explicit-runtime call');
}

// An explicit runtime that resolves through its own path keeps doing so.
{
  const result = resolveAppleCall(index, {
    runtime: 'swift',
    kind: 'function-pointer',
    target: 0x1000n,
    name: 'swift_fn',
  });
  assert.equal(result.runtime, 'swift');
  assert.equal(result.kind, 'direct', 'the generic fallback keeps its direct kind with an explicit target');
}

// Unknown origin (no symbol name) + IMP evidence still infers objc: this is
// the designed inference path the unknown-only guard protects.
{
  const result = resolveAppleCall(index, {
    kind: 'imp',
    impTarget: 0x1000n,
  });
  assert.equal(result.runtime, 'objc');
  assert.equal(result.kind, 'imp');
  assert.equal(result.resolved.className, 'C');
  assert.equal(result.resolved.selector, 'm');
}

// objc_msgSend names keep the message path even with an explicit runtime:
// the entry-point identity (isObjcMsgSendSymbol) is a structural fact about
// the callee, not evidence about the caller's runtime.
{
  const result = resolveAppleCall(index, {
    runtime: 'c',
    kind: 'function-pointer',
    target: 0x2000n,
    name: 'objc_msgSend',
  });
  assert.equal(result.runtime, 'objc');
  assert.equal(result.kind, 'message');
}

// objc-origin calls keep their IMP resolution.
{
  const result = resolveAppleCall(index, {
    runtime: 'objc',
    kind: 'imp',
    impTarget: 0x1000n,
    name: 'helper',
  });
  assert.equal(result.runtime, 'objc');
  assert.equal(result.kind, 'imp');
  assert.equal(result.resolved.className, 'C');
}

console.log('issue #5608 explicit runtime authority over IMP evidence regression: PASS');
