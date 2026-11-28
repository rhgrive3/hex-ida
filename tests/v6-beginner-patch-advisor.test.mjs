import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lang, setLang } from '../js/i18n.js';
import { GLOSSARY_KEY_SET, PATCH_RISK_LEVEL as CONTRACT_RISK_LEVEL } from '../js/analysis/common/v6-auto-contracts.js';
import {
  PATCH_RISK_LEVEL,
  ARM64E_PAC_MNEMONIC_LIST,
  ARM64E_PAC_MNEMONICS,
  extractInstructionMnemonic,
  extractMnemonic,
  assessPatchRisk,
} from '../js/ui/beginner/patch-risk-advisor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADVISOR_PATH = path.resolve(__dirname, '../js/ui/beginner/patch-risk-advisor.js');
const INITIAL_LANG = lang();

const EXPECTED_PAC_33 = [
  'paciasp', 'pacibsp', 'paciaz', 'pacibz',
  'autiasp', 'autibsp', 'autiaz', 'autibz',
  'retaa', 'retab',
  'xpaclri', 'xpaci', 'xpacd',
  'blraa', 'blraaz', 'blrab', 'blrabz',
  'braa', 'braaz', 'brab', 'brabz',
  'pacia', 'pacib', 'pacda', 'pacdb',
  'autia', 'autib', 'autda', 'autdb',
  'paciza', 'pacizb', 'pacdza', 'pacdzb',
];

const VALID_LEVELS = new Set(Object.values(CONTRACT_RISK_LEVEL));

function assertValidPatchRiskResult(res) {
  assert.equal(typeof res, 'object');
  assert.notEqual(res, null);
  assert.ok(VALID_LEVELS.has(res.level), `invalid risk level: ${res.level}`);
  assert.equal(typeof res.isFailSafe, 'boolean');

  if (res.isFailSafe) {
    assert.equal(res.level, PATCH_RISK_LEVEL.UNKNOWN);
    assert.equal(res.score, null);
  } else {
    assert.equal(typeof res.score, 'number');
    assert.ok(Number.isFinite(res.score), 'score must be finite');
    assert.ok(res.score >= 0 && res.score <= 100, `score out of 0..100 range: ${res.score}`);
  }

  assert.ok(Array.isArray(res.reasons));
  assert.ok(res.reasons.length > 0, 'reasons must be non-empty');
  for (const r of res.reasons) {
    assert.equal(typeof r, 'string');
    assert.ok(r.trim().length > 0);
  }

  assert.ok(Array.isArray(res.cautions));
  assert.ok(res.cautions.length > 0, 'cautions must be non-empty');
  for (const c of res.cautions) {
    assert.equal(typeof c, 'string');
    assert.ok(c.trim().length > 0);
  }

  assert.ok(Array.isArray(res.glossaryKeys));
  const seen = new Set();
  for (const key of res.glossaryKeys) {
    assert.equal(typeof key, 'string');
    assert.equal(GLOSSARY_KEY_SET.has(key), true, `glossary key outside 24-word contract: ${key}`);
    assert.equal(seen.has(key), false, `duplicate glossary key: ${key}`);
    seen.add(key);
  }
}

afterEach(() => {
  setLang(INITIAL_LANG);
});

describe('v6-beginner-patch-advisor (Track 6)', () => {
  it('obeys INV-005 module boundary rules (no js/targets/architecture or js/semantics imports)', () => {
    const src = fs.readFileSync(ADVISOR_PATH, 'utf8');
    assert.equal(/targets\/architecture/.test(src), false, 'must not import js/targets/architecture/');
    assert.equal(/['"][^'"]*\/semantics\//.test(src), false, 'must not import js/semantics/');
  });

  it('re-exports PATCH_RISK_LEVEL identically to v6-auto-contracts', () => {
    assert.strictEqual(PATCH_RISK_LEVEL, CONTRACT_RISK_LEVEL);
    assert.deepEqual(PATCH_RISK_LEVEL, {
      LOW: 'LOW',
      MEDIUM: 'MEDIUM',
      HIGH: 'HIGH',
      UNKNOWN: 'UNKNOWN',
    });
  });

  it('exposes exact 33 ARM64e PAC mnemonics as frozen list and read-only facade', () => {
    assert.equal(Object.isFrozen(ARM64E_PAC_MNEMONIC_LIST), true);
    assert.equal(ARM64E_PAC_MNEMONIC_LIST.length, 33);
    assert.deepEqual([...ARM64E_PAC_MNEMONIC_LIST], EXPECTED_PAC_33);

    assert.equal(Object.isFrozen(ARM64E_PAC_MNEMONICS), true);
    assert.equal(ARM64E_PAC_MNEMONICS.size, 33);
    assert.equal('add' in ARM64E_PAC_MNEMONICS, false);
    assert.equal('delete' in ARM64E_PAC_MNEMONICS, false);
    assert.equal('clear' in ARM64E_PAC_MNEMONICS, false);

    assert.deepEqual([...ARM64E_PAC_MNEMONICS], EXPECTED_PAC_33);
    assert.deepEqual([...ARM64E_PAC_MNEMONICS.values()], EXPECTED_PAC_33);
    assert.deepEqual([...ARM64E_PAC_MNEMONICS.keys()], EXPECTED_PAC_33);
    assert.equal([...ARM64E_PAC_MNEMONICS.entries()].length, 33);

    const visited = [];
    ARM64E_PAC_MNEMONICS.forEach((m) => visited.push(m));
    assert.deepEqual(visited, EXPECTED_PAC_33);

    for (const m of EXPECTED_PAC_33) {
      assert.equal(ARM64E_PAC_MNEMONICS.has(m), true, `missing PAC mnemonic: ${m}`);
    }
    assert.equal(ARM64E_PAC_MNEMONICS.has('mov'), false);
    assert.equal(ARM64E_PAC_MNEMONICS.has('ret'), false);
  });

  it('extracts mnemonics from strings and objects (mnemonic ?? mn ?? op ?? text)', () => {
    assert.strictEqual(extractInstructionMnemonic, extractMnemonic);

    assert.equal(extractInstructionMnemonic('  PACIASP  '), 'paciasp');
    assert.equal(extractInstructionMnemonic('MOV x0, #1'), 'mov');
    assert.equal(extractInstructionMnemonic('0x100004000: BLRAA x8, x9'), 'blraa');
    assert.equal(extractInstructionMnemonic({ mnemonic: 'RETAB', mn: 'mov' }), 'retab');
    assert.equal(extractInstructionMnemonic({ mn: 'AUTIASP', op: 'nop' }), 'autiasp');
    assert.equal(extractInstructionMnemonic({ op: 'XPACLRI', text: 'ret' }), 'xpaclri');
    assert.equal(extractInstructionMnemonic({ text: '  pacibsp ; sign lr' }), 'pacibsp');
    assert.equal(extractInstructionMnemonic({ mnemonic: '', mn: 'braa' }), 'braa');

    assert.equal(extractInstructionMnemonic(null), null);
    assert.equal(extractInstructionMnemonic(undefined), null);
    assert.equal(extractInstructionMnemonic(''), null);
    assert.equal(extractInstructionMnemonic('   '), null);
    assert.equal(extractInstructionMnemonic({}), null);
    assert.equal(extractInstructionMnemonic(123), null);
  });

  it('detects all 33 ARM64e PAC mnemonics as HIGH risk', () => {
    setLang('ja');
    for (const pac of EXPECTED_PAC_33) {
      const res = assessPatchRisk({
        instructions: [{ mn: pac.toUpperCase() }, { mnemonic: 'ret' }],
      });
      assertValidPatchRiskResult(res);
      assert.equal(res.level, PATCH_RISK_LEVEL.HIGH, `expected HIGH for PAC mnemonic ${pac}`);
      assert.equal(res.isFailSafe, false);
      assert.ok(res.score >= 60, `expected score >= 60 for ${pac}, got ${res.score}`);
      assert.equal(res.glossaryKeys.includes('pac'), true, `expected 'pac' glossaryKey for ${pac}`);
    }
  });

  it('enforces fail-safe UNKNOWN for all missing/insufficient evidence patterns', () => {
    const failSafeInputs = [
      null,
      undefined,
      '',
      42,
      {},
      { instructions: null },
      { instructions: [] },
      { instructions: [null, '', {}] },
      { wasmHints: { available: false } },
      {
        wasmHints: {
          available: false,
          callgraph: { role: 3, roleName: 'utility_hub' },
          jumpTableCount: 4,
          rmwHitCount: 3,
          tags: ['obfuscated', 'cff', 'mba'],
        },
      },
      { wasmHints: { available: true } },
      { wasmHints: { available: true, tags: [], constTableRefs: [] } },
      { xrefs: { inCount: 2 } }, // score 10 < 20 and !hasInstructions -> UNKNOWN
      { cfg: { blockCount: 10 } }, // score 10 < 20 and !hasInstructions -> UNKNOWN
    ];

    for (const input of failSafeInputs) {
      const res = assessPatchRisk(input);
      assertValidPatchRiskResult(res);
      assert.equal(res.level, PATCH_RISK_LEVEL.UNKNOWN, `expected UNKNOWN for ${JSON.stringify(input)}`);
      assert.equal(res.score, null);
      assert.equal(res.isFailSafe, true);
    }
  });

  it('rates safe instructions with no risk factors as LOW', () => {
    setLang('ja');
    const res = assessPatchRisk({
      instructions: [
        'stp x29, x30, [sp, #-16]!',
        'mov x29, sp',
        'add w0, w0, #1',
        'ldp x29, x30, [sp], #16',
        'ret',
      ],
    });
    assertValidPatchRiskResult(res);
    assert.equal(res.level, PATCH_RISK_LEVEL.LOW);
    assert.equal(res.score, 0);
    assert.equal(res.isFailSafe, false);
    assert.equal(res.glossaryKeys.includes('patch'), true);
  });

  it('prioritizes MEDIUM and HIGH risk even when instructions are omitted if strong evidence exists', () => {
    // callgraph.role === 3 (utility_hub) without instructions -> MEDIUM (score >= 20)
    const hubByNum = assessPatchRisk({
      wasmHints: { available: true, callgraph: { role: 3 } },
    });
    assertValidPatchRiskResult(hubByNum);
    assert.equal(hubByNum.level, PATCH_RISK_LEVEL.MEDIUM);
    assert.equal(hubByNum.isFailSafe, false);
    assert.equal(hubByNum.glossaryKeys.includes('xref'), true);

    // callgraph.roleName === 'utility_hub'
    const hubByName = assessPatchRisk({
      wasmHints: { available: true, callgraph: { roleName: 'utility_hub' } },
    });
    assertValidPatchRiskResult(hubByName);
    assert.equal(hubByName.level, PATCH_RISK_LEVEL.MEDIUM);
    assert.equal(hubByName.score, hubByNum.score);

    // Stack canary alone -> MEDIUM
    const canary = assessPatchRisk({ hasStackCanary: true });
    assertValidPatchRiskResult(canary);
    assert.equal(canary.level, PATCH_RISK_LEVEL.MEDIUM);
    assert.equal(canary.isFailSafe, false);
    assert.equal(canary.glossaryKeys.includes('stack_frame'), true);

    // Combined utility_hub + stack canary -> HIGH (>= 60)
    const combinedHigh = assessPatchRisk({
      hasStackCanary: true,
      wasmHints: { available: true, callgraph: { role: 3 } },
    });
    assertValidPatchRiskResult(combinedHigh);
    assert.equal(combinedHigh.level, PATCH_RISK_LEVEL.HIGH);
    assert.equal(combinedHigh.isFailSafe, false);
    assert.ok(combinedHigh.score >= 60);
  });

  it('clamps extreme combined risk scores to 0..100', () => {
    const extreme = assessPatchRisk({
      instructions: [
        { mn: 'paciasp' },
        { mn: 'autiasp' },
        { mn: 'svc' },
        { mn: 'blr' },
        { mn: 'ldaxr' },
      ],
      cfg: { blockCount: 40 },
      xrefs: { inCount: 50 },
      deobfOverlay: { hasOverlay: true },
      hasStackCanary: true,
      isSystemLibrary: true,
      wasmHints: {
        available: true,
        tags: ['obfuscated', 'cff', 'mba', 'crypto'],
        constTableRefs: [{ addr: '0x1000' }, { addr: '0x1020' }],
        callgraph: { role: 3, roleName: 'utility_hub' },
        rmwHitCount: 4,
        jumpTableCount: 3,
      },
    });
    assertValidPatchRiskResult(extreme);
    assert.equal(extreme.level, PATCH_RISK_LEVEL.HIGH);
    assert.equal(extreme.score, 100);
    assert.equal(extreme.isFailSafe, false);
  });

  it('handles LOW / MEDIUM / HIGH boundary transitions cleanly', () => {
    // LOW: hasInstructions + minor xref (score = 10 < 20)
    const low = assessPatchRisk({
      instructions: ['mov x0, #0', 'ret'],
      xrefs: ['0x1000', '0x2000'],
    });
    assertValidPatchRiskResult(low);
    assert.equal(low.level, PATCH_RISK_LEVEL.LOW);
    assert.equal(low.score, 10);

    // MEDIUM: hasInstructions + 5 xrefs (score = 20)
    const med = assessPatchRisk({
      instructions: ['mov x0, #0', 'ret'],
      xrefs: { inCount: 5 },
    });
    assertValidPatchRiskResult(med);
    assert.equal(med.level, PATCH_RISK_LEVEL.MEDIUM);
    assert.equal(med.score, 20);

    // HIGH: deobfOverlay (35) + isSystemLibrary (25) = 60
    const high = assessPatchRisk({
      instructions: ['mov x0, #0', 'ret'],
      deobfOverlay: { hasOverlay: true },
      isSystemLibrary: true,
    });
    assertValidPatchRiskResult(high);
    assert.equal(high.level, PATCH_RISK_LEVEL.HIGH);
    assert.equal(high.score, 60);
  });

  it('switches output language between ja and en via i18n', () => {
    const sampleEvidence = {
      instructions: ['paciasp', 'mov x0, #1', 'autiasp', 'ret'],
      hasStackCanary: true,
      wasmHints: { available: true, callgraph: { role: 3 } },
    };

    setLang('ja');
    const jaRes = assessPatchRisk(sampleEvidence);
    assertValidPatchRiskResult(jaRes);

    setLang('en');
    const enRes = assessPatchRisk(sampleEvidence);
    assertValidPatchRiskResult(enRes);

    assert.equal(jaRes.level, enRes.level);
    assert.equal(jaRes.score, enRes.score);
    assert.deepEqual(jaRes.glossaryKeys, enRes.glossaryKeys);

    // Japanese text contains CJK/Kana characters; English text does not
    assert.ok(/[\u3040-\u30ff\u4e00-\u9faf]/.test(jaRes.reasons.join(' ')), 'expected Japanese reasons');
    assert.equal(/[\u3040-\u30ff\u4e00-\u9faf]/.test(enRes.reasons.join(' ')), false, 'expected English reasons');
    assert.ok(/[\u3040-\u30ff\u4e00-\u9faf]/.test(jaRes.cautions.join(' ')), 'expected Japanese cautions');
    assert.equal(/[\u3040-\u30ff\u4e00-\u9faf]/.test(enRes.cautions.join(' ')), false, 'expected English cautions');

    // Also verify fail-safe messages switch language
    setLang('ja');
    const jaUnknown = assessPatchRisk({});
    setLang('en');
    const enUnknown = assessPatchRisk({});
    assert.ok(/[\u3040-\u30ff\u4e00-\u9faf]/.test(jaUnknown.reasons[0]));
    assert.equal(/[\u3040-\u30ff\u4e00-\u9faf]/.test(enUnknown.reasons[0]), false);
  });
});
