# ARM64 WASM デコンパイラ 全面レビュー（2026-11-28）

対象: `main` の `4bcb45b14f9617cf2bc74c9dcf3fe711f14cd4a1`（作業ツリーはクリーン）。
比較の相手: CodeFuse-DeBench で公開されている IDA Pro 9.1 / Hex-Rays の出力（160 ケース）。

## 1. 結論

- **速さ、カバー率、コンパイルできる C の出力は、もう IDA に勝っています。**
- **意味の正しさには P0 のバグが 4 つあります。** どのバグも `PASS` のまま出ます。そのため、今のゲートではバグを見つけられません。
- **読みやすさは、IDA に大きく負けています。** 行数は 4.3 倍、キャストは 10 倍です。呼び出し先の名前もなくなっています。

「IDA 超え」と言うには、次の順で進めるのがよいです。

1. completeness（出力が完全かどうかの判定）を正しくする。
2. P0 のバグを直す。
3. 意味が同じかを調べるテストを CI のゲートにする。
4. 名前と引数を解決する。
5. 読みやすくする（IR に乗せる）。

## 2. 測ったこと

| 測ったこと | 方法 |
|---|---|
| ベンチ（全 160 ケース、11060 関数） | `node tools/validation/public-benchmark/run.mjs --output <dir> --timeout-ms 300000` を HEAD で実行。既定の WASM の道 |
| 意味の比較（3277 関数） | 新しいツール `ida-differential.py`（このフォルダ）。IDA の出力と Hex の出力を両方 gcc でコンパイルし、同じ 18 個の入力で動かして結果を比べる |
| JS の道との比較（1 ケース） | 同じコマンドを `HEX_ENGINE=js` で実行 |
| コードを読む | C++ の emitter、pass の選び方、JS 側の後処理、completeness の流れ |

注意: `reports/public-benchmark-parallel/summary.json` は古い結果です（SHA `56a6576`、WASM の前）。今の状態を表していません。

## 3. 数字（HEAD、IDA 9.1 との比較）

| 項目 | IDA 9.1 | Hex WASM | 判定 |
|---|---|---|---|
| 関数のカバー率 | 99.1% | **99.8%** | 勝ち |
| 状態が PASS の関数 | – | 11060 / 11060 | ※ 4.4 を見てください |
| goto の数 | 3002 | **50** | 勝ち |
| 行数（空行を除く） | 157,815 | 675,504（4.3 倍） | 負け |
| キャストの数 | 23,010 | 233,442（10 倍） | 負け |
| `printf(` の呼び出し | 3271 | **0** | 負け |
| 速さ | 測っていない | 2 ケースで 3.2 秒（JS の道は 1 ケースで 79 秒） | JS の約 50 倍速い |

意味の比較（`differential-results.json`）:

| 結果 | 数 |
|---|---|
| 両方コンパイルできて、同じ答え | 3217 |
| 違う答え | 60（このうち、本当の Hex のバグは 46） |
| 片方だけ止まる・落ちる（判定できない） | 70 |
| 調べられない（IDA の出力がコンパイルできない 1437、ほかの関数の呼び出しがあってリンクできない 1008、Hex の出力がコンパイルできない 2） | 2447 |

違う答えの 60 件の内訳:
- **本当のバグ（46 件）:** ジャンプテーブルと間接分岐で 36 件（`state_machine`、`large_jump_table`、`fsm_func_table`、`loop_break`、`computed_goto`、`switch_*`、`enum_switch`）。末尾呼び出しが消える `call_printf` で 10 件。
- **ツールの誤検出（10 件）:** `op_shl` と `op_shr`。下位 32 ビットは同じです。Hex は `int` を返します。ツールは IDA の型（`__int64`）に合わせて 64 ビットで比べたので、上位ビットのゴミで違って見えました。
- **判定できない（4 件）:** `call_struct_byval` と `call_ret_large_struct`。IDA の値（32742 など）もゴミの値に見えます。

## 4. P0: 意味が変わるバグ

### 4.1 末尾呼び出しで終わる関数を、空の関数にする

- 場所: `cpp/src/decompiler/passes/arm64_global_thunk_emit.cpp:272-312`（Pattern 2）
- 内容: 引数を入れて外部へ `b` で飛ぶだけの関数を、`void f(void) {}` として出します。呼び出しが丸ごと消えます。
- 例: `call_printf`（`6/6_clang_O2_g`、0x1954）。本当は `return printf("Value: %d, Name: %s\n", 42, "Test");` です。
  ```
  adrp x0,…; adrp x2,…; add x0,…; add x2,…; mov w1,#42; b printf@plt
  ```
- 数: **140 関数**。IDA ではどれも中身があります。`call_printf`、`call_extern_func`、`call_varargs_param`、`call_fread_fwrite`、`call_mutex_lock`、C++ のデストラクタ `D0Ev` など。
- 直し方: Pattern 2 を消します。general emitter の `b` の外部ターゲット処理（`arm64_general_emit.cpp:1229-1259`）に任せます。そこには `return sub_X(...)` の道がもうあります。

### 4.2 `br xN`（ジャンプテーブル、間接の末尾呼び出し）を捨てて、次の行へ進む

- 場所: `cpp/src/decompiler/passes/arm64_general_emit.cpp:1335-1346`
- 内容: `(void)xN; /* indirect branch */` と出します。C ではそのまま次の文へ進みます。`switch` は、どの case も同じ 1 か所に流れます。
- もう 1 つの問題: ジャンプテーブルの表は `.rodata` にあります。でも出力では `static … __hex_global_…_buf[512] = {0}` という 0 で埋めた配列から読みます。
- 数: **998 関数、1010 か所**。意味の比較では 36 件で違う答えになりました。
- 例: `switch_small`（`1/1_clang_O0_g`）。入力 1、2、3 で IDA は 5、50、2 を返します。Hex はどれも 15 を返します。
- 直し方:
  1. `cpp/src/analysis/jumptable_scanner.cpp` はもうあります。emitter から使って `switch` を出します。
  2. 解決できない場合は `__asm("br xN")` を残し、completeness を `partial` にします。
  3. 外部への間接の末尾呼び出しは `return ((fn_t)xN)(x0, …, x7);` にします。

### 4.3 `blr xN`（関数ポインタの呼び出し）で、呼び先と引数を捨てる

- 場所: `cpp/src/decompiler/passes/arm64_general_emit.cpp:1314-1333`
- 内容: `x0 = unknown_call(x0);` と出します。`xN`（呼び先）と `x1`〜`x7` がなくなります。
- 数: **224 関数**。
- 直し方: `x0 = ((uint64 (*)(uint64, …))xN)(x0, …, x7);` を出します。引数の数は、呼び出しの前に定義されたレジスタから決めます。

### 4.4 WASM の道では、completeness がいつも `complete` になる

- 場所: `js/decompile.js:186-199` は completeness を返しません。`js/analysis/query/app-adapter.js:753` の `completenessOf(value, 'complete')` は、値がないときに `complete` を選びます。
- 結果: 上の 3 つのバグがあっても、11060 / 11060 が `PASS` です。ゲートでは何も見えません。
- 直し方: emitter が「失ったもの」のフラグを返すようにします。例: `unresolved-indirect-branch`、`unknown-call-arguments`、`dropped-tail-call`。フラグがあれば `partial` にします。**最初にこれをやってください。** ほかのバグを数えられるようになります。

## 5. P1: 読みやすさと名前

### 5.1 呼び出し先の名前がなくなる

- `x0 = sub_N(/* arguments unknown */);` が **21,294 行**あります。
- 自分の関数の名前も出ません。例: `main` の中の `sub_E0C()` は、本当は `test_control_flow_l1()` です。バイナリにシンボルがあり、Hex の関数一覧には名前が出ています。
- 原因: `js/core/hex-engine-bridge.js:801` の `postprocessWasmGeneralC` は `symbolFor` を受け取ります。でも名前を付けるのは `WASM_GENERAL_LIBC_SPECS`（`:560`、libc の約 70 個）に入っている関数だけです。`printf`、`puts`、`fprintf`、自分の関数、C++ ランタイム、`objc_msgSend` は対象外です。
- 直し方: emitter に呼び先のシンボル表を渡します。`sub_N` ではなく、名前で出します。引数の数は次の順で決めます。
  1. 分かっているプロトタイプ
  2. 呼び先の関数が入口で読むレジスタ
  3. 呼び出しの前に定義されたレジスタ
  
  `printf` のような可変長引数の関数は、書式文字列から引数の数を決めます。

### 5.2 引数のない呼び出しになる

- **3214 関数**に `/* arguments unknown */` があります。C の上では、引数なしで呼んでいます。そのため、出力をコンパイルして動かすと意味が変わります。5.1 と同じ方法で直します。

### 5.3 出力が「レジスタをそのまま C にした形」

- `__hex_stack_frame`（スタックを 4096 バイト以上の配列にまねる）を使う関数: **5138**
- `__hex_nzcv`（フラグを毎回計算する）を使う関数: **1168**
- 例: `single_if` は IDA では 8 行、Hex では 23 行です。
- 原因:
  - `subs w8, w8, #0` のように結果も使う `SUBS` は、フラグをまとめる処理（`try_decode_fusable_cmp`、`:485`）の対象外です。
  - スタックの場所が変数になりません。
  - レジスタのコピーが消えません。
- 小さく直せること: 結果も使う `SUBS`/`ADDS` も比較としてまとめる。`sp + 定数` の場所を局所変数にする。

## 6. P2: 作りの問題

1. **CFG と IR を使っていない。** ARM64 の general emitter は 1 ファイル 9299 行です。`process_insn` だけで約 4200 行あります（`:1147-5348`）。`structurize_c_body`（`:5843`）は、自分が出した C の**テキスト**を読み直して構造を作ります。C++ には `cfg_engine`、`loop_engine`、`region_decomp`、`stack_web`、`ir_optimizer` があります。でも ARM64 の emitter はどれも使っていません。
2. **使われていないコード。** `hex_region_extract`、`hex_stack_web_split`、`hex_typed_emit_format` は WASM から export されています。でも JS から呼ぶところがありません（`scripts/build-wasm.mjs:99-104` でビルドはしています）。
3. **形を決め打ちする pass。** `engine_runtime.cpp:67-81` の pass は、語数の範囲で選ばれます（例: `frame_branch_bl` はちょうど 20 語だけ）。また、JS と同じ出力にするための特例があります（`arm64_general_emit.cpp:8508`）。4.1 のバグもこの種類です。決め打ちの pass は、general emitter にまとめるのが安全です。
4. **テキストを正規表現で書き換える後処理。** `postprocessWasmGeneralC` には正規表現の処理が 46 個あります。ELF しか読みません（`hex-engine-bridge.js:639`）。主な対象の iOS Mach-O では、この後処理が効きません。
5. **ベンチと本当の対象がずれている。** CodeFuse は Linux ELF の小さいプログラムです。README の主な対象は iOS Mach-O（`objc_msgSend`、Swift）です。Mach-O のベンチが必要です。
6. **ベンチの指標が足りない。** `semantic` と `recompilability` は `UNMEASURED` です。読みやすさ（行数比、キャスト比）が悪くなっても止まりません。

## 7. 良い点（残すもの）

- 速さ: WASM は JS の約 50 倍速いです。
- カバー率は 99.8% で、IDA の 99.1% より高いです。
- 出力はそのまま C としてコンパイルできます。調べた関数では 2 件以外すべてコンパイルできました。
- 調べられた関数の 98.2% で、IDA と同じ答えになりました。
- goto は 50 個です。IDA は 3002 個です。
- ARM の割り算の規則（0 で割ると 0）を正しく扱っています。

## 8. 改善の計画（この順で）

| # | やること | 効果 | 大きさ |
|---|---|---|---|
| 1 | 4.4: emitter から失ったもののフラグを返し、`partial` にする | 4.1〜4.3 と 5.2 が数字で見える | 小 |
| 2 | 4.1: Pattern 2 を消す | 140 関数が直る | 小 |
| 3 | 4.2: `jumptable_scanner` から `switch` を出す。できない場合は `partial` にする | 998 関数、36 件の不一致 | 中 |
| 4 | 4.3: `blr` で呼び先と引数を出す | 224 関数 | 小 |
| 5 | `ida-differential.py` を CI のゲートにする。「違う答え」が 0 件でなければ失敗にする（今の 46 件を基準にする） | 意味が悪くなるのを止める | 小 |
| 6 | 5.1 / 5.2: 名前と引数の数を解決する | 21,294 行、3214 関数 | 中 |
| 7 | 5.3: `SUBS` のフラグをまとめる。スタックの場所を局所変数にする | 行数とキャストが大きく減る | 中 |
| 8 | 6.1: 命令 → IR（SSA）→ 最適化 → CFG で構造化 → 出力、の形に移す。今の emitter は正しさの基準として残し、7 の差分テストで両方を比べる | IDA なみの読みやすさ | 大 |
| 9 | Mach-O（iOS）のベンチを追加する | 本当の対象で測れる | 中 |

## 9. 同じ結果を出す方法

```bash
# 1) ベンチ（WASM、既定の道）
node scripts/run-quiet-command.mjs --label pb -- \
  node tools/validation/public-benchmark/run.mjs --output /tmp/pb --timeout-ms 300000

# 2) 意味の比較（gcc が必要。最後の引数は case の絞り込み。省略すると全部）
python3 -I reports/reviews/arm64-wasm-20261128/ida-differential.py /tmp/pb /tmp/diff.json 1/1_clang_O0_g

# 3) JS の道との比較
HEX_ENGINE=js node tools/validation/public-benchmark/run.mjs --output /tmp/pbjs --limit 1
```

## 10. この測り方の限界

- 意味の比較で調べるのは、引数が 0〜4 個の整数で、戻り値も整数の関数だけです。引数ごとに 18 個の入力を使います。
- 5794 個の候補のうち、調べられたのは 3277 個です。IDA の出力の多くはそのままコンパイルできません。ほかの関数を呼ぶ関数は、リンクできないので調べていません。
- 「片方だけ止まる・落ちる」の 70 件は判定していません。主に深い再帰と大きなループです。Hex のスタックをまねる配列は 1 回の呼び出しで 4KB あるので、IDA の出力より先に落ちることがあります。
- IDA の出力も正しいとは限りません。IDA と答えが違った場合は、手で確かめてから「本当のバグ」に入れました。
- 全体のベンチは、Actions ではなく、このコンテナで 1 回だけ実行しました。
