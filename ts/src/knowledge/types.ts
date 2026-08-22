export type KnowledgeKind =
  | "notebook_cell"
  | "notebook_output"
  | "notebook_visualization"
  | "dataset_profile"
  | "column_semantic"
  | "data_representative"
  | "relationship"
  | "note"
  | "error";

/** Migration from legacy kinds stored in IDB before 2026-08-23 */
export const LEGACY_KIND_MAP: Record<string, KnowledgeKind> = {
  cell: "notebook_cell",
  dataset: "dataset_profile",
  operation: "column_semantic",
  result: "notebook_output",
  statistic: "notebook_output",
  export: "notebook_output",
  visualization: "notebook_visualization",
};

export function normalizeKind(raw: string): KnowledgeKind {
  if (
    raw === "notebook_cell" ||
    raw === "notebook_output" ||
    raw === "notebook_visualization" ||
    raw === "dataset_profile" ||
    raw === "column_semantic" ||
    raw === "data_representative" ||
    raw === "relationship" ||
    raw === "note" ||
    raw === "error"
  )
    return raw;
  return (LEGACY_KIND_MAP[raw] ?? "notebook_output") as KnowledgeKind;
}

export interface EmbeddingReference {
  model: string;
  version: string;
  dimension: number;
  hash: string;
}

/** Typed provenance — Stella's semantic boundary (AGENTS.md: One retrieval plane) */
export interface KnowledgeProvenance {
  workspaceId: string;
  notebookId?: string;
  cellId?: string;
  uploadId?: string;
  contentHash?: string;
  datasetIds?: string[];
  datasetName?: string;
  columns?: string[];
  operation?: string;
  sourceCellIds?: string[];
  dependsOn?: string[];
  executionId?: string;
  inputHash?: string;
  outputHash?: string;
  sampleCoverage?: "exact" | "sample";
  chunkId?: string;
  rowIndices?: number[];
}

export interface KnowledgeRecord {
  id: string;
  workspaceId: string;
  datasetId?: string;
  notebookId: string;
  cellId?: string;
  kind: KnowledgeKind;
  text: string;
  metadata: Record<string, unknown>;
  provenance: KnowledgeProvenance;
  sourceHash: string;
  embedding?: EmbeddingReference;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeSearchRequest {
  query: string;
  scope: "workspace" | "all";
  workspaceId?: string;
  notebookId?: string;
  activeCellId?: string;
  datasetIds?: string[];
  kinds?: KnowledgeKind[];
  column?: string;
  includeSuperseded?: boolean;
  includeSystemKnowledge?: boolean;
  limit?: number;
}

/** Back-compat: singular datasetId/cellId aliases datasetIds/activeCellId */
export interface KnowledgeSearchOptions extends Omit<
  KnowledgeSearchRequest,
  "query" | "scope" | "activeCellId" | "datasetIds"
> {
  workspaceId: string;
  notebookId?: string;
  datasetId?: string;
  datasetIds?: string[];
  cellId?: string;
  activeCellId?: string;
  scope?: "workspace" | "all";
  kinds?: KnowledgeKind[];
  column?: string;
  limit?: number;
  includeSystemKnowledge?: boolean;
  includeSuperseded?: boolean;
}

export interface KnowledgeResult {
  record: KnowledgeRecord;
  score: number;
  vector?: Float32Array;
}

export interface KnowledgeStoreRecord extends KnowledgeRecord {
  embeddingKey?: string;
}
