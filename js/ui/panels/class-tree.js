/*
 * Explorer-style Virtual Class / Folder Tree panel.
 *
 * - Strictly lazy DOM expansion via `tree.getChildren(folderId, { offset, limit })`
 * - Search via `tree.search(query, { limit })`
 * - Semantic naming enrichment via `app?.v6Workbench?.getSemanticName?.(addr)`
 * - Safe navigation via `app?.goToAddress?.(addr, { announce: true })`
 * - Zero `innerHTML` usage (XSS-safe for C++ template names containing `<`, `>`, `&`)
 * - Sharp `border-radius: 0` visual styling and touch-friendly targets for iPad/mobile
 */

import { Sheet, el, button, noteBox } from '../../ui.js';
import { addrText } from '../../format.js';
import { pick } from '../../i18n.js';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_RENDER_DEPTH = 32;
const SEARCH_DEBOUNCE_MS = 140;

function showCodeRoute() {
  const router = typeof window !== 'undefined' ? window.__hexUi?.router : null;
  if (router && router.current?.route?.id !== 'code') {
    router.navigate('/code');
  }
}

function setStyles(node, styles) {
  if (!node || !node.style || !styles) return;
  for (const [k, v] of Object.entries(styles)) {
    node.style[k] = v;
  }
}

function normalizeFuncAddr(entry) {
  if (typeof entry === 'bigint') return entry;
  if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) {
    return BigInt(entry);
  }
  if (typeof entry === 'string') {
    const s = entry.trim();
    if (!s) return null;
    try {
      const b = BigInt(s);
      return b >= 0n ? b : null;
    } catch {
      return null;
    }
  }
  if (entry && typeof entry === 'object') {
    return normalizeFuncAddr(entry.addr ?? entry.fnVa ?? entry.address ?? entry.start);
  }
  return null;
}

function formatAddrSafe(addr) {
  if (addr == null) return '';
  try {
    return addrText(addr);
  } catch {
    return typeof addr === 'bigint' ? `0x${addr.toString(16)}` : String(addr);
  }
}

function resolveSemanticCard(app, addr) {
  if (addr == null || typeof app?.v6Workbench?.getSemanticName !== 'function') {
    return null;
  }
  try {
    return app.v6Workbench.getSemanticName(addr) || null;
  } catch {
    return null;
  }
}

function resolveSymbolName(app, addr) {
  if (addr == null || typeof app?.symbols?.nameAt !== 'function') return null;
  try {
    const name = app.symbols.nameAt(addr);
    return typeof name === 'string' && name.trim() ? name : null;
  } catch {
    return null;
  }
}

function confidenceLabel(confidence) {
  if (confidence === 'high') return pick('高', 'HIGH');
  if (confidence === 'medium') return pick('中', 'MED');
  if (confidence === 'low') return pick('低', 'LOW');
  return '';
}

function sourceLabel(source) {
  switch (source) {
    case 'cxx-rtti': return 'C++';
    case 'objc': return 'ObjC';
    case 'swift': return 'Swift';
    case 'api-role': return pick('役割', 'Role');
    case 'callgraph': return pick('補助', 'Helper');
    case 'unclassified': return pick('未分類', 'Other');
    default: return '';
  }
}

function createBadge(text, extraClass = '') {
  const badge = el('span', extraClass ? `class-tree-badge ${extraClass}` : 'class-tree-badge', text);
  setStyles(badge, {
    display: 'inline-block',
    padding: '1px 6px',
    marginLeft: '6px',
    fontSize: '11px',
    lineHeight: '1.4',
    border: '1px solid currentColor',
    borderRadius: '0px',
    opacity: '0.82',
    flexShrink: '0',
  });
  return badge;
}

function navigateToAddress(app, sheet, addr) {
  if (addr == null) return false;
  sheet?.close?.();
  showCodeRoute();

  let navigated = false;
  if (typeof app?.goToAddress === 'function') {
    navigated = Boolean(app.goToAddress(addr, { announce: true }));
  } else if (typeof app?.viewer?.goToAddress === 'function') {
    navigated = Boolean(app.viewer.goToAddress(addr));
  }

  if (navigated && typeof app?.viewer?.rowOfAddress === 'function') {
    const row = app.viewer.rowOfAddress(addr);
    if (row != null) {
      app.viewer?.mark?.(row);
      app.viewer?.select?.(row, false);
      app.store?.set?.({ selectedRow: row });
    }
  }
  return navigated;
}

/**
 * Show the lazy-expanding Explorer-style Virtual Class / Folder Tree sheet.
 *
 * @param {object} app
 * @param {{ tree?: object|null, pageSize?: number, searchLimit?: number }} [opts]
 * @returns {{ sheet: Sheet, rootEl: HTMLElement, searchInput: HTMLInputElement|null, treeContainer: HTMLElement|null, close: () => void, isEmpty: boolean }}
 */
export function showClassTree(app, opts = {}) {
  const tree = opts?.tree ?? app?.v6Workbench?.getVirtualTree?.() ?? null;
  const pageSize = Number.isSafeInteger(opts?.pageSize) && opts.pageSize > 0
    ? Math.min(opts.pageSize, 500)
    : DEFAULT_PAGE_SIZE;
  const searchLimit = Number.isSafeInteger(opts?.searchLimit) && opts.searchLimit > 0
    ? Math.min(opts.searchLimit, 200)
    : DEFAULT_SEARCH_LIMIT;

  let closed = false;
  let searchTimer = null;
  const expandedFolders = new Set();
  const folderOffsets = new Map();

  const cleanup = () => {
    closed = true;
    if (searchTimer != null) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    expandedFolders.clear();
    folderOffsets.clear();
  };

  const sheet = new Sheet(pick('クラスツリー', 'Class Tree'), {
    size: 'wide',
    onClose: cleanup,
  });

  const rootEl = el('div', 'class-tree-panel');
  setStyles(rootEl, {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    borderRadius: '0px',
  });

  if (!tree || typeof tree.getChildren !== 'function') {
    const emptyBox = noteBox(
      pick(
        'クラスツリーはまだ利用できません。自動解析を実行して RTTI・クラス情報を復元してください。',
        'Class tree is not available yet. Run auto-analysis to recover RTTI and class metadata.',
      ),
    );
    setStyles(emptyBox, { borderRadius: '0px' });
    rootEl.append(emptyBox);
    sheet.body.append(rootEl);
    return {
      sheet,
      rootEl,
      searchInput: null,
      treeContainer: null,
      close: () => sheet.close(),
      isEmpty: true,
    };
  }

  // Summary / stats header
  const stats = tree.stats || {};
  const summaryBar = el('div', 'class-tree-summary');
  setStyles(summaryBar, {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 8px',
    border: '1px solid var(--border, #3a3a3a)',
    borderRadius: '0px',
    fontSize: '12px',
  });

  const folderCount = Number.isFinite(stats.totalFolders) ? stats.totalFolders : 0;
  const fnCount = Number.isFinite(stats.totalFunctions) ? stats.totalFunctions : 0;
  summaryBar.append(
    el(
      'span',
      'class-tree-summary-text',
      pick(
        `フォルダ ${folderCount.toLocaleString()} / 関数 ${fnCount.toLocaleString()}`,
        `${folderCount.toLocaleString()} folders / ${fnCount.toLocaleString()} functions`,
      ),
    ),
  );
  if (tree.completeness === 'partial' || tree.truncated) {
    summaryBar.append(createBadge(pick('部分結果', 'Partial'), 'class-tree-badge-partial'));
  }

  // Search bar
  const searchRow = el('div', 'class-tree-search-row');
  setStyles(searchRow, {
    display: 'flex',
    gap: '6px',
    alignItems: 'stretch',
    borderRadius: '0px',
  });

  const searchInput = el('input', 'class-tree-search-input');
  searchInput.type = 'search';
  searchInput.autocomplete = 'off';
  searchInput.autocapitalize = 'off';
  searchInput.spellcheck = false;
  searchInput.placeholder = pick(
    'クラス名・名前空間・関数を検索...',
    'Search classes, namespaces, or functions...',
  );
  searchInput.setAttribute('aria-label', pick('クラスツリーを検索', 'Search class tree'));
  setStyles(searchInput, {
    flex: '1',
    minHeight: '40px',
    padding: '6px 10px',
    borderRadius: '0px',
    touchAction: 'manipulation',
  });

  const clearBtn = button(pick('クリア', 'Clear'), 'chip class-tree-clear-btn', () => {
    searchInput.value = '';
    renderTreeMode();
  });
  setStyles(clearBtn, {
    minHeight: '40px',
    borderRadius: '0px',
    touchAction: 'manipulation',
  });
  clearBtn.style.display = 'none';

  const searchBtn = button(pick('検索', 'Search'), 'chip class-tree-search-btn', () => {
    runSearch();
  });
  setStyles(searchBtn, {
    minHeight: '40px',
    borderRadius: '0px',
    touchAction: 'manipulation',
  });

  searchRow.append(searchInput, clearBtn, searchBtn);

  const statusLine = el('div', 'hint class-tree-status', '');
  const treeContainer = el('div', 'class-tree-view');
  treeContainer.setAttribute('role', 'tree');
  treeContainer.setAttribute('aria-label', pick('クラスツリー', 'Class Tree'));
  setStyles(treeContainer, {
    borderRadius: '0px',
  });

  const searchResultsEl = el('div', 'class-tree-search-results');
  searchResultsEl.style.display = 'none';
  setStyles(searchResultsEl, {
    borderRadius: '0px',
  });

  rootEl.append(summaryBar, searchRow, statusLine, treeContainer, searchResultsEl);
  sheet.body.append(rootEl);

  function buildFunctionRow(rawEntry, depth) {
    const addr = normalizeFuncAddr(rawEntry);
    const li = el('li', 'class-tree-func-item');
    li.setAttribute('role', 'treeitem');
    if (addr != null) li.setAttribute('data-func-addr', formatAddrSafe(addr));
    setStyles(li, {
      listStyle: 'none',
      borderRadius: '0px',
    });

    const semanticCard = resolveSemanticCard(app, addr);
    const naming = semanticCard?.naming || null;
    const hasHighOrMedSemantic = Boolean(
      naming && naming.confidence !== 'low' && (naming.labelJa || naming.nameEn),
    );
    const symName = resolveSymbolName(app, addr);
    const addrLabel = formatAddrSafe(addr);

    const primaryText = hasHighOrMedSemantic
      ? pick(naming.labelJa || naming.nameEn, naming.nameEn || naming.labelJa)
      : (symName || addrLabel || pick('不明な関数', 'Unknown function'));

    const subParts = [];
    if (addrLabel && primaryText !== addrLabel) subParts.push(addrLabel);
    if (hasHighOrMedSemantic && symName && symName !== primaryText) subParts.push(symName);
    if (semanticCard?.slotIndex != null) subParts.push(`slot ${semanticCard.slotIndex}`);

    const rowBtn = button('', 'class-tree-row class-tree-func-btn', () => {
      if (addr != null) navigateToAddress(app, sheet, addr);
    });
    setStyles(rowBtn, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      minHeight: '40px',
      padding: `6px 10px 6px ${Math.min(depth, MAX_RENDER_DEPTH) * 16 + 14}px`,
      textAlign: 'left',
      border: 'none',
      borderBottom: '1px solid var(--border, #2a2a2a)',
      borderRadius: '0px',
      background: 'transparent',
      cursor: 'pointer',
      touchAction: 'manipulation',
    });

    const leftCol = el('span', 'class-tree-row-main');
    setStyles(leftCol, {
      display: 'flex',
      flexDirection: 'column',
      minWidth: '0',
      flex: '1',
    });

    const titleSpan = el('span', 'class-tree-func-title', primaryText);
    setStyles(titleSpan, {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    leftCol.append(titleSpan);

    if (subParts.length > 0) {
      const subSpan = el('span', 'class-tree-func-sub', subParts.join(' · '));
      setStyles(subSpan, {
        fontSize: '11px',
        opacity: '0.72',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
      leftCol.append(subSpan);
    }

    rowBtn.append(leftCol);
    if (naming?.confidence) {
      const confText = confidenceLabel(naming.confidence);
      if (confText) {
        rowBtn.append(createBadge(confText, `class-tree-conf-${naming.confidence}`));
      }
    }

    li.append(rowBtn);
    return li;
  }

  function buildFolderRow(folder, depth) {
    const folderId = String(folder.id ?? '');
    const li = el('li', 'class-tree-folder-item');
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-expanded', 'false');
    li.setAttribute('data-folder-id', folderId);
    setStyles(li, {
      listStyle: 'none',
      borderRadius: '0px',
    });

    const chevron = el('span', 'class-tree-chevron', '▸');
    setStyles(chevron, {
      display: 'inline-block',
      width: '16px',
      flexShrink: '0',
    });

    const labelSpan = el('span', 'class-tree-folder-label', String(folder.label ?? folderId));
    setStyles(labelSpan, {
      flex: '1',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });

    const childList = el('ul', 'class-tree-children');
    childList.setAttribute('role', 'group');
    childList.style.display = 'none';
    setStyles(childList, {
      margin: '0',
      padding: '0',
      listStyle: 'none',
      borderRadius: '0px',
    });

    const toggleFolder = () => {
      if (closed) return;
      const isExpanded = expandedFolders.has(folderId);
      if (isExpanded) {
        expandedFolders.delete(folderId);
        folderOffsets.delete(folderId);
        if (typeof childList.querySelectorAll === 'function') {
          const descendants = childList.querySelectorAll('[data-folder-id]');
          for (let d = 0; d < descendants.length; d++) {
            const descId = descendants[d]?.getAttribute?.('data-folder-id');
            if (descId != null) {
              expandedFolders.delete(descId);
              folderOffsets.delete(descId);
            }
          }
        }
        li.setAttribute('aria-expanded', 'false');
        chevron.textContent = '▸';
        childList.style.display = 'none';
        childList.replaceChildren();
      } else {
        expandedFolders.add(folderId);
        li.setAttribute('aria-expanded', 'true');
        chevron.textContent = '▾';
        childList.style.display = '';
        renderFolderPage(folderId, childList, depth + 1, false);
      }
    };

    const rowBtn = button('', 'class-tree-row class-tree-folder-btn', toggleFolder);
    setStyles(rowBtn, {
      display: 'flex',
      alignItems: 'center',
      width: '100%',
      minHeight: '40px',
      padding: `6px 10px 6px ${Math.min(depth, MAX_RENDER_DEPTH) * 16 + 8}px`,
      textAlign: 'left',
      border: 'none',
      borderBottom: '1px solid var(--border, #2a2a2a)',
      borderRadius: '0px',
      background: 'transparent',
      cursor: 'pointer',
      touchAction: 'manipulation',
    });

    rowBtn.append(chevron, labelSpan);

    const srcText = sourceLabel(folder.source);
    if (srcText) rowBtn.append(createBadge(srcText, `class-tree-src-${folder.source}`));

    const fnCountVal = Number.isFinite(folder.functionCount) ? folder.functionCount : 0;
    rowBtn.append(createBadge(String(fnCountVal), 'class-tree-count'));

    li.append(rowBtn, childList);
    return li;
  }

  function renderFolderPage(folderId, container, depth, append) {
    if (closed || depth > MAX_RENDER_DEPTH) return;
    const offset = append ? (folderOffsets.get(folderId) ?? 0) : 0;
    if (!append) {
      container.replaceChildren();
      folderOffsets.set(folderId, 0);
    } else {
      // Remove only this folder's direct load-more row (never a nested child folder's button)
      const kids = Array.isArray(container.children) ? container.children : Array.from(container.children || []);
      for (let k = kids.length - 1; k >= 0; k--) {
        const ch = kids[k];
        if (ch?.getAttribute?.('data-load-more') === 'true' && ch?.getAttribute?.('data-load-more-for') === String(folderId)) {
          if (typeof ch.remove === 'function') ch.remove();
        }
      }
    }

    let page;
    try {
      page = tree.getChildren(folderId, { offset, limit: pageSize }) || {};
    } catch {
      page = { folders: [], functions: [], totalFolders: 0, totalFunctions: 0, hasMore: false };
    }

    const folders = Array.isArray(page.folders) ? page.folders : [];
    const functions = Array.isArray(page.functions) ? page.functions : [];
    const returnedCount = folders.length + functions.length;
    folderOffsets.set(folderId, offset + returnedCount);

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      if (!folder || typeof folder !== 'object') continue;
      container.append(buildFolderRow(folder, depth));
    }

    for (let i = 0; i < functions.length; i++) {
      container.append(buildFunctionRow(functions[i], depth));
    }

    if (page.hasMore && returnedCount > 0) {
      const moreLi = el('li', 'class-tree-load-more-item');
      moreLi.setAttribute('data-load-more', 'true');
      moreLi.setAttribute('data-load-more-for', String(folderId));
      setStyles(moreLi, { listStyle: 'none', borderRadius: '0px' });

      const moreBtn = button(
        pick('さらに表示...', 'Load more...'),
        'chip class-tree-load-more-btn',
        () => renderFolderPage(folderId, container, depth, true),
      );
      setStyles(moreBtn, {
        width: '100%',
        minHeight: '40px',
        margin: '4px 0',
        borderRadius: '0px',
        touchAction: 'manipulation',
      });
      moreLi.append(moreBtn);
      container.append(moreLi);
    }
  }

  let isFocusedFolderView = false;

  function resetToRootTree() {
    isFocusedFolderView = false;
    expandedFolders.clear();
    folderOffsets.clear();
    const freshRootUl = el('ul', 'class-tree-root-list');
    setStyles(freshRootUl, { margin: '0', padding: '0', listStyle: 'none', borderRadius: '0px' });
    treeContainer.replaceChildren(freshRootUl);
    statusLine.textContent = '';
    renderFolderPage(rootId, freshRootUl, 0, false);
  }

  function renderTreeMode() {
    if (closed) return;
    clearBtn.style.display = 'none';
    searchResultsEl.style.display = 'none';
    searchResultsEl.replaceChildren();
    treeContainer.style.display = '';
    statusLine.textContent = pick(
      'フォルダをタップして展開・関数をタップしてコードへジャンプします。',
      'Tap a folder to expand or a function to jump to its code.',
    );
  }

  function runSearch() {
    if (closed) return;
    const q = (searchInput.value || '').trim();
    if (!q) {
      renderTreeMode();
      return;
    }

    clearBtn.style.display = '';
    treeContainer.style.display = 'none';
    searchResultsEl.style.display = '';
    searchResultsEl.replaceChildren();

    let matches = [];
    if (typeof tree.search === 'function') {
      try {
        const res = tree.search(q, { limit: searchLimit });
        matches = Array.isArray(res?.matches) ? res.matches : [];
      } catch {
        matches = [];
      }
    }

    statusLine.textContent = pick(
      `「${q}」の検索結果: ${matches.length} 件`,
      `${matches.length} matches for "${q}"`,
    );

    if (matches.length === 0) {
      const empty = el(
        'div',
        'hint class-tree-search-empty',
        pick('一致するクラス・関数は見つかりませんでした。', 'No matching classes or functions found.'),
      );
      setStyles(empty, { padding: '12px 8px', borderRadius: '0px' });
      searchResultsEl.append(empty);
      return;
    }

    const ul = el('ul', 'class-tree-search-list');
    setStyles(ul, { margin: '0', padding: '0', listStyle: 'none', borderRadius: '0px' });

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (!m || typeof m !== 'object') continue;
      const li = el('li', 'class-tree-search-item');
      setStyles(li, { listStyle: 'none', borderRadius: '0px' });

      const addr = m.kind === 'function' ? normalizeFuncAddr(m.addr) : null;
      const semanticCard = addr != null ? resolveSemanticCard(app, addr) : null;
      const hasSemantic = Boolean(
        semanticCard?.naming
        && semanticCard.naming.confidence !== 'low'
        && (semanticCard.naming.labelJa || semanticCard.naming.nameEn),
      );
      const labelText = hasSemantic
        ? pick(
            semanticCard.naming.labelJa || semanticCard.naming.nameEn,
            semanticCard.naming.nameEn || semanticCard.naming.labelJa,
          )
        : String(m.label ?? m.fullPath ?? m.nodeId ?? '');

      const subText = m.kind === 'function'
        ? [formatAddrSafe(addr), m.fullPath].filter(Boolean).join(' · ')
        : String(m.fullPath ?? '');

      const rowBtn = button('', 'class-tree-row class-tree-search-hit', () => {
        if (m.kind === 'function' && addr != null) {
          navigateToAddress(app, sheet, addr);
        } else if (m.kind === 'folder' && m.nodeId != null) {
          // Return to tree view and focus matched folder with a Back-to-Root control
          searchInput.value = '';
          renderTreeMode();
          const backBtn = button(
            pick('← ルートへ戻る', '← Back to Root'),
            'class-tree-back-root-btn',
            () => {
              isFocusedFolderView = false;
              resetToRootTree();
            },
          );
          backBtn.setAttribute('data-back-to-root', 'true');
          setStyles(backBtn, {
            minHeight: '36px',
            padding: '4px 10px',
            marginBottom: '6px',
            borderRadius: '0px',
            cursor: 'pointer',
          });
          const folderUl = el('ul', 'class-tree-root-list');
          setStyles(folderUl, { margin: '0', padding: '0', listStyle: 'none', borderRadius: '0px' });
          treeContainer.replaceChildren(backBtn, folderUl);
          isFocusedFolderView = true;
          expandedFolders.clear();
          folderOffsets.clear();
          expandedFolders.add(String(m.nodeId));
          statusLine.textContent = pick(
            `フォルダ表示中: ${String(m.fullPath || m.label || m.nodeId)}`,
            `Viewing folder: ${String(m.fullPath || m.label || m.nodeId)}`,
          );
          renderFolderPage(String(m.nodeId), folderUl, 0, false);
        }
      });
      setStyles(rowBtn, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        minHeight: '40px',
        padding: '6px 10px',
        textAlign: 'left',
        border: 'none',
        borderBottom: '1px solid var(--border, #2a2a2a)',
        borderRadius: '0px',
        background: 'transparent',
        cursor: 'pointer',
        touchAction: 'manipulation',
      });

      const leftCol = el('span', 'class-tree-row-main');
      setStyles(leftCol, {
        display: 'flex',
        flexDirection: 'column',
        minWidth: '0',
        flex: '1',
      });
      leftCol.append(el('span', 'class-tree-search-title', labelText));
      if (subText) {
        const sub = el('span', 'class-tree-search-sub', subText);
        setStyles(sub, { fontSize: '11px', opacity: '0.72' });
        leftCol.append(sub);
      }

      rowBtn.append(leftCol);
      rowBtn.append(
        createBadge(
          m.kind === 'function' ? pick('関数', 'Fn') : pick('フォルダ', 'Dir'),
          `class-tree-kind-${m.kind || 'folder'}`,
        ),
      );
      if (m.confidence) {
        const confText = confidenceLabel(m.confidence);
        if (confText) rowBtn.append(createBadge(confText, `class-tree-conf-${m.confidence}`));
      }

      li.append(rowBtn);
      ul.append(li);
    }

    searchResultsEl.append(ul);
  }

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (searchTimer != null) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      runSearch();
    } else if (event.key === 'Escape') {
      searchInput.value = '';
      renderTreeMode();
      if (isFocusedFolderView) resetToRootTree();
    }
  });

  searchInput.addEventListener('input', () => {
    if (searchTimer != null) clearTimeout(searchTimer);
    const val = (searchInput.value || '').trim();
    if (!val) {
      renderTreeMode();
      return;
    }
    searchTimer = setTimeout(() => {
      searchTimer = null;
      runSearch();
    }, SEARCH_DEBOUNCE_MS);
  });

  // Initial lazy root render (only immediate children of rootId)
  const rootId = tree.rootId || 'root';
  const rootList = el('ul', 'class-tree-root-list');
  setStyles(rootList, {
    margin: '0',
    padding: '0',
    listStyle: 'none',
    borderRadius: '0px',
  });
  treeContainer.append(rootList);
  expandedFolders.add(rootId);
  renderTreeMode();
  renderFolderPage(rootId, rootList, 0, false);

  return {
    sheet,
    rootEl,
    searchInput,
    treeContainer,
    close: () => sheet.close(),
    isEmpty: false,
  };
}
