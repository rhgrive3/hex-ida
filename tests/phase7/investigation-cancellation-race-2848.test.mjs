import assert from 'node:assert/strict';
import fs from 'node:fs';

const investigation = fs.readFileSync(new URL('../../js/analysis/investigation-service.js', import.meta.url), 'utf8');
const postRegistrationAbortChecks = investigation.match(/if \(signal\?\.aborted\) onAbort\(\);/g) || [];
assert.ok(postRegistrationAbortChecks.length >= 3, 'all InvestigationService cancellation helpers must recheck AbortSignal after listener registration');

console.log('issue 2848 investigation cancellation race: PASS');
