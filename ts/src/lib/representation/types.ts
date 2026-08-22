/**
 * Representation layer types — semantic representation of data before vectorization.
 * Dataset → semantic representation → vector artifacts (not Dataset → 200 embeddings)
 */

export type RepresentationKind =
  "dataset_profile" | "column_semantic" | "data_representative" | "exact_row";

export type DatasetProfileEmbedding = {
  kind: "dataset_profile";
  datasetId: string;
  uploadId: string;
  contentHash: string;
  text: string;
  metadata: {
    rows: number;
    cols: number;
    format: string;
    columnCountByType: Record<string, number>;
    duplicatePct: number;
  };
};

export type ColumnSemanticEmbedding = {
  kind: "column_semantic";
  datasetId: string;
  uploadId: string;
  contentHash: string;
  columnName: string;
  text: string;
  metadata: {
    type: string;
    unique: number;
    missingPct: number;
    mean?: number;
    median?: number;
    semanticLevel: "schema" | "profile";
    profileStatus: "pending" | "complete";
  };
};

export type DataRepresentativeSample = {
  n: number;
  method: "stratified";
  coverage: "sample" | "exact";
  seed: string;
  strategyVersion: string;
};

export type DataRepresentativeEmbedding = {
  kind: "data_representative";
  datasetId: string;
  uploadId: string;
  contentHash: string;
  chunkId: string;
  chunkHash: string;
  text: string;
  metadata: {
    source: "derived-data";
    persistence: "local" | "server";
    rawDataPersisted: false;
    sample: DataRepresentativeSample;
    rowIndices?: number[];
  };
};

export type ExactRowEmbedding = {
  kind: "exact_row";
  datasetId: string;
  uploadId: string;
  contentHash: string;
  rowIndex: number;
  text: string;
  metadata: {
    source: "derived-data";
    persistence: "local" | "server";
    rawDataPersisted: false;
    sample: DataRepresentativeSample & { coverage: "exact" };
  };
};

export type RepresentationArtifact =
  | DatasetProfileEmbedding
  | ColumnSemanticEmbedding
  | DataRepresentativeEmbedding
  | ExactRowEmbedding;

export type RepresentationMode = "representative" | "exact";

export type SelectionPolicy = {
  mode: RepresentationMode;
  sampleN: number;
  sample: DataRepresentativeSample;
};
