import assert from "node:assert/strict";
import { showDetail, showFunctionSummary } from "../../js/panels-base.js";

function createMockElement(tag = "div") {
  const children = [];
  const classList = new Set();
  const dataset = {};
  const style = {};
  const attrs = new Map();
  const listeners = new Map();

  const elem = {
    tagName: tag.toUpperCase(),
    children,
    childNodes: children,
    parentElement: null,
    isConnected: true,
    tabIndex: 0,
    className: "",
    textContent: "",
    dataset,
    style,
    classList: {
      add: (...names) => names.forEach((n) => classList.add(n)),
      remove: (...names) => names.forEach((n) => classList.delete(n)),
      contains: (n) => classList.has(n),
    },
    setAttribute(name, val) { attrs.set(name, String(val)); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    removeAttribute(name) { attrs.delete(name); },
    append(...nodes) {
      for (const n of nodes) {
        if (n == null) continue;
        if (typeof n === "string") {
          const textNode = { textContent: n, parentElement: elem, childNodes: [] };
          children.push(textNode);
        } else {
          n.parentElement = elem;
          children.push(n);
        }
      }
    },
    replaceChildren(...nodes) {
      children.length = 0;
      this.append(...nodes);
    },
    insertBefore(node, ref) {
      if (!node) return;
      node.parentElement = elem;
      const idx = children.indexOf(ref);
      if (idx >= 0) children.splice(idx, 0, node);
      else children.push(node);
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    remove() {
      if (elem.parentElement) {
        const idx = elem.parentElement.children.indexOf(elem);
        if (idx >= 0) elem.parentElement.children.splice(idx, 1);
        elem.parentElement = null;
      }
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
  };
  return elem;
}

const overlayDiv = createMockElement("div");
overlayDiv.id = "overlays";

globalThis.document = {
  activeElement: null,
  getElementById(id) {
    if (id === "overlays") return overlayDiv;
    return null;
  },
  createElement(tag) { return createMockElement(tag); },
  createTextNode(text) { return { textContent: text, parentElement: null, childNodes: [] }; },
  body: createMockElement("body"),
  documentElement: createMockElement("html"),
};

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

globalThis.window = {
  visualViewport: null,
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: globalThis.requestAnimationFrame,
};

function makeMockApp({ region, rows, architecture, isVariable = false }) {
  const storeMap = new Map([
    ["currentRegion", region],
    ["architecture", architecture],
    ["canDisassemble", true],
    ["displayMode", "asm"],
  ]);
  const navigated = [];
  return {
    store: {
      get: (key) => storeMap.get(key),
      set: (key, val) => storeMap.set(key, val),
    },
    viewer: {
      isVariableAsm: () => isVariable,
      rowData: (row) => rows[row] || null,
      rowAddress: (row) => rows[row]?.address ?? (region.vmAddr + BigInt(row) * 4n),
      totalRows: rows.length,
    },
    symbols: {
      functionCount: 1,
      label: () => "sub_1000",
      nameAt: () => null,
      functionAt: (addr) => ({ start: 0x1000n, end: 0x1020n }),
      gen: 1,
    },
    notes: null,
    backend: {
      readAt: async () => ({ found: false }),
    },
    router: {
      navigate: (path) => navigated.push(path),
    },
    navigated,
  };
}

// Helper to find text content recursively
function collectText(node) {
  if (!node) return "";
  let s = node.textContent || "";
  for (const child of node.children || []) {
    s += " " + collectText(child);
  }
  return s;
}

// 1. x86_64 Variable Width detail presentation
{
  const region = {
    id: "text-x86",
    name: "__TEXT,__text",
    vmAddr: 0x1000n,
    fileOffset: 0x400n,
    size: 0x100n,
  };
  const rows = [
    { row: 0, address: 0x1000n, bytes: "55", mnemonic: "push", operands: "rbp", length: 1 },
    { row: 1, address: 0x1001n, bytes: "48 89 E5", mnemonic: "mov", operands: "rbp, rsp", length: 3 },
    { row: 2, address: 0x1004n, bytes: "48 83 EC 20", mnemonic: "sub", operands: "rsp, 0x20", length: 4 },
  ];
  const app = makeMockApp({ region, rows, architecture: "x86_64", isVariable: true });
  showDetail(app, 2);

  const text = collectText(overlayDiv);
  assert.match(text, /1004/i, "Detail header must contain decoded instruction address 0x1004");
  assert.match(text, /404/i, "Detail where location must contain exact fileOffset 0x404");
  assert.doesNotMatch(text, /408/i, "Detail location must not use fixed row * 4 offset");

  // Verify showFunctionSummary navigates cleanly to canonical function overview
  showFunctionSummary(app, 2);
  assert.equal(app.navigated.length, 1);
  assert.equal(app.navigated[0], "/function/4100/overview");
}

// 2. RV64IMC Variable Width detail presentation
{
  const region = {
    id: "text-rv",
    name: ".text",
    vmAddr: 0x2000n,
    fileOffset: 0x800n,
    size: 0x100n,
  };
  const rows = [
    { row: 0, address: 0x2000n, bytes: "01 00", mnemonic: "c.nop", operands: "", length: 2 },
    { row: 1, address: 0x2002n, bytes: "13 05 15 00", mnemonic: "addi", operands: "a0, a0, 1", length: 4 },
  ];
  const app = makeMockApp({ region, rows, architecture: "riscv64", isVariable: true });
  showDetail(app, 1);

  const text = collectText(overlayDiv);
  assert.match(text, /2002/i, "RV64 detail must show address 0x2002");
  assert.match(text, /802/i, "RV64 detail must show file offset 0x802");

  showFunctionSummary(app, 1);
  assert.equal(app.navigated.length, 1);
  assert.equal(app.navigated[0], "/function/8194/overview");
}

// 3. ARM64 fixed width detail presentation
{
  const region = {
    id: "text-arm64",
    name: "__TEXT,__text",
    vmAddr: 0x1000n,
    fileOffset: 0x400n,
    size: 0x100n,
  };
  const rows = [
    { row: 0, address: 0x1000n, bytes: "FD 7B BF A9", mnemonic: "stp", operands: "x29, x30, [sp, #-32]!", length: 4 },
    { row: 1, address: 0x1004n, bytes: "FD 03 00 91", mnemonic: "mov", operands: "x29, sp", length: 4 },
  ];
  const app = makeMockApp({ region, rows, architecture: "arm64", isVariable: false });
  showDetail(app, 1);

  const text = collectText(overlayDiv);
  assert.match(text, /1004/i);
}

console.log("issue-2594-showdetail-variable-width: PASS");
