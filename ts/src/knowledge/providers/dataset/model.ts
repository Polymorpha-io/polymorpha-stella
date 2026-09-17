import type { RagProfileState } from "../../../lib/rag/types";

/** Raw dataset surface the provider needs (structural, not the full Dataset). */
export interface ProviderRaw {
  rows: unknown[];
  columns: Array<{ name: string; type: string }>;
  fileName: string;
}

export interface ProviderDataState {
  raw: ProviderRaw | null;
  uploadId: string | null;
  objective?: string | null;
}

export interface ProviderRagState {
  byDataset: Map<string, RagProfileState>;
  activeUploadId: string | null;
}

/** Per-dataset record context shared by all record builders. */
export interface DsCtx {
  workspaceId: string;
  datasetId: string;
  uploadId: string;
  contentHash: string;
  datasetName: string;
  now: number;
  updatedAt: number;
}

export type DatasetKnowledgeProviderInput = {
  ragDatasets: Map<string, import("../../../lib/rag/types").RagProfileState>;
  activeUploadId?: string | null;
  dataState?: {
    raw?:
      | import("../../../notebook/types").Notebook
      | (unknown & { rows?: unknown[]; columns?: unknown[]; fileName?: string })
      | null;
    uploadId?: string | null;
    objective?: string | null;
  } | null;
};
