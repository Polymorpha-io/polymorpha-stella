export interface StellaConfig {
  embedModel?: string;
  embedDim?: number;
  embedChunkTokens?: number;
  embedPerColumnLimit?: number;
  embedDataSampleN?: number;
  embedSamplingVersion?: string;
  embedSamplingSeed?: string;
  vectorMaxBytes?: number;
  vectorMaxEntries?: number;
}

export const DEFAULT_STELLA_CONFIG: Required<StellaConfig> = {
  embedModel: "Xenova/all-MiniLM-L6-v2",
  embedDim: 384,
  embedChunkTokens: 512,
  embedPerColumnLimit: 12,
  embedDataSampleN: 200,
  embedSamplingVersion: "v1-head-tail-quantile-rare",
  embedSamplingSeed: "polymorpha-v1",
  vectorMaxBytes: 20 * 1024 * 1024,
  vectorMaxEntries: 10_000,
};
