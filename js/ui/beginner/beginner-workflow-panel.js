// XSS-safe beginner workflow panel built strictly with DOM node creation and textContent.
// Zero dependency on architecture or semantics modules (INV-005 compliant).

import {
  AUTO_ANALYSIS_STATUS,
  PATCH_RISK_LEVEL,
  safeInvokeCallback,
} from '../../analysis/common/v6-auto-contracts.js';
import { pick } from '../../i18n.js';

const ACTIVE_PANELS = new WeakMap();

const VALID_RISK_LEVELS = new Set(Object.values(PATCH_RISK_LEVEL));

function toSafeText(value) {
  if (value == null) return '';
  return String(value);
}

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(100, Math.max(0, Math.round(num)));
}

function setAttr(el, name, value) {
  if (el && typeof el.setAttribute === 'function') {
    el.setAttribute(name, toSafeText(value));
  }
}

function appendChild(parent, child) {
  if (parent && child && typeof parent.appendChild === 'function') {
    parent.appendChild(child);
  }
}

function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === 'function') {
    node.replaceChildren();
    return;
  }
  if (typeof node.removeChild === 'function') {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
    while (Array.isArray(node.children) && node.children.length > 0) {
      node.removeChild(node.children[node.children.length - 1]);
    }
    return;
  }
  if (Array.isArray(node.childNodes)) {
    node.childNodes.length = 0;
  }
  if (Array.isArray(node.children)) {
    node.children.length = 0;
  }
}

function createEl(doc, tag, className = '', text = null) {
  const el = doc.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== null && text !== undefined) {
    el.textContent = toSafeText(text);
  }
  return el;
}

function statusLabel(status) {
  switch (status) {
    case AUTO_ANALYSIS_STATUS.IDLE:
      return pick('待機中', 'Idle');
    case AUTO_ANALYSIS_STATUS.RUNNING:
      return pick('解析中', 'Running');
    case AUTO_ANALYSIS_STATUS.DONE:
      return pick('完了', 'Done');
    case AUTO_ANALYSIS_STATUS.SKIPPED:
      return pick('スキップ', 'Skipped');
    case AUTO_ANALYSIS_STATUS.OFFLINE:
      return pick('オフライン', 'Offline');
    case AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED:
      return pick('時間上限で一時停止', 'Time budget reached');
    case AUTO_ANALYSIS_STATUS.MEMORY_LIMIT:
      return pick('メモリ上限で一時停止', 'Memory limit reached');
    case AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH:
      return pick('未対応アーキテクチャ', 'Unsupported architecture');
    case AUTO_ANALYSIS_STATUS.ABORTED:
      return pick('中断', 'Aborted');
    case AUTO_ANALYSIS_STATUS.STALE:
      return pick('古い結果', 'Stale');
    case AUTO_ANALYSIS_STATUS.ERROR:
      return pick('エラー', 'Error');
    default:
      return toSafeText(status || pick('不明', 'Unknown'));
  }
}

function categoryLabel(category) {
  switch (category) {
    case 'entrypoint':
      return pick('開始地点', 'Entrypoint');
    case 'crypto':
      return pick('暗号・ハッシュ', 'Crypto');
    case 'obfuscated':
      return pick('難読化', 'Obfuscated');
    case 'rmw':
      return pick('同期・原子的処理', 'Atomic / RMW');
    case 'library':
      return pick('ライブラリ', 'Library');
    case 'app_logic':
      return pick('アプリ処理', 'App Logic');
    default:
      return toSafeText(category || pick('一般', 'General'));
  }
}

function riskLevelLabel(level) {
  switch (level) {
    case PATCH_RISK_LEVEL.LOW:
      return pick('低リスク (LOW)', 'Low risk (LOW)');
    case PATCH_RISK_LEVEL.MEDIUM:
      return pick('中リスク (MEDIUM)', 'Medium risk (MEDIUM)');
    case PATCH_RISK_LEVEL.HIGH:
      return pick('高リスク (HIGH)', 'High risk (HIGH)');
    case PATCH_RISK_LEVEL.UNKNOWN:
    default:
      return pick('不明 (UNKNOWN)', 'Unknown (UNKNOWN)');
  }
}

function createNoopHandle() {
  return {
    root: null,
    update() {},
    destroy() {},
  };
}

/**
 * Render an XSS-safe beginner workflow panel into `container` using only DOM element
 * creation and `textContent`. Automatically destroys any prior panel mounted on the
 * same container and cleans up all event listeners on `update()` and `destroy()`.
 *
 * @param {object|null|undefined} container
 * @param {object|null} [model=null]
 * @param {{ doc?: object|null, onSelectFunction?: Function|null, onSelectGlossary?: Function|null }} [options]
 * @returns {{ root: object|null, update: (nextModel: object|null) => void, destroy: () => void }}
 */
export function renderBeginnerWorkflowPanel(
  container,
  model = null,
  { doc = null, onSelectFunction = null, onSelectGlossary = null } = {},
) {
  if (!container || typeof container !== 'object') {
    return createNoopHandle();
  }

  const resolvedDoc =
    doc ||
    container.ownerDocument ||
    (typeof document !== 'undefined' ? document : null);

  if (!resolvedDoc || typeof resolvedDoc.createElement !== 'function') {
    return createNoopHandle();
  }

  // Re-mount protection: tear down any existing panel bound to this container.
  const existingHandle = ACTIVE_PANELS.get(container);
  if (existingHandle && typeof existingHandle.destroy === 'function') {
    existingHandle.destroy();
  }

  const listeners = [];
  let destroyed = false;

  const root = createEl(resolvedDoc, 'section', 'beginner-workflow-panel');
  setAttr(root, 'data-panel', 'beginner-workflow');

  clearChildren(container);
  appendChild(container, root);

  function addListener(target, type, handler) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler);
    listeners.push({ target, type, handler });
  }

  function clearListeners() {
    for (let i = listeners.length - 1; i >= 0; i--) {
      const entry = listeners[i];
      if (entry.target && typeof entry.target.removeEventListener === 'function') {
        entry.target.removeEventListener(entry.type, entry.handler);
      }
    }
    listeners.length = 0;
  }

  function renderProgressSection(progress) {
    const section = createEl(resolvedDoc, 'section', 'beginner-section beginner-progress');
    setAttr(section, 'data-section', 'progress');
    appendChild(
      section,
      createEl(resolvedDoc, 'h3', 'beginner-section-title', pick('自動解析の進捗', 'Auto-Analysis Progress')),
    );

    if (!progress || typeof progress !== 'object') {
      const empty = createEl(
        resolvedDoc,
        'p',
        'beginner-empty',
        pick('自動解析はまだ開始されていません。', 'Auto-analysis has not started yet.'),
      );
      setAttr(empty, 'data-empty', 'progress');
      appendChild(section, empty);
      return section;
    }

    const percent = clampPercent(progress.percent);
    const overallStatus = toSafeText(progress.overallStatus || AUTO_ANALYSIS_STATUS.IDLE);

    const summaryRow = createEl(resolvedDoc, 'div', 'beginner-progress-summary');
    const statusBadge = createEl(resolvedDoc, 'span', 'beginner-status-badge', statusLabel(overallStatus));
    setAttr(statusBadge, 'data-status', overallStatus);
    appendChild(summaryRow, statusBadge);

    const pctEl = createEl(resolvedDoc, 'span', 'beginner-progress-percent', `${percent}%`);
    setAttr(pctEl, 'role', 'progressbar');
    setAttr(pctEl, 'aria-valuemin', '0');
    setAttr(pctEl, 'aria-valuemax', '100');
    setAttr(pctEl, 'aria-valuenow', String(percent));
    setAttr(pctEl, 'data-percent', String(percent));
    appendChild(summaryRow, pctEl);
    appendChild(section, summaryRow);

    if (progress.headline) {
      appendChild(section, createEl(resolvedDoc, 'p', 'beginner-progress-headline', progress.headline));
    }
    if (progress.nextAction) {
      appendChild(section, createEl(resolvedDoc, 'p', 'beginner-progress-next-action', progress.nextAction));
    }

    if (Array.isArray(progress.phases) && progress.phases.length > 0) {
      const phaseList = createEl(resolvedDoc, 'ul', 'beginner-phase-list');
      for (const phase of progress.phases) {
        if (!phase || typeof phase !== 'object') continue;
        const li = createEl(resolvedDoc, 'li', 'beginner-phase-item');
        if (phase.id) setAttr(li, 'data-phase-id', phase.id);
        if (phase.status) setAttr(li, 'data-phase-status', phase.status);

        const labelText = toSafeText(phase.label || phase.id || '');
        const statusText = statusLabel(phase.status);
        appendChild(li, createEl(resolvedDoc, 'span', 'beginner-phase-label', labelText));
        appendChild(li, createEl(resolvedDoc, 'span', 'beginner-phase-status', statusText));

        if (phase.detail) {
          appendChild(li, createEl(resolvedDoc, 'span', 'beginner-phase-detail', phase.detail));
        } else if (Number.isFinite(phase.completed) && Number.isFinite(phase.total) && phase.total > 0) {
          appendChild(
            li,
            createEl(resolvedDoc, 'span', 'beginner-phase-detail', `${phase.completed}/${phase.total}`),
          );
        }
        appendChild(phaseList, li);
      }
      appendChild(section, phaseList);
    }

    return section;
  }

  function renderStarterFunctionsSection(starterFunctions) {
    const section = createEl(resolvedDoc, 'section', 'beginner-section beginner-starters');
    setAttr(section, 'data-section', 'starter-functions');
    appendChild(
      section,
      createEl(resolvedDoc, 'h3', 'beginner-section-title', pick('最初に見るべき関数', 'Recommended Starting Functions')),
    );

    const validItems = Array.isArray(starterFunctions)
      ? starterFunctions.filter((item) => item && typeof item === 'object' && typeof item.vaHex === 'string' && item.vaHex.length > 0)
      : [];

    if (validItems.length === 0) {
      const empty = createEl(
        resolvedDoc,
        'p',
        'beginner-empty',
        pick('おすすめの関数はまだありません。解析が進むと表示されます。', 'No recommended functions yet. They will appear as analysis progresses.'),
      );
      setAttr(empty, 'data-empty', 'starter-functions');
      appendChild(section, empty);
      return section;
    }

    const list = createEl(resolvedDoc, 'ul', 'beginner-starter-list');
    for (const item of validItems) {
      const li = createEl(resolvedDoc, 'li', 'beginner-starter-entry');
      const btn = createEl(resolvedDoc, 'button', 'beginner-starter-btn');
      setAttr(btn, 'type', 'button');
      setAttr(btn, 'data-va-hex', item.vaHex);
      if (item.category) {
        setAttr(btn, 'data-category', item.category);
      }

      const title = toSafeText(item.displayName || item.vaHex);
      appendChild(btn, createEl(resolvedDoc, 'span', 'beginner-starter-name', title));
      appendChild(btn, createEl(resolvedDoc, 'span', 'beginner-starter-va', item.vaHex));
      if (item.category) {
        appendChild(btn, createEl(resolvedDoc, 'span', 'beginner-starter-category', categoryLabel(item.category)));
      }
      if (item.reason) {
        appendChild(btn, createEl(resolvedDoc, 'span', 'beginner-starter-reason', item.reason));
      }

      const vaHex = item.vaHex;
      addListener(btn, 'click', () => {
        safeInvokeCallback(onSelectFunction, vaHex);
      });

      appendChild(li, btn);
      appendChild(list, li);
    }
    appendChild(section, list);
    return section;
  }

  function renderActiveCardSection(activeCard) {
    const section = createEl(resolvedDoc, 'section', 'beginner-section beginner-active-card');
    setAttr(section, 'data-section', 'active-card');
    appendChild(
      section,
      createEl(resolvedDoc, 'h3', 'beginner-section-title', pick('選択中の関数ガイド', 'Active Function Guide')),
    );

    if (!activeCard || typeof activeCard !== 'object') {
      const empty = createEl(
        resolvedDoc,
        'p',
        'beginner-empty',
        pick('関数を選択すると、わかりやすい解説が表示されます。', 'Select a function to see a plain-language explanation.'),
      );
      setAttr(empty, 'data-empty', 'active-card');
      appendChild(section, empty);
      return section;
    }

    if (activeCard.headline) {
      appendChild(section, createEl(resolvedDoc, 'h4', 'beginner-card-headline', activeCard.headline));
    }

    if (Array.isArray(activeCard.whatItDoes)) {
      const lines = activeCard.whatItDoes
        .filter((line) => line != null && String(line).trim() !== '')
        .map((line) => String(line));
      if (lines.length > 0) {
        const list = createEl(resolvedDoc, 'ul', 'beginner-card-what-list');
        setAttr(list, 'data-field', 'what-it-does');
        for (const line of lines) {
          appendChild(list, createEl(resolvedDoc, 'li', 'beginner-card-what-item', line));
        }
        appendChild(section, list);
      }
    } else if (typeof activeCard.whatItDoes === 'string' && activeCard.whatItDoes.trim() !== '') {
      const p = createEl(resolvedDoc, 'p', 'beginner-card-what-text', activeCard.whatItDoes);
      setAttr(p, 'data-field', 'what-it-does');
      appendChild(section, p);
    }

    if (typeof activeCard.patchImpact === 'string' && activeCard.patchImpact.trim() !== '') {
      const impactWrap = createEl(resolvedDoc, 'div', 'beginner-card-patch-impact');
      appendChild(
        impactWrap,
        createEl(resolvedDoc, 'strong', 'beginner-card-label', pick('書き換えた場合の影響', 'Patch Impact')),
      );
      appendChild(impactWrap, createEl(resolvedDoc, 'p', 'beginner-card-text', activeCard.patchImpact));
      appendChild(section, impactWrap);
    }

    if (Array.isArray(activeCard.v6Highlights) && activeCard.v6Highlights.length > 0) {
      const highlights = activeCard.v6Highlights
        .filter((h) => h != null && String(h).trim() !== '')
        .map((h) => String(h));
      if (highlights.length > 0) {
        const hlWrap = createEl(resolvedDoc, 'div', 'beginner-card-highlights');
        appendChild(
          hlWrap,
          createEl(resolvedDoc, 'strong', 'beginner-card-label', pick('自動解析の検出ポイント', 'Auto-Analysis Highlights')),
        );
        const ul = createEl(resolvedDoc, 'ul', 'beginner-card-highlight-list');
        for (const h of highlights) {
          appendChild(ul, createEl(resolvedDoc, 'li', 'beginner-card-highlight-item', h));
        }
        appendChild(hlWrap, ul);
        appendChild(section, hlWrap);
      }
    }

    if (Array.isArray(activeCard.glossaryMatches) && activeCard.glossaryMatches.length > 0) {
      const keys = activeCard.glossaryMatches
        .filter((k) => typeof k === 'string' && k.trim() !== '');
      if (keys.length > 0) {
        const matchWrap = createEl(resolvedDoc, 'div', 'beginner-card-glossary-matches');
        appendChild(
          matchWrap,
          createEl(resolvedDoc, 'strong', 'beginner-card-label', pick('出てきた用語', 'Matched Terms')),
        );
        const chips = createEl(resolvedDoc, 'div', 'beginner-glossary-chips');
        for (const key of keys) {
          const btn = createEl(resolvedDoc, 'button', 'beginner-glossary-chip', key);
          setAttr(btn, 'type', 'button');
          setAttr(btn, 'data-glossary-key', key);
          addListener(btn, 'click', () => {
            safeInvokeCallback(onSelectGlossary, key);
          });
          appendChild(chips, btn);
        }
        appendChild(matchWrap, chips);
        appendChild(section, matchWrap);
      }
    }

    return section;
  }

  function renderPatchRiskSection(patchRisk) {
    const section = createEl(resolvedDoc, 'section', 'beginner-section beginner-patch-risk');
    setAttr(section, 'data-section', 'patch-risk');
    appendChild(
      section,
      createEl(resolvedDoc, 'h3', 'beginner-section-title', pick('パッチ安全性', 'Patch Risk')),
    );

    if (!patchRisk || typeof patchRisk !== 'object') {
      const empty = createEl(
        resolvedDoc,
        'p',
        'beginner-empty',
        pick('安全性評価はまだありません。', 'No patch risk assessment available yet.'),
      );
      setAttr(empty, 'data-empty', 'patch-risk');
      appendChild(section, empty);
      return section;
    }

    const level = VALID_RISK_LEVELS.has(patchRisk.level) ? patchRisk.level : PATCH_RISK_LEVEL.UNKNOWN;
    const badge = createEl(resolvedDoc, 'span', 'beginner-risk-badge', riskLevelLabel(level));
    setAttr(badge, 'data-risk-level', level);
    appendChild(section, badge);

    if (typeof patchRisk.score === 'number' && Number.isFinite(patchRisk.score)) {
      appendChild(
        section,
        createEl(
          resolvedDoc,
          'span',
          'beginner-risk-score',
          pick(`危険度スコア: ${patchRisk.score}/100`, `Risk score: ${patchRisk.score}/100`),
        ),
      );
    }

    if (patchRisk.isFailSafe === true) {
      appendChild(
        section,
        createEl(
          resolvedDoc,
          'p',
          'beginner-risk-failsafe',
          pick(
            '命令情報が不足しているため、安全側（不明）として判定しています。',
            'Assessed as unknown (fail-safe) because instruction evidence is unavailable.',
          ),
        ),
      );
    }

    if (Array.isArray(patchRisk.reasons) && patchRisk.reasons.length > 0) {
      const reasons = patchRisk.reasons.filter((r) => r != null && String(r).trim() !== '');
      if (reasons.length > 0) {
        const ul = createEl(resolvedDoc, 'ul', 'beginner-risk-reasons');
        for (const reason of reasons) {
          appendChild(ul, createEl(resolvedDoc, 'li', 'beginner-risk-reason', reason));
        }
        appendChild(section, ul);
      }
    }

    if (Array.isArray(patchRisk.cautions) && patchRisk.cautions.length > 0) {
      const cautions = patchRisk.cautions.filter((c) => c != null && String(c).trim() !== '');
      if (cautions.length > 0) {
        const ul = createEl(resolvedDoc, 'ul', 'beginner-risk-cautions');
        for (const caution of cautions) {
          appendChild(ul, createEl(resolvedDoc, 'li', 'beginner-risk-caution', caution));
        }
        appendChild(section, ul);
      }
    }

    return section;
  }

  function renderGlossarySection(glossaryEntries) {
    const section = createEl(resolvedDoc, 'section', 'beginner-section beginner-glossary');
    setAttr(section, 'data-section', 'glossary');
    appendChild(
      section,
      createEl(resolvedDoc, 'h3', 'beginner-section-title', pick('用語ガイド', 'Glossary Guide')),
    );

    const validEntries = Array.isArray(glossaryEntries)
      ? glossaryEntries.filter((entry) => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.length > 0)
      : [];

    if (validEntries.length === 0) {
      const empty = createEl(
        resolvedDoc,
        'p',
        'beginner-empty',
        pick('関連する用語はまだありません。', 'No related glossary terms yet.'),
      );
      setAttr(empty, 'data-empty', 'glossary');
      appendChild(section, empty);
      return section;
    }

    const list = createEl(resolvedDoc, 'ul', 'beginner-glossary-list');
    for (const entry of validEntries) {
      const li = createEl(resolvedDoc, 'li', 'beginner-glossary-entry');
      const btn = createEl(resolvedDoc, 'button', 'beginner-glossary-btn');
      setAttr(btn, 'type', 'button');
      setAttr(btn, 'data-glossary-key', entry.key);

      const termText = toSafeText(entry.term || entry.shortLabel || entry.key);
      appendChild(btn, createEl(resolvedDoc, 'span', 'beginner-glossary-term', termText));
      if (entry.shortLabel && entry.shortLabel !== termText) {
        appendChild(btn, createEl(resolvedDoc, 'span', 'beginner-glossary-short', entry.shortLabel));
      }
      if (entry.explanation) {
        appendChild(btn, createEl(resolvedDoc, 'span', 'beginner-glossary-explanation', entry.explanation));
      }
      if (entry.tip) {
        appendChild(btn, createEl(resolvedDoc, 'span', 'beginner-glossary-tip', entry.tip));
      }

      const key = entry.key;
      addListener(btn, 'click', () => {
        safeInvokeCallback(onSelectGlossary, key);
      });

      appendChild(li, btn);
      appendChild(list, li);
    }
    appendChild(section, list);
    return section;
  }

  function render(currentModel) {
    clearListeners();
    clearChildren(root);

    const safeModel = currentModel && typeof currentModel === 'object' ? currentModel : {};
    const header = createEl(resolvedDoc, 'header', 'beginner-workflow-header');
    appendChild(header, createEl(resolvedDoc, 'h2', 'beginner-workflow-title', pick('初心者ガイド', 'Beginner Guide')));
    appendChild(root, header);

    appendChild(root, renderProgressSection(safeModel.progress ?? null));
    appendChild(root, renderStarterFunctionsSection(safeModel.starterFunctions ?? []));
    appendChild(root, renderActiveCardSection(safeModel.activeCard ?? null));

    const effectivePatchRisk = safeModel.patchRisk ?? safeModel.activeCard?.patchRisk ?? null;
    appendChild(root, renderPatchRiskSection(effectivePatchRisk));
    appendChild(root, renderGlossarySection(safeModel.glossaryEntries ?? []));
  }

  const handle = {
    root,
    update(nextModel) {
      if (destroyed) return;
      render(nextModel);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearListeners();
      clearChildren(root);
      if (root.parentNode === container && typeof container.removeChild === 'function') {
        container.removeChild(root);
      } else {
        clearChildren(container);
      }
      if (ACTIVE_PANELS.get(container) === handle) {
        ACTIVE_PANELS.delete(container);
      }
    },
  };

  ACTIVE_PANELS.set(container, handle);
  render(model);

  return handle;
}
