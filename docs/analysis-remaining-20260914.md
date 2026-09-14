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

## Checkpoint 1: 解析入口の依存欠落

- `2f8d57bd2` をリモートへ保存済み。
- 開始時のC1/C2/C3受入は245件中241成功/4失敗。3ファイルは
  `blocks-base.js` が存在しない `arm64ReadsDestination` をimportして読込不能。
  残る1件はC1の `v2-frame-non-escaping` (`may` vs `no`)。未解消として保持する。
- X-02も旧120行は通るが、追加行列が同じimport欠落で読込不能。
- 根因: `d792b212` がmainのconsumerを採用した際、#3606のproducerが欠落。
  元commit `cd7db4f5ebfebcea0e8b0389760cc769d5626114` のhelperを復元。
  CFG/flags/faultやC4の変更は行っていない。
- 新規回帰は修正前import失敗、修正後6件成功。既存所有権検査も成功。
  実ファイルallowlistと未宣言差分を拒否する回帰を併せて更新。
- npm依存はlockfile通り導入済み（Playwright 1.63.0）。Chromium1243/WebKit2359を
  永続cacheへ取得済み。WebKit共有library不足の解消と実起動は進行中。
- `npm run check` はquiet wrapperで実行中。現時点では合格とはしない。

証拠: 永続evidence配下の `entrypoint-before.{json,log}`、
`entrypoint-after.{json,log}`、`c1-c2-c3.{json,log}`、`x02.{json,log}`。
修正後の実行はcommit前の作業ツリーであり、receiptのsourceHeadだけでexact-head証拠とはしない。
次はcommit後の重点検査、全体の最初の失敗、C1 aliasの正の受入を確認する。

## Checkpoint 2: 重点受入と環境

- source commit `1957bc55b33b0fcf79328bbf88d9e2675f6d0847` はpush済み。
- `focused-restored`: 266/266成功（C1再帰return、C3 ABI、C2 byte forwarding、
  追加X-02、入口依存、call-boundary）。log SHA256:
  `d68cafac2da457a0ee7fc3a2cce64db4a2e48478c4cd933da675a75de76ee18a`。
- 入口依存+既存ownershipは29/29成功。`call-boundary` 単独も成功。
- canonical userscript buildを2回実行し、一致。template SHA256:
  `bed1dd7bb132db1c14f910c858d15a595df54b5d042713ff71552e1eef0a8446`。
- Playwright 1.63.0の不足libraryを導入し、Linux x64上でChromium 153.0.8010.12と
  WebKit26.6の実起動・ページ読込に成功。物理iPad/Safariの証拠ではない。
- canonical `tests/phase9/browser/worker-runtime.mjs` は初回SATがtimeout、続くqueryが
  invalid-queryとなり失敗。起動成功をsolver受入成功に読み替えない。閾値は不変更。
- LLVMはUbuntu14.0.0のみで指定Ubuntu18.1.3は未導入。X02-H-02を成功にしない。
- CodeRabbit0.7.6は未認証。`auth login --agent` はenvironment_unsupported
  （localhost browser callbackが必要）。ユーザー側の `coderabbit auth login` が必要。
  独立レビューは未実施、承認なし。
- 全体checkはmachine-effects-contractを実行中。最終結果は
  永続evidenceの `check-first.json` に終了後atomic保存される。

### 残件の再開順

1. `check-first.json` の有無とログを確認。失敗を削除せず最初の原因を調べる。
2. C1の旧非escape正例と #4977 の両root証拠契約の衝突を解決する。
   片側non-escapeだけでexactを許可する変更・期待値をmayへ変える変更は未実施。
3. Worker初回SAT timeoutを原因分離し、同じ2秒予算・32/64-bit全分母で再検証。
4. 指定LLVM、独立レビュー認証、物理Apple/iPad/ordering/signing/runtime証拠を揃える。
5. 全canonical gates、exact-head CI、candidate tree、ユーザーC4との統合はそれから検証。

環境再開時は `PLAYWRIGHT_BROWSERS_PATH=/mnt/workspace/.dev-state/agent-work/cache/analysis-remaining-20260914/browsers`。
全体は引き続きIN PROGRESS。ユーザー担当の完了も、この分担の全完了も宣言していない。

## リモート提出と継続検証

- Draft PR: https://github.com/rhgrive3/hex-ida/pull/8888 （既存 #7036 のブランチ向け）。
- `76f7b6926d8edb009443f973789862ddec0b5008` をpush済み。
- このclean commitでcanonical buildを再実行し、tracked生成物の差分ゼロ。
  `generated-committed.json` / `.log` に記録。module-boundariesも同commitで成功。
- 全体check終了後、永続checkpointの `publish-check.py` がreceiptのログhash、
  branch/head、clean treeを照合してこの文書だけに結果を追記し、commit/pushする。
  並行変更があれば編集せず `automatic-publication.json` にblocked理由を保存する。
  push失敗でもcommitと全証拠は永続workspaceに残す。force-pushしない。
- 自動記録は診断の保存であり、review/merge/releaseの承認ではない。
