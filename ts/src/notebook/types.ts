import type { AppStep, CleaningConfig } from "@/types";

// ---------------------------------------------------------------------------
// Notebook — per workspace, cells reference one or more datasets
// ---------------------------------------------------------------------------

export type NotebookCellType =
  | "markdown"
  | "upload"
  | "inspect"
  | "model"
  | "clean"
  | "transform"
  | "analysis"
  | "visualization"
  | "export"
  | "assistant";

export type CellStatus =
  | "active"
  | "superseded"
  | "stale"
  | "failed"
  | "cancelled"
  | "idle"
  | "queued"
  | "running"
  | "success"
  | "error";

export interface CellExecution {
  executionCount: number | null;
  status:
    "idle" | "queued" | "running" | "success" | "error" | "cancelled" | "stale";
  startedAt?: number;
  completedAt?: number;
  inputHash: string;
  outputHash?: string;
  durationMs?: number;
}

export interface CellProvenance {
  datasetIds: string[];
  sourceCellIds: string[];
  inputHashes: string[];
  operation?: string;
  columns?: string[];
  parentCellId?: string;
  dependsOn: string[];
}

export type NotebookOutputType =
  "text" | "table" | "chart" | "metric" | "diff" | "dataset" | "error" | "file";

export interface NotebookOutput {
  id: string;
  type: NotebookOutputType;
  data: unknown;
  metadata: {
    mimeType?: string;
    title?: string;
    columns?: string[];
    rowCount?: number;
    chartType?: string;
  };
}

export interface CellMetadata {
  title?: string;
  collapsed?: boolean;
  tags?: string[];
}

export interface CellSource {
  // For wizard-derived cells, store the originating config snapshot.
  config?: CleaningConfig | Record<string, unknown> | null;
  markdown?: string;
  uploadId?: string;
  datasetId?: string;
}

export interface NotebookCell {
  id: string;
  index: number;
  type: NotebookCellType;
  status: CellStatus;
  source: CellSource;
  outputs: NotebookOutput[];
  metadata: CellMetadata;
  execution: CellExecution;
  provenance: CellProvenance;
  createdAt: number;
  updatedAt: number;
  // convenience
  step: AppStep;
  datasetIds: string[];
}

export interface NotebookMetadata {
  title?: string;
  kernel?: string;
}

export interface Notebook {
  id: string;
  workspaceId: string;
  version: number;
  cells: NotebookCell[];
  metadata: NotebookMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface NotebookArtifact {
  id: string;
  type: "dataset" | "table" | "chart" | "file" | "image";
  hash: string;
  storageKey: string;
  metadata: Record<string, unknown>;
}

export interface SuggestedCell {
  id: string;
  title: string;
  type: NotebookCellType;
  datasetIds: string[];
  operation: string;
  config: Record<string, unknown>;
  estimate?: {
    rowsAffected?: number;
    colsAffected?: number;
    previewDiff?: string;
  };
  source: "stella";
  createdAt: number;
}
