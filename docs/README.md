# Hex ドキュメント目次

本ディレクトリには、**Hex ユニバーサルバイナリ解析プラットフォーム**の現行仕様・アーキテクチャ・サポート真実性・開発ガードレール・運用ガイドを格納しています。すべてのドキュメントは 2026-11-28 時点の実装および機械可読契約に合わせて維持されます。

## ルートドキュメント

- [`../README.md`](../README.md) — プロジェクト概要・機能一覧・クイックスタート・テストコマンド
- [`../ABI.md`](../ABI.md) — 統合 C++20/WASM エンジン（`wasm/hex_engine.wasm`）C ABI 仕様
- [`../ROLLBACK.md`](../ROLLBACK.md) — WASM エンジン即時ロールバック・モード切替手順
- [`../PLAN.md`](../PLAN.md) — C++20/WASM 統合エンジン設計・運用方針
- [`../PROGRESS.md`](../PROGRESS.md) — 現在の開発進捗・到達ステータス
- [`../RESEARCH.md`](../RESEARCH.md) — Freestanding C++20/WASM 採用根拠と技術調査
- [`../AGENTS.md`](../AGENTS.md) / [`../CLAUDE.md`](../CLAUDE.md) / [`../GEMINI.md`](../GEMINI.md) — エージェント運用・低トークンテスト実行ガイド

## アーキテクチャ・能力真実性

- [`HEX_MASTER_ARCHITECTURE.md`](HEX_MASTER_ARCHITECTURE.md) — マスターアーキテクチャ仕様・不変条件・情報源優先順位
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) — アーキテクチャ / フォーマット / マネージド言語の能力サポートマトリクス（`js/platform/capability-maturity.js` の投影）
- [`HEX_COMPLETION_GOAL.md`](HEX_COMPLETION_GOAL.md) — 現在の品質基準・完成目標・検証要件
- [`universal-platform.md`](universal-platform.md) — ユニバーサルバイナリ解析プラットフォーム設計
- [`universal-binary-foundation.md`](universal-binary-foundation.md) — マルチフォーマットバイナリ基盤・ローダ設計
- [`machine-effects-prerequisites.md`](machine-effects-prerequisites.md) — Exact MachineEffects 前提契約

## 解析・デコンパイラ・検証仕様

- [`DECOMPILER_BUDGETS.md`](DECOMPILER_BUDGETS.md) — デコンパイラ実行バジェット仕様
- [`FUNCTION_TIMEOUT_SEMANTICS.md`](FUNCTION_TIMEOUT_SEMANTICS.md) — 関数タイムアウト仕様
- [`SCPA_CONDITIONAL_ANALYSIS.md`](SCPA_CONDITIONAL_ANALYSIS.md) — 条件付き解析（SCPA）仕様
- [`SCPA_CONDITIONAL_MODELS.md`](SCPA_CONDITIONAL_MODELS.md) — SCPA 条件モデル定義
- [`SCPA_FUNCTIONAL_ACCEPTANCE.md`](SCPA_FUNCTIONAL_ACCEPTANCE.md) — SCPA 機能受入基準
- [`symbolic-proof-optimizer-v8.md`](symbolic-proof-optimizer-v8.md) — シンボリック証明オプティマイザ仕様
- [`PUBLIC_COMPETITOR_BENCHMARK.md`](PUBLIC_COMPETITOR_BENCHMARK.md) — 公開ベンチマーク仕様

## 開発プロセス・互換性ガードレール・CI

- [`ENGINEERING_PROCESS_GUARDRAILS.md`](ENGINEERING_PROCESS_GUARDRAILS.md) — エンジニアリングプロセスガードレール（マージ阻害条件・完了チェックリスト）
- [`MIGRATION_GUARDRAILS.md`](MIGRATION_GUARDRAILS.md) — 公開境界・互換性・依存制約ガードレール
- [`ci/CIRCLECI_BOOTSTRAP.md`](ci/CIRCLECI_BOOTSTRAP.md) — CircleCI ブートストラップ手順

## AI・Userscript・認証・UI

- [`ai-architecture.md`](ai-architecture.md) — AI 統合アーキテクチャ
- [`ai-analyst-ux.md`](ai-analyst-ux.md) — AI アナリスト UX 設計
- [`ai-integration-contract.md`](ai-integration-contract.md) — AI 統合契約
- [`ai-quality-gate.md`](ai-quality-gate.md) — AI 品質ゲート
- [`chatgpt-userscript.md`](chatgpt-userscript.md) — ChatGPT Userscript 連携ガイド
- [`DISCORD_AUTH_LOCAL_SETUP.md`](DISCORD_AUTH_LOCAL_SETUP.md) — Discord 認証ローカルセットアップ
- [`DISCORD_AUTH_IMPLEMENTATION_VERIFICATION.md`](DISCORD_AUTH_IMPLEMENTATION_VERIFICATION.md) — Discord 認証実装検証
- [`ui-information-architecture.md`](ui-information-architecture.md) — UI 情報設計
- [`ui-audit.md`](ui-audit.md) — UI 監査ガイド

## リファレンス

- [`SOURCES.md`](SOURCES.md) — 一次技術ソース・外部リファレンス一覧
