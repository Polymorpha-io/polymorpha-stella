import type { KnowledgeRecord } from "../types";
import type { KnowledgeProvider } from "../KnowledgeService";
import type { RagProfileState } from "../../lib/rag/types";
import { sourceHash } from "../sourceHash";
import { EMBED_PER_COLUMN_LIMIT } from "../../config";
import { SNIPPET_ID, SNIPPET_PROFILE } from "../../config/knowledge";
import {
  buildDatasetProfileEmbedding,
  buildDatasetDescriptionEmbedding,
  buildColumnSemanticEmbeddings,
  buildHeaderOnlyColumnEmbeddings,
} from "../../lib/representation/DatasetRepresentationService";
import type {
  ColumnSemanticEmbedding,
  DatasetProfileEmbedding,
} from "../../lib/representation/types";
import type {
  DatasetKnowledgeProviderInput,
  DsCtx,
  ProviderRaw,
} from "./dataset/model";
export type { DatasetKnowledgeProviderInput } from "./dataset/model";
import { resolveProviderState } from "./dataset/input";
import {
  buildRepresentativeTexts,
  ensureSyntheticEntries,
  pushColumnRecord,
} from "./dataset/records";

/**
 * DatasetKnowledgeProvider — thin adapter over DatasetRepresentationService + RagStore.
 * Produces KnowledgeRecords for the single semantic retrieval plane.
 * Does not own vector storage; only translates semantic representation → KnowledgeRecord.
 * G24: reuses existing sampling + Rag pipelines, no duplicate engine.
 *
 * Split 2026-09-11: input resolution → dataset/input.ts, record assembly →
 * dataset/records.ts. This class keeps orchestration + public API unchanged.
 */
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
      const resolved = await resolveProviderState(
        injectedOverride,
        this.injected,
      );
      if (!resolved) return [];
      const { ragState, dataState } = resolved;
      const out: KnowledgeRecord[] = [];
      const now = Date.now();

      // Collect datasets: byDataset map + active raw dataset fallback
      const entries: Array<[string, RagProfileState]> = Array.from(
        ragState.byDataset.entries(),
      );
      // Ensure at least one entry if RAG hasn't profiled yet but raw exists
      const isSyntheticFallback = ensureSyntheticEntries(
        entries,
        dataState,
        now,
      );

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
        const ctx: DsCtx = {
          workspaceId,
          datasetId,
          uploadId,
          contentHash: String(contentHash),
          datasetName,
          now,
          updatedAt: state.updatedAt ?? now,
        };

        // 1) dataset_profile — synthetic description via template (P2)
        if (datasetForRep) {
          try {
            const synthetic = buildDatasetDescriptionEmbedding(
              datasetId,
              uploadId,
              String(contentHash),
              datasetForRep as unknown as import("../../types").Dataset,
              objective,
            );
            const shSynth = await sourceHash(
              `${workspaceId}:${datasetId}:description:${synthetic.text.slice(0, SNIPPET_ID)}`,
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
                datasetForRep as unknown as import("../../types").Dataset,
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
            `${workspaceId}:${datasetId}:profile:${text.slice(0, SNIPPET_PROFILE)}`,
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
              datasetForRep as unknown as import("../../types").Dataset,
            );
          } catch {
            // ignore
          }
          for (const col of headerOnly) {
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:col:${col.columnName}:${col.text.slice(0, SNIPPET_ID)}`,
            );
            pushColumnRecord(
              out,
              ctx,
              col.columnName,
              col.text,
              {
                ...col.metadata,
              },
              sh,
            );
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
              `${workspaceId}:${datasetId}:col:${col.columnName}:${col.text.slice(0, SNIPPET_ID)}`,
            );
            pushColumnRecord(
              out,
              ctx,
              col.columnName,
              col.text,
              {
                ...col.metadata,
              },
              sh,
            );
          }
          // remaining beyond limit -> header-only (no sampleCoverage)
          if (profile.perColumn.length > EMBED_PER_COLUMN_LIMIT) {
            const remaining = profile.perColumn.slice(EMBED_PER_COLUMN_LIMIT);
            for (const col of remaining) {
              const text = `Column "${col.name}" is ${col.type}`;
              const sh = await sourceHash(
                `${workspaceId}:${datasetId}:col:${col.name}:${text.slice(0, SNIPPET_ID)}`,
              );
              pushColumnRecord(
                out,
                ctx,
                col.name,
                text,
                {
                  type: col.type,
                  unique: 0,
                  missingPct: 0,
                  semanticLevel: "schema" as const,
                  profileStatus: "pending" as const,
                },
                sh,
              );
            }
          }
        } else if (datasetForRep) {
          // no perColumn yet but dataset exists (edge)
          const headerOnly = buildHeaderOnlyColumnEmbeddings(
            datasetId,
            uploadId,
            String(contentHash),
            datasetForRep as unknown as import("../../types").Dataset,
          );
          for (const col of headerOnly) {
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:col:${col.columnName}:${col.text.slice(0, SNIPPET_ID)}`,
            );
            pushColumnRecord(
              out,
              ctx,
              col.columnName,
              col.text,
              {
                ...col.metadata,
              },
              sh,
            );
          }
        }

        // 3) data_representative — sample n=200 describes sample, not vector count; chunk serialized rows by 512 tokens
        {
          const rep = await buildRepresentativeTexts({
            dataset: datasetForRep as unknown as ProviderRaw | null,
            datasetId,
            uploadId,
            contentHash: String(contentHash),
            datasetName,
            perColumn: profile.perColumn,
            sampleMeta,
          });

          for (let i = 0; i < rep.texts.length; i++) {
            const text = rep.texts[i];
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:rep:${i}:${text.slice(0, SNIPPET_ID)}`,
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
                sample: rep.sample,
                chunkId: `rep-${i}`,
                columns: profile.perColumn?.map((c) => c.name),
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                datasetName,
                sampleCoverage: rep.sample.coverage,
                chunkId: `rep-${i}`,
                rowIndices: rep.rowIndices[i],
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
