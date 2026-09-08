import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  process.env.HEX_5025_SOURCE_PATH || new URL('../js/userscript/entry.js', import.meta.url),
  'utf8',
);
assert.match(source, /function installLegacyLauncher\(host\)/);
assert.match(source, /function showLegacyFailure\(launcher, error\)/);

const functions = {
  installLegacyLauncher: extractFunction(source, 'function installLegacyLauncher(host)', '\nasync function revealLegacyWhenReady'),
  showLegacy: extractFunction(source, 'function showLegacy(host, launcher)', '\nfunction setLegacyLauncherState'),
  showLegacyFailure: extractFunction(source, 'function showLegacyFailure(launcher, error)', '\nfunction cleanupPreviousSession'),
};

function runPortableRegression() {
  const normal = createScenario();
  const normalLauncher = normal.runtime.installLegacyLauncher(normal.host);
  normalLauncher.click();
  assert.deepEqual(snapshot(normal), {
    visible: true,
    pointerEvents: 'auto',
    ariaHidden: null,
    launcherHidden: true,
    launcherText: 'HEX',
    details: 0,
  }, 'normal launcher click must reveal the initialized host');

  const failure = createScenario();
  const failureLauncher = failure.runtime.installLegacyLauncher(failure.host);
  failure.runtime.showLegacyFailure(failureLauncher, new Error('startup failed'));
  failureLauncher.click();
  assert.deepEqual(snapshot(failure), {
    visible: false,
    pointerEvents: 'none',
    ariaHidden: 'true',
    launcherHidden: false,
    launcherText: 'Hex failed — tap for details',
    details: 1,
  }, 'failure details click must not reveal the uninitialized host');

  const old = createScenario();
  const oldLauncher = old.runtime.installLegacyLauncher(old.host);
  if (!functions.installLegacyLauncher.includes("addEventListener('click'")) {
    oldLauncher.addEventListener('click', () => old.runtime.showLegacy(old.host, oldLauncher));
  }
  old.runtime.showLegacyFailure(oldLauncher, new Error('startup failed'));
  oldLauncher.click();
  assert.equal(old.details, 1, 'old behavior still opens failure details');
  assert.equal(old.host.style.visibility, 'visible', 'old addEventListener + onclick behavior reproduces the bug');
  assert.equal(old.host.style.pointerEvents, 'auto');
  assert.equal(old.host.getAttribute('aria-hidden'), null);
}

async function runBrowserRegression() {
  const moduleName = process.env.HEX_PLAYWRIGHT_MODULE || 'playwright';
  const playwright = await import(moduleName);
  const { chromium } = playwright.default || playwright;
  const executablePath = process.env.HEX_CHROMIUM_PATH || chromium.executablePath();
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(({ installSource, showSource, failureSource }) => {
      const makeFunctions = new Function('document', 'alert', `${showSource}\n${failureSource}\n${installSource}\nreturn { installLegacyLauncher, showLegacy, showLegacyFailure };`);
      let details = 0;
      const runtime = makeFunctions(document, () => { details += 1; });
      const mount = () => {
        document.getElementById('hex-userscript-launcher')?.remove();
        document.body.innerHTML = '<div id="hex-userscript-host" aria-hidden="true"></div>';
        const host = document.getElementById('hex-userscript-host');
        host.style.visibility = 'hidden';
        host.style.pointerEvents = 'none';
        return { host, launcher: runtime.installLegacyLauncher(host) };
      };
      const normal = mount();
      normal.launcher.click();
      const normalResult = {
        visible: normal.host.style.visibility === 'visible',
        pointerEvents: normal.host.style.pointerEvents,
        ariaHidden: normal.host.getAttribute('aria-hidden'),
        launcherHidden: normal.launcher.hidden,
      };
      const failure = mount();
      runtime.showLegacyFailure(failure.launcher, new Error('startup failed'));
      failure.launcher.click();
      const failureResult = {
        visible: failure.host.style.visibility === 'visible',
        pointerEvents: failure.host.style.pointerEvents,
        ariaHidden: failure.host.getAttribute('aria-hidden'),
        launcherHidden: failure.launcher.hidden,
        details,
      };
      const old = mount();
      if (!installSource.includes("addEventListener('click'")) {
        old.launcher.addEventListener('click', () => runtime.showLegacy(old.host, old.launcher));
      }
      runtime.showLegacyFailure(old.launcher, new Error('startup failed'));
      old.launcher.click();
      return {
        normal: normalResult,
        failure: failureResult,
        old: {
          visible: old.host.style.visibility === 'visible',
          pointerEvents: old.host.style.pointerEvents,
          ariaHidden: old.host.getAttribute('aria-hidden'),
          details,
        },
      };
    }, {
      installSource: functions.installLegacyLauncher,
      showSource: functions.showLegacy,
      failureSource: functions.showLegacyFailure,
    });
    console.log(`issue 5025 real Chromium: ${JSON.stringify(result)}`);
    assert.deepEqual(result.normal, {
      visible: true, pointerEvents: 'auto', ariaHidden: null, launcherHidden: true,
    });
    assert.deepEqual(result.failure, {
      visible: false, pointerEvents: 'none', ariaHidden: 'true', launcherHidden: false, details: 1,
    });
    assert.deepEqual(result.old, {
      visible: true, pointerEvents: 'auto', ariaHidden: null, details: 2,
    });
  } finally {
    await browser.close();
  }
}

function createScenario() {
  const document = new FakeDocument();
  const host = new FakeElement('div');
  host.id = 'hex-userscript-host';
  host.setAttribute('aria-hidden', 'true');
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  document.register(host);
  const scenario = { document, host, details: 0 };
  const makeFunctions = new Function('document', 'alert', `${functions.showLegacy}\n${functions.showLegacyFailure}\n${functions.installLegacyLauncher}\nreturn { installLegacyLauncher, showLegacy, showLegacyFailure };`);
  scenario.runtime = makeFunctions(document, () => { scenario.details += 1; });
  return scenario;
}

function snapshot(scenario) {
  return {
    visible: scenario.host.style.visibility === 'visible',
    pointerEvents: scenario.host.style.pointerEvents,
    ariaHidden: scenario.host.getAttribute('aria-hidden'),
    launcherHidden: scenario.document.getElementById('hex-userscript-launcher')?.hidden ?? null,
    launcherText: scenario.document.getElementById('hex-userscript-launcher')?.textContent ?? null,
    details: scenario.details,
  };
}

function extractFunction(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source function boundary: ${start}`);
  return text.slice(from, to).trim();
}

class FakeDocument {
  constructor() {
    this.nodes = new Map();
    this.documentElement = { append: (node) => this.register(node) };
  }
  createElement(tagName) { return new FakeElement(tagName); }
  getElementById(id) { return this.nodes.get(id) || null; }
  register(node) { if (node.id) this.nodes.set(node.id, node); }
}

class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.style = {};
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.onclick = null;
    this.textContent = '';
    this.id = '';
    this.type = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    if (typeof this.onclick === 'function') this.onclick.call(this, new Event('click'));
  }
}

if (process.env.HEX_5025_BROWSER === '1') await runBrowserRegression();
runPortableRegression();
console.log('issue 5025 legacy failure launcher: ok');
