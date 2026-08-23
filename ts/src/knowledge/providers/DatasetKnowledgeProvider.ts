import type { KnowledgeRecord } from "../types";
import type { KnowledgeProvider } from "../KnowledgeService";
import { hashString } from "@polymorpha/business-logic";
import {
  EMBED_CHUNK_TOKENS,
  EMBED_PER_COLUMN_LIMIT,
  EMBED_DATA_SAMPLE_N,
} from "../../config";
import {
  buildDatasetProfileEmbedding,
  buildDatasetDescriptionEmbedding,
  buildColumnSemanticEmbeddings,
  buildHeaderOnlyColumnEmbeddings,
  buildDataRepresentativeEmbeddings,
} from "../../lib/representation/DatasetRepresentationService";
import type {
  DataRepresentativeEmbedding,
  ColumnSemanticEmbedding,
  DatasetProfileEmbedding,
} from "../../lib/representation/types";

/**
 * DatasetKnowledgeProvider — thin adapter over DatasetRepresentationService + RagStore.
 * Produces KnowledgeRecords for the single semantic retrieval plane.
 * Does not own vector storage; only translates semantic representation → KnowledgeRecord.
 * G24: reuses existing sampling + Rag pipelines, no duplicate engine.
 */

async function sourceHash(text: string): Promise<string> {
  try {
    const hex = await hashString(text);
    return hex.slice(0, 16);
  } catch {
    let h = 5381;
    for (let i = 0; i < text.length; i++)
      h = (Math.imul(33, h) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
}

function chunkTextSimple(text: string, chunkTokens: number): string[] {
  if (!text) return [];
  const approxChars = chunkTokens * 4;
  if (text.length <= approxChars) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    // try to break at newline
    let end = Math.min(start + approxChars, text.length);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start + approxChars * 0.5) end = lastNewline + 1;
    }
    out.push(text.slice(start, end).trim());
    start = end;
  }
  return out.filter(Boolean);
}

export type DatasetKnowledgeProviderInput = {
  ragDatasets: Map<string, import("../../lib/rag/types").RagProfileState>;
  activeUploadId?: string | null;
  dataState?: {
    raw?:
      | import("../../notebook/types").Notebook
      | (unknown & { rows?: unknown[]; columns?: unknown[]; fileName?: string })
      | null;
    uploadId?: string | null;
    objective?: string | null;
  } | null;
};

export class DatasetKnowledgeProvider implements KnowledgeProvider {
  // Library: GitHub-only, no local fallback. Caller (polymorpha) must inject ragDatasets + dataState.
  // If not injected, try store fallback for unit tests (P2 header-only), else return [].
  private injected: DatasetKnowledgeProviderInput | null = null;

  setInput(input: DatasetKnowledgeProviderInput | null): void {
    this.injected = input;
  }

  async provide(
    workspaceId: string,
    // notebook unused for dataset plane but kept for interface parity
    _notebook?: unknown,
    injectedOverride?: DatasetKnowledgeProviderInput,
  ): Promise<KnowledgeRecord[]> {
    try {
      let src = injectedOverride ?? this.injected;
      // Fallback for unit tests / local polymorpha when not injected — read from stores
      if (!src) {
        try {
          const { useDataStore } = await import("@/store/useDataStore");
          const { useRagStore } = await import("@/store/useRagStore");
          const dsState = (
            useDataStore as unknown as {
              getState: () => {
                raw: unknown;
                uploadId: string | null;
                objective?: string | null;
              };
            }
          ).getState();
          const ragStateRaw = (
            useRagStore as unknown as {
              getState: () => {
                byDataset: Map<
                  string,
                  import("../../lib/rag/types").RagProfileState
                >;
                activeUploadId: string | null;
              };
            }
          ).getState();
          // Only fallback if we have something to provide
          if (dsState.raw || ragStateRaw.byDataset.size > 0) {
            src = {
              ragDatasets: ragStateRaw.byDataset,
              activeUploadId:
                (dsState as unknown as { uploadId: string | null }).uploadId ??
                null,
              dataState: {
                raw: dsState.raw as unknown as
                  | import("../../notebook/types").Notebook
                  | (unknown & {
                      rows?: unknown[];
                      columns?: unknown[];
                      fileName?: string;
                    })
                  | null,
                uploadId:
                  (dsState as unknown as { uploadId: string | null })
                    .uploadId ?? null,
                objective:
                  (dsState as unknown as { objective?: string | null })
                    .objective ?? null,
              },
            } as unknown as DatasetKnowledgeProviderInput;
          }
        } catch {
          // ignore, will return []
        }
      }
      if (!src) return [];
      const ragState = {
        byDataset: src.ragDatasets,
        activeUploadId: src.activeUploadId ?? null,
      } as unknown as {
        byDataset: Map<string, import("../../lib/rag/types").RagProfileState>;
        activeUploadId: string | null;
      };
      const dataState = (src.dataState ?? {
        raw: null,
        uploadId: null,
      }) as unknown as {
        raw:
          | (import("../../lib/rag/types").RagDatasetProfile & {
              rows: unknown[];
              columns: { name: string; type: string }[];
              fileName: string;
            })
          | null;
        uploadId: string | null;
        objective?: string | null;
      };
      const out: KnowledgeRecord[] = [];
      const now = Date.now();

      // Collect datasets: byDataset map + active raw dataset fallback
      const entries = Array.from(ragState.byDataset.entries());
      // Ensure at least one entry if RAG hasn't profiled yet but raw exists
      let isSyntheticFallback = false;
      if (entries.length === 0 && dataState.raw) {
        isSyntheticFallback = true;
        const fileName = dataState.raw.fileName ?? "dataset.csv";
        const uploadId = dataState.uploadId ?? fileName;
        entries.push([
          uploadId,
          {
            profile: {
              dataset: {
                rows: dataState.raw.rows.length,
                cols: dataState.raw.columns.length,
                fileSizeEstimate: 0,
                columnCountByType: dataState.raw.columns.reduce(
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
              perColumn: dataState.raw.columns.map((c) => ({
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
          } as unknown as (typeof entries)[number][1],
        ]);
      }

      for (const [uploadId, state] of entries) {
        const profile = state.profile;
        const contentHash = state.hash ?? state.contentHash ?? uploadId;
        const sampleMeta = state.sample;
        const datasetId = uploadId;
        const datasetName =
          dataState.raw?.fileName ??
          (dataState.raw?.columns[0]?.name ? `${uploadId}.csv` : uploadId);
        // Resolve dataset for representative building if this is active dataset
        const isActive =
          dataState.uploadId === uploadId ||
          ragState.activeUploadId === uploadId;
        const datasetForRep = isActive ? dataState.raw : null;
        const objective =
          (dataState as unknown as { objective?: string | null }).objective ??
          null;

        // 1) dataset_profile — synthetic description via template (P2)
        if (datasetForRep) {
          try {
            const synthetic = buildDatasetDescriptionEmbedding(
              datasetId,
              uploadId,
              String(contentHash),
              datasetForRep as unknown as import("@/types").Dataset,
              objective,
            );
            const shSynth = await sourceHash(
              `${workspaceId}:${datasetId}:description:${synthetic.text.slice(0, 80)}`,
            );
            out.push({
              id: `dataset:${datasetId}:description`,
              workspaceId,
              notebookId: `nb:${workspaceId}`,
              datasetId,
              kind: "dataset_profile",
              text: synthetic.text,
              metadata: {
                source: "dataset_metadata",
                representation: "synthetic_description",
                generated: false as unknown as boolean,
                semanticLevel: "synthetic" as const,
                profileStatus: "pending" as const,
                uploadId,
                contentHash: String(contentHash),
                datasetName,
                ...synthetic.metadata,
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                datasetName,
              },
              sourceHash: shSynth,
              createdAt: state.updatedAt ?? now,
              updatedAt: state.updatedAt ?? now,
            });
          } catch {}
        }

        if (profile.dataset) {
          // For synthetic fallback, skip duplicate profile vs synthetic? Keep both but synthetic already above.
          // Only add profile if not synthetic fallback or if we want both; for header-only test we still need profile? The test doesn't check profile for header-only, only column.
          // We will add profile record even for synthetic fallback to keep previous behavior.
          const artifact: DatasetProfileEmbedding | null = datasetForRep
            ? buildDatasetProfileEmbedding(
                datasetId,
                uploadId,
                String(contentHash),
                profile.dataset,
                datasetForRep as unknown as import("@/types").Dataset,
              )
            : null;
          const text =
            artifact?.text ??
            `Dataset ${datasetName} profile: ${profile.dataset.rows} rows ×${profile.dataset.cols} cols format ${profile.dataset.format}, duplicate ${profile.dataset.duplicatePct}% (${profile.dataset.duplicateRows} rows), types ${Object.entries(
              profile.dataset.columnCountByType,
            )
              .map(([k, v]) => `${k}:${v}`)
              .join(", ")}`;
          const sh = await sourceHash(
            `${workspaceId}:${datasetId}:profile:${text.slice(0, 100)}`,
          );
          out.push({
            id: `dataset:${datasetId}:profile`,
            workspaceId,
            notebookId: `nb:${workspaceId}`,
            datasetId,
            kind: "dataset_profile",
            text,
            metadata: {
              source: "dataset_profile",
              uploadId,
              contentHash: String(contentHash),
              datasetName,
              ...artifact?.metadata,
            },
            provenance: {
              workspaceId,
              datasetIds: [datasetId],
              uploadId,
              contentHash: String(contentHash),
              datasetName,
            },
            sourceHash: sh,
            createdAt: state.updatedAt ?? now,
            updatedAt: state.updatedAt ?? now,
          });
        }

        // 2) column_semantic — one column = one vector, limit is richness cap not truncation (P2)
        // Cases:
        // - before profile (isSyntheticFallback && datasetForRep): header-only for all columns via buildHeaderOnly
        // - with profile: first EMBED_PER_COLUMN_LIMIT profile-rich, remaining header-only
        // - no profile and no dataset: skip
        if (isSyntheticFallback && datasetForRep) {
          let headerOnly: ColumnSemanticEmbedding[] = [];
          try {
            headerOnly = buildHeaderOnlyColumnEmbeddings(
              datasetId,
              uploadId,
              String(contentHash),
              datasetForRep as unknown as import("@/types").Dataset,
            );
          } catch {
            // ignore
          }
          for (const col of headerOnly) {
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:col:${col.columnName}:${col.text.slice(0, 80)}`,
            );
            out.push({
              id: `dataset:${datasetId}:col:${col.columnName}`,
              workspaceId,
              notebookId: `nb:${workspaceId}`,
              datasetId,
              kind: "column_semantic",
              text: col.text,
              metadata: {
                source: "column_semantic",
                uploadId,
                contentHash: String(contentHash),
                column: col.columnName,
                columns: [col.columnName],
                ...col.metadata,
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                datasetName,
                columns: [col.columnName],
              },
              sourceHash: sh,
              createdAt: state.updatedAt ?? now,
              updatedAt: state.updatedAt ?? now,
            });
          }
        } else if (profile.perColumn && profile.perColumn.length > 0) {
          const colArtifacts: ColumnSemanticEmbedding[] =
            buildColumnSemanticEmbeddings(
              datasetId,
              uploadId,
              String(contentHash),
              profile.perColumn,
              EMBED_PER_COLUMN_LIMIT,
            );
          for (const col of colArtifacts) {
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:col:${col.columnName}:${col.text.slice(0, 80)}`,
            );
            out.push({
              id: `dataset:${datasetId}:col:${col.columnName}`,
              workspaceId,
              notebookId: `nb:${workspaceId}`,
              datasetId,
              kind: "column_semantic",
              text: col.text,
              metadata: {
                source: "column_semantic",
                uploadId,
                contentHash: String(contentHash),
                column: col.columnName,
                columns: [col.columnName],
                ...col.metadata,
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                datasetName,
                columns: [col.columnName],
              },
              sourceHash: sh,
              createdAt: state.updatedAt ?? now,
              updatedAt: state.updatedAt ?? now,
            });
          }
          // remaining beyond limit -> header-only (no sampleCoverage)
          if (profile.perColumn.length > EMBED_PER_COLUMN_LIMIT) {
            const remaining = profile.perColumn.slice(EMBED_PER_COLUMN_LIMIT);
            for (const col of remaining) {
              const text = `Column "${col.name}" is ${col.type}`;
              const sh = await sourceHash(
                `${workspaceId}:${datasetId}:col:${col.name}:${text.slice(0, 80)}`,
              );
              out.push({
                id: `dataset:${datasetId}:col:${col.name}`,
                workspaceId,
                notebookId: `nb:${workspaceId}`,
                datasetId,
                kind: "column_semantic",
                text,
                metadata: {
                  source: "column_semantic",
                  uploadId,
                  contentHash: String(contentHash),
                  column: col.name,
                  columns: [col.name],
                  type: col.type,
                  unique: 0,
                  missingPct: 0,
                  semanticLevel: "schema" as const,
                  profileStatus: "pending" as const,
                },
                provenance: {
                  workspaceId,
                  datasetIds: [datasetId],
                  uploadId,
                  contentHash: String(contentHash),
                  datasetName,
                  columns: [col.name],
                },
                sourceHash: sh,
                createdAt: state.updatedAt ?? now,
                updatedAt: state.updatedAt ?? now,
              });
            }
          }
        } else if (datasetForRep) {
          // no perColumn yet but dataset exists (edge)
          const headerOnly = buildHeaderOnlyColumnEmbeddings(
            datasetId,
            uploadId,
            String(contentHash),
            datasetForRep as unknown as import("@/types").Dataset,
          );
          for (const col of headerOnly) {
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:col:${col.columnName}:${col.text.slice(0, 80)}`,
            );
            out.push({
              id: `dataset:${datasetId}:col:${col.columnName}`,
              workspaceId,
              notebookId: `nb:${workspaceId}`,
              datasetId,
              kind: "column_semantic",
              text: col.text,
              metadata: {
                source: "column_semantic",
                uploadId,
                contentHash: String(contentHash),
                column: col.columnName,
                columns: [col.columnName],
                ...col.metadata,
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                datasetName,
                columns: [col.columnName],
              },
              sourceHash: sh,
              createdAt: state.updatedAt ?? now,
              updatedAt: state.updatedAt ?? now,
            });
          }
        }

        // 3) data_representative — sample n=200 describes sample, not vector count; chunk serialized rows by 512 tokens
        {
          let repTexts: string[] = [];
          let repSample = sampleMeta ?? {
            n: EMBED_DATA_SAMPLE_N,
            method: "stratified" as const,
            coverage: "sample" as const,
            seed: "polymorpha-v1",
            strategyVersion: "v1-head-tail-quantile-rare",
          };
          let repRowIndices: number[][] = [];

          if (datasetForRep) {
            try {
              const embeddings: DataRepresentativeEmbedding[] =
                await buildDataRepresentativeEmbeddings(
                  datasetId,
                  uploadId,
                  String(contentHash),
                  datasetForRep as unknown as import("@/types").Dataset,
                  profile.perColumn,
                  {
                    mode:
                      repSample.coverage === "exact"
                        ? "exact"
                        : "representative",
                    sampleN: repSample.n ?? EMBED_DATA_SAMPLE_N,
                  },
                );
              if (embeddings.length > 0) {
                repSample = embeddings[0].metadata.sample;
                // Serialize per-row texts then chunk by token budget
                const serialized = embeddings.map((e) => e.text).join("\n");
                const chunks = chunkTextSimple(serialized, EMBED_CHUNK_TOKENS);
                repTexts = chunks;
                // chunk row indices roughly proportionally
                const perChunk = Math.ceil(
                  embeddings.length / Math.max(1, chunks.length),
                );
                for (let i = 0; i < chunks.length; i++) {
                  const slice = embeddings.slice(
                    i * perChunk,
                    (i + 1) * perChunk,
                  );
                  repRowIndices.push(
                    slice.flatMap((e) => e.metadata.rowIndices ?? []),
                  );
                }
              }
            } catch {
              // ignore, fallback below
            }
          }

          // Fallback if no dataset rows available but columns exist — synthesize representatives from column stats
          if (
            repTexts.length === 0 &&
            profile.perColumn &&
            profile.perColumn.length > 0
          ) {
            const synth = `Representative sample for ${datasetName} (${datasetId}): ${profile.perColumn
              .slice(0, 5)
              .map(
                (c) =>
                  `${c.name}(${c.type}) top ${
                    c.topK
                      ?.slice(0, 3)
                      .map((k) => `${k.value}`)
                      .join(", ") ?? "n/a"
                  }`,
              )
              .join(" | ")}`;
            repTexts = chunkTextSimple(synth, EMBED_CHUNK_TOKENS);
            repRowIndices = repTexts.map(() => []);
          }

          for (let i = 0; i < repTexts.length; i++) {
            const text = repTexts[i];
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:rep:${i}:${text.slice(0, 80)}`,
            );
            out.push({
              id: `dataset:${datasetId}:rep:${i}`,
              workspaceId,
              notebookId: `nb:${workspaceId}`,
              datasetId,
              kind: "data_representative",
              text,
              metadata: {
                source: "data_representative",
                uploadId,
                contentHash: String(contentHash),
                sample: repSample,
                chunkId: `rep-${i}`,
                columns: profile.perColumn?.map((c) => c.name),
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                datasetName,
                sampleCoverage: repSample.coverage,
                chunkId: `rep-${i}`,
                rowIndices: repRowIndices[i],
                columns: profile.perColumn?.map((c) => c.name),
              },
              sourceHash: sh,
              createdAt: state.updatedAt ?? now,
              updatedAt: state.updatedAt ?? now,
            });
          }
        }
      }

      return out;
    } catch {
      return [];
    }
  }
}

export const datasetKnowledgeProvider = new DatasetKnowledgeProvider();
