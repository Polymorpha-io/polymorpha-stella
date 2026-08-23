import type { KnowledgeRecord } from "../types";
import type { KnowledgeProvider } from "../KnowledgeService";
import { hashString } from "@polymorpha/business-logic";

/**
 * RelationshipKnowledgeProvider — thin adapter over RagService pipelines.
 * No new analysis engine; reuses existing RAG outputs:
 * missing.missingTogether, duplicate.candidateKeys/compositeKeys, perColumn correlations.
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

export type RelationshipKnowledgeProviderInput = {
  ragDatasets: Map<string, import("../../lib/rag/types").RagProfileState>;
  activeUploadId?: string | null;
};

export class RelationshipKnowledgeProvider implements KnowledgeProvider {
  private injected: RelationshipKnowledgeProviderInput | null = null;
  setInput(input: RelationshipKnowledgeProviderInput | null): void {
    this.injected = input;
  }

  async provide(
    workspaceId: string,
    notebook?: unknown,
    injectedOverride?: RelationshipKnowledgeProviderInput,
  ): Promise<KnowledgeRecord[]> {
    void notebook;
    try {
      const src = injectedOverride ?? this.injected;
      if (!src) return [];
      const ragState = {
        byDataset: src.ragDatasets,
        activeUploadId: src.activeUploadId ?? null,
        profile: {
          dataset: null,
          perColumn: null,
          missing: null,
          duplicate: null,
          quality: null,
        } as unknown as import("../../lib/rag/types").RagDatasetProfile,
        status: {} as Record<string, string>,
        isProfiling: false,
        error: null,
        hash: null,
        updatedAt: null,
        // for fallback single
        get profileGetter() {
          return (this as unknown as { profile: unknown }).profile;
        },
      } as unknown as {
        byDataset: Map<string, import("../../lib/rag/types").RagProfileState>;
        activeUploadId: string | null;
        profile: import("../../lib/rag/types").RagDatasetProfile;
        status: Record<string, string>;
        isProfiling: boolean;
        error: null;
        hash: string | null;
        updatedAt: number | null;
      };
      const entries = Array.from(ragState.byDataset.entries());
      const out: KnowledgeRecord[] = [];
      const now = Date.now();

      // If no profile, try single compatibility profile
      if (entries.length === 0 && ragState.profile.dataset) {
        // fallback single
        entries.push([
          ragState.hash ?? "__single__",
          {
            profile: ragState.profile,
            status: ragState.status,
            isProfiling: ragState.isProfiling,
            error: ragState.error,
            hash: ragState.hash,
            updatedAt: ragState.updatedAt,
            uploadId: ragState.activeUploadId ?? "__single__",
            contentHash: ragState.hash,
            sample:
              ragState.byDataset.get(ragState.activeUploadId ?? "__single__")
                ?.sample ?? null,
          } as unknown as (typeof entries)[number][1],
        ]);
      }

      for (const [uploadId, state] of entries) {
        const { missing, duplicate, quality, perColumn } = state.profile;
        const contentHash = state.hash ?? state.contentHash ?? uploadId;
        const datasetId = uploadId;

        // missingTogether → relationship
        if (missing?.missingTogether && missing.missingTogether.length > 0) {
          for (const rel of missing.missingTogether.slice(0, 10)) {
            const text = `Relationship: columns "${rel.a}" and "${rel.b}" tend to be missing together (correlation ${rel.correlation.toFixed(2)}) in dataset ${datasetId}`;
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:rel:missingTogether:${rel.a}:${rel.b}`,
            );
            out.push({
              id: `rel:${datasetId}:missingTogether:${rel.a}:${rel.b}`,
              workspaceId,
              notebookId: `nb:${workspaceId}`,
              datasetId,
              kind: "relationship",
              text,
              metadata: {
                source: "relationship",
                type: "missingTogether",
                uploadId,
                contentHash: String(contentHash),
                columns: [rel.a, rel.b],
                correlation: rel.correlation,
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                columns: [rel.a, rel.b],
              },
              sourceHash: sh,
              createdAt: state.updatedAt ?? now,
              updatedAt: state.updatedAt ?? now,
            });
          }
        }

        // duplicate candidateKeys
        if (duplicate?.candidateKeys && duplicate.candidateKeys.length > 0) {
          const keys = duplicate.candidateKeys.slice(0, 5).join(", ");
          const text = `Relationship: candidate key columns [${keys}] uniquely identify rows in dataset ${datasetId} (duplicate ${duplicate.duplicatePct}% ${duplicate.duplicateRows} rows)`;
          const sh = await sourceHash(
            `${workspaceId}:${datasetId}:rel:candidateKeys:${keys}`,
          );
          out.push({
            id: `rel:${datasetId}:candidateKeys`,
            workspaceId,
            notebookId: `nb:${workspaceId}`,
            datasetId,
            kind: "relationship",
            text,
            metadata: {
              source: "relationship",
              type: "candidateKeys",
              uploadId,
              contentHash: String(contentHash),
              columns: duplicate.candidateKeys,
            },
            provenance: {
              workspaceId,
              datasetIds: [datasetId],
              uploadId,
              contentHash: String(contentHash),
              columns: duplicate.candidateKeys,
            },
            sourceHash: sh,
            createdAt: state.updatedAt ?? now,
            updatedAt: state.updatedAt ?? now,
          });
        }

        if (duplicate?.compositeKeys && duplicate.compositeKeys.length > 0) {
          for (const comp of duplicate.compositeKeys.slice(0, 5)) {
            const text = `Relationship: composite key [${comp.join(", ")}] uniquely identifies rows in dataset ${datasetId}`;
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:rel:composite:${comp.join("_")}`,
            );
            out.push({
              id: `rel:${datasetId}:composite:${comp.join("_")}`,
              workspaceId,
              notebookId: `nb:${workspaceId}`,
              datasetId,
              kind: "relationship",
              text,
              metadata: {
                source: "relationship",
                type: "compositeKeys",
                uploadId,
                contentHash: String(contentHash),
                columns: comp,
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                columns: comp,
              },
              sourceHash: sh,
              createdAt: state.updatedAt ?? now,
              updatedAt: state.updatedAt ?? now,
            });
          }
        }

        // quality invalid / mixed types
        if (quality?.invalid && quality.invalid.length > 0) {
          for (const inv of quality.invalid.slice(0, 5)) {
            const text = `Relationship: column "${inv.column}" has ${inv.count} invalid ${inv.issue} values in dataset ${datasetId}`;
            const sh = await sourceHash(
              `${workspaceId}:${datasetId}:rel:quality:${inv.column}:${inv.issue}`,
            );
            out.push({
              id: `rel:${datasetId}:quality:${inv.column}:${inv.issue}`,
              workspaceId,
              notebookId: `nb:${workspaceId}`,
              datasetId,
              kind: "relationship",
              text,
              metadata: {
                source: "relationship",
                type: "quality",
                uploadId,
                contentHash: String(contentHash),
                columns: [inv.column],
              },
              provenance: {
                workspaceId,
                datasetIds: [datasetId],
                uploadId,
                contentHash: String(contentHash),
                columns: [inv.column],
              },
              sourceHash: sh,
              createdAt: state.updatedAt ?? now,
              updatedAt: state.updatedAt ?? now,
            });
          }
        }

        // highMissingCols
        if (missing?.highMissingCols && missing.highMissingCols.length > 0) {
          const text = `Relationship: columns with high missing rate in ${datasetId}: ${missing.highMissingCols.join(", ")} (avg missing per row ${missing.perRow.avgMissingPerRow.toFixed(1)})`;
          const sh = await sourceHash(
            `${workspaceId}:${datasetId}:rel:highMissing:${missing.highMissingCols.join(",")}`,
          );
          out.push({
            id: `rel:${datasetId}:highMissing`,
            workspaceId,
            notebookId: `nb:${workspaceId}`,
            datasetId,
            kind: "relationship",
            text,
            metadata: {
              source: "relationship",
              type: "highMissing",
              uploadId,
              contentHash: String(contentHash),
              columns: missing.highMissingCols,
            },
            provenance: {
              workspaceId,
              datasetIds: [datasetId],
              uploadId,
              contentHash: String(contentHash),
              columns: missing.highMissingCols,
            },
            sourceHash: sh,
            createdAt: state.updatedAt ?? now,
            updatedAt: state.updatedAt ?? now,
          });
        }

        // numeric correlations via perColumn - if we had correlation matrix we'd add; for now top correlations from perColumn skewness etc not relationship — skip
        void perColumn;
      }

      return out;
    } catch {
      return [];
    }
  }
}
