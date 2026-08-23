export type ColumnType = "numeric" | "categorical" | "date" | "boolean" | "unknown";

export interface Column {
  name: string;
  type: ColumnType;
  detectedType?: ColumnType;
}

export type Row = Record<string, unknown>;

export interface Dataset {
  columns: Column[];
  rows: Row[];
  fileName: string;
  uploadedAt?: Date;
}

export type AppStep = "upload" | "model" | "preview" | "clean" | "stats" | "export";

export interface CleaningConfig extends Record<string, unknown> {
  type?: string;
  column?: string;
}

export type SampleCoverage = "sample" | "exact";
export type RepresentationMode = "representative" | "exact";

export interface DataOperationStep {
  id: string;
  description: string;
  config: CleaningConfig & { type: string; column?: string };
}
