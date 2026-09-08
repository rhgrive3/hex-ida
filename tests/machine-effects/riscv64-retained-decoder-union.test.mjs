// Keep the already-merged RISC-V decoder contributions in the canonical gate.
// #7010 accidentally reverted the #7262/#7070/#6973 producer union while
// retaining its tests. Reuse those tests instead of a second decoder model.
import '../issue-5813-riscv64-decoded-typed-fields.mjs';
import '../issue-5990-riscv-identity-string-coercion.mjs';
import '../phase6/decoder/issue-4992-riscv64-raw-byte-authority.test.mjs';
