import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeVaHex,
  toSafeByteSize,
  isStrippedFunctionName,
  isSafeAssetUrl,
  AUTO_ANALYSIS_STATUS,
  PATCH_RISK_LEVEL,
  GLOSSARY_KEYS,
  GLOSSARY_KEY_SET,
  safeInvokeCallback,
} from '../js/analysis/common/v6-auto-contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_PATH = path.resolve(__dirname, '../js/analysis/common/v6-auto-contracts.js');

describe('v6-auto-contracts', () => {
  it('has zero external imports (pure zero-dependency module)', () => {
    const src = fs.readFileSync(CONTRACTS_PATH, 'utf8');
    assert.equal(/\bimport\s+/.test(src), false, 'v6-auto-contracts.js must not import any module');
    assert.equal(/\brequire\s*\(/.test(src), false, 'v6-auto-contracts.js must not use require()');
  });

  it('normalizeVaHex handles BigInt, safe integers, 0x hex, decimal strings, and rejects invalid inputs', () => {
    assert.equal(normalizeVaHex(0n), '0x0');
    assert.equal(normalizeVaHex(0x100004000n), '0x100004000');
    assert.equal(normalizeVaHex(-1n), null);

    assert.equal(normalizeVaHex(0), '0x0');
    assert.equal(normalizeVaHex(4096), '0x1000');
    assert.equal(normalizeVaHex(Number.MAX_SAFE_INTEGER), `0x${BigInt(Number.MAX_SAFE_INTEGER).toString(16)}`);
    assert.equal(normalizeVaHex(Number.MAX_SAFE_INTEGER + 1), null);
    assert.equal(normalizeVaHex(-1), null);
    assert.equal(normalizeVaHex(NaN), null);
    assert.equal(normalizeVaHex(Infinity), null);
    assert.equal(normalizeVaHex(1.5), null);

    assert.equal(normalizeVaHex('0x10'), '0x10');
    assert.equal(normalizeVaHex('  0XAbCd  '), '0xabcd');
    assert.equal(normalizeVaHex('16'), '0x10');
    assert.equal(normalizeVaHex('  255 '), '0xff');
    assert.equal(normalizeVaHex('deadbeef'), null);
    assert.equal(normalizeVaHex('0b1010'), null);
    assert.equal(normalizeVaHex('0o777'), null);
    assert.equal(normalizeVaHex('-0x10'), null);
    assert.equal(normalizeVaHex(''), null);
    assert.equal(normalizeVaHex('   '), null);
    assert.equal(normalizeVaHex(null), null);
    assert.equal(normalizeVaHex(undefined), null);
    assert.equal(normalizeVaHex({}), null);
  });

  it('toSafeByteSize safely converts BigInt and finite non-negative numbers', () => {
    assert.equal(toSafeByteSize(0n), 0);
    assert.equal(toSafeByteSize(256n), 256);
    assert.equal(toSafeByteSize(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    assert.equal(toSafeByteSize(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 64), 64);
    assert.equal(toSafeByteSize(-10n, 32), 32);

    assert.equal(toSafeByteSize(128.9), 128);
    assert.equal(toSafeByteSize(-1, 16), 16);
    assert.equal(toSafeByteSize(NaN, 16), 16);
    assert.equal(toSafeByteSize(Infinity, 16), 16);
  assert.equal(toSafeByteSize(1e20, 7), 7);
  assert.equal(toSafeByteSize(Number.MAX_SAFE_INTEGER + 2, 7), 7);
    assert.equal(toSafeByteSize('128', 16), 16);
    assert.equal(toSafeByteSize(null, 16), 16);
  });

  it('isStrippedFunctionName identifies placeholders and preserves real symbols', () => {
    for (const s of [null, undefined, '', '   ', 'sub_1000', 'FUN_00401000', 'func_abcd', 'fn_1234', 'loc_dead', 'unk_cafe', 'unnamed_func_1', 'UNNAMED_42']) {
      assert.equal(isStrippedFunctionName(s), true, `expected stripped: ${String(s)}`);
    }
    for (const real of ['main', '_main', 'sub_custom', 'FUN_helper', 'my_func', '_Z3foov', '_$s4mainyyF', 'objc_msgSend']) {
      assert.equal(isStrippedFunctionName(real), false, `expected real symbol: ${real}`);
    }
  });

  it('isSafeAssetUrl accepts valid URLs and rejects traversal, whitespace, bad schemes, missing host, and credentials', () => {
    assert.equal(isSafeAssetUrl('til-hub/manifest.json'), true);
    assert.equal(isSafeAssetUrl('packs/ios-sdk-core.til1.gz'), true);
    assert.equal(isSafeAssetUrl('https://cdn.example.com/til-hub/manifest.json'), true);
    assert.equal(isSafeAssetUrl('http://example.com/a.json'), true);
    assert.equal(isSafeAssetUrl('til-hub/manifest.json', { allowRelative: false }), false);

    const unsafe = [
      '',
      ' ',
      ' javascript:alert(1)',
      'javascript:alert(1)',
      'data:text/plain;base64,QQ==',
      'file:///etc/passwd',
      ' //evil.example/x',
      '//evil.example/x',
      'til-hub/../../etc/passwd',
      'til-hub/%2e%2e/secret',
      'til-hub/%2e./secret',
      'til-hub/.%2e/secret',
      'til-hub/%5csecret',
      'til-hub\\secret',
      'til-hub/a\nb',
      'til-hub/a\x00b',
      'til-hub/with space.json',
      'https://',
      'http://',
      'https:///path',
      'https://user:pass@example.com/x',
      'https://user@example.com/x',
      null,
      123,
    ];
    for (const u of unsafe) {
      assert.equal(isSafeAssetUrl(u), false, `expected unsafe URL to be rejected: ${JSON.stringify(u)}`);
    }
  });

  it('exports frozen AUTO_ANALYSIS_STATUS (11), PATCH_RISK_LEVEL (4), GLOSSARY_KEYS (24), and read-only GLOSSARY_KEY_SET', () => {
    assert.equal(Object.isFrozen(AUTO_ANALYSIS_STATUS), true);
    assert.equal(Object.keys(AUTO_ANALYSIS_STATUS).length, 11);
    assert.equal(Object.isFrozen(PATCH_RISK_LEVEL), true);
    assert.deepEqual(Object.keys(PATCH_RISK_LEVEL).sort(), ['HIGH', 'LOW', 'MEDIUM', 'UNKNOWN']);

    assert.equal(Object.isFrozen(GLOSSARY_KEYS), true);
    assert.equal(GLOSSARY_KEYS.length, 24);
    assert.equal(new Set(GLOSSARY_KEYS).size, 24);

    assert.equal(Object.isFrozen(GLOSSARY_KEY_SET), true);
    assert.equal(GLOSSARY_KEY_SET.size, 24);
    assert.equal(GLOSSARY_KEY_SET.has('pac'), true);
    assert.equal(GLOSSARY_KEY_SET.has('nonexistent'), false);
    assert.equal('add' in GLOSSARY_KEY_SET, false);
    assert.equal('delete' in GLOSSARY_KEY_SET, false);
    assert.equal('clear' in GLOSSARY_KEY_SET, false);
    assert.deepEqual([...GLOSSARY_KEY_SET], [...GLOSSARY_KEYS]);
  });

  it('safeInvokeCallback isolates callback errors and passes arguments through', () => {
    assert.equal(safeInvokeCallback((a, b) => a + b, 2, 3), 5);
    assert.equal(safeInvokeCallback(() => { throw new Error('boom'); }), undefined);
    assert.equal(safeInvokeCallback(null, 1), undefined);
  });
});
