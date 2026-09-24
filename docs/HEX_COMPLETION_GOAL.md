# Hex 完成目標（2026-09-25 更新）

この文書は、2026-09-23 の[原依頼](https://github.com/rhgrive3/hex-ida/blob/8ebdc35b6bd4980beaaf3d731a929205ad6e55b8/reports/handoff-codex-20260924/ORIGINAL_REQUEST.md)を、現在の事実に合わせて更新する。目標は変わらない。重要問題を **原因特定 → 最小の製品修正 → focused regression → 再測定 → PR/merge → 最終 acceptance → freeze** まで進め、完成した `main` を作る。調査結果や修正ブランチだけでは完了としない。

## 現在の基準

- 2026-09-25 02:12 CST に確認したリモート `main`: `9ac43546d79f5e440096773ad3e30e3bf7cb5251`。以後の検証前には必ず再取得する。旧依頼の `18a7750ee54eff3fa265172106ce4f014199237d` と旧弱点測定の `09dfcb283f721b6598f34675a8a42480147d5752` は過去の基準であり、現在値ではない。
- 未完の living integration は draft PR [#9557](https://github.com/rhgrive3/hex-ida/pull/9557)。ローカル統合ヘッド `d3c129a24cbe96bc50f94a7c25fb4b0e3b9e1e5e` は `main` の `142372232` まで取り込み、生成物の再ビルド差分が 0。新しい `main` の `9ac43546d` はまだ未統合。リモート PR ヘッドも古い `a3ad54245b718f1d2f928da3312d76a3277e4c69` なので、ローカルの緑を PR の緑と扱わない。
- 旧依頼で唯一 open だった #9520 は CLOSED。#9625–#9634 の新規 Issue も `main` の #9635–#9639 で修正され、確認時の open Issue は 0。完了前に再確認し、critical/major と未説明の blocking failure を 0 にする。open fix PR も 0 にする。
- 正規 `npm run check` は現統合ヘッドでまだ成功していない。前の実行は環境を復旧した後、`independent-oracle-report.test.mjs` が SIGTERM で終了した。原因を未確定のまま成功扱いしない。

## 必須の製品結果

1. **安定性・OpenMW:** OpenMW と OpenTTD の ARM64 real-game job が最終ヘッドで成功し、`result.json` を生成する。旧統合ヘッド `aa4e29fe4` では各 2 回成功したが、最終版の証拠ではない。crash 0、既知の重大な lifecycle 欠陥 0。
2. **FAST 速度と timeout:** FAST を通常 default、Deep を明示指定に保つ。証明・digest・snapshot・GC・dataflow の反復処理と重い tail を一般則で改善し、前後の同一入力 equivalence regression を追加する。関数名特例は禁止。p50/p95/p99/tail を同じ条件の複数実行で比較し、説明のない速度悪化を残さない。`--function-timeout-ms` は実際の hard watchdog か、API/CLI/docs 上の明確な best-effort に決着させる。fastbudget レーンは 160/160 成功した一方、合計 elapsed +12.25%、最大 shard +8.37%、per-function p50 悪化を報告しており、速度 acceptance は未達・未判定。
3. **Decompiler・出力:** completeness と未知命令の明示を維持し、回避可能な goto、soft-float、局所変数・型・global・TU の構文失敗を最新 `main` で再測定して修正する。out2 レーンでは採取した 48 関数中 24 関数が構文解析可能になったが、8 ケースの TU は 0/8 のまま。未解決名を捏造せず `partial` として残す。
4. **C++ 投影:** RTTI/class → vtable → slot target → virtual/indirect call → receiver/class → field/member/type → pseudocode を、バイナリ根拠だけで結ぶ。OpenTTD と OpenMW の最終ヘッドで確認し、同一ビルドの debug/unstripped reference を持つ field/member holdout を最低 1 件通す。発明した事実 0。旧比較で vtable slot 数が OpenMW 6912→1913、OpenTTD 2305→919 に変わり、indirect-call marker も減った。定義変更と品質低下を同一アドレスで区別する。
5. **Pinpoint/Jev:** 426-field candidate recall、exact 品質、false strong を悪化させない。score を確率として扱わず、threshold だけで ranking 欠陥を直さない。Jev は既存候補間の preference のみ、≤255 の送信 shortlist、失敗時のローカル結果維持、fact minting 0。router 固定後の新規 free-form・binary-disjoint holdout で評価し、安全なら canonical、そうでなければ advisory と決めて終了する。G28 の事後結果や #9519 の HTTP 400 を精度証拠にしない。
6. **ベンチマークと最終 acceptance:** 最終統合ヘッドで 160 ケース・11,060 関数の FAST ベンチマーク、既知 tail、実ゲーム 2 回、独立 verifier、正規フル gate を実行する。分母、出力、品質、速度、toolchain、run ID、正確な SHA を記録する。旧ヘッドの成功を転用しない。

## 進め方と完了判定

- `docs/ENGINEERING_PROCESS_GUARDRAILS.md` の MUST/MUST NOT、所有ファイル、candidate merge tree、独立 verifier、生成物の二度目ビルド差分 0、移動する `main` の統合責任、active runtime/target device の要件を守る。各 component を候補木で証明し、統合後の checkpoint が閉じるまで次を採用しない。
- 重いテストは `rhgrive3/actions` の GitHub Actions に **push 済みの同一 40 桁 SHA** を渡し、独立した実行を runner 容量に合わせて並列化する。正規 gate は `node scripts/run-quiet-command.mjs --label check -- npm run check` を **一つの変更しないコマンド**として実行する。分割 suite や focused test は代替にならない。
- 最終的に、適用対象の[工程完了チェックリスト](ENGINEERING_PROCESS_GUARDRAILS.md#10-phase-completion-checklist)をすべて満たし、統合を expected-head protection で `main` に取り込み、`main` が正確な製品 SHA を含むことと必要な active runtime を確認する。最終結果を commit し、open critical/major Issue 0・open fix PR 0 で freeze する。

現在の実行状態と Claude Code の再開手順は [引き継ぎ](CLAUDE_CODE_HANDOFF_20260925.md)を参照する。
