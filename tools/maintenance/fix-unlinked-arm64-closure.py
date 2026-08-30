from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if new in s:
        return
    if old not in s:
        raise SystemExit(f"guard failed: {path}: {old[:120]!r}")
    p.write_text(s.replace(old, new, 1))


replace_once(
    'js/targets/architecture/arm64/effects/addressing.js',
    """function canonicalStructuredRegister(input) {\n  const bits = Number(input?.bits);\n  const num = input?.num == null ? null : Number(input.num);""",
    """function canonicalStructuredRegister(input) {\n  const bits = input?.bits;\n  const num = input?.num == null ? null : input.num;\n  if (typeof bits !== 'number' || !Number.isInteger(bits) || !Number.isFinite(bits)) return null;\n  if (num != null && (typeof num !== 'number' || !Number.isInteger(num) || !Number.isFinite(num))) return null;""",
)

replace_once(
    'js/targets/architecture/arm64e/effects.js',
    """const AUTH_RETURN = Object.freeze({\n  retaa: { key: 'ia' },\n  retab: { key: 'ib' },\n});""",
    """const AUTH_RETURN = Object.freeze({\n  retaa: { key: 'ia' },\n  retab: { key: 'ib' },\n});\n\nconst AUTH_EXCEPTION_RETURN = Object.freeze({\n  eretaa: { key: 'ia' },\n  eretab: { key: 'ib' },\n});""",
)

replace_once(
    'js/targets/architecture/arm64e/effects.js',
    """  ...Object.keys(AUTH_CALL),\n  ...Object.keys(AUTH_RETURN),\n]);""",
    """  ...Object.keys(AUTH_CALL),\n  ...Object.keys(AUTH_RETURN),\n  ...Object.keys(AUTH_EXCEPTION_RETURN),\n]);""",
)

anchor = """export function isArm64ePointerAuthenticationInstruction(decoded) {"""
insert = r'''function authenticateExceptionReturn(decoded, context, instructionId, descriptor) {
  const operands = operandList(decoded);
  if (operands.length !== 0) {
    return partialMissing(decoded, context, instructionId, 'authenticated exception-return operand shape is invalid', { control: true, fault: true });
  }

  const operations = [];
  const modifier = modifierInput(operations, { ...descriptor, modifier: 'sp' }, operands, 0, instructionId);
  if (!modifier) {
    return partialMissing(decoded, context, instructionId, 'authenticated exception-return SP modifier is unavailable', { control: true, fault: true });
  }
  const { keyId } = readPAuthState(operations, descriptor.key, instructionId);
  const reason = 'authenticated exception-return environment restore is not fully represented';
  const categories = ['control', 'registers', 'memory', 'faults', 'other'];
  operations.push(createMachineOperation({
    kind: 'unknown',
    reason,
    categories,
  }));
  const controlEffect = {
    kind: 'indirect',
    target: { kind: 'exception-return-address' },
    reason: 'authenticated-exception-return',
  };
  return baseBundle(decoded, context, instructionId, operations, controlEffect, 'partial', {
    possibleFaults: [
      authFault(mnemonicOf(decoded), keyId, 'control-target'),
      authenticatedTargetAlignmentFault(),
      { kind: 'illegal-exception-return', condition: { kind: 'architectural-exception-return-check' } },
    ],
    unknownEffects: {
      categories,
      reason,
      detail: {
        keyIdentity: keyId,
        modifier: 'sp',
        targetSource: 'exception-return-address',
        environmentRestore: true,
      },
    },
    metadata: {
      transform: 'authenticate',
      authenticatedExceptionReturn: true,
      exceptionReturn: true,
      keyIdentity: keyId,
      modifier: modifier.metadata,
      architectureStateInput: PAUTH_STATE_ID,
      environmentBoundary: true,
      environmentFootprintComplete: false,
    },
  });
}

'''
p = Path('js/targets/architecture/arm64e/effects.js')
s = p.read_text()
if 'function authenticateExceptionReturn(' not in s:
    if anchor not in s:
        raise SystemExit('guard failed: arm64e effects export anchor')
    p.write_text(s.replace(anchor, insert + anchor, 1))

replace_once(
    'js/targets/architecture/arm64e/effects.js',
    """    || Object.hasOwn(AUTH_CALL, mnemonic)\n    || Object.hasOwn(AUTH_RETURN, mnemonic);""",
    """    || Object.hasOwn(AUTH_CALL, mnemonic)\n    || Object.hasOwn(AUTH_RETURN, mnemonic)\n    || Object.hasOwn(AUTH_EXCEPTION_RETURN, mnemonic);""",
)

replace_once(
    'js/targets/architecture/arm64e/effects.js',
    """  if (Object.hasOwn(AUTH_CALL, mnemonic)) return authenticateControlTarget(decoded, context, instructionId, AUTH_CALL[mnemonic], 'call');\n  if (Object.hasOwn(AUTH_RETURN, mnemonic)) return authenticateControlTarget(decoded, context, instructionId, AUTH_RETURN[mnemonic], 'return');\n  return null;""",
    """  if (Object.hasOwn(AUTH_CALL, mnemonic)) return authenticateControlTarget(decoded, context, instructionId, AUTH_CALL[mnemonic], 'call');\n  if (Object.hasOwn(AUTH_RETURN, mnemonic)) return authenticateControlTarget(decoded, context, instructionId, AUTH_RETURN[mnemonic], 'return');\n  if (Object.hasOwn(AUTH_EXCEPTION_RETURN, mnemonic)) return authenticateExceptionReturn(decoded, context, instructionId, AUTH_EXCEPTION_RETURN[mnemonic]);\n  return null;""",
)

replace_once(
    'js/targets/architecture/arm64/effects/system.js',
    """const ARM64E_ONLY = /^(?:paci|pacd|auti|autd|xpac|retaa|retab|braa|brab|blraa|blrab)/;""",
    """const ARM64E_ONLY = /^(?:paci|pacd|auti|autd|xpac|retaa|retab|eretaa|eretab|braa|brab|blraa|blrab)/;""",
)

replace_once(
    'tools/validation/machine-effects/arm64e-pac-denominator.mjs',
    """  ['xpaclri',0xd50320ff],['retaa',0xd65f0bff],['retab',0xd65f0fff],""",
    """  ['xpaclri',0xd50320ff],['retaa',0xd65f0bff],['retab',0xd65f0fff],\n  ['eretaa',0xd69f0bff],['eretab',0xd69f0fff],""",
)

replace_once(
    'tests/machine-effects/arm64e-pac-denominator.test.mjs',
    """assert.equal(denominator.encodingFamilyCount,38);\nassert.equal(denominator.encodingCaseCount,45_515);""",
    """assert.equal(denominator.encodingFamilyCount,40);\nassert.equal(denominator.encodingCaseCount,45_517);""",
)

replace_once(
    'tests/machine-effects/arm64e-pac-denominator.test.mjs',
    """      assert.ok(effects,`${item.id}: escaped PAC ownership`);\n      assert.equal(effects.completeness,'exact-with-intrinsic',`${item.id}:${effects.unknownEffects?.reason}`);\n      assert.equal(effects.metadata.family,'arm64e-pointer-authentication');""",
    """      assert.ok(effects,`${item.id}: escaped PAC ownership`);\n      const expectedCompleteness = item.mnemonic === 'eretaa' || item.mnemonic === 'eretab' ? 'partial' : 'exact-with-intrinsic';\n      assert.equal(effects.completeness,expectedCompleteness,`${item.id}:${effects.unknownEffects?.reason}`);\n      assert.equal(effects.metadata.family,'arm64e-pointer-authentication');""",
)

replace_once(
    'tests/arm64-presentation-compat.mjs',
    """assert.equal(facade.categoryOf(\"dmb\"), \"system\", \"barriers retain their established presentation category\");\nconsole.log(\"  ok 6 atomic category variants\");""",
    """assert.equal(facade.categoryOf(\"dmb\"), \"system\", \"barriers retain their established presentation category\");\nassert.equal(facade.categoryOf(\"eret\"), \"system\");\nassert.equal(facade.categoryOf(\"eretaa\"), \"system\");\nassert.equal(facade.categoryOf(\"ERETAB\"), \"system\");\nassert.equal(facade.categoryOf(\"retaa\"), \"flow\");\nassert.equal(facade.categoryOf(\"retab\"), \"flow\");\nassert.notEqual(facade.categoryOf(\"eretax\"), \"system\");\nconsole.log(\"  ok 6 atomic category variants + authenticated exception-return classification\");""",
)

Path('tests/unlinked-arm64-closure.mjs').write_text(r'''import assert from 'node:assert/strict';
import { arm64RegisterOperand } from '../js/targets/architecture/arm64/effects/addressing.js';
import { liftArm64eEffects, arm64ePointerAuthenticationMnemonics } from '../js/targets/architecture/arm64e/effects.js';

for (const valid of [
  { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:30, bits:32, text:'w30' },
  { k:'reg', cls:'sp', num:31, bits:64, text:'sp' },
  { k:'reg', cls:'zr', num:31, bits:32, text:'wzr' },
  { k:'reg', cls:'vec', num:31, bits:128, text:'q31' },
]) assert.ok(arm64RegisterOperand(valid), JSON.stringify(valid));

for (const invalid of [
  { k:'reg', cls:'gp', num:'0', bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:false, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:0, bits:'64', text:'x0' },
  { k:'reg', cls:'vec', num:'31', bits:128, text:'q31' },
  { k:'reg', cls:'gp', num:0.5, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:NaN, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:Infinity, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:{ valueOf(){ return 0; } }, bits:64, text:'x0' },
]) assert.equal(arm64RegisterOperand(invalid), null, JSON.stringify(invalid));
assert.equal(arm64RegisterOperand('x0')?.physicalId, 'x0');
assert.equal(arm64RegisterOperand('fp')?.physicalId, 'x29');
assert.equal(arm64RegisterOperand('lr')?.physicalId, 'x30');

const mnemonics = new Set(arm64ePointerAuthenticationMnemonics());
assert.equal(mnemonics.has('eretaa'), true);
assert.equal(mnemonics.has('eretab'), true);
for (const mnemonic of ['eretaa','eretab']) {
  const effects = liftArm64eEffects({ instructionId:`test:${mnemonic}`, mnemonic, ops:[], mode:'arm64e' });
  assert.ok(effects);
  assert.equal(effects.completeness, 'partial');
  assert.equal(effects.controlEffect?.kind, 'indirect');
  assert.equal(effects.controlEffect?.target?.kind, 'exception-return-address');
  assert.equal(effects.metadata?.authenticatedExceptionReturn, true);
  assert.equal(effects.possibleFaults.some((fault)=>fault.kind === 'illegal-exception-return'), true);
  assert.equal(effects.possibleFaults.some((fault)=>fault.kind === 'instruction-address-fault'), true);
  assert.match(effects.unknownEffects?.reason || '', /environment restore/);

  const malformed = liftArm64eEffects({ instructionId:`test:${mnemonic}:bad`, mnemonic, ops:[{k:'reg',cls:'gp',num:0,bits:64,text:'x0'}], mode:'arm64e' });
  assert.equal(malformed.completeness, 'partial');
  assert.match(malformed.unknownEffects?.reason || '', /operand shape/);
}

console.log('unlinked ARM64 closure: PASS');
''')
