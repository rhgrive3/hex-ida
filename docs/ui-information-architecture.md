# Hex Product UI Information Architecture

## Product principle

Hex presents analysis in this order:

**Question → Answer → Evidence → Detail**

Users should not need to choose an internal analysis algorithm before they can
ask a useful question. Internal strategies such as string search, feature
grouping, dataflow, decompilation, and runtime verification are selected by
context and exposed only when they help explain an answer.

## Canonical terminology

| Canonical term | Meaning | Do not use as competing top-level labels |
|---|---|---|
| 調べる / Investigate | ask a question or start automatic investigation | 自動解析, 機能から探す, 目的から探す as separate destinations |
| コード / Code | current assembly/hex address context | Viewer, Raw view as top-level destinations |
| 索引 / Explorer | browse/search entities in the binary | Functions, Strings, Sections as separate top-level pages |
| 結果 / Results | findings, evidence, history, and pins | Reliability/Pins as separate global destinations |
| 関数 / Function Workspace | understand one function progressively | Function Summary, Function Report, Decompiler as competing screens |
| 根拠 / Evidence | why a conclusion is supported | ranking score, stars, or probability presented as certainty |
| 高度な機能 / Advanced | patch/script/plugin/raw low-level tools | Tools as a beginner destination |

Beginner-facing copy describes intent (e.g. 「値の流れ」「なぜそう言える？」「書き換えている場所」). Formal terms such as SSA, Memory SSA, and
architecture-specific details remain available in expert detail.

## Top-level navigation

The persistent navigation has four entries only (`PRIMARY_NAV` in
`js/ui/registry.js`):

1. **調べる / Investigate** (`/investigate`) — structured question entry.
2. **コード / Code** (`/code`) — current assembly/hex context, and the default route.
3. **索引 / Explorer** (`/explorer/functions`) — entity browsing/search.
4. **結果 / Results** (`/results`) — revisit conclusions and evidence.

The four entries live in the chrome row as compact tabs from 900px up, and are
pinned to the bottom of the viewport below that. There is no left rail: the
width it would reserve belongs to the disassembly.

**Code is the default route**, before a file exists as well as after. With no
file open the workbench shows a compact open/sample card in the viewer area;
opening a file goes straight to the instructions instead of a question screen
or an overview sheet. Investigate remains one tap away for a structured goal,
and the AI Assistant answers natural-language questions from wherever the user
already is.

Secondary destinations live in More: Settings, Learn, Help, and Advanced.
Functions, Sections, Structure, Search, and Tools are never repeated there.
Diff (`/diff`) is a canonical non-primary route reached contextually rather
than a fifth persistent navigation item.

## Route hierarchy

Defined canonically in `js/ui/registry.js` (11 routes/workspaces):

```text
/investigate
/code/:address?
/explorer/:scope?
  functions
  strings
  classes
  data
  external
  sections
/results
/diff
/finding/:id
/function/:address/:tab?
  overview
  pseudocode
  flow
  calls
  evidence
  runtime
/settings
/help
/learn
/advanced
```

`ProductRouter` (`js/ui/router.js`) uses browser history rather than retaining
screen DOM. A route may serialize scroll, query, filter, and selection state
into `history.state`; views are rebuilt from cached domain results when
restored.

## Global command/search (Omnibox)

The global field accepts intent without requiring command syntax
(`js/ai/interaction/omnibox.js`, `js/ui/product-base.js`):

- `0x100458C00` → exact address navigation;
- `sub_100458C00` → open that function;
- exact symbol name (with or without leading `_`, including user renames) →
  **Omnibox exact jump** resolves unique symbol matches directly (preferring
  function starts via `isFunctionStart`, which supports both arrays and typed
  views), while ambiguous multi-target names fall through to Explorer search;
- `"reward"` → string search;
- `PlayerData` / `Reward` → Explorer search across relevant names;
- `> settings` or `> 設定` → command navigation;
- `? コインが増えるのはどこ` → ask the AI Assistant.

The classified intent is named beside the field as the user types, so pressing
Enter is never a surprise. Command syntax is optional. `Cmd/Ctrl+K` and `/`
focus the field for expert use.

## AI Assistant

The assistant is ambient, never a destination: a 48px launcher at the bottom
right, a docked column beside the code from 900px up, a bottom sheet on a
tablet, full screen on a phone. The docked layout shrinks the workspace rather
than covering it; the overlay layouts step aside as soon as an action
navigates.

| Control | Meaning |
|---|---|
| チャット / Chat | fast answers about the current context; no binary-wide search |
| エージェント / Agent | search, trace, and verify, reporting factual progress events |
| やさしく / Beginner | conclusion first, terms explained, evidence one disclosure away |
| 解析者 / Analyst | addresses, facts, and cost front-loaded |
| 範囲 / Scope | Auto, selection, function, neighborhood, binary, project, runtime |

Every answer carries evidence, hypotheses, and executable actions rather than
prose alone, and every card ends somewhere in the code. Reading needs no
approval; any change to project state (rename, comment, type, patch) is a
proposal card that does nothing until the user presses Apply.

## Investigate

Investigate is a primary structured-question screen, **not the default landing
route**. It contains:

- natural-language goal input;
- common goal suggestions;
- recent questions;
- automatic overview entry;
- contextual next questions/results.

Feature words, strings, function candidates, and other strategies are
implementation details of the investigation flow, not competing global
destinations.

## Explorer

Explorer has one search model with scopes (`EXPLORER_SCOPES`):

- Functions (`functions`)
- Strings (`strings`)
- Types / Classes (`classes`)
- Data (`data`)
- External APIs (`external`)
- Sections (`sections`)

Large flat lists use `VirtualList`; only visible rows plus overscan exist in
the DOM. Source/query budgets are explicit and may produce partial result sets
with completeness/truncation metadata; an unscanned tail is never treated as
negative evidence. Search/filter chrome is sticky. Selecting a function pushes
the Function Workspace; selecting an address moves to Code.

## Function Workspace

A function is one route (`/function/:address/:tab?`) with progressive tabs
(`FUNCTION_TABS`):

- **Overview** (`overview`) — plain-language role, core facts, next steps.
- **Pseudo-C** (`pseudocode`) — C-like reconstruction with copy/wrap/assembly
  jump, **Clean View** presentation (`js/decompiler/clean-view.js`: typedef
  prelude stripping, dead stack spill elision, and callee-saved stack spill
  folding via `foldCalleeSavedStackSpills`), and **cancellable decompilation**
  (`js/ui/product-base.js`: `AbortController`-backed progress indicator with
  live Cancel button, Retry action on cancellation, and automatic abort on
  route change or superseded render).
- **Flow** (`flow`) — interactive CFG (`js/graphview.js`,
  `js/graphview-base.js`) plus text representation. GraphView UI chrome, node
  aria-labels, overflow line counts, zoom/fit controls, legends, loop-header
  markers, and branch labels are fully localized in Japanese and English via
  `js/i18n.js` (`pick()`).
- **Calls** (`calls`) — callers/callees and deduplicated call graph.
- **Evidence** (`evidence`) — observed facts vs inference.
- **Runtime** (`runtime`) — runtime verification/debugger entry.

The default tab is Overview. Expert details are never required to understand
the first answer.

## V6 Workbench Bridge & contextual popovers

`js/ui/v6-workbench-bridge.js` connects `js/app.js` and `js/ui/product-base.js`
to Hex's v6 analysis engines and contextual overlays without adding top-level
navigation tabs (`PRIMARY_NAV.length === 4`) and without blocking initial
binary load:

- **Contextual popovers & modals:**
  - Type Edit Popover (`js/ui/type-edit-popover.js`) — transactional type
    editing backed by `TypeTransactionManager`, `DirtyConeIndex`, and
    `GlobalTypeMap`;
  - Slice Panel (`js/ui/slice-panel.js`) — value slicing via `SliceService`;
  - Export Interop Modal (`js/ui/export-interop.js`,
    `js/ui/binexport2-writer.js`) — BinExport2 and external interop export;
  - Manual Recovery Popover (`js/ui/manual-recovery-popover.js`) — manual
    segments, function chunks, custom ABI specs, stack-slot overrides, and
    shifted pointers.
- **Integrated analysis overlays:** TIL packs (`TilPackManager`,
  `TilLiteResolver`), HexSig hubs (`HexSigIndex`, `hexsig-hub-loader`),
  deobfuscation overlays (`DeobfOverlayStore`, CFF unflattening, MBA
  simplification), STL pattern recognition, Apple/Swift ARC decompilation
  refinement, Clean View formatting, and JEV query overlays.

## Evidence model

Evidence state and ranking score are separate dimensions
(`js/ui/evidence-model.js`).

Canonical UI semantic states:

- **Confirmed** — directly observed binary/runtime fact.
- **Likely** — inference supported by evidence.
- **Unverified** — insufficient evidence.
- **Contradicted** — evidence conflicts with the claim.

The component uses text, border/icon, and color; color is never the only
signal. Candidate ranking may be shown where useful, but it must not be
labelled or styled as certainty. The AI core's wire/evidence states remain a
separate schema contract (`verified`, `supported`, `hypothesis`, `unknown`); UI
presentation must not blur the two vocabularies.

## Overlay rules

- **Screen** — persistent/deep navigation. Owns a route and participates in browser history.
- **Inspector** — supplementary information for the selected function/instruction. Desktop/tablet may use a side pane; phone uses a full-screen push or dedicated route.
- **Bottom Sheet** — transient, short tasks only: action picker, filter options, copy options. Never a nested navigation tree.
- **Popover / Menu** — small set of context actions anchored to a control or selection (including V6 contextual popovers and decompiler provenance sheets).
- **Dialog** — confirmation, destructive action, or blocking decision only.
- **Toast** — short-lived feedback only.

## Responsive architecture

Canonical breakpoints shared conceptually by CSS and JS:

- **Phone:** `< 600px`
- **Tablet:** `600–899px`
- **Desktop:** `>= 900px`

JavaScript avoids breakpoint-dependent behavior whenever CSS can express it.

### Phone

- persistent 4-item bottom navigation;
- 44px minimum touch target;
- address + assembly prioritized in ASM viewer;
- bytes de-emphasized on narrow ASM layouts, available through Hex mode;
- code and pseudocode own their horizontal scrolling;
- Function Workspace is full route content, not nested sheets;
- graphs use available screen space and include a text representation;
- keyboard visibility uses `visualViewport` and `--ui-keyboard-inset`;
- bottom navigation withdraws while the soft keyboard is open.

### Landscape phone

On short landscape viewports, primary navigation becomes a compact right-side
rail and chrome height is reduced so code/graph regions retain vertical space.

### iPad / tablet

Tablet keeps the simple primary navigation with wider content/card grids and
larger graph space, supporting a contextual inspector without forcing a
three-pane IDE on first-time users.

### Desktop

Canonical screen content is width-bounded for readability while supporting
docked AI Assistant and contextual inspectors without changing routes or domain
APIs.

## Code viewer & Mobile Safari rules

- preserve row virtualization; body must never horizontally scroll;
- narrow widths prioritize address/mnemonic/operands; code-local horizontal
  scrolling is allowed;
- current row/selection remains domain/viewer state, not route DOM state;
- route/orientation changes must not rerun analysis merely to recreate UI;
- use `100dvh`/`100svh` fallback strategy and `env(safe-area-inset-*)` for
  fixed chrome;
- bridge `visualViewport.height/offsetTop` into CSS variables and clean up
  listeners on destroy;
- retain Clipboard API and editable-textarea `execCommand('copy')` fallback;
- dismiss context menus on outside pointer, scroll, and navigation/orientation
  changes (`js/ui/viewer-gesture-guard.js`).

## Design system

Canonical stylesheet stack:

```text
css/ux.css        compatibility entrypoint only
  css/tokens.css      semantic tokens and z layers
  css/base.css        document/focus/reduced-motion foundations
  css/shell.css       application/navigation layout
  css/components.css  shared components
  css/mobile.css      phone/tablet responsive behavior
css/app.css           workbench application styles
css/ai/               launcher.css, panel.css, message.css
```

Token domains cover color/surface/text/border/accent/danger/evidence, spacing,
typography/line-height, radius/elevation, 44px touch targets, content/inspector
widths, safe-area and keyboard insets, and named z layers (`base`, `sticky`,
`inspector`, `backdrop`, `sheet`, `popover`, `dialog`, `toast`). Runtime inline
styles are reserved for geometry such as virtualization offsets, progress,
graph transforms, and measured viewport values.

## Interaction principles

1. Selection reveals contextual actions; global toolbars do not show irrelevant operations.
2. Back/forward means browser navigation for canonical screens.
3. Returning restores useful state (route, query, tab, list/code scroll) without retaining large DOM trees.
4. Long-running work names user-level phases and supports explicit cancellation.
5. Empty/error states explain why no result exists and offer a next action.
6. Transient UI is destroyed on close; viewport/scroll observers have explicit cleanup.
7. Japanese is the primary copy target; layout must tolerate longer English labels and 200% text scaling.

## Test contract

- `npm run ui:test` — unit/contract checks including `tests/ui/routes.mjs`,
  `tests/ux.mjs`, `tests/ui/next-views.mjs`, `tests/ui/integration-hardening.mjs`,
  `tests/format-mnemonic-class.test.mjs`, `tests/arm64-presentation-compat.mjs`,
  `tests/panels-compat-surface.mjs`, and `tests/ui/issue-5481-call-graph-self-edge-dedupe.test.mjs`.
- `npm run ui:browser` — Playwright browser verification across `tests/ui/browser.mjs`
  (Chromium viewport matrix 375×667 through 1440×900 + WebKit),
  `tests/ui/project-settings-import.browser.mjs`, `tests/ui/analysis-navigation.mjs`,
  `tests/ui/mobile-state.mjs`, `tests/ui/accessibility.mjs`, and `npm run ai:browser`.
- `npm run decompiler:test` — includes Clean View tests (`tests/decompiler/clean-view.test.mjs`).
- `npm run browser` — real-analysis browser suite (`tests/browser.mjs`).
