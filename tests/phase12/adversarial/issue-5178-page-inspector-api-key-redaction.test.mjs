import assert from 'node:assert/strict';
import test from 'node:test';

import { ParentPageInspector } from '../../../js/userscript/dev/admin/page-inspector.js';

class FakeElement {
  constructor(tagName, { attributes = {}, children = [], text = '' } = {}) {
    this.tagName = String(tagName).toUpperCase();
    this._attributes = new Map(Object.entries(attributes));
    this.children = children;
    this.text = text;
  }

  get attributes() {
    return [...this._attributes].map(([name, value]) => ({ name, value }));
  }

  getAttribute(name) {
    const key = String(name);
    return this._attributes.has(key) ? this._attributes.get(key) : null;
  }

  setAttribute(name, value) {
    this._attributes.set(String(name), String(value));
  }

  removeAttribute(name) {
    this._attributes.delete(String(name));
  }

  querySelectorAll(selector) {
    if (selector !== '*') return [];
    return this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
  }

  cloneNode(deep = false) {
    return new FakeElement(this.tagName, {
      attributes: Object.fromEntries(this._attributes),
      children: deep ? this.children.map((child) => child.cloneNode(true)) : [],
      text: this.text,
    });
  }

  get outerHTML() {
    const attributes = [...this._attributes]
      .map(([name, value]) => ` ${name}="${String(value).replaceAll('"', '&quot;')}"`)
      .join('');
    const content = `${this.text}${this.children.map((child) => child.outerHTML).join('')}`;
    return `<${this.tagName.toLowerCase()}${attributes}>${content}</${this.tagName.toLowerCase()}>`;
  }
}

function makeDocument() {
  const root = new FakeElement('body', {
    children: [new FakeElement('div', {
      attributes: {
        'data-api-key': 'sk-html-secret',
        'data-safe': 'kept',
      },
      text: 'marker',
    })],
  });
  return {
    title: 'fixture',
    scripts: [{
      src: '',
      textContent: 'const apiKey = "sk-inline-secret"; function targetMarker() {}',
    }],
    querySelectorAll(selector) {
      return selector === 'body' ? [root] : [];
    },
    querySelector(selector) {
      return selector === 'body' ? root : null;
    },
  };
}

test('issue 5178 redacts api-key assignments and blocks sensitive inline needles', async () => {
  const inspector = new ParentPageInspector({ document: makeDocument() });
  const result = await inspector.scriptSource({ index: 0, needle: 'targetMarker', contextChars: 256 });
  const excerpt = result.excerpts[0]?.text || '';

  assert.match(excerpt, /apiKey\s*=\s*["']\[redacted\]["']/);
  assert.doesNotMatch(excerpt, /sk-inline-secret/);
  await assert.rejects(
    () => inspector.scriptSource({ index: 0, needle: 'apiKey' }),
    (error) => error?.code === 'inline-sensitive-needle',
  );
});

test('issue 5178 removes api-key attributes from HTML snapshots', () => {
  const inspector = new ParentPageInspector({ document: makeDocument() });
  const result = inspector.snapshot({ includeHtml: true, htmlSelector: 'body' });

  assert.doesNotMatch(result.html, /data-api-key|sk-html-secret/i);
  assert.match(result.html, /data-safe="kept"/);
});
