import { chunkText as modelChunkText } from "../../../stella/models/embeddingModel";
import type { KnowledgeRecord } from "../../types";
import type {
  RagDatasetProfile,
  RagProfileState,
} from "../../../lib/rag/types";
import {
  DATASET_TOP_INSIGHTS,
  DATASET_TOP_QUALITY,
  SNIPPET_ID,
} from "../../../config/knowledge";
import {
  EMBED_CHUNK_TOKENS,
  EMBED_DATA_SAMPLE_N,
  EMBED_SAMPLING_SEED,
  EMBED_SAMPLING_VERSION,
} from "../../../config";
import { buildDataRepresentativeEmbeddings } from "../../../lib/representation/DatasetRepresentationService";
import type {
  DataRepresentativeEmbedding,
  DataRepresentativeSample,
} from "../../../lib/representation/types";
import type { DsCtx, ProviderDataState, ProviderRaw } from "./model";

/**
 * Record builders for DatasetKnowledgeProvider (were inline in provide()).
 * Pure assembly: callers own sourcing (builders) and hashing (sourceHash).
 */

/** Single column_semantic record — the triplicated push, now one function. */
export function pushColumnRecord(
  out: KnowledgeRecord[],
  ctx: DsCtx,
  columnName: string,
  text: string,
  metadata: Record<string, unknown>,
  sourceHash: string,
): void {
  out.push({
    id: `dataset:${ctx.datasetId}:col:${columnName}`,
    workspaceId: ctx.workspaceId,
    notebookId: `nb:${ctx.workspaceId}`,
    datasetId: ctx.datasetId,
    kind: "column_semantic",
    text,
    metadata: {
      source: "column_semantic",
      uploadId: ctx.uploadId,
      contentHash: ctx.contentHash,
      column: columnName,
      columns: [columnName],
      ...metadata,
    },
    provenance: {
      workspaceId: ctx.workspaceId,
      datasetIds: [ctx.datasetId],
      uploadId: ctx.uploadId,
      contentHash: ctx.contentHash,
      datasetName: ctx.datasetName,
      columns: [columnName],
    },
    sourceHash,
    createdAt: ctx.updatedAt,
    updatedAt: ctx.updatedAt,
  });
}

type PerColumn = NonNullable<RagDatasetProfile["perColumn"]>;

/**
 * Synthetic fallback entry when RAG hasn't profiled yet but raw exists.
 * Returns true when the fallback was installed (caller treats columns as header-only).
 */
export function ensureSyntheticEntries(
  entries: Array<[string, RagProfileState]>,
  dataState: ProviderDataState,
  now: number,
): boolean {
  if (entries.length > 0 || !dataState.raw) return false;
  const raw: ProviderRaw = dataState.raw;
  const fileName = raw.fileName ?? "dataset.csv";
  const uploadId = dataState.uploadId ?? fileName;
  entries.push([
    uploadId,
    {
      profile: {
        dataset: {
          rows: raw.rows.length,
          cols: raw.columns.length,
          fileSizeEstimate: 0,
          columnCountByType: raw.columns.reduce(
            (acc: Record<string, number>, c) => {
              acc[c.type] = (acc[c.type] ?? 0) + 1;
              return acc;
            },
            {},
          ),
          duplicateRows: 0,
          duplicatePct: 0,
          emptyRows: 0,
          emptyCols: 0,
          constantCols: [],
          format: fileName.split(".").pop() ?? "csv",
        },
        perColumn: raw.columns.map((c) => ({
          name: c.name,
          type: c.type,
          detectedType: c.type,
          unique: 0,
          cardinalityRatio: 0,
          missing: 0,
          missingPct: 0,
        })),
        missing: null,
        duplicate: null,
        quality: null,
      },
      status: {
        dataset: "done",
        perColumn: "done",
        missing: "pending",
        duplicate: "pending",
        quality: "pending",
      },
      isProfiling: false,
      error: null,
      hash: null,
      updatedAt: now,
      uploadId,
      contentHash: null,
      sample: null,
    } as unknown as RagProfileState,
  ]);
  return true;
}

export interface RepresentativeTexts {
  texts: string[];
  sample: DataRepresentativeSample;
  rowIndices: number[][];
}

/**
 * data_representative text computation: sample → serialize → chunk by token
 * budget, with column-stats synthesis fallback when rows are unavailable.
 */
export async function buildRepresentativeTexts(args: {
  dataset: ProviderRaw | null;
  datasetId: string;
  uploadId: string;
  contentHash: string;
  datasetName: string;
  perColumn: PerColumn | null | undefined;
  sampleMeta: DataRepresentativeSample | null | undefined;
}): Promise<RepresentativeTexts> {
  const { dataset, datasetId, uploadId, contentHash, datasetName, perColumn } =
    args;
  let repTexts: string[] = [];
  let repSample: DataRepresentativeSample = args.sampleMeta ?? {
    n: EMBED_DATA_SAMPLE_N,
    method: "stratified" as const,
    coverage: "sample" as const,
    seed: EMBED_SAMPLING_SEED,
    strategyVersion: EMBED_SAMPLING_VERSION,
  };
  let repRowIndices: number[][] = [];

  if (dataset) {
    try {
      const sample = repSample;
      const embeddings: DataRepresentativeEmbedding[] =
        await buildDataRepresentativeEmbeddings(
          datasetId,
          uploadId,
          String(contentHash),
          dataset as unknown as import("../../../types").Dataset,
          perColumn ?? null,
          {
            mode: sample.coverage === "exact" ? "exact" : "representative",
            sampleN: sample.n ?? EMBED_DATA_SAMPLE_N,
          },
        );
      if (embeddings.length > 0) {
        repSample = embeddings[0].metadata.sample;
        // Serialize per-row texts then chunk by token budget
        const serialized = embeddings.map((e) => e.text).join("\n");
        const chunks = modelChunkText(serialized, EMBED_CHUNK_TOKENS);
        repTexts = chunks;
        // chunk row indices roughly proportionally
        const perChunk = Math.ceil(
          embeddings.length / Math.max(1, chunks.length),
        );
        for (let i = 0; i < chunks.length; i++) {
          const slice = embeddings.slice(i * perChunk, (i + 1) * perChunk);
          repRowIndices.push(slice.flatMap((e) => e.metadata.rowIndices ?? []));
        }
      }
    } catch {
      // ignore, fallback below
    }
  }

  // Fallback if no dataset rows available but columns exist — synthesize representatives from column stats
  if (repTexts.length === 0 && perColumn && perColumn.length > 0) {
    const synth = `Representative sample for ${datasetName} (${datasetId}): ${perColumn
      .slice(0, DATASET_TOP_INSIGHTS)
      .map(
        (c) =>
          `${c.name}(${c.type}) top ${
            c.topK
              ?.slice(0, DATASET_TOP_QUALITY)
              .map((k) => `${k.value}`)
              .join(", ") ?? "n/a"
          }`,
      )
      .join(" | ")}`;
    repTexts = modelChunkText(synth, EMBED_CHUNK_TOKENS);
    repRowIndices = repTexts.map(() => []);
  }

  return { texts: repTexts, sample: repSample, rowIndices: repRowIndices };
}
