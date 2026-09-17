import type { RagProfileState } from "../../../lib/rag/types";
import type { DatasetKnowledgeProviderInput } from "./model";
import type { ProviderDataState, ProviderRagState, ProviderRaw } from "./model";

/**
 * Input resolution for DatasetKnowledgeProvider (was inline in provide()).
 * Prefers explicit injection; falls back to library stores for unit tests /
 * un-injected UI; returns null when there is nothing to provide.
 */
export async function resolveProviderState(
  injectedOverride: DatasetKnowledgeProviderInput | undefined,
  injected: DatasetKnowledgeProviderInput | null,
): Promise<{
  ragState: ProviderRagState;
  dataState: ProviderDataState;
} | null> {
  let src = injectedOverride ?? injected;
  // Fallback for unit tests / local polymorpha when not injected — read from stores
  if (!src) {
    try {
      const { useDataStore } = await import("../../../store/useDataStore");
      const { useRagStore } = await import("../../../store/useRagStore");
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
            byDataset: Map<string, RagProfileState>;
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
            raw: dsState.raw as unknown as ProviderRaw | null,
            uploadId:
              (dsState as unknown as { uploadId: string | null }).uploadId ??
              null,
            objective:
              (dsState as unknown as { objective?: string | null }).objective ??
              null,
          },
        } as unknown as DatasetKnowledgeProviderInput;
      }
    } catch {
      // ignore, will return null below
    }
  }
  if (!src) return null;
  return {
    ragState: {
      byDataset: src.ragDatasets,
      activeUploadId: src.activeUploadId ?? null,
    },
    dataState: (src.dataState ?? {
      raw: null,
      uploadId: null,
    }) as ProviderDataState,
  };
}
