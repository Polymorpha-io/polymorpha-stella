/**
 * Representation-sampling constants (single source, `D20`).
 * Thresholds and formulas from DatasetRepresentationService / RagService.
 * Values moved verbatim.
 */

/** Row counts at/below this use exact (non-sampled) representation. */
export const EXACT_MAX_ROWS = 1_000;
/** Row counts at/below this use lightweight representative sampling. */
export const REPRESENTATIVE_MAX_ROWS = 5_000;
/** Large-dataset sample-size formula: min(BASE + floor(n / DIVISOR), CAP). */
export const SAMPLE_FORMULA_BASE = 400;
export const SAMPLE_FORMULA_DIVISOR = 10;
export const SAMPLE_FORMULA_CAP = 1_000;
/** Head/tail slice: min(MAX, floor(sampleN * PCT)). */
export const HEAD_TAIL_MAX = 15;
export const HEAD_TAIL_PCT = 0.15;
/** Rare-category values kept per column. */
export const RARE_CATEGORY_TOP = 5;
/** Duplicate-row scan cap in RAG pipelines. */
export const DUPLICATE_SAMPLE_CAP = 5_000;
