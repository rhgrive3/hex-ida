# Hex 完成目標と品質基準

本ドキュメントは、**Hex (`rhgrive3/hex-ida`)** の開発・統合・リリースにおいて維持すべき製品品質基準と完了条件を定義します。すべての変更は **原因特定 → 最小の製品修正 → focused regression → フルゲート検証 → マージ** の原則で完結させます。

## 1. 製品品質の必須要件

1. **解析の安定性と決定性**
   - 実バイナリ（Mach-O / ELF / PE / Fat / `MH_OBJECT` およびマネージド `wasm` / `dex` / `cil` / `jvm`）に対してクラッシュ 0・無言のスキップ 0 を維持する。
   - すべての解析・デコンパイル・スキャンはキャンセル可能かつバジェット境界内で動作し、境界超過時は明示的に fail-closed する。
2. **デコンパイラ出力と Clean View の品質**
   - Completeness と未知命令の明示を維持しつつ、Clean View（callee-saved 畳み込み、重複 `__asm` 集約、安全な不要スタックスピル除去）および ObjC / Swift 5 ARC パスにより可読性の高い擬似 C を提供する。
   - 未解決のシンボル名や型を捏造せず、不確定な事実には `partial` / `unknown` を明示する。
3. **C++ / iOS (ARM64e / ObjC / Swift 5) メタデータ投影**
   - RTTI / クラス / vtable / 仮想呼び出し / フィールドアクセスおよび ObjC / Swift 5 メタデータ・TIL・HEX-SIG 解決をバイナリ根拠のみで接続し、根拠のない事実生成を 0 に保つ。
4. **C++20/WASM エンジンの 0-diff パリティと即時ロールバック**
   - `wasm/hex_engine.wasm` は JS 実装との 0-diff パリティとネイティブ ASan/UBSan 0-UB を維持し、未対応経路は必ず `js/core/wasm-telemetry.js` に構造化理由コードを記録して JS へ安全にフォールバックする。
   - `HEX_ENGINE=js` / `globalThis.HEX_ENGINE = 'js'` による即時ロールバックを常時保証する（[`../ROLLBACK.md`](../ROLLBACK.md)）。
5. **Pinpoint / AI 統合の証拠規律**
   - Pinpoint スコアを確率として誤用せず、根拠付きの候補ランキングを維持する。
   - AI によるバイナリ変更・注釈操作は必ず承認ゲート（evidence-backed proposal → 承認トークン → `CapabilityExecutor`）を経由させ、根拠のない事実生成を禁止する。
6. **iOS / iPad Safari ファーストの UX**
   - GraphView i18n、Omnibox 厳密ジャンプ、キャンセル可能なデコンパイル、および Dev Supervisor の単一タブ同一オリジン iframe 構成を iPad Safari 制約下で壊さない。

## 2. 検証と完了判定

- すべての統合・リリース作業は [`ENGINEERING_PROCESS_GUARDRAILS.md`](ENGINEERING_PROCESS_GUARDRAILS.md) の `MUST` / `MUST NOT` および [完了チェックリスト](ENGINEERING_PROCESS_GUARDRAILS.md#10-phase-completion-checklist) を満たすこと。
- 正規フルゲートは単一の変更しないコマンドとして実行する：
  ```sh
  node scripts/run-quiet-command.mjs --label check -- npm run check
  ```
- 能力真実性および事前検証ゲート：
  ```sh
  NODE_OPTIONS=--experimental-global-webcrypto node --test \
    tests/phase6/foundation/capability-truth.test.mjs \
    tests/phase9/foundation/preflight.test.mjs
  ```
- 生成物（`wasm/hex_engine.wasm`, `js/core/hex-engine-wasm.js`, Userscript 生成物）を変更した場合は再ビルド後の差分が 0 であることを確認し、正確な commit SHA で CI を通過させてから完了とする。
