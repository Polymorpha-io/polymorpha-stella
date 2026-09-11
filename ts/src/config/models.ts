/**
 * Embedding-model constants (single source, `D20`).
 * The model/dim/version triple itself stays in StellaConfig (injectable);
 * these are the fixed pipeline mechanics around it.
 */

export const EMBED_PIPELINE_TASK = "feature-extraction";
export const EMBED_POOLING = "mean";
export const EMBED_NORMALIZE = true;
/** Native output dim of the configured MiniLM model (warn if config differs). */
export const MODEL_NATIVE_DIM = 384;
