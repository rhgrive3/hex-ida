// Issues #6182/#6189 regressions: cross-binary API-family fallbacks must not
// mint semantic effects from namespace membership alone.
// - #6182: the broad Security.framework fallback asserted effect:'crypto' for
//   every unknown Sec* symbol, including pure data retrieval/serialization
//   (SecCertificateCopyData, SecRequirementCopyData). The family keeps its
//   subsystem identity but no longer asserts a crypto effect; precise entries
//   prove the real contract for the specified APIs.
// - #6189: vImage* (Accelerate CPU image processing) was laundered into a UI
//   effect by the apple_ui_media namespace regex; it is a separate
//   memory-transform family now.
import assert from 'node:assert/strict';
import { extraApiInfo } from '../js/api-cross-binary-families.js';
import { apiInfo } from '../js/blocks.js';

// 1. #6189: the representative scale entry keeps its precise ABI contract,
//    while the broad family remains available for unknown operations.
for (const name of ['vImageScale_ARGB8888', '_vImageScale_ARGB8888']) {
  const extra = extraApiInfo(name);
  assert.ok(extra, `${name} must stay in a known extra family`);
  assert.equal(extra.id, 'accelerate_vimage_scale');
  assert.deepEqual(extra.args, ['src', 'dest', 'tempBuffer', 'flags']);
  assert.equal(extra.ret, 'status');
  assert.equal(extra.effect, 'convert');

  const info = apiInfo(name);
  assert.ok(info, `${name} must stay in a known family`);
  assert.notEqual(info.effect, 'ui', `${name} must not claim a UI effect`);
  assert.equal(info.id, 'accelerate_vimage_scale', `${name} must use the precise scale contract`);
  assert.deepEqual(info.args, ['src', 'dest', 'tempBuffer', 'flags']);
  assert.equal(info.ret, 'status');
  assert.equal(info.effect, 'convert');
}

// Unknown vImage operations retain the merged conservative fallback.
for (const name of ['vImageConvert_16Uto8', '_vImageHistogramCalculation_ARGB8888']) {
  const info = apiInfo(name);
  assert.ok(info, `${name} must stay in a known family`);
  assert.notEqual(info.effect, 'ui', `${name} must not claim a UI effect`);
  assert.equal(info.id, 'accelerate_vimage', `${name} must use the broad Accelerate image-transform family`);
  assert.equal(info.cat, 'memory');
  assert.equal(info.effect, null);
}

// 2. #6189: genuinely UI-shaped families keep their UI effect.
for (const name of ['UIApplicationMain', 'UIRectFill', 'UIAccessibilityPostNotification', 'UTTypeCreatePreferredIdentifierForTag']) {
  const info = apiInfo(name);
  assert.ok(info, `${name} must stay covered`);
  assert.equal(info.effect, 'ui', `${name} must keep the UI effect`);
}

// 3. #6182: non-crypto Security.framework retrieval APIs must not claim a
//    crypto effect from the broad fallback.
for (const name of ['SecCertificateCopyData', '_SecCertificateCopyData', 'SecRequirementCopyData', '_SecRequirementCopyData']) {
  const extra = extraApiInfo(name);
  assert.ok(extra, `${name} must stay covered by the public fallback`);
  assert.equal(extra.cat, 'crypto');
  const info = apiInfo(name);
  assert.ok(info, `${name} must stay covered`);
  assert.notEqual(info.effect, 'crypto', `${name} must not claim a crypto effect`);
}

// 4. #6182: the specified retrieval APIs gain precise contracts (base table
//    precedence) with a read effect instead of crypto.
{
  const certificateExtra = extraApiInfo('SecCertificateCopyData');
  assert.equal(certificateExtra.id, 'security_certificate_copy_data');
  assert.equal(certificateExtra.ret, 'ptr');
  assert.equal(certificateExtra.effect, 'read');
  const info = apiInfo('SecCertificateCopyData');
  assert.equal(info.id, 'security_cert_data');
  assert.equal(info.ret, 'object');
  assert.equal(info.effect, 'read');
  assert.deepEqual(info.args, ['certificate']);
  const requirementExtra = extraApiInfo('_SecRequirementCopyData');
  assert.equal(requirementExtra.id, 'security_framework');
  assert.equal(requirementExtra.effect, null);
  const req = apiInfo('_SecRequirementCopyData');
  assert.equal(req.id, 'security_requirement_data');
  assert.equal(req.ret, 'object');
  assert.deepEqual(req.args, ['requirement']);
  assert.equal(req.effect, 'read');
}

// 5. #6182: unknown Sec* symbols keep Security.framework subsystem identity
//    but no proven semantic effect (fail closed).
{
  const info = apiInfo('SecTaskCopyValueForEntitlement');
  assert.equal(info.id, 'security_framework');
  assert.equal(info.cat, 'crypto');
  assert.equal(info.effect, null);
}

// 6. The actually-crypto precise families keep precedence and semantics.
for (const name of ['SecKeyCreateEncryptedData', 'SecTrustEvaluateWithError']) {
  const info = apiInfo(name);
  assert.ok(info, `${name} must stay covered by the precise crypto entries`);
  assert.equal(info.effect, 'crypto', `${name} must keep the crypto effect`);
}

console.log('issues #6182/#6189 api family fallback classifier regressions: PASS');
