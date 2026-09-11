export * from "./StellaConfig";
export * from "./retrieval";
export * from "./sampling";
export * from "./chunking";
export * from "./models";
export * from "./knowledge";
import { DEFAULT_STELLA_CONFIG } from "./StellaConfig";

export const EMBED_MODEL = DEFAULT_STELLA_CONFIG.embedModel;
export const EMBED_DIM = DEFAULT_STELLA_CONFIG.embedDim;
export const EMBED_CHUNK_TOKENS = DEFAULT_STELLA_CONFIG.embedChunkTokens;
export const EMBED_PER_COLUMN_LIMIT = DEFAULT_STELLA_CONFIG.embedPerColumnLimit;
export const EMBED_DATA_SAMPLE_N = DEFAULT_STELLA_CONFIG.embedDataSampleN;
export const EMBED_SAMPLING_VERSION =
  DEFAULT_STELLA_CONFIG.embedSamplingVersion;
export const EMBED_SAMPLING_SEED = DEFAULT_STELLA_CONFIG.embedSamplingSeed;
export const EMBED_VECTOR_MAX_BYTES = DEFAULT_STELLA_CONFIG.vectorMaxBytes;
export const EMBED_VECTOR_MAX_ENTRIES = DEFAULT_STELLA_CONFIG.vectorMaxEntries;
export type SampleCoverage = "sample" | "exact";
