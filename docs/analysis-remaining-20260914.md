# 解析改善・分担後の再開記録

状態: **IN PROGRESS**。全体完了・マージ・実機受入は未認定。

- ユーザー担当: C4全領域、PHI/CFG、flags/NZCV、fault/exception/unwind。
- この作業の担当: 上記以外の解析改善。既存実装の受入、C0/ME/C1/C2/C3/SYM/X/S2の残件。
- 基準: PR #7036、`d792b212ed85f1d01734cb190caf441ab23f091d`。
- 正本: `docs/解析ツール改善.md` と `docs/analysis-local-acceptance-audit.json`。
  mainにある歴史的finding ledgerだけで現況を判定しない。
- 保存ブランチ: `codex/analysis-remaining-20260914`。小さくcommit/pushし、force-pushしない。
- 作業先: `/mnt/workspace/.dev-state/agent-work/checkouts/analysis-remaining-20260914/integration`。
- 証拠/再開: 同じ永続rootの `evidence/analysis-remaining-20260914/` と
  `checkpoints/analysis-remaining-20260914/`。

## 担当境界

既存PRにはユーザー担当の実装も存在する。基準に含まれるその実装を維持し、
この作業の差分ではC4/PHI/CFG/flags/faultの意味論を編集しない。
ユーザー担当の不合格は全体ゲートから消さず、引き継ぐ。
生成物はcanonical builderでのみ再生成し、二回目一致を確認する。
main統合は既存PRの統合責任と競合させず、まずこの分担の差分と証拠を保存する。

## 現在の調査

1. 主要なC1/C2/C3/SYM/X実装は既存PRにある。再実装せず現候補で検証する。
2. 旧環境でLLVM18.1.3、Playwright、ネットワークinterface検査が阻害されていた。
   この環境はNode24.20.0 / Ubuntu22.04 / LLVM14。指定LLVMの代用とはしない。
   永続Playwright cacheにChromium headless shellがある。実起動はまだ未検証。
3. 物理Apple arm64e/iPad、hardware ordering oracle、署名・active runtimeの証拠は未取得。
4. 23 finding / 21 FRと全分母を保持する。局所テスト成功で全体完了へ昇格しない。

## 次の実行

- 依存を永続workspaceから解決し、既存canonical gateをquiet wrapperで実行する。
- 最初の失敗を環境/非C4製品/ユーザー担当へ分類する。
- 非C4の失敗を最小反例とともに修復し、重点→canonicalの順に再検証する。
- 各区切りでこの記録にcommit・コマンド・結果・残件を追記してpushする。
- exact-head CI、独立レビュー、candidate merge-tree、実機・release証拠が必要な箇所は
  古い合格や疑似fixtureで置き換えない。

再開前に `git status` とリモートheadを照合し、このブランチの未push変更を保存する。
全コマンドに永続 `TMPDIR/TMP/TEMP` を設定する。OS一時領域は使用しない。
