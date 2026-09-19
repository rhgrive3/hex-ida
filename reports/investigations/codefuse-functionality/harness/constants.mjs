// Pinned upstream contract for the CodeFuse-DeBench comparison lane.
//
// Every value here was transcribed from the upstream repository at the pinned
// commit below. Nothing in this file is inferred: the `paths` are the files the
// contract was read from, and `published` is the README snapshot of the five
// evaluated decompilers. Re-verify before changing any of them.

export const UPSTREAM = Object.freeze({
  repository: 'https://github.com/codefuse-ai/CodeFuse-DeBench',
  pinnedCommit: 'c956988f8e16c85eafd4f7fd91b27feaa86bcb2b',
  pinnedCommitDate: '2026-05-29T02:38:08Z',
  paper: 'https://arxiv.org/abs/2605.29490',
  // Exact upstream files the contract was read from (path -> what it defines).
  paths: Object.freeze({
    step2Entry: 'evaluator/syntactic/auto_fixer_v3.py',
    step2Compiler: 'evaluator/syntactic/utils/compiler.py',
    step2LlmClient: 'evaluator/syntactic/utils/llm_client.py',
    step2ErrorParser: 'evaluator/syntactic/utils/error_parser_v3.py',
    step2MetricsDoc: 'docs/STEP2_METRICS.md',
    step3Entry: 'evaluator/semantic/run_instrumentation.py',
    step3Analyzer: 'evaluator/semantic/analyze_traces.py',
    step3Utils: 'evaluator/semantic/semantic_utils.py',
    step3TraceFormat: 'evaluator/semantic/trace_format.py',
    step3StabilityConfig: 'evaluator/semantic/case_stability_config.json',
    step3TargetFunctions: 'evaluator/semantic/target_functions.json',
    step3Hooks: 'evaluator/semantic/hook_trace.js',
    step3Docs: 'docs/SEMANTIC_EVALUATION_DETAILS.md',
    llmConfig: 'config/llm_config.json',
    llmDocs: 'docs/LLM_CONFIGURATION_GUIDE.md',
    projectStructure: 'docs/PROJECT_STRUCTURE.md',
  }),
  // Step 2 states (docs/STEP2_METRICS.md section 2).
  step2States: Object.freeze(['success', 'linker_failed', 'compile_failed']),
  step2ExceptionalStates: Object.freeze(['context_exceeded', 'tool_call_invalid', 'api_error']),
  step2DefaultMaxIterations: 50,
  // Step 2 default toolchain fallback (evaluator/syntactic/utils/compiler.py).
  step2DefaultCompileCommand: Object.freeze(['gcc', '-c', '-g', '-O0']),
  step2DefaultLinkCommand: Object.freeze(['gcc', '-O0', '-g']),
  // Step 3 states (docs/SEMANTIC_EVALUATION_DETAILS.md section 2 / analyze_traces.py).
  step3ProgramStates: Object.freeze(['exact', 'partial', 'fail', 'unsupported']),
  step3QualityStates: Object.freeze(['pass', 'partial', 'fail', 'unsupported']),
  step3TraceFormatVersion: 2,
  step3AnalysisVersion: 5,
  step3DefaultRunTimeoutSeconds: 30,
  // Published snapshot from the README of the pinned commit.
  published: Object.freeze({
    metricDefinitions: Object.freeze({
      readability: 'mean of the L1-L5 overview scores',
      recompilability: 'Full Success (FS) rate',
      functionality: 'program-level Exact Stdout + Partial rate',
    }),
    ida: Object.freeze({ readability: 5.73, recompilabilityPercent: 64.8, functionalityPercent: 29.7 }),
    ghidra: Object.freeze({ readability: 5.50, recompilabilityPercent: 65.5, functionalityPercent: 22.8 }),
    binaryai: Object.freeze({ readability: 4.99, recompilabilityPercent: 47.2, functionalityPercent: 14.8 }),
    retdec: Object.freeze({ readability: 4.51, recompilabilityPercent: 50.2, functionalityPercent: 1.5 }),
    angr: Object.freeze({ readability: 4.36, recompilabilityPercent: 38.0, functionalityPercent: 9.2 }),
  }),
});

export const SCHEMA = Object.freeze({
  summary: 'hex-codefuse-functionality-probe-summary/v1',
  case: 'hex-codefuse-functionality-probe-case/v1',
  upstreamContract: 'hex-codefuse-functionality-upstream-contract/v1',
});

// Variant labels must never be merged: raw function text, deterministic
// CodeFuse-fair preprocessing, product translation-unit packaging, and
// LLM-repaired output are four different measurement inputs.
export const SOURCE_VARIANTS = Object.freeze({
  rawFunctionText: 'raw-function-text',
  codefusePreprocessed: 'codefuse-preprocessed',
  translationUnit: 'product-translation-unit',
  repaired: 'repaired',
});
