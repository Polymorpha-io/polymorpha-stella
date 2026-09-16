/** Model reference for the OpenCode transport (`POST /session/:id/message`). */
export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

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
  /** Base URL of `opencode serve` (default `http://127.0.0.1:4096`). */
  openCodeBaseUrl?: string;
  /** Model used on the OpenCode backend (must be connected server-side). */
  openCodeModel?: OpenCodeModelRef;
  /** Optional `OPENCODE_SERVER_PASSWORD` (HTTP basic auth, username `opencode`). */
  openCodePassword?: string;
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
  openCodeBaseUrl: "http://127.0.0.1:4096",
  openCodeModel: {
    providerID: "opencode-go",
    modelID: "muse-spark-1.2-contributor",
  },
  openCodePassword: "",
};
