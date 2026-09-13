import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

const PACM_WORD = 0xd50324ff;
const PACM_BYTES = Uint8Array.of(0xff, 0x24, 0x03, 0xd5);
const HINT_25_BYTES = Uint8Array.of(0xbf, 0x24, 0x03, 0xd5);

function decoded(raw, id, extra = {}) {
  return {
    instructionId:id,
    address:raw.address,
    size:raw.size,
    mnemonic:raw.mnemonic,
    operands:raw.opStr,
    opStr:raw.opStr,
    ops:parseOperands(raw.opStr),
    mode:'arm64e',
    origin:{ instructionIds:[id] },
    ...extra,
  };
}

function registerOps(bundle, kind, registerId) {
  return bundle.operations.filter((operation) => operation.kind === kind && operation.register?.registerId === registerId);
}

function pacmIntrinsic(bundle) {
  return bundle.operations.find((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64e.pauth.pacm');
}

const session = await createCapstoneArm64Session();
let raw;
let unrelatedRaw;
try {
  [raw] = session.decode(PACM_BYTES, 0x1000n);
  [unrelatedRaw] = session.decode(HINT_25_BYTES, 0x1100n);
} finally {
  session.close();
}
assert.ok(raw, 'Capstone must decode the architectural PACM word');
assert.equal(raw.mnemonic, 'hint');
assert.equal(raw.opStr, '#0x27');
assert.ok(unrelatedRaw);
assert.equal(unrelatedRaw.mnemonic, 'hint');
assert.equal(unrelatedRaw.opStr, '#0x25');

// Encoding-backed alias normalization: text alone must not capture an unrelated
// synthetic HINT, while the exact architectural word must enter PACM semantics.
const spoof = ARM64E_ARCHITECTURE.liftExact(decoded(raw, 'issue-8332:spoof'));
assert.equal(spoof.metadata.family, 'arm64e-pointer-authentication');
assert.equal(spoof.completeness, 'partial');
assert.equal(spoof.metadata.failClosed, true);
assert.equal(spoof.metadata.environmentFootprintComplete, false);
assert.equal(spoof.operations.some((operation) => operation.intrinsicId === 'arm64.environment.hint'), false);
assert.equal(registerOps(spoof, 'register-write', 'PAuthState').length, 0);

const unrelated = ARM64E_ARCHITECTURE.liftExact(decoded(unrelatedRaw, 'issue-8332:unrelated', { bytes:HINT_25_BYTES }));
assert.equal(unrelated.metadata.family, 'arm64-system');
assert.equal(unrelated.completeness, 'exact-with-intrinsic');
assert.equal(unrelated.operations.some((operation) => operation.intrinsicId === 'arm64.environment.hint'), true);
assert.equal(registerOps(unrelated, 'register-write', 'PAuthState').length, 0);

const unknown = ARM64E_ARCHITECTURE.liftExact(decoded(raw, 'issue-8332:unknown', { word:PACM_WORD }));
assert.equal(unknown.metadata.family, 'arm64e-pointer-authentication');
assert.equal(unknown.metadata.pacm, true);
assert.equal(unknown.completeness, 'partial');
assert.equal(registerOps(unknown, 'register-read', 'PAuthState').length, 1);
assert.equal(registerOps(unknown, 'register-write', 'PAuthState').length, 1);
assert.ok(pacmIntrinsic(unknown));
assert.equal(pacmIntrinsic(unknown).metadata.conditionResolution, 'unknown');
assert.match(unknown.unknownEffects.reason, /PACM .*state is unresolved/i);

const enabled = ARM64E_ARCHITECTURE.liftExact(
  decoded(raw, 'issue-8332:enabled', { rawBytes:PACM_BYTES }),
  { featPAuthLr:true, pacmEnabled:true },
);
assert.equal(enabled.completeness, 'exact-with-intrinsic');
assert.equal(enabled.metadata.pacmValue, 1);
assert.equal(registerOps(enabled, 'register-read', 'PAuthState').length, 1);
assert.equal(registerOps(enabled, 'register-write', 'PAuthState').length, 1);
assert.equal(pacmIntrinsic(enabled).metadata.pacmValue, 1);

const directMnemonic = ARM64E_ARCHITECTURE.liftExact({
  instructionId:'issue-8332:direct-pacm',
  address:0x1200n,
  mnemonic:'pacm',
  opStr:'',
  ops:[],
  mode:'arm64e',
  origin:{ instructionIds:['issue-8332:direct-pacm'] },
}, { featPAuthLr:true, pacmEnabled:true });
assert.equal(directMnemonic.metadata.family, 'arm64e-pointer-authentication');
assert.equal(directMnemonic.metadata.pacmValue, 1);
assert.equal(directMnemonic.completeness, 'exact-with-intrinsic');

const directMalformed = ARM64E_ARCHITECTURE.liftExact({
  instructionId:'issue-8332:direct-pacm-malformed',
  address:0x1204n,
  mnemonic:'pacm',
  opStr:'x0',
  ops:parseOperands('x0'),
  mode:'arm64e',
  origin:{ instructionIds:['issue-8332:direct-pacm-malformed'] },
}, { featPAuthLr:true, pacmEnabled:true });
assert.equal(directMalformed.completeness, 'partial');
assert.equal(directMalformed.metadata.failClosed, true);
assert.match(directMalformed.unknownEffects.reason, /operand-shape-invalid/);

const nonBooleanContext = ARM64E_ARCHITECTURE.liftExact(
  decoded(raw, 'issue-8332:non-boolean-context', { word:PACM_WORD }),
  { featPAuthLr:'yes', pacmEnabled:1 },
);
assert.equal(nonBooleanContext.completeness, 'partial');
assert.match(nonBooleanContext.unknownEffects.reason, /implementation state is unresolved/);

const disabledByPolicy = ARM64E_ARCHITECTURE.liftExact(
  decoded(raw, 'issue-8332:pacm-disabled', { encodingWord:BigInt(PACM_WORD) }),
  { featPAuthLr:true, pacmEnabled:false },
);
assert.equal(disabledByPolicy.completeness, 'exact-with-intrinsic');
assert.equal(disabledByPolicy.metadata.pacmValue, 0);
assert.equal(registerOps(disabledByPolicy, 'register-write', 'PAuthState').length, 1);
assert.equal(pacmIntrinsic(disabledByPolicy).metadata.pacmValue, 0);

const featureAbsent = ARM64E_ARCHITECTURE.liftExact(
  decoded(raw, 'issue-8332:feature-absent', { bytes:PACM_BYTES }),
  { featPAuthLr:false },
);
assert.equal(featureAbsent.completeness, 'exact');
assert.equal(featureAbsent.metadata.pacmFeatureImplemented, false);
assert.equal(featureAbsent.operations.some((operation) => operation.intrinsicId === 'arm64e.pauth.pacm'), false);
assert.equal(registerOps(featureAbsent, 'register-write', 'PAuthState').length, 0);

// Contradictory redundant encoding evidence is not authoritative and must not
// be promoted from printed `hint #0x27` text.
const contradictory = ARM64E_ARCHITECTURE.liftExact(decoded(raw, 'issue-8332:contradictory', {
  word:PACM_WORD,
  rawBytes:Uint8Array.of(0x1f, 0x20, 0x03, 0xd5), // NOP
}));
assert.equal(contradictory.metadata.family, 'arm64e-pointer-authentication');
assert.equal(contradictory.completeness, 'partial');
assert.equal(contradictory.metadata.failClosed, true);
assert.equal(contradictory.metadata.environmentFootprintComplete, false);
assert.equal(registerOps(contradictory, 'register-write', 'PAuthState').length, 0);

// The producer and the PAuth_LR consumers must use the same architecture-state
// identity so use-def construction can connect PACM to PACIASP/AUTIASP/RETAA.
for (const [mnemonic, opStr, expectedSecond] of [
  ['paciasp', '', 'pc'],
  ['autiasp', '', 'x16'],
  ['retaa', '', 'x16'],
]) {
  const consumer = ARM64E_ARCHITECTURE.liftExact({
    instructionId:`issue-8332:${mnemonic}`,
    address:0x2000n,
    mnemonic,
    opStr,
    ops:parseOperands(opStr),
    mode:'arm64e',
    origin:{ instructionIds:[`issue-8332:${mnemonic}`] },
  });
  assert.equal(registerOps(consumer, 'register-read', 'PAuthState').length, 1, `${mnemonic}: shared PAuthState input`);
  const second = consumer.operations.find((operation) => operation.kind === 'register-read'
    && operation.register?.registerId === expectedSecond
    && operation.metadata?.conditional?.pstateField === 'PACM');
  assert.ok(second, `${mnemonic}: PAuth_LR second modifier must remain PACM-conditioned`);
  assert.equal(second.metadata.conditional.architectureStateInput, 'PAuthState');
}

console.log('issue 8332 ARM64e PACM producer state: PASS');
