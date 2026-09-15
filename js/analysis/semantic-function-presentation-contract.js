// Cache schema for the shared x86/RISC-V semantic-function presentation.
// v2 adds snapshot-bound render provenance to the returned decompiler view.
// Old rows without a map must miss even though their IR/ABI validator passes.
// This is presentation invalidation, not a new semantic-equivalence claim.
export const SEMANTIC_FUNCTION_PRESENTATION_SCHEMA_VERSION = 'semantic-ir-v2-compat-function-v2';
