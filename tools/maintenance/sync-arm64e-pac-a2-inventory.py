import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / 'tests/machine-effects/a2-denominator-inventory.json'

probe = r'''
import { validateArm64ePacDenominator } from './tools/validation/machine-effects/arm64e-pac-denominator.mjs';
import { validateArm64eA64DelegationDenominator } from './tools/validation/machine-effects/arm64e-a64-delegation-denominator.mjs';
import { arm64ePointerAuthenticationMnemonics } from './js/targets/architecture/arm64e/effects.js';
console.log(JSON.stringify({
  pac: validateArm64ePacDenominator(),
  delegation: validateArm64eA64DelegationDenominator(),
  mnemonics: [...arm64ePointerAuthenticationMnemonics()],
}));
'''
result = subprocess.run(
    ['node', '--input-type=module', '-e', probe],
    cwd=ROOT,
    check=True,
    text=True,
    capture_output=True,
)
live = json.loads(result.stdout.strip().splitlines()[-1])
pac = live['pac']
delegation = live['delegation']
mnemonics = live['mnemonics']

if pac['encodingCaseCount'] != 45517:
    raise SystemExit(f"unexpected live PAC case count: {pac['encodingCaseCount']}")
if pac['encodingFamilyCount'] != 40 or pac['mnemonicCount'] != 40:
    raise SystemExit(f"unexpected live PAC family/mnemonic counts: {pac['encodingFamilyCount']}/{pac['mnemonicCount']}")
if delegation['pacEncodingCaseCount'] != pac['encodingCaseCount']:
    raise SystemExit('delegation PAC case count disagrees with PAC denominator')
if delegation['pacMnemonicCount'] != pac['mnemonicCount'] or delegation['pacDispatchOwnerCount'] != pac['mnemonicCount']:
    raise SystemExit('delegation PAC ownership count disagrees with production registry')
if set(mnemonics) != {'pacia','pacib','pacda','pacdb','paciza','pacizb','pacdza','pacdzb','paciasp','pacibsp','pacia1716','pacib1716','autia','autib','autda','autdb','autiza','autizb','autdza','autdzb','autiasp','autibsp','autia1716','autib1716','xpaci','xpacd','xpaclri','pacga','braa','brab','braaz','brabz','blraa','blrab','blraaz','blrabz','retaa','retab','eretaa','eretab'}:
    raise SystemExit('unexpected production PAC mnemonic set')

data = json.loads(INVENTORY.read_text())
arm64e = next((a for a in data.get('architectures', []) if a.get('id') == 'arm64e'), None)
if arm64e is None:
    raise SystemExit('arm64e inventory entry missing')
decoder = arm64e['decoder']
proof = decoder['delegation']
for field in [
    'pacEncodingCaseCount','pacMnemonicCount','knownBaselineEncodingCaseCount',
    'strictBaselineDisjointEncodingCaseCount','baselineFeatureAliasOverlapCount',
    'positiveDelegationSampleCount','pacDispatchOwnerCount','fallbackDisposition',
]:
    proof[field] = delegation[field]
pac_proof = decoder['pacDenominator']
for field in ['schemaVersion','denominatorId','profileId','encodingFamilyCount','encodingCaseCount','mnemonicCount','oracleIds']:
    if field in pac:
        pac_proof[field] = pac[field]
arm64e['pointerAuthenticationMnemonics'] = mnemonics

INVENTORY.write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps({
    'pacEncodingCaseCount': proof['pacEncodingCaseCount'],
    'pacMnemonicCount': proof['pacMnemonicCount'],
    'pacDispatchOwnerCount': proof['pacDispatchOwnerCount'],
    'encodingFamilyCount': pac_proof['encodingFamilyCount'],
    'encodingCaseCount': pac_proof['encodingCaseCount'],
    'mnemonicCount': pac_proof['mnemonicCount'],
}))
