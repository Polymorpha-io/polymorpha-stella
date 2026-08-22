import type { SampleCoverage } from "@/config";

export type RagPipelineName =
  "dataset" | "perColumn" | "missing" | "duplicate" | "quality";

export type PipelineStatus =
  "pending" | "running" | "done" | "error" | "skipped";

export interface DatasetLevelProfile {
  rows: number;
  cols: number;
  fileSizeEstimate: number;
  columnCountByType: Record<string, number>;
  duplicateRows: number;
  duplicatePct: number;
  emptyRows: number;
  emptyCols: number;
  constantCols: string[];
  format: string;
}

export interface PerColumnProfile {
  name: string;
  type: string;
  detectedType: string;
  unique: number;
  cardinalityRatio: number;
  missing: number;
  missingPct: number;
  // numeric
  mean?: number;
  median?: number;
  mode?: string | number | null;
  min?: number;
  max?: number;
  range?: number;
  std?: number;
  variance?: number;
  q1?: number;
  q3?: number;
  iqr?: number;
  skewness?: number;
  kurtosis?: number;
  // categorical
  topK?: Array<{ value: string; count: number; pct: number }>;
  entropy?: number;
}

export interface MissingProfile {
  perColumn: Array<{ column: string; missing: number; missingPct: number }>;
  perRow: { avgMissingPerRow: number; maxMissingPerRow: number };
  highMissingCols: string[];
  missingTogether: Array<{ a: string; b: string; correlation: number }>;
}

export interface DuplicateProfile {
  duplicateRows: number;
  duplicatePct: number;
  candidateKeys: string[];
  compositeKeys: string[][];
  uniqueCols: string[];
}

export interface QualityProfile {
  invalid: Array<{ column: string; issue: string; count: number }>;
  mixedTypes: string[];
  whitespaceCols: string[];
}

export interface RagDatasetProfile {
  dataset: DatasetLevelProfile | null;
  perColumn: PerColumnProfile[] | null;
  missing: MissingProfile | null;
  duplicate: DuplicateProfile | null;
  quality: QualityProfile | null;
}

export interface RagProfileState {
  profile: RagDatasetProfile;
  status: Record<RagPipelineName, PipelineStatus>;
  isProfiling: boolean;
  error: string | null;
  hash: string | null;
  updatedAt: number | null;
  // G23 multi-dataset extensions
  uploadId?: string | null;
  contentHash?: string | null;
  sample?: DataRepresentativeSample | null;
}

/** Addendum §2 versioned sampling contract — seed + strategyVersion invalidate embedding */
export interface DataRepresentativeSample {
  n: number;
  method: "stratified";
  coverage: SampleCoverage;
  seed: string;
  strategyVersion: string;
}

/** Per-dataset profile bundle stored in Map<uploadId> */
export interface RagProfileByDataset {
  key: string; // uploadId or contentHash
  state: RagProfileState;
}
