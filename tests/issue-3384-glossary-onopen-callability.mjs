import assert from 'node:assert/strict';

class FakeFragment {
  constructor() { this.nodeType = 11; this.childNodes = []; }
  append(...nodes) { this.childNodes.push(...nodes); }
}

class FakeText {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentNode = null; }
  replaceWith(node) {
    const parent = this.parentNode;
    const index = parent.childNodes.indexOf(this);
    const replacements = node?.nodeType === 11 ? node.childNodes : [node];
    for (const child of replacements) child.parentNode = parent;
    parent.childNodes.splice(index, 1, ...replacements);
  }
}

class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.className = '';
    this.textContent = '';
    this.attributes = new Map();
    this.listeners = new Map();
    this.afterNode = null;
    this.parentNode = null;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node?.nodeType === 11) this.append(...node.childNodes);
      else {
        node.parentNode = this;
        this.childNodes.push(node);
      }
    }
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { this.listeners.get('click')?.({ type:'click', target:this }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  after(node) { this.afterNode = node; }
  remove() { this.removed = true; }
}

const previousDocument = globalThis.document;
globalThis.document = {
  createElement(tag) { return new FakeElement(tag); },
  createTextNode(value) { return new FakeText(value); },
  createDocumentFragment() { return new FakeFragment(); },
};

try {
  const { decorateTerms } = await import('../js/ai/render/terms.js');

  function fixture(text = 'CPU') {
    const host = new FakeElement('p');
    const node = new FakeText(text);
    node.parentNode = host;
    host.childNodes.push(node);
    return { host, root:{ querySelectorAll:() => [host] } };
  }

  function findByClass(node, className) {
    if (typeof node?.className === 'string' && node.className.split(/\s+/).includes(className)) return node;
    for (const child of node?.childNodes || []) {
      const hit = findByClass(child, className);
      if (hit) return hit;
    }
    return null;
  }

  {
    const { host, root } = fixture();
    assert.equal(decorateTerms(root, { onOpen:{ call:'not-a-function' } }), 1);
    const termButton = findByClass(host, 'ai-term');
    assert.ok(termButton, 'known term should be decorated');
    termButton.click();
    assert.ok(host.afterNode, 'definition should open');
    assert.equal(findByClass(host.afterNode, 'ai-term-more'), null, 'non-callable onOpen must not create a dead More button');
  }

  {
    const opened = [];
    const { host, root } = fixture();
    assert.equal(decorateTerms(root, { onOpen:(id) => opened.push(id) }), 1);
    findByClass(host, 'ai-term').click();
    const more = findByClass(host.afterNode, 'ai-term-more');
    assert.ok(more, 'callable onOpen should preserve the More button');
    more.click();
    assert.deepEqual(opened, ['cpu']);
  }

  console.log('issue #3384 glossary onOpen callability: PASS');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
