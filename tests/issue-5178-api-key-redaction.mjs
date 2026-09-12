import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ParentPageInspector } from '../js/userscript/dev/admin/page-inspector.js';

const SECRET = 'sk-proj-AbCdEf123456789';
const API_KEY_CLASS = 'api[-_]?key';

class FakeElement {
  constructor(tagName, attributes = [], children = [], text = '') {
    this.tagName = String(tagName).toUpperCase();
    this._attributes = attributes.map(([name, value]) => ({ name, value }));
    this.childNodes = [...children];
    this.text = text;
    this.parentNode = null;
    for (const child of this.childNodes) child.parentNode = this;
  }

  get attributes() { return this._attributes.map((entry) => ({ name: entry.name, value: entry.value })); }

  getAttribute(name) {
    const hit = this._attributes.find((entry) => entry.name.toLowerCase() === String(name).toLowerCase());
    return hit ? hit.value : null;
  }

  setAttribute(name, value) {
    const hit = this._attributes.find((entry) => entry.name.toLowerCase() === String(name).toLowerCase());
    if (hit) hit.value = String(value);
    else this._attributes.push({ name: String(name), value: String(value) });
  }

  removeAttribute(name) {
    this._attributes = this._attributes.filter((entry) => entry.name.toLowerCase() !== String(name).toLowerCase());
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    if (String(selector).trim() !== '*') return [];
    const out = [];
    for (const child of this.childNodes) { out.push(child); out.push(...child.querySelectorAll('*')); }
    return out;
  }

  cloneNode(deep) {
    return new FakeElement(this.tagName, this._attributes.map((entry) => [entry.name, entry.value]), deep ? this.childNodes.map((child) => child.cloneNode(true)) : [], this.text);
  }

  get outerHTML() {
    const tag = this.tagName.toLowerCase();
    const attrs = this._attributes.map((entry) => ` ${entry.name}="${entry.value}"`).join('');
    const inner = `${this.childNodes.map((child) => child.outerHTML).join('')}${this.text}`;
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
}

function inlineInspector(source) {
  const node = {
    src: '', type: '', async: false, defer: false, integrity: '', nonce: '', textContent: source,
    getAttribute(name) { return this[name] ?? null; },
  };
  const document = {
    title: 'ChatGPT',
    location: { href: 'https://chatgpt.com/g/g-p-demo/project' },
    scripts: [node],
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  return new ParentPageInspector({ document, location: document.location, fetchRef: null });
}

async function excerptFor(source, needle) {
  const result = await inlineInspector(source).scriptSource({ index: 0, needle });
  return result.excerpts.map((entry) => entry.text).join('\n');
}

function expectRedacted(text, name, label) {
  assert.ok(!text.includes(SECRET), `${label} must not leak its value: ${text}`);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(text, new RegExp(`${escaped}["']?\\s*[:=]\\s*"\\[redacted\\]"`), `${label} must be redacted in place: ${text}`);
  assert.ok(text.includes('targetMarker'), `benign needle context must survive for ${label}`);
}

async function inlineAssignmentsAreRedacted() {
  const cases = [
    [`const apiKey = "${SECRET}";\nfunction targetMarker() {}`, 'apiKey'],
    [`const api_key = "${SECRET}";\nfunction targetMarker() {}`, 'api_key'],
    [`const API_KEY = "${SECRET}";\nfunction targetMarker() {}`, 'API_KEY'],
    [`const ApiKey = "${SECRET}";\nfunction targetMarker() {}`, 'ApiKey'],
    [`const cfg = { apiKey: "${SECRET}" };\nfunction targetMarker() {}`, 'apiKey'],
    [`const cfg = { api_key: "${SECRET}" };\nfunction targetMarker() {}`, 'api_key'],
    [`const headers = { "api-key": "${SECRET}" };\nfunction targetMarker() {}`, 'api-key'],
    [`const headers = { "API-KEY": "${SECRET}" };\nfunction targetMarker() {}`, 'API-KEY'],
    [`self.__hex.API_KEY = "${SECRET}";\nfunction targetMarker() {}`, 'API_KEY'],
  ];
  for (const [source, name] of cases) {
    const text = await excerptFor(source, 'targetMarker');
    expectRedacted(text, name, `inline ${name} assignment`);
  }
}

async function existingInlineRedactionStays() {
  const source = [
    'const sessionToken = "tok-abc123456";',
    'const authToken = "auth-abc123456";',
    'const userPassword = "pw-abc123456";',
    'const localSecret = "sec-abc123456";',
    'const browserStorage = "store-abc123456";',
    'const label = "benign-visible-value";',
    'const authHeader = "Bearer abcdef123456789";',
    'function targetMarker() {}',
  ].join('\n');
  const text = await excerptFor(source, 'targetMarker');
  assert.ok(!text.includes('tok-abc123456'), 'sessionToken redaction must be preserved');
  assert.ok(!text.includes('auth-abc123456'), 'authToken redaction must be preserved');
  assert.ok(!text.includes('pw-abc123456'), 'password redaction must be preserved');
  assert.ok(!text.includes('sec-abc123456'), 'secret redaction must be preserved');
  assert.ok(!text.includes('store-abc123456'), 'storage redaction must be preserved');
  assert.ok(!text.includes('abcdef123456789'), 'bearer redaction must be preserved');
  assert.ok(text.includes('"benign-visible-value"'), 'non-sensitive assignments must not be stripped');
}

async function sensitiveNeedlesAreRejected() {
  for (const needle of ['apiKey', 'api_key', 'API-KEY', 'x-api-key', 'sessionToken']) {
    let code = null;
    try {
      await inlineInspector('function targetMarker() {}').scriptSource({ index: 0, needle });
    } catch (error) {
      code = error?.code;
    }
    assert.equal(code, 'inline-sensitive-needle', `needle ${needle} must be rejected as sensitive`);
  }
  const allowed = await inlineInspector('function targetMarker() {}').scriptSource({ index: 0, needle: 'targetMarker' });
  assert.equal(allowed.kind, 'chatgpt-page-script-source', 'benign needles must stay allowed');
}

function htmlInspector(root) {
  const document = {
    title: 'ChatGPT',
    location: { href: 'https://chatgpt.com/g/g-p-demo/project' },
    scripts: [],
    querySelectorAll() { return []; },
    querySelector: (selector) => (selector === 'body' ? root : null),
  };
  return new ParentPageInspector({ document, location: document.location, fetchRef: null });
}

function htmlAttributesAreRedacted() {
  const root = new FakeElement('body', [], [
    new FakeElement('div', [
      ['id', 'app'],
      ['data-api-key', SECRET],
      ['data-apikey', SECRET],
      ['data-API-KEY', SECRET],
      ['data-token', 'tok-abc123456'],
      ['data-plan', 'pro'],
      ['class', 'shell'],
    ], [], 'marker'),
  ]);
  const html = htmlInspector(root).snapshot({ selectors: [], includeHtml: true, htmlSelector: 'body' }).html;
  assert.ok(!html.includes(SECRET), `api-key attributes must not leak their value: ${html}`);
  assert.ok(!html.includes('tok-abc123456'), 'existing data-token redaction must be preserved');
  assert.ok(html.includes('data-plan="pro"'), 'non-sensitive data-* attributes must be preserved');
  assert.ok(html.includes('id="app"') && html.includes('class="shell"'), 'safe identity attributes must be preserved');
  assert.ok(html.includes('marker'), 'element text must be preserved');
}

function redactionPoliciesStayAligned() {
  const inspectorSource = fs.readFileSync(new URL('../js/userscript/dev/admin/page-inspector.js', import.meta.url), 'utf8');
  const recoverySource = fs.readFileSync(new URL('../js/ai/dev/supervisor/tool-error-recovery.js', import.meta.url), 'utf8');
  for (const name of ['SENSITIVE_ATTRIBUTE', 'SENSITIVE_INLINE_NEEDLE', 'SENSITIVE_SCRIPT_ASSIGNMENT']) {
    const line = inspectorSource.split('\n').find((entry) => entry.startsWith(`const ${name} =`));
    assert.ok(line, `page-inspector.js must keep ${name}`);
    assert.ok(line.includes(API_KEY_CLASS), `${name} must treat api key names as sensitive`);
  }
  const recoveryLine = recoverySource.split('\n').find((entry) => entry.startsWith('const SENSITIVE_KEY ='));
  assert.ok(recoveryLine?.includes(API_KEY_CLASS), 'tool-error redaction must keep the same api key class');
}

await inlineAssignmentsAreRedacted();
await existingInlineRedactionStays();
await sensitiveNeedlesAreRejected();
htmlAttributesAreRedacted();
redactionPoliciesStayAligned();

console.log('issue #5178 apiKey/api-key redaction regressions PASS');
