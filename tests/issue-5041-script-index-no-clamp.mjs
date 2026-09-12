import assert from 'node:assert/strict';
import { ParentPageInspector } from '../js/userscript/dev/admin/page-inspector.js';

const SCRIPT_SOURCES = [
  { src: 'https://chatgpt.com/assets/a.js', body: 'const marker = "ALPHA";' },
  { src: 'https://chatgpt.com/assets/b.js', body: 'const marker = "BRAVO";' },
  { src: 'https://chatgpt.com/assets/c.js', body: 'const marker = "CHARLIE";' },
];

function fakeScript(src) {
  return {
    src, type: '', async: false, defer: false, integrity: '', nonce: '', textContent: '',
    getAttribute(name) { return this[name] ?? null; },
  };
}

function harness({ withFetch = true } = {}) {
  const document = {
    title: 'ChatGPT',
    location: { href: 'https://chatgpt.com/g/g-p-demo/project' },
    scripts: SCRIPT_SOURCES.map((entry) => fakeScript(entry.src)),
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const fetched = [];
  const options = { document, location: document.location };
  if (withFetch) {
    options.fetchRef = async (url) => {
      fetched.push(String(url));
      const entry = SCRIPT_SOURCES.find((candidate) => candidate.src === String(url));
      return { ok: true, status: 200, text: async () => entry?.body || 'UNEXPECTED-SCRIPT' };
    };
  } else {
    options.fetchRef = null;
  }
  const inspector = new ParentPageInspector(options);
  return { inspector, fetched };
}

async function rejectsScriptNotLoaded(inspector, args, label) {
  let outcome = null;
  try {
    outcome = { resolved: await inspector.scriptSource(args) };
  } catch (error) {
    outcome = { error };
  }
  assert.ok(outcome.error, `${label} must be rejected, got ${JSON.stringify(outcome.resolved)}`);
  assert.equal(outcome.error.code, 'script-not-loaded', `${label} must reject with script-not-loaded`);
}

assert.equal(SCRIPT_SOURCES.length, 3);

{
  const { inspector } = harness();
  const listed = inspector.scripts();
  assert.deepEqual(listed.scripts.map((entry) => entry.index), [0, 1, 2]);
}

{
  const { inspector, fetched } = harness();
  await rejectsScriptNotLoaded(inspector, { index: SCRIPT_SOURCES.length }, 'index === scripts.length');
  await rejectsScriptNotLoaded(inspector, { index: 999 }, 'index 999');
  await rejectsScriptNotLoaded(inspector, { index: -1 }, 'index -1');
  await rejectsScriptNotLoaded(inspector, { index: -999 }, 'index -999');
  assert.deepEqual(fetched, [], 'out-of-range index must not trigger any fetch');
}

{
  const { inspector, fetched } = harness();
  for (const index of [1.5, 0.0001, '1', '0', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, true]) {
    await rejectsScriptNotLoaded(inspector, { index }, `non-safe-integer index ${String(index)}`);
  }
  assert.deepEqual(fetched, [], 'non-safe-integer index must not trigger any fetch');
}

{
  const { inspector, fetched } = harness();
  const sources = [];
  for (const index of [0, 1, 2]) {
    const result = await inspector.scriptSource({ index });
    sources.push(result.text);
    assert.equal(result.src, SCRIPT_SOURCES[index].src, 'selected src must keep its index identity');
  }
  assert.deepEqual(sources, SCRIPT_SOURCES.map((entry) => entry.body), 'each valid index must return its own script body');
  assert.deepEqual(fetched, SCRIPT_SOURCES.map((entry) => entry.src));
}

{
  const { inspector, fetched } = harness({ withFetch: false });
  await rejectsScriptNotLoaded(inspector, { index: 999 }, 'out-of-range index without fetch capability');
  assert.deepEqual(fetched, []);
  let outcome = null;
  try {
    await inspector.scriptSource({ index: 0 });
  } catch (error) {
    outcome = error;
  }
  assert.equal(outcome?.code, 'fetch-unavailable', 'a valid index must still report the unchanged capability failure');
}

{
  const { inspector } = harness();
  await rejectsScriptNotLoaded(inspector, { src: 'https://evil.example/x.js' }, 'unknown src');
  const matched = await inspector.scriptSource({ src: SCRIPT_SOURCES[1].src });
  assert.equal(matched.text, SCRIPT_SOURCES[1].body);
}

{
  const { inspector } = harness();
  let missingArgs = null;
  try {
    await inspector.scriptSource({});
  } catch (error) {
    missingArgs = error;
  }
  assert.ok(missingArgs instanceof TypeError, 'missing index and src must keep the argument-type failure');
}

console.log('issue #5041 script_source index range regressions PASS');
