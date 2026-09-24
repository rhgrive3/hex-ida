# Claude Code 引き継ぎ — Hex 完成作業（2026-09-25 02:12 CST）

最初に [現在の目標](HEX_COMPLETION_GOAL.md)、`AGENTS.md`、`CLAUDE.md`、`docs/ENGINEERING_PROCESS_GUARDRAILS.md` を読む。2026-09-23 の依頼要約は `git show 8ebdc35b6bd4980beaaf3d731a929205ad6e55b8:reports/handoff-codex-20260924/ORIGINAL_REQUEST.md` で確認できる。旧 Claude セッション `66f00133-4c7e-408c-9061-0c6bcce43b22` と、その `/mnt/workspace/.dev-state/agent-work/checkpoints/hex-completion-20260924/claude/STATUS.md` から継続している。古い `resume.json` は使わない。

## 今すぐ監視する OpenCode

**実行中の担当を止めず、二重起動しない。** `opencode --auto -m proxlane/gemini-3.8-flash-high run` で起動済み。コマンドは `TMPDIR/TMP/TEMP=/mnt/workspace/.dev-state/agent-work/scratch` で実行する。`/tmp`、`/var/tmp`、`/dev/shm` は使わない。

| 担当 | worktree | evidence / exit marker | 起動セッション | 状態（記録時） |
| --- | --- | --- | --- | --- |
| ARM64 `arm64b` | `/mnt/workspace/.dev-state/agent-work/checkouts/hex-completion-20260924/candidate-arm64-20260925` | `/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/opencode-arm64b/` 内 `runner.log`、`exit-code`、`RESULT.md` | 84963、監視 75994 | 実行中。fba/fbb の重複 BTI 修正を統合する担当 |

指示全文は `/mnt/workspace/.dev-state/agent-work/checkpoints/hex-completion-20260924/opencode-20260925/arm64b.md`。終了時は結果を検証し、他に稼働中の担当があれば process、exit marker、成果物を一括確認する。短間隔で pool/status を繰り返さない。監視スクリプトは同ディレクトリの `watch.mjs`。起動セッション ID が Claude 側で使えない場合も、exit marker と実際の process を確認してから handoff/relaunch する。OpenCode が 0 終了でも `RESULT.md` なしなら未完了。直前の `arm64` 担当は 0 終了したが読書だけで、修正はしていない。

## 完了済み・未統合の修正

- CFG tail-call: ブランチ `feat/cfg-tail-call-fallthrough` を push 済み。source `be1acbf740555292ae14d08022493a2a19a21631`、回帰テスト `26c3ec7a6fb2ee8217b10a975a6ecf16f69e6d66`。親も focused test を再実行して PASS、`cd5223e4d` との候補 merge tree は clean。現 `main` と統合後の gate は未実施。証拠 `.../evidence/hex-completion-20260924/opencode-cfg4/RESULT.md`。
- RMW `self->hp -=`: `candidate/hex-completion-20260925` の `65a450e1c06283f6945c1bb1c65b11ad3e029aec` に、`semantic-core.js` と `pipeline-core.js` の最小前提を統合。親も `tests/decompiler-semantic.mjs` と issue-6315 guard を PASS。元の `b306fd819` 単体は旧 WIP 前提を欠くので、そのまま採用しない。候補には先行する redp9 query 修正と生成物もある。未 push、現 `main` との再統合と広い gate が残る。証拠 `.../opencode-redp8b2/RESULT.md`。
- C 出力: `candidate/out2-20260925` の `b1143e8c271f950acbb304d272c6344898ab6bdc` に out2 の 3 コミットを統合。11/11、1/1、12/12 の focused tests が PASS。branch はローカル clean、まだ push していない。親の独立確認、現 `main` との候補 merge tree、広い gate が残る。証拠 `.../opencode-out2b/RESULT.md`。
- 旧 7 レーンはすべて `RESULT.md` を提出済み: out2、fastbudget、redp8b、fba、fbb、fbd、fbg。redp7 と redp9fix も以前に完了。各結果は `/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/<lane>/RESULT.md`。終了したレーンを無条件に再起動しない。
- fastbudget の検証済み source `a8fa8aec737aacd59ca3f198f69763ce5dcf7924` は 160/160 PASS だが elapsed 合計 +12.25%・最大 shard +8.37%、p50 悪化。ブランチ HEAD には後続 WIP がある。速度 acceptance と統合可否は未決。fbg は旧 known-tail 低下が手元 A/B で再現しなかったと報告。最終ヘッドで複数回比較する。
- fbd の旧統合ヘッド `aa4e29fe4` に対する OpenMW/OpenTTD 2 回は成功・aggregate 同一。ただし vtable slot 定義の変更と indirect-call marker 減少が残る。最終ヘッドで同一アドレス比較が必要。`.../fbd/PARENT_REVIEW.md` 参照。

## 統合と CI の現状

- リモート `main` は記録時 `9ac43546d79f5e440096773ad3e30e3bf7cb5251`。この引き継ぎと目標文書の PR merge でさらに進むため、作業再開時に fetch する。
- living integration worktree `/mnt/workspace/.dev-state/agent-work/checkouts/hex-completion-20260924/integration` は `d3c129a24cbe96bc50f94a7c25fb4b0e3b9e1e5e`。`main` の `142372232` まで clean merge し、生成 userscript を commit、再ビルド差分 0。`9ac43546d` の修正はまだ未統合。リモート PR [#9557](https://github.com/rhgrive3/hex-ida/pull/9557) は draft、リモートヘッドはまだ `a3ad54245b718f1d2f928da3312d76a3277e4c69`。実際の component acceptance は未完了。
- 正規フル check は未合格。前の `cd5223e4d` 実行ではホスト Git/WebKit の不足を直した後、`independent-oracle-report.test.mjs` が SIGTERM。ログは `/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/integration-20260925/check-cd5223e4d-restored.full.log`。ホスト Git 2.49 と WebKit 依存は復旧済み。重い再実行はローカルでせず Actions を使う。
- `rhgrive3/actions` の `hex-suite-runner.yml` は `commands` 空欄だと `npm run check` を分割する。**正規 gate の代わりにしない。** exact pushed SHA に対し `-f commands='["node scripts/run-quiet-command.mjs --label check -- npm run check"]'` を指定する。real-game は `hex-realgame-dispatch.yml` を同じ SHA で 2 回、FAST 160 ケースは `hex-ida-fresh-benchmark-dispatch.yml`。独立 verifier は focused C++ test 1 件では代用できない。実行案と訂正は `.../evidence/hex-completion-20260924/opencode-proof2/{PLAN.md,PARENT_REVIEW.md}`。新しい候補 SHA が未 push なので、これらの最終 run はまだ dispatch していない。
- PR #9614 は親監督規則、PR #9624 は重いテストの Actions 並列実行規則を `AGENTS.md` と `CLAUDE.md` に入れて MERGED。作業時はその現行規則を守る。
- 2026-09-25 02:12 CST 時点の open PR は #9557 のみ。open Issue は 0。#9520 と #9625–#9634 は CLOSED。作業再開時と freeze 前に再確認する。

## Claude Code が次にすること

1. 稼働中の ARM64 担当を監視し、結果・diff・focused test・push 先を検証する。停止したら残作業を記録して別の OpenCode 実行へ引き継ぐ。C 出力のローカル候補も親として検証する。既存 worktree を保全する。
2. 最新 `main` と候補ごとの actual inventory / ownership / merge tree を照合する。CFG、RMW、out2、ARM64、redp7、fastbudget を個別に評価し、広い gate と独立 verifier が通るまで living integration に採用しない。生成物の checkpoint transaction を閉じる。
3. 最終候補を push して同一 SHA の正規 check、独立 verifier、160 ケース FAST、known-tail、OpenMW/OpenTTD 2 回、C++ holdout を `rhgrive3/actions` で容量内に並列実行する。run ID、aggregate、同一アドレス品質、速度を確認する。
4. 再取得時に open の重要 Issue があれば解消し、旧依頼の未完条件を満たす。expected-head protection で PR を merge し、最新 `main` の製品・runtime identity を確認して最終報告 commit と freeze を行う。完成と呼ぶ条件は [目標](HEX_COMPLETION_GOAL.md)と工程 guardrails に従う。

作業用ファイルはすべて `/mnt/workspace/.dev-state/agent-work/` 以下に保持する。既存の evidence/checkpoint を消さず、秘密を remote evidence に含めない。
