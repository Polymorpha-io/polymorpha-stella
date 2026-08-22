/**
 * DatasetRepresentationService — semantic representation of data.
 * Extracted from UserLibrary/RAG per your mandatory revision #1.
 * Dataset → semantic representation → vector artifacts
 * Representation layer = semantic representation, Vector layer = index, RAG = retrieval
 */
import type { Dataset } from "@/types";
import type { RagDatasetProfile } from "@/lib/rag/types";
import type {
  DatasetProfileEmbedding,
  ColumnSemanticEmbedding,
  DataRepresentativeEmbedding,
  RepresentationMode,
  DataRepresentativeSample,
  SelectionPolicy,
} from "./types";
import { hashString } from "@polymorpha/business-logic";
import { EMBED_SAMPLING_VERSION, EMBED_SAMPLING_SEED } from "@/config";

const STRATEGY_VERSION = EMBED_SAMPLING_VERSION;

function seedFor(datasetId: string, contentHash: string): string {
  return `${datasetId}:${contentHash}:${EMBED_SAMPLING_SEED}:${STRATEGY_VERSION}`;
}

export function buildDatasetProfileEmbedding(
  datasetId: string,
  uploadId: string,
  contentHash: string,
  profile: RagDatasetProfile["dataset"],
  dataset: Dataset,
): DatasetProfileEmbedding | null {
  if (!profile) return null;
  const text = `RAG dataset profile: ${profile.rows} rows ×${profile.cols} cols (${dataset.fileName}), duplicate ${profile.duplicatePct}% (${profile.duplicateRows} rows), empty rows ${profile.emptyRows}, constant cols: ${profile.constantCols.join(", ") || "none"}, types: ${Object.entries(
    profile.columnCountByType,
  )
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")}`;
  return {
    kind: "dataset_profile",
    datasetId,
    uploadId,
    contentHash,
    text,
    metadata: {
      rows: profile.rows,
      cols: profile.cols,
      format: dataset.fileName.split(".").pop() || "csv",
      columnCountByType: profile.columnCountByType,
      duplicatePct: profile.duplicatePct,
    },
  };
}

/**
 * Synthetic deterministic dataset description — template-only, no LLM.
 * Epistemic status marked via caller metadata representation:"synthetic_description"
 */
export function buildDatasetDescriptionEmbedding(
  datasetId: string,
  uploadId: string,
  contentHash: string,
  dataset: Dataset,
  objective: string | null,
): DatasetProfileEmbedding {
  const domain = objective?.trim() || dataset.fileName.replace(/\.[^.]+$/, "");
  const typeCounts: Record<string, number> = {};
  for (const c of dataset.columns)
    typeCounts[c.type] = (typeCounts[c.type] ?? 0) + 1;
  const colsText = dataset.columns
    .map((c) => `${c.name} (${c.type})`)
    .join(", ");
  const text = `Dataset "${dataset.fileName}" purpose: ${domain} has ${dataset.rows.length} rows and ${dataset.columns.length} columns. Types: ${Object.entries(
    typeCounts,
  )
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")}. Columns: ${colsText}.`;
  return {
    kind: "dataset_profile",
    datasetId,
    uploadId,
    contentHash,
    text,
    metadata: {
      rows: dataset.rows.length,
      cols: dataset.columns.length,
      format: dataset.fileName.split(".").pop() || "csv",
      columnCountByType: typeCounts,
      duplicatePct: 0,
    },
  };
}

/**
 * One column = one vector. `limit` means profile-rich cap, not truncation.
 * Fallback header-only handled by buildHeaderOnlyColumnEmbeddings.
 */
export function buildColumnSemanticEmbeddings(
  datasetId: string,
  uploadId: string,
  contentHash: string,
  profile: RagDatasetProfile["perColumn"],
  limit = 12,
): ColumnSemanticEmbedding[] {
  if (!profile) return [];
  // Only first `limit` get rich stats; caller will create header-only for remainder via fallback helper.
  return profile.slice(0, limit).map((col) => {
    const text =
      col.type === "numeric"
        ? `Column "${col.name}" (${col.type}): missing ${col.missingPct.toFixed(1)}% unique ${col.unique}, mean ${col.mean?.toFixed(2)}, median ${col.median?.toFixed(2)}, std ${col.std?.toFixed(2)}, skew ${col.skewness?.toFixed(2)}`
        : `Column "${col.name}" (${col.type}): missing ${col.missingPct.toFixed(1)}% unique ${col.unique}, top ${col.topK?.map((k) => `${k.value} ${k.pct.toFixed(0)}%`).join(", ")}, entropy ${col.entropy?.toFixed(2)}`;
    return {
      kind: "column_semantic",
      datasetId,
      uploadId,
      contentHash,
      columnName: col.name,
      text,
      metadata: {
        type: col.type,
        unique: col.unique,
        missingPct: col.missingPct,
        mean: col.mean,
        median: col.median,
        semanticLevel: "profile" as const,
        profileStatus: "complete" as const,
      },
    };
  });
}

export function buildHeaderOnlyColumnEmbeddings(
  datasetId: string,
  uploadId: string,
  contentHash: string,
  dataset: Dataset,
): ColumnSemanticEmbedding[] {
  return dataset.columns.map((col) => ({
    kind: "column_semantic",
    datasetId,
    uploadId,
    contentHash,
    columnName: col.name,
    text: `Column "${col.name}" is ${col.type}`, // tiny, no chunker needed
    metadata: {
      type: col.type,
      unique: 0,
      missingPct: 0,
      semanticLevel: "schema" as const,
      profileStatus: "pending" as const,
    },
  }));
}

export async function buildDataRepresentativeEmbeddings(
  datasetId: string,
  uploadId: string,
  contentHash: string,
  dataset: Dataset,
  profile: RagDatasetProfile["perColumn"],
  opts: { mode: RepresentationMode; sampleN: number } = {
    mode: "representative",
    sampleN: 200,
  },
): Promise<DataRepresentativeEmbedding[]> {
  const n = dataset.rows.length;
  const sampleN = opts.mode === "exact" ? n : Math.min(opts.sampleN, n);
  const seed = await hashString(seedFor(datasetId, contentHash)).catch(() =>
    seedFor(datasetId, contentHash).slice(0, 12),
  );
  const sample: DataRepresentativeSample = {
    n: sampleN,
    method: "stratified",
    coverage: opts.mode === "exact" ? "exact" : "sample",
    seed: String(seed).slice(0, 12),
    strategyVersion: STRATEGY_VERSION,
  };

  // Selection policy: small → exact may be selected, medium → representative, large → representative + server exact (per plan)
  // v1 sampling: 20-30 head/tail + 120-140 stratified quantile-aware + 30-40 categorical/rare
  // For brevity, implement deterministic head/tail + quantile + rare, not full density
  const indices: number[] = [];
  const headTail = Math.min(15, Math.floor(sampleN * 0.15));
  for (let i = 0; i < Math.min(headTail, n); i++) indices.push(i);
  for (let i = Math.max(0, n - headTail); i < n; i++)
    if (!indices.includes(i)) indices.push(i);

  // Stratified by numeric quantile - sort by first numeric column if exists
  const firstNumeric = profile?.find((c) => c.type === "numeric")?.name;
  if (firstNumeric && indices.length < sampleN) {
    const sorted = [...dataset.rows]
      .map((r, idx) => ({ idx, v: Number(r[firstNumeric]) }))
      .filter((x) => !isNaN(x.v))
      .sort((a, b) => a.v - b.v);
    const remaining = sampleN - indices.length;
    const step = Math.max(
      1,
      Math.floor(sorted.length / Math.max(1, remaining)),
    );
    for (let i = 0; i < sorted.length && indices.length < sampleN; i += step) {
      if (!indices.includes(sorted[i].idx)) indices.push(sorted[i].idx);
    }
  }

  // Categorical rare: add rare category representatives
  const categoricalCol = profile?.find((c) => c.type === "categorical")?.name;
  if (categoricalCol && indices.length < sampleN) {
    const freq = new Map<string, number>();
    for (const r of dataset.rows)
      freq.set(
        String(r[categoricalCol] ?? ""),
        (freq.get(String(r[categoricalCol] ?? "")) || 0) + 1,
      );
    const rare = [...freq.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 5)
      .map(([v]) => v);
    for (const rv of rare) {
      const idx = dataset.rows.findIndex(
        (r) => String(r[categoricalCol]) === rv,
      );
      if (idx !== -1 && !indices.includes(idx) && indices.length < sampleN)
        indices.push(idx);
    }
  }

  // Fill remaining deterministically with hash-seeded shuffle
  let s = 0;
  for (const c of seed) s = (Math.imul(33, s) ^ c.charCodeAt(0)) >>> 0;
  while (indices.length < sampleN) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    const idx = s % n;
    if (!indices.includes(idx)) indices.push(idx);
  }

  const results: DataRepresentativeEmbedding[] = [];
  for (const idx of indices.slice(0, sampleN)) {
    const row = dataset.rows[idx];
    const text = Object.entries(row)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | ");
    const chunkHash = await hashString(
      `${contentHash}:${idx}:${text.slice(0, 50)}`,
    ).catch(() => `${contentHash}-${idx}`);
    results.push({
      kind: "data_representative",
      datasetId,
      uploadId,
      contentHash,
      chunkId: `row-${idx}`,
      chunkHash: String(chunkHash).slice(0, 12),
      text,
      metadata: {
        source: "derived-data",
        persistence: "local",
        rawDataPersisted: false,
        sample,
        rowIndices: [idx],
      },
    });
  }
  return results;
}

export function getSelectionPolicy(rowCount: number): SelectionPolicy {
  if (rowCount <= 1000) {
    return {
      mode: "exact",
      sampleN: rowCount,
      sample: {
        n: rowCount,
        method: "stratified",
        coverage: "exact",
        seed: "auto",
        strategyVersion: STRATEGY_VERSION,
      },
    };
  }
  if (rowCount <= 5000) {
    return {
      mode: "representative",
      sampleN: Math.min(400 + Math.floor(rowCount / 10), 1000),
      sample: {
        n: Math.min(400 + Math.floor(rowCount / 10), 1000),
        method: "stratified",
        coverage: "sample",
        seed: "auto",
        strategyVersion: STRATEGY_VERSION,
      },
    };
  }
  return {
    mode: "representative",
    sampleN: 200,
    sample: {
      n: 200,
      method: "stratified",
      coverage: "sample",
      seed: "auto",
      strategyVersion: STRATEGY_VERSION,
    },
  };
}
