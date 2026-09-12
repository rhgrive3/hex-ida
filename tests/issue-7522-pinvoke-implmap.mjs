import assert from 'node:assert/strict';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';
import { parseCil } from '../js/managed/cil/parser.js';
import { CilFrontend } from '../js/managed/cil/frontend.js';
import { collect } from './phase11/fixtures/medium-cil.mjs';

// #7522: ImplMap (0x1C) + ModuleRef (0x1A) are the ECMA-335 II.22.22 P/Invoke
// dispatch authority. They must be decoded and bound to their MethodDef so the
// canonical image keeps the unmanaged DLL, native entrypoint, and
// PInvokeAttributes — changing an ImplMap row must never leave the projection
// byte-identical.

// leadingStrings keeps the heap indexes deterministic: 1='KERNEL32',
// 10='USER32', 17='Beep', 21='MessageBeep'.
const strings = { KERNEL32: 1, USER32: 10, Beep: 17, MessageBeep: 22 };
const leadingStrings = ['KERNEL32', 'USER32', 'Beep', 'MessageBeep'];

const fixture = ({ methods, extraRows }) => buildCil({
  leadingStrings,
  types: [{ name: 'KERNEL32', namespace: 'Interop', methodList: 1, fieldList: 1 }],
  methods,
  extraRows,
}).bytes;

const methodFlags = (pinvoke) => (pinvoke ? 0x2016 : 0x0016);
const method = (pinvoke = true) => ({ name: 'Beep', body: null, flags: methodFlags(pinvoke) });
const moduleRefs = (names) => [0x1a, {
  count: names.length,
  bytes: Uint8Array.from(names.flatMap((name) => [strings[name] & 0xff, (strings[name] >> 8) & 0xff])),
}];
const implMap = ({ flags = 0x0100, forwarded = (1 << 1) | 1, name = strings.Beep, scope = 1 }) => [0x1c, {
  count: 1,
  bytes: Uint8Array.of(flags & 0xff, (flags >> 8) & 0xff, forwarded & 0xff, (forwarded >> 8) & 0xff,
    name & 0xff, (name >> 8) & 0xff, scope & 0xff, (scope >> 8) & 0xff),
}];

const project = (image) => JSON.stringify({
  types: image.types, methods: image.methods, fields: image.fields, methodBodies: image.methodBodies,
});

// 1. A single ImplMap row binds KERNEL32!Beep to MethodDef #1.
{
  const image = parseCil(fixture({
    methods: [method()],
    extraRows: new Map([moduleRefs(['KERNEL32']), implMap({})]),
  }));
  assert.deepEqual(image.methods[0].pinvoke, {
    rid: 1, token: '0x1c000001', mappingFlags: 0x0100,
    memberForwardedToken: '0x06000001', importName: 'Beep', importScope: 'KERNEL32',
  });
}

// 2. Control: same binary minus the ImplMap row (ModuleRef kept) must not
//    project identically — the mapping is no longer invisible metadata.
{
  const without = parseCil(fixture({ methods: [method(false)], extraRows: new Map([moduleRefs(['KERNEL32'])]) }));
  const withMap = parseCil(fixture({
    methods: [method()], extraRows: new Map([moduleRefs(['KERNEL32']), implMap({})]),
  }));
  assert.equal(without.methods[0].pinvoke, undefined);
  assert.notEqual(project(without), project(withMap));
}

// 3. Changing ImportName changes the canonical native entrypoint.
{
  const a = parseCil(fixture({ methods: [method()], extraRows: new Map([moduleRefs(['KERNEL32']), implMap({})]) }));
  const b = parseCil(fixture({
    methods: [method()],
    extraRows: new Map([moduleRefs(['KERNEL32']), implMap({ name: strings.MessageBeep })]),
  }));
  assert.equal(a.methods[0].pinvoke.importName, 'Beep');
  assert.equal(b.methods[0].pinvoke.importName, 'MessageBeep');
}

// 4. Changing ImportScope to another ModuleRef changes the DLL identity.
{
  const a = parseCil(fixture({ methods: [method()], extraRows: new Map([moduleRefs(['KERNEL32']), implMap({})]) }));
  const b = parseCil(fixture({ methods: [method()], extraRows: new Map([moduleRefs(['KERNEL32', 'USER32']), implMap({ scope: 2 })]) }));
  assert.equal(a.methods[0].pinvoke.importScope, 'KERNEL32');
  assert.equal(b.methods[0].pinvoke.importScope, 'USER32');
}

// 5. PInvokeAttributes stay lossless (call convention, charset, SetLastError).
{
  const stdcallUnicodeSetLastError = parseCil(fixture({
    methods: [method()],
    extraRows: new Map([moduleRefs(['KERNEL32']), implMap({ flags: 0x0300 | 0x0006 | 0x0040 })]),
  }));
  assert.equal(stdcallUnicodeSetLastError.methods[0].pinvoke.mappingFlags, 0x0346);
  const cdeclAnsi = parseCil(fixture({
    methods: [method()],
    extraRows: new Map([moduleRefs(['KERNEL32']), implMap({ flags: 0x0200 | 0x0002 })]),
  }));
  assert.equal(cdeclAnsi.methods[0].pinvoke.mappingFlags, 0x0202);
}

// 6. Out-of-range / mis-tagged rows fail closed.
{
  const base = { methods: [{ name: 'Beep', body: null, flags: 0x2016 }] };
  // MemberForwarded tag 0 (Field) is not a MethodDef.
  assert.throws(() => parseCil(fixture({
    ...base, extraRows: new Map([moduleRefs(['KERNEL32']), implMap({ forwarded: (1 << 1) | 0 })]),
  })), /cil-unsupported-binary/);
  // MethodDef RID 9 with a single MethodDef row.
  assert.throws(() => parseCil(fixture({
    ...base, extraRows: new Map([moduleRefs(['KERNEL32']), implMap({ forwarded: (9 << 1) | 1 })]),
  })), /cil-unsupported-binary/);
  // ImportScope RID 2 with a single ModuleRef row.
  assert.throws(() => parseCil(fixture({
    ...base, extraRows: new Map([moduleRefs(['KERNEL32']), implMap({ scope: 2 })]),
  })), /cil-unsupported-binary/);
  // Two ImplMap rows for one method: the dispatch target is ambiguous.
  assert.throws(() => parseCil(fixture({
    ...base,
    extraRows: new Map([moduleRefs(['KERNEL32']), [0x1c, {
      count: 2,
      bytes: Uint8Array.of(0, 1, 3, 0, 1, 0, 1, 0, 0, 1, 3, 0, 1, 0, 1, 0),
    }]]),
  })), /cil-unsupported-binary/);
}

// 7. ECMA-335 II.22.22 flag/row agreement, both directions.
{
  assert.throws(() => parseCil(fixture({
    methods: [{ name: 'Beep', body: null, flags: 0x2016 }],
    extraRows: new Map([moduleRefs(['KERNEL32'])]),
  })), /cil-unsupported-binary/);
  assert.throws(() => parseCil(fixture({
    methods: [{ name: 'Beep', body: null, flags: 0x0016 }],
    extraRows: new Map([moduleRefs(['KERNEL32']), implMap({})]),
  })), /cil-unsupported-binary/);
}

// 8. CilFrontend.enumerateMethods() restores the same P/Invoke mapping.
{
  const image = parseCil(fixture({
    methods: [method()],
    extraRows: new Map([moduleRefs(['KERNEL32']), implMap({})]),
  }));
  const methods = await collect(new CilFrontend().enumerateMethods(image));
  assert.equal(methods[0].pinvoke.importName, 'Beep');
  assert.equal(methods[0].pinvoke.importScope, 'KERNEL32');
  assert.equal(methods[0].pinvoke.mappingFlags, 0x0100);
}

console.log('issue-7522: all assertions passed');
