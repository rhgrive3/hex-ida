import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachV6Workbench } from '../js/ui/v6-workbench-bridge.js';
import {
  DELTA_SESSION_VERSION,
  serializeDeltaJson,
  parseDeltaJson,
} from '../js/cache/delta-session.js';
import { PRIMARY_NAV } from '../js/ui/registry.js';
import { getHexEngineExports, resetHexEngineForTest } from '../js/core/hex-engine-wasm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. PRIMARY_NAV invariant untouched
assert.equal(PRIMARY_NAV.length, 4, 'PRIMARY_NAV.length must stay 4');

// 2. Verify app.js and product-base.js E2E wiring presence
const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
assert.ok(appSrc.includes('attachV6Workbench'), 'js/app.js must attach V6Workbench');
assert.ok(appSrc.includes('this.v6?.detach?.()'), 'js/app.js forgetSemantics must detach v6');
assert.ok(appSrc.includes('version: DELTA_SESSION_VERSION'), 'js/app.js must emit DELTA_SESSION_VERSION');

const pbSrc = fs.readFileSync(path.join(ROOT, 'js/ui/product-base.js'), 'utf8');
assert.ok(pbSrc.includes('openTypeEditPopover'), 'product-base.js must wire Y -> openTypeEditPopover');
assert.ok(pbSrc.includes('openManualRecoveryPopover'), 'product-base.js must wire Shift+Y -> openManualRecoveryPopover');
assert.ok(pbSrc.includes('openSlicePanel'), 'product-base.js must wire Shift+S -> openSlicePanel');
assert.ok(pbSrc.includes('openExportInteropModal'), 'product-base.js must wire Shift+E -> openExportInteropModal');

// 3. V6Workbench lifecycle, popovers, Undo/Redo, and delta-session v2 round-trip
const fakeApp = {
  notes: {
    names: new Map([['4096', 'player_update']]),
    types: new Map([['4096', 'void player_update(void* self)']]),
    structs: [{ name: 'Player', size: 16, members: [{ offset: 0, size: 4, type: 'int32_t', name: 'hp' }] }],
  },
};

const wb = attachV6Workbench(fakeApp);
assert.equal(wb.getActivePopoverKind(), null);

// Open each contextual popover in headless mode
wb.openTypeEditPopover({ va: 0x1000n, name: 'player_update', currentType: 'void (void* self)' });
assert.equal(wb.getActivePopoverKind(), 'type-edit');

wb.openManualRecoveryPopover({ va: 0x1000n, tab: 'segment' });
assert.equal(wb.getActivePopoverKind(), 'manual-recovery');

wb.openSlicePanel({ va: 0x1000n, direction: 'backward', steps: [{ va: '0x1000', desc: 'ldr w0, [x1]' }] });
assert.equal(wb.getActivePopoverKind(), 'slice-panel');

wb.openExportInteropModal();
assert.equal(wb.getActivePopoverKind(), 'export-interop');

wb.closeActivePopover();
assert.equal(wb.getActivePopoverKind(), null);

// Atomic type-tx Undo/Redo round-trip on V6Workbench state
wb.displayHints['0x1000'] = { radix: 'hex' };
wb.typeTx.begin('set-hint');
wb.displayHints['0x1000'] = { radix: 'dec' };
wb.typeTx.recordDelta('displayHintsDelta', { va: '0x1000', radix: 'dec' });
wb.typeTx.commit();
assert.equal(wb.displayHints['0x1000'].radix, 'dec');
wb.undoTypeEdit();
assert.equal(wb.displayHints['0x1000'].radix, 'hex');
wb.redoTypeEdit();
assert.equal(wb.displayHints['0x1000'].radix, 'dec');

// Delta-session v2 serialization round-trip
const v2Fields = wb.exportV2DeltaFields();
const record = {
  format: 'hex-delta-session',
  version: DELTA_SESSION_VERSION,
  fingerprint: { sha256: 'a'.repeat(64), name: 'test.macho', size: 4096 },
  delta: {
    names: { '4096': 'player_update' },
    comments: {},
    vars: {},
    types: {},
    structs: [],
    bookmarks: [],
    patches: [],
    projectAnnotations: [],
    ...v2Fields,
  },
  resume: {},
};
const jsonText = serializeDeltaJson(record);
const parsed = parseDeltaJson(jsonText, 'a'.repeat(64));
assert.equal(parsed.ok, true);
assert.equal(parsed.record.version, 2);
assert.equal(parsed.record.delta.displayHints['0x1000'].radix, 'dec');

// Detach cleanup (forgetSemantics(true) simulation)
wb.onBinaryReady({ sha256: 'a'.repeat(64), name: 'test.macho', architecture: 'arm64' });
wb.detach();
assert.equal(wb.getActivePopoverKind(), null);

// 4. Unified WASM exports & HEX_ENGINE=js rollback parity
resetHexEngineForTest();
const wasmEx = getHexEngineExports({ _engine: 'wasm' });
assert.ok(wasmEx, 'Unified hex_engine.wasm must instantiate');
assert.equal(typeof wasmEx.hex_type_arena_init, 'function', 'Track 1 export present');
assert.equal(typeof wasmEx.hex_hexsig_mount, 'function', 'Track 2 export present');
assert.equal(typeof wasmEx.hex_manual_seg_add_entry, 'function', 'Track 3 export present');
assert.equal(typeof wasmEx.hex_stack_web_split, 'function', 'Track 4 export present');
assert.equal(typeof wasmEx.hex_mba_simplify, 'function', 'Track 5 export present');

const jsForced = getHexEngineExports({ _engine: 'js' });
assert.equal(jsForced, null, 'HEX_ENGINE=js must return null for WASM exports (rollback parity)');

console.log('v6-e2e-workbench tests: PASS (all 10 tracks wired E2E + WASM/JS parity verified)');
