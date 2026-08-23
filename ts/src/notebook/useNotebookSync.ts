import { useEffect, useRef } from "react";
import { useDataStore } from "@/store/useDataStore";
import { notebookService } from "./NotebookService";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import type { Dataset } from "@/types";

function datasetIdsFromStore(
  ds: ReturnType<typeof useDataStore.getState>,
): string[] {
  const ids: string[] = [];
  if (ds.uploadId) ids.push(ds.uploadId);
  return ids;
}

/**
 * G24: Reuses NotebookService + KnowledgeService (thin adapters over IndexedDB/Embeddings) — no custom parsers.
 * Syncs wizard → notebook cells and keeps KnowledgeStore up-to-date.
 */
export function useNotebookSync(workspaceId: string | null) {
  const effectiveWsId = workspaceId ?? "guest";
  const raw = useDataStore(
    (s) => (s as unknown as { raw: Dataset | null }).raw,
  ) as Dataset | null;
  const cleaned = useDataStore(
    (s) => (s as unknown as { cleaned: Dataset | null }).cleaned,
  ) as Dataset | null;
  const appliedSteps = useDataStore(
    (s) =>
      (
        s as unknown as {
          appliedSteps: Array<{
            id: string;
            description: string;
            config: Record<string, unknown> & { type: string; column?: string };
          }>;
        }
      ).appliedSteps,
  ) as Array<{
    id: string;
    description: string;
    config: Record<string, unknown> & { type: string; column?: string };
  }>;
  const cleaningDiff = useDataStore(
    (s) =>
      (
        s as unknown as {
          cleaningDiff: {
            rowsRemoved?: number;
            valuesImputed?: Record<string, unknown>;
          } | null;
        }
      ).cleaningDiff,
  ) as { rowsRemoved?: number; valuesImputed?: Record<string, unknown> } | null;
  const results = useDataStore(
    (s) =>
      (s as unknown as { results: Record<string, unknown> | null }).results,
  ) as Record<string, unknown> | null;

  const prevRawRef = useRef<Dataset | null>(null);
  const prevAppliedLen = useRef(0);
  const prevCleanedRef = useRef<Dataset | null>(null);
  const prevResultsRef = useRef<unknown>(null);

  // Upload → cell
  useEffect(() => {
    if (!raw) return;
    if (prevRawRef.current && prevRawRef.current === raw) return;
    const isNew =
      !prevRawRef.current ||
      prevRawRef.current.fileName !== raw.fileName ||
      prevRawRef.current.rows.length !== raw.rows.length;
    if (!isNew) return;
    prevRawRef.current = raw;
    const dsIds = datasetIdsFromStore(useDataStore.getState());
    notebookService
      .appendCell(effectiveWsId, {
        type: "upload",
        status: "active",
        source: { uploadId: dsIds[0] },
        outputs: [
          {
            id: `out_${Date.now()}`,
            type: "dataset",
            data: { fileName: raw.fileName },
            metadata: {
              title: raw.fileName,
              rowCount: raw.rows.length,
              columns: raw.columns.map((c) => c.name),
            },
          },
        ],
        metadata: { title: `Upload ${raw.fileName}` },
        execution: {
          executionCount: 1,
          status: "success",
          inputHash: "upload",
          outputHash: `h_${raw.rows.length}_${raw.columns.length}`,
        },
        provenance: {
          datasetIds: dsIds,
          sourceCellIds: [],
          inputHashes: [],
          dependsOn: [],
        },
        step: "upload",
        datasetIds: dsIds,
      })
      .then(async () => {
        try {
          const nb = await notebookService.getOrCreate(effectiveWsId);
          await knowledgeService.indexNotebook(nb);
        } catch {}
      })
      .catch(() => {});
  }, [raw, effectiveWsId]);

  // Model ops → cells
  useEffect(() => {
    if (appliedSteps.length <= prevAppliedLen.current) {
      prevAppliedLen.current = appliedSteps.length;
      return;
    }
    const newSteps = appliedSteps.slice(prevAppliedLen.current);
    prevAppliedLen.current = appliedSteps.length;
    const dsIds = datasetIdsFromStore(useDataStore.getState());
    for (const step of newSteps) {
      notebookService
        .appendCell(effectiveWsId, {
          type: "model",
          status: "active",
          source: { config: step.config as unknown as Record<string, unknown> },
          outputs: [],
          metadata: { title: step.description },
          execution: {
            executionCount: 1,
            status: "success",
            inputHash: step.id,
            outputHash: step.id,
          },
          provenance: {
            datasetIds: dsIds,
            sourceCellIds: [],
            inputHashes: [step.id],
            operation: step.config.type,
            columns: (step.config as { column?: string }).column
              ? [(step.config as { column: string }).column]
              : [],
            dependsOn: [],
          },
          step: "model",
          datasetIds: dsIds,
        })
        .catch(() => {});
    }
    notebookService
      .getOrCreate(effectiveWsId)
      .then((nb) => knowledgeService.indexNotebook(nb))
      .catch(() => {});
  }, [appliedSteps, effectiveWsId]);

  // Clean → cell
  useEffect(() => {
    if (!cleaned || !cleaningDiff) return;
    if (prevCleanedRef.current === cleaned) return;
    prevCleanedRef.current = cleaned;
    const dsIds = datasetIdsFromStore(useDataStore.getState());
    const rowsRemoved = cleaningDiff.rowsRemoved ?? 0;
    notebookService
      .appendCell(effectiveWsId, {
        type: "clean",
        status: "active",
        source: {
          config: useDataStore.getState().cleaningConfig as unknown as Record<
            string,
            unknown
          >,
        },
        outputs: [
          {
            id: `out_${Date.now()}`,
            type: "diff",
            data: cleaningDiff,
            metadata: { title: "Cleaning diff", rowCount: rowsRemoved },
          },
        ],
        metadata: { title: `Clean — ${rowsRemoved} rows removed` },
        execution: {
          executionCount: 1,
          status: "success",
          inputHash: `clean_${dsIds[0]}`,
          outputHash: `clean_out_${cleaned.rows.length}`,
        },
        provenance: {
          datasetIds: dsIds,
          sourceCellIds: [],
          inputHashes: [],
          operation: "clean",
          columns: Object.keys(cleaningDiff.valuesImputed || {}),
          dependsOn: [],
        },
        step: "clean",
        datasetIds: dsIds,
      })
      .then(async () => {
        const nb = await notebookService.getOrCreate(effectiveWsId);
        await knowledgeService.indexNotebook(nb);
      })
      .catch(() => {});
  }, [cleaned, cleaningDiff, effectiveWsId]);

  // Analysis → cell
  useEffect(() => {
    if (!results) return;
    if (prevResultsRef.current === results) return;
    prevResultsRef.current = results;
    const dsIds = datasetIdsFromStore(useDataStore.getState());
    const hasData = Object.values(results).some((v) =>
      Array.isArray(v) ? v.length > 0 : v != null,
    );
    if (!hasData) return;
    notebookService
      .appendCell(effectiveWsId, {
        type: "analysis",
        status: "active",
        source: { config: results as unknown as Record<string, unknown> },
        outputs: [
          {
            id: `out_${Date.now()}`,
            type: "table",
            data: results,
            metadata: { title: "Analysis results" },
          },
        ],
        metadata: { title: "Analysis" },
        execution: {
          executionCount: 1,
          status: "success",
          inputHash: `analysis_${dsIds[0]}`,
          outputHash: `analysis_${Date.now()}`,
        },
        provenance: {
          datasetIds: dsIds,
          sourceCellIds: [],
          inputHashes: [],
          operation: "analysis",
          dependsOn: [],
        },
        step: "stats",
        datasetIds: dsIds,
      })
      .then(async () => {
        const nb = await notebookService.getOrCreate(effectiveWsId);
        await knowledgeService.indexNotebook(nb);
      })
      .catch(() => {});
  }, [results, effectiveWsId]);
}
