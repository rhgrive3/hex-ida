/*
 * Executing an answer.
 *
 * Every action the assistant offers ends in the workbench, not in more chat:
 * an address becomes a scrolled, highlighted row; a function becomes an open
 * function; a proposal becomes a decision. On a narrow layout the panel steps
 * out of the way after navigating, because an answer the user cannot see the
 * code for is not an answer.
 */
import { toast } from '../../ui.js';
import { pick } from '../../i18n.js';
import { showXrefs, showValueFlow } from '../../panels.js';
import { showDebugger, showPatchEditor } from '../../tools.js';

function narrow() {
  return typeof window !== 'undefined' && window.innerWidth < 900;
}

function addressesEqual(a, b) {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

function toAddressBigInt(value) {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function goToCode(app, ui, addr, { select = false } = {}) {
  if (addr == null) return false;
  const moved = app.goToAddress(addr, { announce: true });
  if (!moved) return false;
  if (ui && ui.router) ui.router.navigate('/code/' + addr.toString());
  if (select) {
    const region = app.store.get('currentRegion');
    if (region) {
      const row = app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null;
      if (row != null) {
        app.viewer.select(row, false);
        app.store.set({ selectedRow: row });
      }
    }
  }
  return true;
}

/**
 * @param {object} app
 * @param {{ui: object, assistant: object}} deps
 * @returns {(action: object) => Promise<void>}
 */
export function createActionRunner(app, { ui, assistant } = {}) {
  return async function runAction(action) {
    if (!action) return;
    const addr = action.address != null ? action.address : action.target != null ? action.target : null;
    switch (action.kind) {
      case 'open-function': {
        if (addr == null) return;
        app.goToFunction(addr);
        if (ui && ui.router) ui.router.navigate('/code/' + addr.toString());
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'open-address': {
        if (!goToCode(app, ui, addr, { select: true })) {
          toast(pick('そのアドレスは開けませんでした。', 'That address could not be opened.'));
          return;
        }
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'emulate-function': {
        const targetAddr = toAddressBigInt(addr);
        if (targetAddr == null) return;
        if (ui?.actions?.has?.('emulate.function')) {
          await ui.actions.run('emulate.function', targetAddr);
        } else if (typeof app?.emulateFunction === 'function') {
          await app.emulateFunction(targetAddr);
        } else if (typeof ui?.onEmulateFunction === 'function') {
          await ui.onEmulateFunction(targetAddr);
        } else if (ui?.router) {
          ui.router.navigate('/function/' + targetAddr.toString() + '/runtime');
        } else {
          await showDebugger(app, targetAddr);
        }
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'open-patch-editor': {
        const targetAddr = toAddressBigInt(addr);
        if (targetAddr == null) return;
        if (ui?.actions?.has?.('patch.open')) {
          await ui.actions.run('patch.open', targetAddr, action);
        } else if (ui?.actions?.has?.('showPatchEditor')) {
          await ui.actions.run('showPatchEditor', targetAddr, action);
        } else if (typeof app?.openPatchEditor === 'function') {
          await app.openPatchEditor(targetAddr, action);
        } else if (typeof ui?.onOpenPatchEditor === 'function') {
          await ui.onOpenPatchEditor(targetAddr, action);
        } else {
          if (typeof app?.goToAddress === 'function') {
            goToCode(app, ui, targetAddr, { select: true });
          }
          const row = app?.viewer?.rowOfAddress ? app.viewer.rowOfAddress(targetAddr) : null;
          const insn = row != null && app?.viewer?.rowData ? app.viewer.rowData(row) : null;
          const insnArg = insn && insn.mnemonic
            ? { mnemonic: insn.mnemonic, operands: insn.operands || '', address: targetAddr }
            : undefined;
          await showPatchEditor(app, targetAddr, insnArg);
        }
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'show-xrefs': {
        if (addr == null) return;
        showXrefs(app, addr);
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'show-callers':
      case 'show-callees': {
        if (addr == null || !ui || !ui.router) return;
        ui.router.navigate('/function/' + addr.toString() + '/calls');
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'show-cfg':
      case 'show-pseudocode': {
        if (addr == null || !ui?.router) return;
        ui.router.navigate('/function/' + BigInt(addr).toString() + (action.kind === 'show-cfg' ? '/flow' : '/pseudocode'));
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'open-evidence': {
        // Schema-valid empty args must not escape the AIError boundary as a
        // raw TypeError (BigInt(null)): navigation without a target is a
        // no-op like the other null-guarded branches (#5383).
        if (addr == null) return;
        if (!goToCode(app, ui, BigInt(addr), { select: true })) return;
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'trace-value': {
        if (addr == null) return;
        const semantic = app.semantic;
        const region = app.store.get('currentRegion');
        const model = semantic && semantic.model;
        const insn = model?.instructions?.find((i) => i.address === addr || addressesEqual(i.address, addr));
        const row = insn?.row ?? (app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null);
        if (model && row != null && Number.isFinite(row)) showValueFlow(app, model, row, region);
        else if (ui && ui.router) ui.router.navigate('/function/' + addr.toString() + '/overview');
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'run-agent': {
        const target = typeof action.target === 'string' ? action.target.trim() : '';
        if (!assistant || !target) return;
        assistant.open();
        assistant.ask(target, { mode: 'agent' });
        return;
      }
      case 'review-proposal': {
        if (assistant) assistant.focusProposal(action.target);
        return;
      }
      default:
        toast(pick('この操作にはまだ対応していません。', 'That action is not supported yet.'));
    }
  };
}

export default createActionRunner;
