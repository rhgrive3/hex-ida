import test from 'node:test';
import assert from 'node:assert/strict';
import { extraApiInfo } from '../js/api-cross-binary-families.js';
import { apiInfo } from '../js/blocks.js';

test('issue #6182: SecCertificateCopyData retrieves certificate data with read effect, not crypto effect', () => {
  for (const name of ['SecCertificateCopyData', '_SecCertificateCopyData']) {
    const extra = extraApiInfo(name);
    assert.ok(extra, `${name} must be classified`);
    assert.equal(extra.id, 'security_certificate_copy_data');
    assert.equal(extra.cat, 'crypto');
    assert.equal(extra.ret, 'ptr');
    assert.equal(extra.effect, 'read');
    assert.notEqual(extra.effect, 'crypto');
    assert.deepEqual(extra.args, ['certificate']);

    const info = apiInfo(name);
    assert.ok(info, `${name} must be returned by apiInfo`);
    assert.equal(info.id, 'security_certificate_copy_data');
    assert.equal(info.cat, 'crypto');
    assert.equal(info.ret, 'ptr');
    assert.equal(info.effect, 'read');
    assert.notEqual(info.effect, 'crypto');
  }
});

test('issue #6182: broad Sec* fallback does not claim crypto effect for arbitrary security symbols', () => {
  for (const name of ['SecRequirementCopyData', '_SecRequirementCopyData', 'SecAccessControlCreate', 'SecPolicyCreateBasicX509']) {
    const extra = extraApiInfo(name);
    assert.ok(extra, `${name} should be matched by broad fallback`);
    assert.equal(extra.id, 'security_framework');
    assert.equal(extra.cat, 'crypto');
    assert.equal(extra.effect, null, `${name} effect must be null, not crypto`);

    const info = apiInfo(name);
    assert.ok(info, `${name} must resolve in apiInfo`);
    assert.equal(info.effect, null);
  }
});

test('issue #6182: precise SecKey and SecTrust entries maintain crypto effect via baseApiInfo precedence', () => {
  for (const name of ['SecKeyRawSign', 'SecKeyCreateRandomKey', 'SecTrustEvaluate', 'SecTrustCreateWithCertificates']) {
    const info = apiInfo(name);
    assert.ok(info, `${name} must resolve in apiInfo`);
    assert.equal(info.cat, 'crypto');
    assert.equal(info.effect, 'crypto');
  }
});

console.log('issue #6182 test file loaded.');
