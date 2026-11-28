/**
 * 24-term bilingual beginner glossary translator for v6 auto-analysis & beginner UX.
 * Pure data module (no HTML generation, no DOM access, INV-005 compliant).
 */

import { pick } from '../../i18n.js';
import {
  GLOSSARY_KEYS,
  GLOSSARY_KEY_SET,
  EXTENDED_GLOSSARY_KEYS,
  EXTENDED_GLOSSARY_KEY_SET,
  ALL_GLOSSARY_KEYS,
  ALL_GLOSSARY_KEY_SET,
} from '../../analysis/common/v6-auto-contracts.js';

export {
  GLOSSARY_KEYS,
  GLOSSARY_KEY_SET,
  EXTENDED_GLOSSARY_KEYS,
  EXTENDED_GLOSSARY_KEY_SET,
  ALL_GLOSSARY_KEYS,
  ALL_GLOSSARY_KEY_SET,
};

const DEFAULT_MAX_INPUT_LENGTH = 8192;
const ASCII_WORD_START_RE = /^[A-Za-z0-9_]/;
const ASCII_WORD_END_RE = /[A-Za-z0-9_]$/;

/**
 * Bilingual definitions for all 24 canonical glossary keys.
 * Each entry is resolved via pick(ja, en) at call time so language switches
 * take effect immediately.
 */
const GLOSSARY_DEFINITIONS = Object.freeze({
  cff: Object.freeze({
    term: ['制御フロー平坦化 (CFF)', 'Control Flow Flattening (CFF)'],
    shortLabel: ['処理の順番をわざと隠す難読化', 'Obfuscation that hides code order'],
    explanation: [
      '本来の「上から下へ流れる処理」を大きな switch 文のような分岐にバラバラに詰め込み、コードを読みにくくする難読化手法です。',
      'An obfuscation technique that breaks normal sequential code into a giant state-machine switch loop so the real execution order is hard to follow.',
    ],
    tip: [
      '自動解除（デオブファスケーション）が効いている場合、復元後のフローを優先して読むと本来の手順が見えます。',
      'When auto-deobfuscation recovers the original edges, read the recovered flow instead of tracing the dispatcher loop by hand.',
    ],
  }),

  mba: Object.freeze({
    term: ['混合ブール算術 (MBA)', 'Mixed Boolean-Arithmetic (MBA)'],
    shortLabel: ['単純な計算を複雑な式に化けさせる手法', 'Obfuscation turning simple math into complex expressions'],
    explanation: [
      '足し算や引き算のような単純な計算を、AND・OR・XOR などのビット演算と算術演算を組み合わせた長い式に書き換えて隠す手法です。',
      'An obfuscation trick that rewrites simple arithmetic like addition into long combinations of bitwise (AND, OR, XOR) and arithmetic operations.',
    ],
    tip: [
      '見た目が複雑でも単純化すると 1 行の計算に戻ることが多いため、自動単純化の結果を確認しましょう。',
      'Even very long expressions often collapse to a single operation—check the simplified expression summary first.',
    ],
  }),

  pac: Object.freeze({
    term: ['ポインタ認証 (PAC)', 'Pointer Authentication (PAC)'],
    shortLabel: ['戻り先やポインタの改ざんを防ぐ署名機能', 'ARM64e hardware signature protecting pointers'],
    explanation: [
      'ARM64e のセキュリティ機能で、関数の戻り先アドレスや関数ポインタの上位ビットに暗号署名を付けて改ざんを検出します。',
      'An ARM64e security feature that signs return addresses and function pointers in unused upper bits so tampering causes an immediate fault.',
    ],
    tip: [
      'PAC 命令がある関数を安易にパッチすると署名検証でクラッシュしやすいため、パッチ前に影響範囲を必ず確認してください。',
      'Patching functions with PAC instructions (like paciasp/autiasp/retaa) can break pointer signatures and crash—check patch risk first.',
    ],
  }),

  til: Object.freeze({
    term: ['型情報ライブラリ (TIL)', 'Type Information Library (TIL)'],
    shortLabel: ['OS や SDK の関数・構造体の辞書', 'Dictionary of OS/SDK function signatures and types'],
    explanation: [
      'OS の標準ライブラリやフレームワークに含まれる関数の引数・戻り値・構造体定義をまとめた辞書データです。',
      'A prebuilt library of function prototypes, parameter types, and struct layouts for OS SDKs and common frameworks.',
    ],
    tip: [
      'TIL パックが読み込まれると、関数の引数や戻り値の意味が自動で表示され、処理内容がぐっと読みやすくなります。',
      'With a matching TIL pack loaded, parameter and return types are filled in automatically to make calls easier to read.',
    ],
  }),

  hexsig: Object.freeze({
    term: ['HexSig (バイナリ関数署名)', 'HexSig (Binary Function Signature)'],
    shortLabel: ['機械語の指紋から既知の関数名を当てる仕組み', 'Fingerprinting that identifies known library functions'],
    explanation: [
      '関数先頭の機械語パターン（指紋）をデータベースと照合し、名前が消されたライブラリ関数の正体を自動で特定する機能です。',
      'A signature matching engine that compares machine-code fingerprints against known libraries to restore names on stripped functions.',
    ],
    tip: [
      '自動命名された関数は既知のライブラリ処理である可能性が高いため、アプリ独自の処理を探すときはスキップ候補になります。',
      'Functions matched by HexSig are usually standard library helpers—focus your reading on app-specific functions first.',
    ],
  }),

  demangle: Object.freeze({
    term: ['デマングル (名前復元)', 'Demangle'],
    shortLabel: ['記号化された関数名を元の表記に戻す処理', 'Restoring encoded C++/Swift/Rust names to readable form'],
    explanation: [
      'C++・Swift・Rust などのコンパイラがクラス名や引数型を埋め込んで変換した記号文字列（例: _Z3fooi）を、人間が読める元の名前へ戻すことです。',
      'Decoding compiler-encoded symbol names (such as _Z3fooi or _$s...) back into readable class, method, and parameter signatures.',
    ],
    tip: [
      '復元後の名前にクラス名やメソッド名が出るため、関数の中身を読む前から役割を推測できます。',
      'Read the demangled class and method name first—it often tells you the function purpose before you inspect a single instruction.',
    ],
  }),

  stripped: Object.freeze({
    term: ['ストリップ済み (名前なし)', 'Stripped Binary / Symbol'],
    shortLabel: ['配布用に開発時の関数名が削られた状態', 'Debug and function names removed for release'],
    explanation: [
      'リリース版アプリなどでファイルサイズ削減や解析対策のため、関数名や変数名のシンボル情報が取り除かれている状態です。',
      'A release binary where human-readable function and variable names have been removed, leaving generic placeholders like sub_1000.',
    ],
    tip: [
      'sub_XXXX のような仮名が付いていても、文字列参照や HexSig・呼び出し先 API から役割をたどれます。',
      'Even when functions appear as sub_XXXX, string references, HexSig matches, and called APIs reveal what they do.',
    ],
  }),

  xref: Object.freeze({
    term: ['相互参照 (Xref)', 'Cross-Reference (Xref)'],
    shortLabel: ['「どこから使われているか」のつながり', 'Links showing where a function or data is used'],
    explanation: [
      'ある関数・アドレス・文字列が、バイナリ内のどの場所から呼び出されたり参照されたりしているかを示す一覧です。',
      'A map of every location in the binary that calls a function or references a particular string or data address.',
    ],
    tip: [
      '気になるエラーメッセージや文字列から Xref をたどると、関連する処理関数へ最短で到達できます。',
      'Follow xrefs from an interesting string or error message to jump straight to the function that uses it.',
    ],
  }),

  cfg: Object.freeze({
    term: ['制御フローグラフ (CFG)', 'Control Flow Graph (CFG)'],
    shortLabel: ['条件分岐やループを地図にした図', 'Map of branches and loops inside a function'],
    explanation: [
      '関数の中の命令を「分岐なしの塊（基本ブロック）」に分け、条件分岐やループによる移動先を矢印で結んだ構造です。',
      'A graph that splits a function into straight-line basic blocks and connects them with arrows for branches and loops.',
    ],
    tip: [
      '上向きの矢印はループ、枝分かれは if/else や switch を表します。全体の形を見ると関数の骨格がつかめます。',
      'Backward edges indicate loops and forks indicate if/else or switch logic—scan the graph shape before reading every line.',
    ],
  }),

  ssa: Object.freeze({
    term: ['静的単一代入 (SSA)', 'Static Single Assignment (SSA)'],
    shortLabel: ['値の書き換わりを追跡しやすくする内部表現', 'Form where each variable version is assigned once'],
    explanation: [
      '同じレジスタや変数が何度も上書きされても「v1, v2, v3」のように別の名前を割り当て、値の出どころを正確に追跡できる中間表現です。',
      'An intermediate form where every assignment creates a distinct version (v1, v2, v3), making data flow exact and unambiguous.',
    ],
    tip: [
      'SSA 形式のおかげで、デコンパイラは不要な計算を消したり引数の流れを正しく推測したりできます。',
      'SSA lets the decompiler trace where a value came from without getting confused by reused registers.',
    ],
  }),

  stack_frame: Object.freeze({
    term: ['スタックフレーム', 'Stack Frame'],
    shortLabel: ['関数が実行中だけ使う一時メモ領域', 'Temporary scratchpad memory used while a function runs'],
    explanation: [
      '関数が呼ばれたときにスタック上に確保される作業スペースで、ローカル変数や戻り先アドレスを一時的に保存します。',
      'The slice of stack memory reserved when a function starts, holding its local variables and saved registers until it returns.',
    ],
    tip: [
      '関数先頭でスタックを大きく確保している場合、配列や構造体などのローカルデータを扱っている目印になります。',
      'A large stack frame reservation at function entry usually means local buffers or structs are stored on the stack.',
    ],
  }),

  calling_convention: Object.freeze({
    term: ['呼び出し規約', 'Calling Convention'],
    shortLabel: ['関数の引数と戻り値の受け渡しルール', 'Rules for passing arguments and return values'],
    explanation: [
      '「何番目の引数をどのレジスタ（ARM64 なら x0〜x7 など）に入れ、戻り値をどこに返すか」を決める共通ルールです。',
      'The ABI agreement defining which registers or stack slots carry function arguments (such as x0–x7 on ARM64) and return values.',
    ],
    tip: [
      '関数呼び出し（bl など）の直前で x0・x1 に何をセットしているかを見れば、渡している引数が分かります。',
      'Look at what is loaded into x0, x1, and other argument registers right before a call to see what inputs are being passed.',
    ],
  }),

  prologue: Object.freeze({
    term: ['プロローグ', 'Function Prologue'],
    shortLabel: ['関数のはじめに行う準備処理', 'Setup instructions at the start of a function'],
    explanation: [
      '関数の先頭でスタック領域を確保し、呼び出し元のレジスタや戻り先アドレス（LR）を退避する定型の準備コードです。',
      'The boilerplate instructions at function entry that allocate the stack frame and save the return address and callee-saved registers.',
    ],
    tip: [
      'プロローグはほぼ決まり文句なので、本質的な処理はプロローグが終わった直後から読み始めると効率的です。',
      'Prologues are mostly routine setup—skim past them and start reading the real logic right after the stack setup.',
    ],
  }),

  epilogue: Object.freeze({
    term: ['エピローグ', 'Function Epilogue'],
    shortLabel: ['関数の終わりに行う後片付け処理', 'Cleanup instructions before returning from a function'],
    explanation: [
      '関数が終わるときに退避していたレジスタを元に戻し、スタックを解放してから呼び出し元へ戻る（ret）後片付けコードです。',
      'The cleanup sequence at function exit that restores saved registers, releases the stack frame, and executes the return instruction.',
    ],
    tip: [
      'エピローグ直前で x0 / w0（x64 なら eax/rax）に入っている値が、この関数の戻り値です。',
      'Check what value is placed in the return register (x0/w0 on ARM64, rax/eax on x64) right before the epilogue.',
    ],
  }),

  plt_got: Object.freeze({
    term: ['PLT / GOT (外部呼び出し仲介表)', 'PLT / GOT'],
    shortLabel: ['外部ライブラリの関数へつなぐ中継テーブル', 'Trampoline and address tables for external library calls'],
    explanation: [
      '共有ライブラリ（libc や OS API など）の関数を呼ぶときに使われる中継コード（PLT）と実際のアドレス表（GOT）の仕組みです。',
      'The Procedure Linkage Table (PLT) stubs and Global Offset Table (GOT) pointers that connect calls to external shared libraries.',
    ],
    tip: [
      '短いジャンプだけの関数が見えたら PLT/GOT 経由の外部ライブラリ呼び出しである可能性が高いです。',
      'A tiny stub that immediately jumps through a pointer is usually a PLT/GOT trampoline into a shared library.',
    ],
  }),

  vtable: Object.freeze({
    term: ['仮想関数テーブル (vtable)', 'Virtual Method Table (vtable)'],
    shortLabel: ['オブジェクトの種類ごとの関数一覧表', 'Lookup table of methods for C++ objects'],
    explanation: [
      'C++ などのクラスで継承・多態性（仮想関数）を実現するための関数ポインタ配列で、実行時に呼ぶメソッドを切り替えます。',
      'An array of function pointers stored per C++ class that enables virtual method dispatch at runtime.',
    ],
    tip: [
      '間接呼び出し（blr 等）の直前でオブジェクト先頭からポインタを引いていれば、vtable 経由のメソッド呼び出しです。',
      'An indirect call loading a function pointer from an object header usually means a C++ virtual method call through a vtable.',
    ],
  }),

  stl_container: Object.freeze({
    term: ['STL コンテナ', 'C++ STL Container'],
    shortLabel: ['C++ 標準の配列・文字列・辞書データ構造', 'Standard C++ data structures like vector, string, map'],
    explanation: [
      'C++ 標準ライブラリ（STL）が提供する std::vector（可変長配列）、std::string（文字列）、std::map（辞書）などの定番データ構造です。',
      'Standard Template Library data structures such as std::vector, std::string, std::map, std::unordered_map, and std::shared_ptr.',
    ],
    tip: [
      'STL パターンが認識されると、複雑なポインタ操作を「配列への追加」や「辞書検索」として直感的に読めます。',
      'Once recognized as an STL container, dense pointer arithmetic becomes easy to read as list, string, or map operations.',
    ],
  }),

  syscall: Object.freeze({
    term: ['システムコール (syscall)', 'System Call (syscall)'],
    shortLabel: ['OS カーネルへ直接お願いする窓口命令', 'Direct request from the app to the OS kernel'],
    explanation: [
      'ファイルの読み書き、通信、メモリ確保、プロセス終了などの特権的な処理を OS カーネルへ直接依頼する命令（svc / syscall）です。',
      'A low-level instruction (like svc or syscall) asking the operating system kernel to perform I/O, networking, or memory management.',
    ],
    tip: [
      'システムコール番号と引数を調べると、その関数が OS に対して何の操作をしているか正確に特定できます。',
      'Inspect the syscall number and argument registers to see the exact OS action (file I/O, socket, exit, etc.).',
    ],
  }),

  entrypoint: Object.freeze({
    term: ['エントリポイント', 'Entry Point'],
    shortLabel: ['プログラムが最初に動き出す出発点', 'Starting address where program execution begins'],
    explanation: [
      '実行ファイルが起動されたときに OS が最初にジャンプする開始アドレスです。ここから初期化を経て main 関数へ進みます。',
      'The first instruction address the operating system jumps to when launching the binary, leading into runtime init and main().',
    ],
    tip: [
      'どこから読み始めればよいか迷ったら、エントリポイントや main 関数から呼び出し先をたどるのが王道です。',
      'Not sure where to start? Begin at the entry point or main() and follow calls into the app logic.',
    ],
  }),

  branch: Object.freeze({
    term: ['分岐 (Branch)', 'Branch'],
    shortLabel: ['条件に応じて処理の行き先を変える命令', 'Instruction that jumps to another path based on a condition'],
    explanation: [
      '比較結果などに応じて別のアドレスへジャンプする命令で、プログラムの if 文・else 文・ループを実現します。',
      'An instruction that redirects execution to another address—either unconditionally or when a comparison condition holds.',
    ],
    tip: [
      '分岐の直前にある比較命令（cmp / tst 等）とセットで読むと「どんな条件で分かれるか」が分かります。',
      'Always read a conditional branch together with the comparison instruction right before it to see the exact condition.',
    ],
  }),

  register: Object.freeze({
    term: ['レジスタ', 'Register'],
    shortLabel: ['CPU 内部の超高速な一時入れ物', 'Fast temporary storage slot inside the CPU'],
    explanation: [
      'CPU の中にあるごく少数の作業用ポケット（ARM64 の x0〜x30、x64 の rax 等）で、計算や引数の受け渡しに使われます。',
      'Small, ultra-fast storage slots inside the CPU (such as x0–x30 on ARM64 or rax/rdi on x64) used for math, addresses, and arguments.',
    ],
    tip: [
      'まずは引数・戻り値に使われる x0〜x7 と、スタック位置を持つ sp に注目すると流れが追いやすくなります。',
      'Start by watching argument/return registers (like x0–x7) and the stack pointer (sp) to follow data flow.',
    ],
  }),

  pointer: Object.freeze({
    term: ['ポインタ', 'Pointer'],
    shortLabel: ['データや関数が置かれたメモリ番地', 'Memory address pointing to data or code'],
    explanation: [
      '値そのものではなく「そのデータがメモリの何番地にあるか」を指し示すアドレス値です。構造体や配列、文字列の受け渡しに使われます。',
      'A value holding a memory address where data or a function lives, rather than the data itself.',
    ],
    tip: [
      '[x0, #0x10] のような表記は「x0 が指す場所から 16 バイト先のデータを読む」という意味になります。',
      'Notation like [x0, #0x10] means reading or writing a field 16 bytes past the base address stored in x0.',
    ],
  }),

  patch: Object.freeze({
    term: ['パッチ (書き換え)', 'Patch'],
    shortLabel: ['バイナリの命令やデータを一部変更する操作', 'Modifying instructions or bytes inside a binary'],
    explanation: [
      'バイナリ内の特定アドレスの機械語やデータを別の値に書き換えて、動作を変更・検証する操作です。',
      'Overwriting specific machine-code instructions or data bytes in a binary to alter or test its behavior.',
    ],
    tip: [
      '共有ユーティリティ関数や PAC・カナリア保護付き関数の書き換えは影響が大きいため、パッチ影響度を確認してから行いましょう。',
      'Check patch risk before modifying bytes—changing shared helpers, stack canaries, or PAC code can cause wide side effects.',
    ],
  }),

  decompile: Object.freeze({
    term: ['デコンパイル (逆コンパイル)', 'Decompile'],
    shortLabel: ['機械語を C 言語風の読みやすいコードへ変換', 'Translating machine code into readable C-like pseudocode'],
    explanation: [
      'アセンブリ命令の並びを解析し、変数・if 文・ループ・関数呼び出しを使った C 言語風の擬似コードへ自動変換する処理です。',
      'Automatically reconstructing higher-level C-like pseudocode (variables, loops, conditions, calls) from low-level assembly.',
    ],
    tip: [
      'まずはデコンパイル結果で大まかな意味をつかみ、細部やパッチ位置を確認したいときにアセンブリを見比べると効率的です。',
      'Use decompiled pseudocode to grasp the big picture quickly, then verify exact instructions in assembly when needed.',
    ],
  }),

  rtti: Object.freeze({
    term: ['実行時型情報 (RTTI)', 'Run-Time Type Information (RTTI)'],
    shortLabel: ['アプリの中に残ったクラス名や親子の手がかり', 'Class names and inheritance clues left inside a C++ app'],
    explanation: [
      'C++ で作られたアプリが、実行中に「このデータは何のクラスか」を判断するために残している名札のような情報です。関数名が消されていても、ここから元のクラス名や親子関係を復元できることがあります。',
      'Metadata that C++ apps keep so they can check what class an object belongs to while running. Even when function names are removed, it often lets us recover class names and inheritance.',
    ],
    tip: [
      '名前が消されたアプリでも、RTTI から復元されたクラス名を見ると「コイン管理」「画面表示」などの役割が見つけやすくなります。',
      'Even in stripped apps, class names recovered from RTTI quickly point you toward areas like coins, players, or menus.',
    ],
  }),

  typeinfo: Object.freeze({
    term: ['型情報レコード (typeinfo)', 'Type Info Record (typeinfo)'],
    shortLabel: ['クラスの正式名称と親クラスを記した名簿データ', 'A small data card storing a class name and its parent class'],
    explanation: [
      'RTTI の中身を構成するデータのかたまりで、そのクラスの名前と「どの親クラスを引き継いでいるか」への目印が入っています。仮想関数テーブルのすぐ近くからたどることができます。',
      'A small record inside RTTI that holds a class name and links to its parent classes. It can be reached directly from the class virtual table.',
    ],
    tip: [
      '親クラスへのつながりをたどると、共通の土台となる処理と個別の画面・キャラごとの処理を見分けられます。',
      'Following parent links helps you separate shared base behavior from specialized subclass behavior.',
    ],
  }),

  virtual_tree: Object.freeze({
    term: ['仮想フォルダツリー', 'Virtual Folder Tree'],
    shortLabel: ['関数をクラスや役割ごとのフォルダに整理した一覧', 'A folder view grouping functions by class and purpose'],
    explanation: [
      '何万個もの関数を、復元したクラス名や名前空間（例: Game / System / Coin）や、通信・保存・画面などの役割ごとにフォルダ分けして見やすくまとめたツリー表示です。',
      'An explorer-style tree that organizes thousands of functions into folders by recovered class hierarchy (such as Game / System / Coin) or inferred role like Network and Storage.',
    ],
    tip: [
      '関数を 1 つずつ探すより、関係しそうなフォルダを開いて中身を絞るほうが目的の処理へ素早くたどり着けます。',
      'Open the folder matching the feature you care about instead of scrolling through every function in the binary.',
    ],
  }),

  semantic_name: Object.freeze({
    term: ['役割ベースの仮名', 'Semantic Role Name'],
    shortLabel: ['手がかりから付けた「何をする処理か」のわかりやすい名前', 'A plain-language label describing what a function likely does'],
    explanation: [
      '所属クラス・使っている文字列・呼び出す OS 機能・データ書き換えなどの証拠を組み合わせて、元の名前がない関数に「対象＋目的」が伝わる仮の名前を付けたものです。証拠が少ない場合は無理に決めつけず「未確定」のままにします。',
      'A readable label built from concrete clues—such as class ownership, strings, OS APIs, and state writes—to describe what an unnamed function appears to do. When clues are weak, it stays marked low-confidence instead of guessing.',
    ],
    tip: [
      '仮名の横にある確信度（高・中・低）と根拠リストを一緒に確認すると、どこまで信用してよいか判断できます。',
      'Check the confidence level and evidence list beside the label to see how strongly the clues support it.',
    ],
  }),

  primary_owner: Object.freeze({
    term: ['本来の持ち主クラス', 'Primary Owner Class'],
    shortLabel: ['そのメソッドを最初に定義した元のクラス', 'The class that originally defined a shared virtual method'],
    explanation: [
      '子クラスが親クラスの処理をそのまま引き継いでいると、同じ関数が複数のクラスの表に載ります。親子関係をたどって「実際にその処理を書いた本来の持ち主」を特定したものが本来の持ち主クラスです。',
      'When subclasses inherit a method unchanged, the same function appears in several class tables. Tracing the inheritance chain identifies the original class that actually owns the method.',
    ],
    tip: [
      '見かけ上たくさんのクラスに出てくる関数でも、本来の持ち主クラスを見れば「どこを直せば全体に影響するか」が分かります。',
      'Looking at the primary owner shows where a shared method really lives and how widely a change will affect subclasses.',
    ],
  }),
});

/**
 * 24-key alias table used for term detection in beginner explanations.
 * Sorted at compile time by descending length so longer aliases win first.
 */
export const GLOSSARY_ALIASES = Object.freeze({
  cff: Object.freeze([
    'control flow flattening',
    'control-flow flattening',
    '制御フロー平坦化',
    '制御フローの平坦化',
    'CFF',
  ]),
  mba: Object.freeze([
    'mixed boolean-arithmetic',
    'mixed boolean arithmetic',
    '混合ブール算術',
    'MBA難読化',
    'MBA',
  ]),
  pac: Object.freeze([
    'pointer authentication code',
    'pointer authentication',
    'ポインタ認証',
    'PAC',
  ]),
  til: Object.freeze([
    'type information library',
    '型情報ライブラリ',
    'TIL',
  ]),
  hexsig: Object.freeze([
    'HexSig',
    '関数シグネチャ',
    'バイナリ署名',
  ]),
  demangle: Object.freeze([
    'demangling',
    'demangled',
    'demangle',
    'mangling',
    'mangled',
    'デマングル',
    'マングリング',
    '名前装飾',
    '名前復元',
    'C++',
  ]),
  stripped: Object.freeze([
    'stripped',
    'ストリップ',
    'シンボル削除',
    '名前なし関数',
  ]),
  xref: Object.freeze([
    'cross-reference',
    'cross reference',
    'xrefs',
    'xref',
    '相互参照',
  ]),
  cfg: Object.freeze([
    'control flow graph',
    'control-flow graph',
    '制御フローグラフ',
    'CFG',
  ]),
  ssa: Object.freeze([
    'static single assignment',
    '静的単一代入',
    'SSA',
  ]),
  stack_frame: Object.freeze([
    'stack_frame',
    'stack frame',
    'スタックフレーム',
    'スタック領域',
  ]),
  calling_convention: Object.freeze([
    'calling_convention',
    'calling convention',
    '呼び出し規約',
    'ABI',
  ]),
  prologue: Object.freeze([
    'function prologue',
    'prologue',
    'プロローグ',
  ]),
  epilogue: Object.freeze([
    'function epilogue',
    'epilogue',
    'エピローグ',
  ]),
  plt_got: Object.freeze([
    'procedure linkage table',
    'global offset table',
    'plt_got',
    'PLT/GOT',
    'GOT/PLT',
    'GOT table',
    'GOTテーブル',
    'GOTエントリ',
    'PLT',
  ]),
  vtable: Object.freeze([
    'virtual method table',
    'virtual table',
    'vtable',
    '仮想関数テーブル',
  ]),
  stl_container: Object.freeze([
    'std::unordered_map',
    'std::shared_ptr',
    'std::vector',
    'std::string',
    'std::list',
    'std::map',
    'stl_container',
    'STL container',
    'C++ STL',
    'STLコンテナ',
    'STL コンテナ',
    'STL',
  ]),
  syscall: Object.freeze([
    'system call',
    'syscalls',
    'syscall',
    'システムコール',
  ]),
  entrypoint: Object.freeze([
    'entry point',
    'entrypoint',
    'エントリーポイント',
    'エントリポイント',
  ]),
  branch: Object.freeze([
    'conditional branch',
    'branch',
    '条件分岐',
    '分岐命令',
  ]),
  register: Object.freeze([
    'registers',
    'register',
    'レジスタ',
  ]),
  pointer: Object.freeze([
    'pointers',
    'pointer',
    'ポインタ',
  ]),
  patch: Object.freeze([
    'patching',
    'patched',
    'patch',
    'パッチ',
  ]),
  decompile: Object.freeze([
    'decompilation',
    'decompiler',
    'decompiled',
    'decompile',
    'デコンパイル',
    '逆コンパイル',
  ]),
});

/**
 * Escape all RegExp metacharacters so aliases like "C++", "PLT/GOT", or
 * "std::vector" are matched literally.
 * @param {string} literal
 * @returns {string}
 */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build an alternation branch for one alias.
 * Applies ASCII word boundaries ONLY on edges that start/end with an ASCII word
 * character ([A-Za-z0-9_]), preventing false positives like "unpacked"/"until"/"config"
 * while still matching "C++", "PLT/GOT", and Japanese-adjacent terms like "PAC署名".
 * @param {string} alias
 * @returns {string}
 */
function buildAliasPattern(alias) {
  const escaped = escapeRegExp(alias);
  const prefix = ASCII_WORD_START_RE.test(alias) ? '(?<![A-Za-z0-9_])' : '';
  const suffix = ASCII_WORD_END_RE.test(alias) ? '(?![A-Za-z0-9_])' : '';
  return `${prefix}${escaped}${suffix}`;
}

const ALIAS_TO_KEY = new Map();
const SORTED_ALIAS_ENTRIES = [];

for (const key of GLOSSARY_KEYS) {
  const aliases = GLOSSARY_ALIASES[key];
  if (!Array.isArray(aliases)) continue;
  for (const alias of aliases) {
    if (typeof alias !== 'string' || alias.length === 0) continue;
    const lower = alias.toLowerCase();
    if (ALIAS_TO_KEY.has(lower)) continue;
    ALIAS_TO_KEY.set(lower, key);
    SORTED_ALIAS_ENTRIES.push({ alias, lower, key });
  }
}

SORTED_ALIAS_ENTRIES.sort((a, b) => {
  if (b.alias.length !== a.alias.length) return b.alias.length - a.alias.length;
  return a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0;
});

const COMBINED_ALIAS_RE = new RegExp(
  SORTED_ALIAS_ENTRIES.map((entry) => buildAliasPattern(entry.alias)).join('|'),
  'gi',
);

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}

function computeSafeScanEnd(text, maxInputLength) {
  const rawLimit = maxInputLength == null ? DEFAULT_MAX_INPUT_LENGTH : Number(maxInputLength);
  if (!Number.isFinite(rawLimit)) {
    return Math.min(text.length, DEFAULT_MAX_INPUT_LENGTH);
  }
  const clamped = Math.max(0, Math.floor(rawLimit));
  if (clamped >= text.length) return text.length;
  if (clamped === 0) return 0;
  if (isHighSurrogate(text.charCodeAt(clamped - 1)) && isLowSurrogate(text.charCodeAt(clamped))) {
    return clamped - 1;
  }
  return clamped;
}

function pushSegment(segments, text, glossaryKey) {
  if (!text) return;
  if (glossaryKey === null && segments.length > 0 && segments[segments.length - 1].glossaryKey === null) {
    segments[segments.length - 1].text += text;
    return;
  }
  segments.push({ text, glossaryKey });
}

/**
 * Look up a single bilingual beginner glossary entry by canonical key.
 * @param {string} key
 * @returns {{ key: string, term: string, shortLabel: string, explanation: string, tip: string } | null}
 */
export function getGlossaryEntry(key) {
  if (typeof key !== 'string') return null;
  const normalized = key.trim().toLowerCase();
  if (!ALL_GLOSSARY_KEY_SET.has(normalized)) return null;
  const def = GLOSSARY_DEFINITIONS[normalized];
  if (!def) return null;
  return {
    key: normalized,
    term: pick(def.term[0], def.term[1]),
    shortLabel: pick(def.shortLabel[0], def.shortLabel[1]),
    explanation: pick(def.explanation[0], def.explanation[1]),
    tip: pick(def.tip[0], def.tip[1]),
  };
}

/**
 * List bilingual glossary entries.
 * When `keys` is omitted or null, returns all 24 canonical entries in order
 * (or all 29 entries when `opts.includeExtended === true`).
 * When `keys` is provided as an iterable/array, resolves valid keys, deduplicating
 * while preserving first-seen order.
 * @param {Iterable<string>|null} [keys=null]
 * @param {{ includeExtended?: boolean }} [opts]
 * @returns {Array<{ key: string, term: string, shortLabel: string, explanation: string, tip: string }>}
 */
export function listGlossaryEntries(keys = null, opts = {}) {
  if (keys == null) {
    const sourceKeys = opts?.includeExtended === true ? ALL_GLOSSARY_KEYS : GLOSSARY_KEYS;
    const all = [];
    for (const key of sourceKeys) {
      const entry = getGlossaryEntry(key);
      if (entry) all.push(entry);
    }
    return all;
  }
  if (typeof keys === 'string' || typeof keys[Symbol.iterator] !== 'function') {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const rawKey of keys) {
    const entry = getGlossaryEntry(rawKey);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    result.push(entry);
  }
  return result;
}

/**
 * Annotate occurrences of the 24 glossary terms inside plain text.
 * Returns pure structured data (`segments` and deduplicated first-seen `matchedKeys`)
 * without generating any HTML markup or mutating XSS-like strings.
 *
 * Invariants:
 * - `segments.map((s) => s.text).join('') === text` for every non-empty string input.
 * - UTF-16 surrogate pairs are never split at the `maxInputLength` scan boundary.
 * - Text beyond `maxInputLength` is preserved verbatim as a plain segment (`glossaryKey: null`).
 *
 * @param {string} text
 * @param {{ maxInputLength?: number }} [opts]
 * @returns {{ segments: Array<{ text: string, glossaryKey: string | null }>, matchedKeys: string[] }}
 */
export function annotateGlossaryTerms(text, { maxInputLength = DEFAULT_MAX_INPUT_LENGTH } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { segments: [], matchedKeys: [] };
  }

  const scanEnd = computeSafeScanEnd(text, maxInputLength);
  if (scanEnd === 0) {
    return {
      segments: [{ text, glossaryKey: null }],
      matchedKeys: [],
    };
  }

  const scanText = scanEnd < text.length ? text.slice(0, scanEnd) : text;
  const remainder = scanEnd < text.length ? text.slice(scanEnd) : '';

  const segments = [];
  const matchedKeys = [];
  const seenKeys = new Set();

  let cursor = 0;
  for (const match of scanText.matchAll(COMBINED_ALIAS_RE)) {
    const matchText = match[0];
    const start = match.index ?? 0;
    if (!matchText) continue;

    if (start > cursor) {
      pushSegment(segments, scanText.slice(cursor, start), null);
    }

    const key = ALIAS_TO_KEY.get(matchText.toLowerCase()) ?? null;
    pushSegment(segments, matchText, key);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      matchedKeys.push(key);
    }

    cursor = start + matchText.length;
  }

  if (cursor < scanText.length) {
    pushSegment(segments, scanText.slice(cursor), null);
  }
  if (remainder.length > 0) {
    pushSegment(segments, remainder, null);
  }

  return { segments, matchedKeys };
}

/**
 * Describe a symbol mangle kind (matching DEMANGLE_KIND numeric values 0..5 or
 * canonical string names) in beginner-friendly bilingual prose.
 * @param {number|string|null|undefined} kind
 * @returns {string}
 */
export function describeMangleKindForBeginner(kind) {
  if (kind == null || kind === '' || kind === 0) {
    return pick(
      '名前装飾のない通常の関数名（C 言語など）です。',
      'A plain unmangled function name (such as C).',
    );
  }

  if (typeof kind === 'number') {
    switch (kind) {
      case 1:
        return pick(
          'C++ の名前装飾（Itanium 形式）が付いた関数名です。クラス名や引数の型が記号にまとめられています。',
          'A C++ mangled symbol (Itanium ABI) encoding the class name and parameter types.',
        );
      case 2:
        return pick(
          'Rust（v0 形式）の名前装飾が付いた関数名です。モジュール階層やジェネリクス型が含まれています。',
          'A Rust (v0) mangled symbol encoding module paths and generic type parameters.',
        );
      case 3:
        return pick(
          'Rust（旧形式）の名前装飾が付いた関数名です。モジュール名と識別用ハッシュが含まれています。',
          'A Rust (legacy) mangled symbol containing the module path and a disambiguation hash.',
        );
      case 4:
        return pick(
          'Swift の名前装飾が付いた関数名です。モジュール名・型名・引数の情報が記号化されています。',
          'A Swift mangled symbol encoding the module, type, and parameter signature.',
        );
      case 5:
        return pick(
          'Windows 版 C++（MSVC 形式）の名前装飾が付いた関数名です。クラス名や呼び出し規約が含まれています。',
          'A Windows C++ (MSVC) mangled symbol encoding the class, calling convention, and parameter types.',
        );
      default:
        return pick(
          '種類が特定できない関数名です。',
          'A function symbol with an unrecognized mangling format.',
        );
    }
  }

  if (typeof kind === 'string') {
    const norm = kind.trim().toLowerCase();
    if (norm === 'none' || norm === 'plain' || norm === 'c') {
      return describeMangleKindForBeginner(0);
    }
    if (norm === 'itanium_cpp' || norm === 'itanium-cpp' || norm === 'itanium-cxx' || norm === 'itanium' || norm === 'cpp' || norm === 'c++') {
      return describeMangleKindForBeginner(1);
    }
    if (norm === 'rust_v0' || norm === 'rust-v0') {
      return describeMangleKindForBeginner(2);
    }
    if (norm === 'rust_legacy' || norm === 'rust-legacy' || norm === 'rust') {
      return describeMangleKindForBeginner(3);
    }
    if (norm === 'swift') {
      return describeMangleKindForBeginner(4);
    }
    if (norm === 'msvc_cpp' || norm === 'msvc-cpp' || norm === 'msvc') {
      return describeMangleKindForBeginner(5);
    }
    if (norm === 'objc' || norm === 'objc-method' || norm === 'objc-stub' || norm === 'objective-c') {
      return pick(
        'Objective-C のメソッド名です。クラス名とセレクタ（メッセージ名）の組み合わせで表されます。',
        'An Objective-C method symbol pairing a class name with its selector.',
      );
    }
  }

  return pick(
    '種類が特定できない関数名です。',
    'A function symbol with an unrecognized mangling format.',
  );
}
