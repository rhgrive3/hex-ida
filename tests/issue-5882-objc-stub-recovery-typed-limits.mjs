// Issue #5882 regression: Objective-C stub-recovery coverage limits accept
// only primitive finite positive safe-integer numbers. Structured/coercible
// values must not reshape selector, stub-count, or section-size coverage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { globalThis: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../js/objc-stub-recovery.js', import.meta.url), 'utf8'), ctx);
const { recover } = ctx.globalThis.HexObjCStubRecovery;
assert.ok(recover, 'the legacy IIFE must install HexObjCStubRecovery');

const STUBS_FILE = 0x1000n;
const SELREFS_FILE = 0x2000n;
const TEXT_FILE = 0x3000n;
const STUBS_VM = 0x100000n;
const SELREFS_VM = 0x200000n;
const TEXT_VM = 0x300000n;

function wordsBytes(words) {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  return bytes;
}

function pointerBytes(value) {
  const bytes = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function cstringBytes(text) {
  return Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)).concat(0));
}

function makeEnv(limits = {}, {
  selector = 'abc',
  outputs = 2,
  stubsSize = null,
  stubsBytes = null,
} = {}) {
  const code = stubsBytes ?? wordsBytes(Array.from({ length: outputs }, () => [1, 2, 3]).flat());
  const selectorBytes = cstringBytes(selector);
  const selrefBytes = pointerBytes(TEXT_VM);
  const declaredStubsSize = stubsSize ?? BigInt(code.length);
  const regions = [
    { section: '__objc_stubs', fileOffset: STUBS_FILE, size: declaredStubsSize, vmAddr: STUBS_VM },
    { section: '__objc_selrefs', fileOffset: SELREFS_FILE, size: 8n, vmAddr: SELREFS_VM },
    { section: '__objc_methname', cstrings: true, fileOffset: TEXT_FILE, size: BigInt(selectorBytes.length), vmAddr: TEXT_VM },
  ];
  const reads = [];

  const readSlice = (bytes, regionFile, off, len) => {
    const rel = Number(off - regionFile);
    if (!Number.isSafeInteger(rel) || rel < 0 || rel >= bytes.length) return new Uint8Array(0);
    return bytes.slice(rel, rel + len);
  };

  return {
    slice: { offset: 0n, size: 0x2000000n, regions },
    known: [],
    fileSize: 0x2000000n,
    Words: {
      KIND: { BRANCH: 'branch', RET: 'ret', OTHER: 'other' },
      pcRelTarget: (word) => word === 1 ? { reg: 0, value: SELREFS_VM } : null,
      pairedOffset: (word) => word === 2 ? { load: true, rn: 0, rd: 1, imm: 0n } : null,
      classifyWord: (word) => word === 3 ? 'branch' : 'other',
    },
    readRange: async (off, len) => {
      off = BigInt(off);
      reads.push([off, len]);
      if (off >= STUBS_FILE && off < STUBS_FILE + declaredStubsSize) {
        return readSlice(code, STUBS_FILE, off, len);
      }
      if (off >= SELREFS_FILE && off < SELREFS_FILE + 8n) {
        return readSlice(selrefBytes, SELREFS_FILE, off, len);
      }
      if (off >= TEXT_FILE && off < TEXT_FILE + BigInt(selectorBytes.length)) {
        return readSlice(selectorBytes, TEXT_FILE, off, len);
      }
      return new Uint8Array(0);
    },
    reads,
    budget: {
      takeRegion: () => true,
      takeRead: () => true,
      takeResident: () => true,
      takeOperation: () => true,
      takeString: () => true,
      takeName: () => true,
      releaseResident: () => {},
      expired: () => false,
    },
    requestId: 1,
    cancelled: () => false,
    sanitizePointer: (value) => value,
    ...limits,
  };
}

// Default coverage is live: two synthetic stubs recover the same selector.
{
  const out = await recover(makeEnv());
  assert.equal(out.length, 2);
  assert.equal(out[0].name, '_objc_msgSend$abc');
  assert.equal(out[1].name, '_objc_msgSend$abc');
}

// maxStubs must not accept coercible/structured/invalid values. These all used
// to alter the out.length comparison; each must fall back to the 80,000 default.
for (const invalid of [['1'], '1', true, {}, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
  const out = await recover(makeEnv({ maxStubs: invalid }));
  assert.equal(out.length, 2, `invalid maxStubs ${String(invalid)} must fall back to default`);
}
{
  const out = await recover(makeEnv({ maxStubs: 1 }));
  assert.equal(out.length, 1, 'a valid primitive maxStubs number must keep its existing semantics');
}

// maxSelector must likewise be typed. A one-character structured cap used to
// reject the three-character selector through relational coercion.
for (const invalid of [['1'], '1', true, {}, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
  const out = await recover(makeEnv({ maxSelector: invalid }, { outputs: 1 }));
  assert.equal(out.length, 1, `invalid maxSelector ${String(invalid)} must fall back to default`);
}
{
  const tooShort = await recover(makeEnv({ maxSelector: 2 }, { outputs: 1 }));
  const exact = await recover(makeEnv({ maxSelector: 3 }, { outputs: 1 }));
  assert.equal(tooShort.length, 0, 'a valid short selector cap must still bound selector recovery');
  assert.equal(exact.length, 1, 'a valid primitive selector cap must still permit an exact-length selector');
}

// The default 8 MiB section cap excludes a 9 MiB stubs section before any read.
const oversized = 9n * 1024n * 1024n;
{
  const env = makeEnv({}, { stubsSize: oversized, stubsBytes: new Uint8Array(0) });
  const out = await recover(env);
  assert.equal(out.length, 0);
  assert.equal(env.reads.length, 0, 'default section cap must reject 9 MiB before scanning');
}

// Structured/coercible/invalid section limits must not extend eligibility.
for (const invalid of [['16777216'], '16777216', true, {}, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
  const env = makeEnv({ maxSectionBytes: invalid }, { stubsSize: oversized, stubsBytes: new Uint8Array(0) });
  const out = await recover(env);
  assert.equal(out.length, 0);
  assert.equal(env.reads.length, 0, `invalid maxSectionBytes ${String(invalid)} must keep the default cap`);
}

// A valid primitive number still raises the cap and admits the scan.
{
  const env = makeEnv({ maxSectionBytes: 16 * 1024 * 1024 }, { stubsSize: oversized, stubsBytes: new Uint8Array(0) });
  const out = await recover(env);
  assert.equal(out.length, 0);
  assert.ok(env.reads.some(([off]) => off === STUBS_FILE), 'valid larger cap must admit the stubs scan');
}

console.log('issue #5882 objc stub-recovery typed coverage limits regressions: PASS');
