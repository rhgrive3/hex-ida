// Required-lane bridge for the integrated #6546 symbolic/AI/signature regressions.
// The authoritative Phase 9 runner recursively discovers this .test.mjs file;
// importing the reviewed root regressions registers their node:test cases.
import '../../issue-6083-deserialize-symbolid-sort-conflict.mjs';
import '../../issue-6087-solver-model-key-collision.mjs';
import '../../issue-6089-proposal-evidence-ids-array.mjs';
import '../../issue-6090-symbolic-args-numeric-binding.mjs';
import '../../issue-6100-knowledge-pack-null-entry.mjs';
import '../../issue-6102-refuted-proof-cache-validation.mjs';
