import json
from pathlib import Path

doc = Path('docs/analysis-x02-acceptance.md')
text = doc.read_text()
marker = '## 2026-09-17 real Apple evidence reconciliation'
if marker not in text:
    raise SystemExit('x02 reconciliation marker missing')
prefix = text.split(marker, 1)[0]
section = '''## 2026-09-17 real Apple evidence reconciliation

The frozen 120-row denominator and historical 108/6/4/2 classification remain unchanged. Current acceptance is bound to repository-tracked evidence snapshots and their pinned hosted-Apple provenance; synthetic fixtures are not promoted to Apple runtime authority.

X02-A-08 is current `pass`. `tests/scpa/fixtures/x02-a08-versioned-apple-corpus-20260917.json` pins GitHub Actions run `35124584494` at head `2734f0faa85c15fbda44dd264496b4d7ae136fff`. Three Apple Silicon points span macOS 14.8.9 / 15.7.9 / 26.6.2, Darwin 23.6.0 / 24.6.0 / 25.6.0, Xcode 15.4 / 16.4 / 26.6, Apple clang 15 / 17 / 21, and three distinct compiler-produced Mach-O object/executable identities from one pinned source. Every produced executable ran successfully on its captured OS.

X02-B-06 is current `pass`. `tests/scpa/fixtures/x02-b06-runtime-dyld-evidence-20260916.json` pins GitHub Actions run `35124890143` at head `6a9277931c423a7a3cc1a7e0749c3dae313222ed`, artifact `10459365113` with digest `sha256:60b5053acac0ae56ffc645165759fdadfab476c5795d7431eb8851dc629b4713`. The real `dyld_shared_cache_arm64e` UUID `0517ae4831dc30868d85545fef4d70b7` matches the observed process shared-cache UUID; the OS-derived runtime slide is `0x180d8000`; 43 cache images agree on that slide; and the production v5 decoder reproduces all 6,077 bounded sampled rebases at derived runtime addresses inside the observed runtime shared-cache range.

X02-G-09 remains current `pass`: `/usr/bin/true` is SHA-256 pinned as `501c66a6d1850f8cece66b1c33991969b66f29f003ba91675077672acb15ba5f`, is a universal Mach-O containing arm64e, and passed strict trusted `codesign` validation with an Apple trust chain ending in `Apple Root CA`. X02-F-48 also remains current `pass` from the pinned compiler-produced arm64e/PAC producer evidence.

Current finite classification when the exact pinned LLVM 18.1.3 oracle is unavailable is **118 pass / 0 product-gap / 0 evidence-gap / 2 environment-excluded**. If X02-H-02 independently reparses with the exact pinned LLVM executable/version/digest/format/architecture checks, the conditional classification is **119 / 0 / 0 / 1**.

There are no remaining current evidence-gap rows. The two environment exclusions are X02-F-47 (explicit arm64e runtime authentication; the arm64 probe succeeds but the explicit arm64e probe terminates with `SIGSEGV`) and X02-H-02 when the exact pinned LLVM 18.1.3 oracle is unavailable. Neither exclusion is promoted to a pass.

Whole-roadmap state remains `CHECKPOINT-LOCKED`, `fullRoadmapComplete:false`, and `transformAuthorization:false`; closing the finite X-02 evidence gaps does not by itself satisfy the separate whole-roadmap, device, release, deployment, or protected-merge gates.
'''
doc.write_text(prefix + section)

audit_path = Path('docs/analysis-local-acceptance-audit.json')
audit = json.loads(audit_path.read_text())
finding = next((x for x in audit.get('findings', []) if x.get('id') == 'HEX-X-02'), None)
if finding is None:
    raise SystemExit('HEX-X-02 finding missing')
finding['assessment'] = ('元120行と既存機能case/manifestを保持。current finite overlayはX02-F-48、X02-G-09、'
    'X02-A-08の3点versioned Apple provenance corpus、X02-B-06のreal dyld cache/runtime load-map/OS-derived slideをcurrent passとして、'
    'pinned LLVM 18.1.3 oracleが利用できない通常環境で118 pass/0 product-gap/0 evidence-gap/2 environment-excluded。'
    'X02-H-02 exact independent reparse成功環境のみ119/0/0/1。current evidence-gapは0。'
    'X02-F-47はarm64 PAC実行成功を得たがexplicit arm64e probeはSIGSEGVのためruntime authentication成功を未証明。'
    'X02-H-02はexact pinned LLVM oracle不在時のみenvironment-excluded。全X-02・release受入は未完了。')

found_reconciliation = False

def walk(value):
    global found_reconciliation
    if isinstance(value, dict):
        if value.get('currentAssessment') and isinstance(value['currentAssessment'], str) and '116/0/2/2' in value['currentAssessment']:
            value['currentAssessment'] = ('元120行をcanonical統合し製品不足6行を修正済み。X02-F-48、X02-G-09、X02-A-08、X02-B-06をcurrent passへ進め、'
                '通常current分類は118/0/0/2。exact pinned LLVM 18.1.3でX02-H-02独立reparse成功時のみ119/0/0/1。'
                'current evidence-gapは0で、残るenvironment-excludedはexplicit arm64e PAC runtime authenticationと、exact LLVM oracle不在時のX02-H-02。')
        if 'x02AcceptanceReconciliation20260917' in value:
            found_reconciliation = True
            r = value['x02AcceptanceReconciliation20260917']
            r['currentWithoutPinnedLlvmOracle'] = {'pass':118,'product-gap':0,'evidence-gap':0,'environment-excluded':2}
            r['conditionalWithPinnedLlvmOracle'] = {
                'pass':119,'product-gap':0,'evidence-gap':0,'environment-excluded':1,
                'condition':'X02-H-02 exact independent reparse succeeds with pinned LLVM 18.1.3 executable digest/version/format/architecture checks'
            }
            r['currentPassAdded'] = 'X02-G-09 trusted Apple signing validation; X02-A-08 versioned Apple provenance corpus; X02-B-06 observed runtime dyld slide/rebase evidence'
            r['a08VersionedAppleCorpus'] = {
                'snapshot':'tests/scpa/fixtures/x02-a08-versioned-apple-corpus-20260917.json',
                'workflowRunId':35124584494,
                'headSha':'2734f0faa85c15fbda44dd264496b4d7ae136fff',
                'pointCount':3,
                'runners':['macos-14','macos-15','macos-26']
            }
            r['b06RuntimeDyldEvidence'] = {
                'snapshot':'tests/scpa/fixtures/x02-b06-runtime-dyld-evidence-20260916.json',
                'workflowRunId':35124890143,
                'headSha':'6a9277931c423a7a3cc1a7e0749c3dae313222ed',
                'artifactId':10459365113,
                'artifactDigest':'sha256:60b5053acac0ae56ffc645165759fdadfab476c5795d7431eb8851dc629b4713',
                'cacheUuid':'0517ae4831dc30868d85545fef4d70b7',
                'runtimeSlide':'0x180d8000',
                'sampledRebaseCount':6077
            }
            r['remainingEvidenceGaps'] = []
        for v in value.values():
            walk(v)
    elif isinstance(value, list):
        for v in value:
            walk(v)

walk(audit)
if not found_reconciliation:
    raise SystemExit('x02AcceptanceReconciliation20260917 missing')
audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
