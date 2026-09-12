import assert from 'node:assert/strict';
import { DomSkillRegistry } from '../js/userscript/dev/skills/dom-skill-registry.js';

function deferredGate() {
  let calls = 0;
  const node = {
    tagName: 'BUTTON', nodeName: 'BUTTON', textContent: 'Create project', value: '',
    disabled: false, hidden: false, isContentEditable: false,
    getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    click() {}, focus() {}, dispatchEvent() { return true; },
  };
  const document = {
    querySelector() { calls += 1; return calls >= 2 ? node : null; },
    querySelectorAll() { return []; },
  };
  return { document };
}

function skillManifest(version) {
  return {
    schema: 'hex-dom-skill-v1',
    skillId: 'chatgpt.projects',
    version,
    description: 'Test Project DOM Skill',
    validationPrograms: ['probe'],
    programs: {
      probe: {
        version: 1, name: 'probe', readOnly: true,
        steps: [
          { op: 'waitFor', selector: '[data-testid="gate"]', as: 'node', timeoutMs: 1000, pollMs: 10 },
          { op: 'return', value: { ok: true } },
        ],
      },
    },
  };
}

const { document } = deferredGate();
const registry = new DomSkillRegistry({ document, location: { href: 'https://chatgpt.com/' } });

registry.installCandidate(skillManifest('1'));

const validation = registry.validateCandidate({ skillId: 'chatgpt.projects' });
assert.equal(registry.records.get('chatgpt.projects').candidate.version, '1', 'v1 candidate must be validating');

registry.installCandidate(skillManifest('2'));
assert.equal(registry.records.get('chatgpt.projects').candidate.version, '2', 'v2 install must win while v1 validation is in flight');

let outcome;
try {
  await validation;
  outcome = 'resolved';
} catch (error) {
  outcome = error.code || error.name;
}

assert.equal(outcome, 'candidate-superseded', 'a stale validation must be rejected when its candidate was replaced mid-flight');
assert.equal(registry.records.get('chatgpt.projects').candidate.version, '2', 'stale v1 validation completion must not roll back the installed v2 candidate');
assert.equal(registry.records.get('chatgpt.projects').candidateValidation, null, 'stale validation must not attach a validation result to the v2 candidate');

console.log('[dom-skill] issue #5061 validateCandidate stale write-back race passed');
