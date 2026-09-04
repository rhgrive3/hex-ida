// Canonical Phase 7 route for the #6302 regression that historically landed
// outside the owned test subtree. Importing the original fixture preserves its
// behavior while making Phase 7 discovery/ownership mandatory.
import '../issue-6302-memoryssa-binding-stale-identity.mjs';
