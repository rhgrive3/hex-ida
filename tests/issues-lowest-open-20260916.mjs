// Regression bundle for the ten lowest-number open issues selected on 2026-09-16.
// Several landed upstream while this batch was being rebased; importing their canonical
// regressions here prevents the final residual fixes from regressing them.
import './issue-567-elf-metadata-budget.mjs';
import './phase11/jvm/issue-1138-invoke-descriptor-stack-authority.test.mjs';
import './issue-2554-patch-architecture-gate.mjs';
import './issue-3123-cross-binary-partitions.mjs';
import './issue-3755-binary-id-consumer-cancellation.mjs';
import './phase10/issue-4310-compile-experiment-input-coercion.test.mjs';
import './phase10/issue-4312-observed-offset-coercion.test.mjs';
import './phase10/issue-4313-compare-expected-bits-coercion.test.mjs';
import './semantic-v2/issue-4602-data-operation-arity.test.mjs';
import './phase10/debugger/issue-4606-resume-after-budget-stop.test.mjs';

console.log('lowest-open issue regression bundle: loaded');
