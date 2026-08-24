import assert from 'node:assert/strict';
import { liftArm64MemoryEffects, LEGACY_ARM64_MEMORY_INVENTORY } from '../../js/targets/architecture/arm64/effects/memory.js';

let sequence = 0;
const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const sp = () => ({ k:'reg', text:'sp', cls:'sp', bits:64, num:31 });
const xzr = () => ({ k:'reg', text:'xzr', cls:'zr', bits:64, num:31 });
const wzr = () => ({ k:'reg', text:'wzr', cls:'zr', bits:32, num:31 });
const fp = (prefix, n, bits) => ({ k:'reg', text:`${prefix}${n}`, cls:'fp', bits, num:n });
const imm = (value) => ({ k:'imm', text:`#${value}`, value:BigInt(value) });
const mem = (base, { mode='offset', disp=0n, index=null, shift=null, writebackDisp=undefined } = {}) => {
  const d = disp == null ? null : imm(disp);
  const out = { k:'mem', text:'[...]', base, index, shift, mode, disp:d, addressDisp:mode === 'post' ? null : d, writebackDisp:null };
  if (writebackDisp !== undefined) out.writebackDisp = writebackDisp == null ? null : imm(writebackDisp);
  else if (mode === 'pre') out.writebackDisp = d;
  return out;
};
function lift(mnemonic, ops, extra = {}) {
  const instructionId = `arm64-mem-test-${sequence++}`;
  return liftArm64MemoryEffects({ mnemonic, ops, ...extra }, { instructionId, origin:{ instructionIds:[instructionId] } });
}
const opsOf = (bundle, kind) => bundle.operations.filter((op) => op.kind === kind);

{
  const b = lift('ldr', [x(0), mem(x(1), { disp:16n })]);
  const [load] = opsOf(b, 'memory-read');
  assert.equal(b.completeness, 'exact');
  assert.equal(load.access.space, 'memory');
  assert.equal(load.access.widthBits, 64);
  assert.equal(load.access.endian, 'little');
  assert.equal('atomic' in load.access, false, 'ordinary LDR atomicity is not inferred');
  assert.equal('volatility' in load.access, false, 'volatility is unknown from the instruction alone');
  assert.equal(load.access.addressExpr.kind, 'add');
  assert.equal(load.access.addressExpr.right.value, '16');
  assert.equal(b.possibleFaults[0].kind, 'data-abort');
}

{
  const b = lift('ldr', [x(0), mem(x(1), { index:w(2), disp:0n, shift:{ op:'uxtw', amount:3 } })]);
  const [load] = opsOf(b, 'memory-read');
  assert.equal(b.completeness, 'exact');
  assert.equal(load.access.addressExpr.right.kind, 'shift-left');
  assert.equal(load.access.addressExpr.right.value.kind, 'zero-extend');
  assert.equal(load.access.addressExpr.right.amount, 3);
}

{
  const b = lift('ldur', [x(0), mem(x(1), { disp:-8n })]);
  assert.equal(b.metadata.addressing.encoding, 'unscaled');
  assert.equal(opsOf(b, 'memory-read')[0].access.addressExpr.right.value, BigInt.asUintN(64, -8n).toString());
}

{
  const pre = lift('str', [x(0), mem(sp(), { mode:'pre', disp:-16n })]);
  const post = lift('str', [x(0), mem(sp(), { mode:'post', disp:null, writebackDisp:16n })]);
  const preMem = pre.operations.findIndex((op) => op.kind === 'memory-write');
  const preWb = pre.operations.findIndex((op) => op.kind === 'register-write' && op.metadata?.purpose === 'address-writeback');
  const postMem = post.operations.findIndex((op) => op.kind === 'memory-write');
  const postWb = post.operations.findIndex((op) => op.kind === 'register-write' && op.metadata?.purpose === 'address-writeback');
  assert.ok(preWb > preMem, 'pre-index writeback is a separate post-access register effect');
  assert.ok(postWb > postMem, 'post-index writeback must follow access');
  assert.equal(pre.metadata.addressing.stack, true);
  assert.equal(pre.operations[preWb].register.registerId, 'sp');
  assert.equal(pre.operations[preMem].access.addressExpr.kind, 'add');
  assert.equal(post.operations[postMem].access.addressExpr.kind, 'temporary');
  assert.ok(pre.possibleFaults.some((fault) => fault.kind === 'stack-pointer-alignment-fault'));
}

{
  const b = lift('ldp', [x(0), x(1), mem(sp(), { disp:16n })]);
  const loads = opsOf(b, 'memory-read');
  assert.equal(loads.length, 2);
  assert.equal(loads[0].access.widthBits, 64);
  assert.equal(loads[1].access.widthBits, 64);
  assert.equal(loads[0].metadata.pairIndex, 0);
  assert.equal(loads[1].metadata.pairIndex, 1);
  assert.equal(loads[1].metadata.pairStrideBytes, 8);
  assert.equal(loads[1].access.addressExpr.kind, 'add');
  assert.equal(loads[1].access.addressExpr.right.value, '8');
}

{
  const b = lift('ldnp', [x(0), x(1), mem(x(2), { disp:16n })]);
  assert.equal(b.completeness, 'exact');
  assert.equal(b.metadata.nonTemporal, true);
  assert.equal(opsOf(b, 'memory-read')[0].metadata.nonTemporal, true);
}

{
  const signed = lift('ldrsb', [w(0), mem(x(1))]);
  const unsigned = lift('ldrb', [w(0), mem(x(1))]);
  const signedOps = signed.operations.filter((op) => op.kind === 'value').map((op) => op.opcode);
  const unsignedOps = unsigned.operations.filter((op) => op.kind === 'value').map((op) => op.opcode);
  assert.ok(signedOps.includes('sign-extend'));
  assert.ok(!unsignedOps.includes('sign-extend'));
  assert.ok(unsignedOps.includes('zero-extend'));
  const finalWrite = signed.operations.filter((op) => op.kind === 'register-write').at(-1);
  assert.equal(finalWrite.register.registerId, 'x0');
  assert.equal(finalWrite.register.widthBits, 64);
  assert.equal(finalWrite.register.view, 'w0');
  assert.equal(finalWrite.metadata.writePolicy, 'zero-upper-32');
}

{
  const wLoad = lift('ldr', [w(2), mem(x(1))]);
  const xLoad = lift('ldr', [x(2), mem(x(1))]);
  assert.equal(opsOf(wLoad, 'memory-read')[0].access.widthBits, 32);
  assert.equal(opsOf(xLoad, 'memory-read')[0].access.widthBits, 64);
  assert.equal(wLoad.operations.filter((op) => op.kind === 'register-write').at(-1).register.widthBits, 64);
  assert.equal(xLoad.operations.filter((op) => op.kind === 'register-write').at(-1).register.widthBits, 64);
}

{
  const b = lift('strb', [w(0), mem(x(1))]);
  const registerRead = b.operations.find((op) => op.kind === 'register-read' && op.register.registerId === 'x0');
  const viewTrunc = b.operations.find((op) => op.kind === 'value' && op.opcode === 'truncate'
    && op.metadata?.purpose === 'memory-store-register-view');
  const widthTrunc = b.operations.find((op) => op.kind === 'value' && op.opcode === 'truncate'
    && op.metadata?.purpose === 'memory-store-width');
  const store = b.operations.find((op) => op.kind === 'memory-write');
  assert.equal(registerRead?.register.widthBits, 64, 'W store sources read the canonical physical X state');
  assert.ok(viewTrunc, 'W store source is explicitly projected to its 32-bit architectural view');
  assert.equal(viewTrunc.metadata.fromBits, 64);
  assert.equal(viewTrunc.metadata.toBits, 32);
  assert.ok(widthTrunc, 'STRB explicitly truncates the W source view to the transfer width');
  assert.equal(widthTrunc.metadata.fromBits, 32);
  assert.equal(widthTrunc.metadata.toBits, 8);
  assert.equal(store.access.widthBits, 8);
  assert.equal(store.value.valueType.widthBits, 8);
}

{
  const b = lift('ldrsw', [x(3), { k:'imm', value:0x2000n }], { literalTarget:0x2000n });
  const [load] = opsOf(b, 'memory-read');
  assert.equal(load.access.widthBits, 32);
  assert.equal(load.access.addressExpr.kind, 'bitvector');
  assert.equal(load.access.addressExpr.value, '8192');
  assert.ok(b.operations.some((op) => op.kind === 'value' && op.opcode === 'sign-extend'));
}

{
  const b = lift('ldtr', [w(0), mem(x(1), { disp:-4n })]);
  assert.equal(b.completeness, 'exact');
  assert.equal(opsOf(b, 'memory-read')[0].metadata.unprivileged, true);
}

{
  const malformed = lift('ldr', [x(0), { k:'mem', base:x(1), mode:'post', disp:null, addressDisp:null, writebackDisp:null }]);
  assert.equal(malformed.completeness, 'partial');
  assert.deepEqual([...malformed.unknownEffects.categories].sort(), ['faults','memory','registers']);
  assert.equal(opsOf(malformed, 'memory-read').length, 0, 'malformed addressing must fail closed');
}

{
  const malformedScale = lift('ldr', [x(0), mem(x(1), { index:w(2), shift:{ op:'uxtw', amount:1 } })]);
  assert.equal(malformedScale.completeness, 'partial');
  assert.equal(opsOf(malformedScale, 'memory-read').length, 0);
  const malformedSignedWord = lift('ldrsw', [w(0), mem(x(1))]);
  assert.equal(malformedSignedWord.completeness, 'partial');
}

{
  const pairRegisterOffset = lift('ldp', [x(0), x(1), mem(x(2), { index:x(3) })]);
  const pairDuplicateDestination = lift('ldp', [x(0), x(0), mem(x(2))]);
  const nonTemporalWriteback = lift('stnp', [x(0), x(1), mem(x(2), { mode:'pre', disp:-16n })]);
  assert.equal(pairRegisterOffset.completeness, 'partial');
  assert.equal(pairDuplicateDestination.completeness, 'partial');
  assert.equal(nonTemporalWriteback.completeness, 'partial');
  assert.equal(opsOf(pairRegisterOffset, 'memory-read').length, 0);
}

{
  const acquireOffset = lift('ldar', [w(0), mem(x(1), { disp:4n })]);
  const unscaledWriteback = lift('ldur', [x(0), mem(x(1), { mode:'pre', disp:-8n })]);
  assert.equal(acquireOffset.completeness, 'partial');
  assert.equal(unscaledWriteback.completeness, 'partial');
}

{
  const invalidClass = lift('ldrb', [x(0), mem(x(1))]);
  const invalidVectorClass = lift('ldrb', [fp('b', 0, 8), mem(x(1))]);
  const invalidAcquireWidth = lift('ldarb', [x(0), mem(x(1))]);
  const invalidPairClassMix = lift('ldp', [x(0), fp('s', 1, 32), mem(x(2))]);
  for (const current of [invalidClass, invalidVectorClass, invalidAcquireWidth, invalidPairClassMix]) {
    assert.equal(current.completeness, 'partial');
    assert.equal(opsOf(current, 'memory-read').length + opsOf(current, 'memory-write').length, 0, 'invalid register encodings fail closed');
  }
}

{
  const discardLoad = lift('ldr', [xzr(), mem(x(1))]);
  const signedDiscard = lift('ldrsw', [xzr(), mem(x(1))]);
  const signedPairDiscard = lift('ldpsw', [xzr(), x(2), mem(x(1))]);
  const zeroStore = lift('str', [wzr(), mem(x(1))]);
  assert.equal(discardLoad.completeness, 'exact');
  assert.equal(signedDiscard.completeness, 'exact');
  assert.equal(signedPairDiscard.completeness, 'exact');
  assert.equal(zeroStore.completeness, 'exact');
  assert.equal(opsOf(discardLoad, 'memory-read').length, 1);
  assert.equal(opsOf(discardLoad, 'register-write').length, 0, 'load to XZR discards the result');
  assert.equal(opsOf(zeroStore, 'memory-write')[0].value.value, '0', 'store from WZR writes zero');
  assert.equal(opsOf(zeroStore, 'register-read').length, 1, 'address base remains the only register read');
}

{
  const scaledMax = lift('ldr', [x(0), mem(x(1), { disp:32760n })]);
  const scaledMisaligned = lift('ldr', [x(0), mem(x(1), { disp:7n })]);
  const scaledOverflow = lift('ldr', [x(0), mem(x(1), { disp:32768n })]);
  const unscaledMin = lift('ldur', [x(0), mem(x(1), { disp:-256n })]);
  const unscaledOverflow = lift('ldur', [x(0), mem(x(1), { disp:-257n })]);
  assert.equal(scaledMax.completeness, 'exact');
  assert.equal(unscaledMin.completeness, 'exact');
  for (const current of [scaledMisaligned, scaledOverflow, unscaledOverflow]) assert.equal(current.completeness, 'partial');
}

{
  const structuredOutOfRange = lift('ldur', [w(1), mem(x(29), { disp:-356n })]);
  const legacyAbstract = lift('ldur', [w(1), mem(x(29), { disp:-356n })], {
    row:4,
    parseError:null,
    operands:'w1, [x29, #-0x164]',
    memory:{ base:'x29' },
  });
  assert.equal(structuredOutOfRange.completeness, 'partial', 'decoder-style structured LDUR must still satisfy imm9');
  assert.equal(opsOf(structuredOutOfRange, 'memory-read').length, 0);
  assert.equal(legacyAbstract.completeness, 'exact', 'legacy semantic-model abstract LDUR remains compatible');
  assert.equal(legacyAbstract.metadata.compatibilityEncodingAlias, 'abstract-unscaled');
  assert.equal(legacyAbstract.metadata.addressing.encoding, 'legacy-abstract-unscaled');
  assert.equal(opsOf(legacyAbstract, 'memory-read').length, 1);
}

{
  const pairMax = lift('ldp', [x(0), x(1), mem(x(2), { disp:504n })]);
  const pairOverflow = lift('ldp', [x(0), x(1), mem(x(2), { disp:512n })]);
  const malformedPre = lift('ldr', [x(0), mem(x(1), { mode:'pre', disp:-8n, writebackDisp:-16n })]);
  assert.equal(pairMax.completeness, 'exact');
  assert.equal(pairOverflow.completeness, 'partial');
  assert.equal(malformedPre.completeness, 'partial');
}

assert.ok(LEGACY_ARM64_MEMORY_INVENTORY.loads.includes('ldpsw'));
assert.ok(LEGACY_ARM64_MEMORY_INVENTORY.stores.includes('stlxr'));
assert.deepEqual(LEGACY_ARM64_MEMORY_INVENTORY.simdMemoryDeferred, ['ld1','ld2','ld3','ld4','st1','st2','st3','st4']);
console.log('arm64 memory addressing effects: PASS');
