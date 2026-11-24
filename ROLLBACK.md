# C++/WASM Engine Instant Rollback Runbook

`hex` の C++/WASM 統合エンジン（`wasm/hex-engine-unified.wasm` / `js/core/hex-engine-bridge.js`）は、コード変更や再ビルドなしで **フラグ 1 つで即座に JS 版へロールバック** できる設計になっています。

## エンジン選択の優先順位

`js/core/hex-engine-bridge.js` の `resolveEngineMode(opts)` は以下の優先順位でモード（`'wasm'` / `'js'` / `'auto'`、既定値 `'auto'`）を決定します。

1. **関数オプション**: `opts._engine`（最優先）
2. **グローバル変数**: `globalThis.HEX_ENGINE`
3. **環境変数**: `process.env.HEX_ENGINE`（Node.js 環境）
4. **デフォルト**: `'auto'`（対応関数は WASM、非対応命令・未対応アーキテクチャは自動 JS フォールバック）

---

## 1. 即時ロールバック手順（3 通り）

### 方法 A: 環境変数 `HEX_ENGINE=js`（Node.js CLI・テスト・CI）

プロセス全体を一括で JS 版へ切り替えます。

```bash
HEX_ENGINE=js node --test tests/performance/e2e-decompile-differential.test.mjs
HEX_ENGINE=js node scripts/benchmark-final-e2e.mjs
```

### 方法 B: グローバル変数 `globalThis.HEX_ENGINE = 'js'`（ブラウザ・Userscript・Worker・Node.js ランタイム）

再起動せずに実行中セッション全体を即座に JS 版へ切り替えます。

```js
globalThis.HEX_ENGINE = 'js';
```

元に戻す場合：

```js
globalThis.HEX_ENGINE = 'auto'; // または delete globalThis.HEX_ENGINE
```

### 方法 C: 関数オプション `{ _engine: 'js' }`（呼び出し単位のピンポイント切替）

特定の呼び出しのみ JS 版へ強制ロールバックします（`globalThis.HEX_ENGINE` や `process.env.HEX_ENGINE` より優先されます）。

```js
import { decompile } from './js/decompile.js';
import { openBinary } from './js/binary/index.js';
import { analyzeGraph } from './js/controlflow.js';

const img = openBinary(bytes, { strings: true, _engine: 'js' });
const result = decompile(model, { addr, name, rowOfAddress, _engine: 'js' });
const cfg = analyzeGraph(succs, entry, null, { _forceJs: true, _engine: 'js' });
```

---

## 2. テレメトリによるロールバック確認コマンド

`js/core/wasm-telemetry.js` の `getFallbackCount('FLAG_JS')` と `getWasmCallCounts()` で、WASM デコンパイル経路（`engine_runtime` / `resident_ir` / `ir_optimizer` / `c_emitter`）が 0 回となり、`FLAG_JS` によるフォールバックが記録されたことを検証できます。

### ワンライナー確認コマンド（Node.js）

```bash
HEX_ENGINE=js node --input-type=module -e "
import { buildSampleBinary } from './js/sample.js';
import { openBinary } from './js/binary/index.js';
import { buildSemanticModel } from './js/blocks.js';
import { decompile } from './js/decompile.js';
import { getFallbackCount, getWasmCallCounts, resetAllTelemetry } from './js/core/wasm-telemetry.js';

resetAllTelemetry();
const img = openBinary(buildSampleBinary(), { strings: true });
const insns = [
  { row: 0, address: 0x1000n, size: 4, mn: 'add', ops: 'x0, x0, x1', word: 0x8b010000 },
  { row: 1, address: 0x1004n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
];
const model = buildSemanticModel(insns, { startRow: 0, endRow: 1, rowOfAddress: () => null, symbolFor: () => null, name: '_add' });
decompile(model, { addr: 0x1000n, name: '_add', beginner: false });
console.log({
  FLAG_JS: getFallbackCount('FLAG_JS'),
  wasmCalls: getWasmCallCounts(),
});
"
```

**正常ロールバック時の期待出力**:
- `FLAG_JS >= 1`
- `wasmCalls.engine_runtime` / `resident_ir` / `ir_optimizer` / `c_emitter` がすべて未計上（`undefined` / `0`）

---

## 3. Userscript / ブラウザ（iPad Safari 含む）での適用手順

### DevTools コンソールから即時適用（再読み込み不要）
1. 対象ページの DevTools（または iPad Safari Web Inspector）を開く。
2. コンソールで以下を実行する：
   ```js
   globalThis.HEX_ENGINE = 'js';
   ```
3. 以降に実行される逆コンパイルはすべて JS エンジンへフォールバックされます。

### Userscript 起動時から常時 JS モードに固定する場合
1. Tampermonkey / Userscripts（iOS/iPadOS Safari 拡張）で `hex.user.js` の編集画面を開く。
2. スクリプト先頭（メタデータブロック `// ==/UserScript==` 直後、モジュール初期化前）に 1 行追記して保存する：
   ```js
   globalThis.HEX_ENGINE = 'js';
   ```
3. ページを再読み込みする。Web Worker 内で実行している場合は、Worker 側ブートストラップ先頭でも同様に `self.HEX_ENGINE = 'js';`（`self === globalThis`）を設定してください。

### 復旧（WASM モード再有効化）
- 追記した `globalThis.HEX_ENGINE = 'js';` を削除（または `'auto'` に変更）してページを再読み込みするだけで、元の自動 WASM ルーティングへ復帰します。
