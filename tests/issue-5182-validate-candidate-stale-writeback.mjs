import assert from 'node:assert/strict';
import test from 'node:test';
import { DomSkillRegistry } from '../js/userscript/dev/skills/dom-skill-registry.js';

// Issue #5182: validateCandidate() kept the record/candidate captured before
// `await executeAutomationProgram(...)` and wrote the whole stale record back
// on completion, so a candidate installed during validation silently vanished
// and the superseded candidate + its validation were revived.

function skillManifest(version) {
  return {
    schema: 'hex-dom-skill-v1',
    skillId: 'chatgpt.domskill',
    version,
    description: 'Issue #5182 DOM Skill',
    validationPrograms: ['probe'],
    programs: {
      probe: {
        version: 1, name: 'probe', readOnly: true,
        steps: [
          { op: 'query', selector: '[data-testid="target"]', as: 'target' },
          { op: 'assert', condition: { type: 'exists', target: 'target' } },
          { op: 'return', value: { found: true } },
        ],
      },
    },
  };
}

function newRegistry() {
  const node = fakeNode({ tagName: 'DIV', text: 'target', attrs: { 'data-testid': 'target' } });
  const document = fakeDocument({ '[data-testid="target"]': [node] });
  return new DomSkillRegistry({ document, location: fakeLocation(), now: monotonicNow() });
}

test('#5182 v1 validation superseded by v2 install keeps v2 candidate and rejects the stale commit', async () => {
  const registry = newRegistry();
  registry.installCandidate(skillManifest('1'));
  const validating = registry.validateCandidate({ skillId: 'chatgpt.domskill' });
  registry.installCandidate(skillManifest('2'));

  await assert.rejects(validating, (error) => error.code === 'candidate-superseded', 'the superseded v1 validation must be discarded, not committed');

  const after = registry.describe({ skillId: 'chatgpt.domskill' });
  assert.equal(after.candidate?.version, '2', 'the latest candidate must survive');
  assert.equal(after.candidateValidation, null, 'the v1 validation must not attach to v2');
  assert.equal(after.candidateValidated, false);
});

test('#5182 activate after the race fails closed instead of reviving v1', async () => {
  const registry = newRegistry();
  registry.installCandidate(skillManifest('1'));
  const validating = registry.validateCandidate({ skillId: 'chatgpt.domskill' });
  registry.installCandidate(skillManifest('2'));
  await assert.rejects(validating, (error) => error.code === 'candidate-superseded');

  assert.throws(() => registry.activate({ skillId: 'chatgpt.domskill' }), (error) => error.code === 'candidate-not-validated', 'the unvalidated v2 must not activate through a revived v1 validation');
});

test('#5182 unchanged candidate validates and activates as before', async () => {
  const registry = newRegistry();
  registry.installCandidate(skillManifest('1'));
  const { skill, validation } = await registry.validateCandidate({ skillId: 'chatgpt.domskill' });
  assert.equal(validation.ok, true);
  assert.equal(validation.version, '1');
  assert.deepEqual(validation.results.probe, { found: true });
  assert.equal(skill.candidateVersion, '1');
  assert.equal(skill.candidateValidated, true);
  const state = registry.activate({ skillId: 'chatgpt.domskill' });
  assert.equal(state.activeVersion, '1');
});

test('#5182 activate during validation rejects stale writeback and keeps the activated record', async () => {
  const registry = newRegistry();
  registry.installCandidate(skillManifest('1'));
  await registry.validateCandidate({ skillId: 'chatgpt.domskill' });
  registry.activate({ skillId: 'chatgpt.domskill' });
  registry.installCandidate(skillManifest('2'));
  await registry.validateCandidate({ skillId: 'chatgpt.domskill' });

  const revalidating = registry.validateCandidate({ skillId: 'chatgpt.domskill' });
  registry.activate({ skillId: 'chatgpt.domskill' });
  await assert.rejects(revalidating, (error) => error.code === 'candidate-superseded');

  const after = registry.describe({ skillId: 'chatgpt.domskill' });
  assert.equal(after.activeVersion, '2', 'the activation must not be undone by the stale writeback');
  assert.equal(after.candidate, null);
  assert.equal(after.previousVersion, '1');
});

test('#5182 rollback during validation rejects stale writeback and keeps the rolled-back record', async () => {
  const registry = newRegistry();
  registry.installCandidate(skillManifest('1'));
  await registry.validateCandidate({ skillId: 'chatgpt.domskill' });
  registry.activate({ skillId: 'chatgpt.domskill' });
  registry.installCandidate(skillManifest('2'));
  await registry.validateCandidate({ skillId: 'chatgpt.domskill' });
  registry.activate({ skillId: 'chatgpt.domskill' });
  registry.installCandidate(skillManifest('3'));

  const validating = registry.validateCandidate({ skillId: 'chatgpt.domskill' });
  registry.rollback({ skillId: 'chatgpt.domskill' });
  await assert.rejects(validating, (error) => error.code === 'candidate-superseded');

  const after = registry.describe({ skillId: 'chatgpt.domskill' });
  assert.equal(after.activeVersion, '1', 'the rollback must not be undone by the stale writeback');
  assert.equal(after.candidate, null);
  assert.equal(after.previousVersion, '2');
});

function fakeDocument(selectorMap) {
  return {
    querySelector(selector) { return (selectorMap[selector] || [])[0] || null; },
    querySelectorAll(selector) { return selectorMap[selector] || []; },
  };
}
function fakeLocation() {
  return { href: 'https://chatgpt.com/', hostname: 'chatgpt.com', assign(url) { this.href = url; } };
}
function fakeNode({ tagName, text = '', attrs = {} }) {
  return {
    tagName, nodeName: tagName, textContent: text, value: '', disabled: false, hidden: false,
    isContentEditable: false,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    click() {}, focus() {}, dispatchEvent() { return true; },
  };
}
function monotonicNow() {
  let n = 0;
  return () => `2026-09-12T00:00:${String(n++).padStart(2, '0')}.000Z`;
}
