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

function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(33, h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * G24: Reuses NotebookService + KnowledgeService (thin adapters over IndexedDB/Embeddings) — no custom parsers.
 * Syncs wizard → notebook cells and keeps KnowledgeStore up-to-date.
 * Per-dataset filter (1): cells carry datasetIds (uploadId); dedupe per dataset to avoid 22× spam.
 */
export function useNotebookSync(workspaceId: string | null) {
  const effectiveWsId = workspaceId ?? "guest";
  const raw = useDataStore(
    (s) => (s as unknown as { raw: Dataset | null }).raw,
  ) as Dataset | null;
  const uploadId = useDataStore(
    (s) => (s as unknown as { uploadId: string | null }).uploadId,
  ) as string | null;
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
  const lastUploadHashRef = useRef<string | null>(null);
  const lastUploadCellIdRef = useRef<string | null>(null);
  const lastCleanHashRef = useRef<string | null>(null);
  const lastAnalysisHashRef = useRef<string | null>(null);

  // Reset dedupe refs on workspace switch so same datasetId in different ws can re-emit
  useEffect(() => {
    lastUploadHashRef.current = null;
    lastUploadCellIdRef.current = null;
    lastCleanHashRef.current = null;
    lastAnalysisHashRef.current = null;
    prevRawRef.current = null;
    prevCleanedRef.current = null;
    prevResultsRef.current = null;
    prevAppliedLen.current = 0;
  }, [effectiveWsId]);

  // Upload → cell (per-dataset, deduped; handles authed pending uploadId)
  useEffect(() => {
    if (!raw) return;
    // Guest: uploadId may stay null, use file fallback. Authed: wait for uploadId if workspace present.
    if (effectiveWsId !== "guest" && !uploadId) return;
    if (prevRawRef.current && prevRawRef.current === raw) return;
    const dsIds = datasetIdsFromStore(useDataStore.getState());
    const uploadHash = stableHash(
      `${raw.fileName}:${raw.rows.length}:${raw.columns.length}:${dsIds[0] ?? "guest"}`,
    );
    // Dedupe same datasetId+file within session (prevents 22× re-upload spam)
    if (lastUploadHashRef.current === uploadHash) return;
    // Also skip if raw same fileName+rows but uploadId unchanged (switch back)
    const isNew =
      !prevRawRef.current ||
      prevRawRef.current.fileName !== raw.fileName ||
      prevRawRef.current.rows.length !== raw.rows.length ||
      lastUploadHashRef.current !== uploadHash;
    if (!isNew) return;
    prevRawRef.current = raw;
    lastUploadHashRef.current = uploadHash;
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
          inputHash: `upload_${uploadHash}`,
          outputHash: `h_${raw.rows.length}_${raw.columns.length}`,
        },
        provenance: {
          datasetIds: dsIds,
          sourceCellIds: [],
          inputHashes: [uploadHash],
          dependsOn: [],
        },
        step: "upload",
        datasetIds: dsIds,
      })
      .then(async (cell) => {
        lastUploadCellIdRef.current = cell.id;
        try {
          const nb = await notebookService.getOrCreate(effectiveWsId);
          await knowledgeService.indexNotebook(nb);
        } catch {}
      })
      .catch(() => {});
  }, [raw, uploadId, effectiveWsId]);

  // Patch last upload cell when uploadId arrives after raw (authed async recordUpload)
  useEffect(() => {
    if (!raw || !uploadId || !lastUploadCellIdRef.current) return;
    // If last cell already has this datasetId, nothing to do
    void (async () => {
      try {
        const cell = await notebookService.getCell(effectiveWsId, lastUploadCellIdRef.current as string);
        if (!cell) return;
        const hasId = cell.datasetIds.includes(uploadId) || cell.provenance.datasetIds.includes(uploadId);
        if (hasId) return;
        // Backfill datasetId (empty guest race)
        if (cell.datasetIds.length === 0) {
          await notebookService.updateCell(effectiveWsId, cell.id, {
            datasetIds: [uploadId],
            provenance: { ...cell.provenance, datasetIds: [uploadId] },
            source: { ...cell.source, uploadId },
          } as unknown as Partial<typeof cell>);
        }
      } catch {}
    })();
  }, [uploadId, raw, effectiveWsId]);

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

  // Clean → cell (per-dataset, deduped by rowsRemoved+output length+dataset)
  useEffect(() => {
    if (!cleaned || !cleaningDiff) return;
    if (prevCleanedRef.current === cleaned) return;
    const dsIds = datasetIdsFromStore(useDataStore.getState());
    const rowsRemoved = cleaningDiff.rowsRemoved ?? 0;
    const cleanHash = stableHash(`${dsIds[0] ?? "guest"}:${rowsRemoved}:${cleaned.rows.length}:${cleaned.columns.length}`);
    if (lastCleanHashRef.current === cleanHash) {
      prevCleanedRef.current = cleaned;
      return;
    }
    lastCleanHashRef.current = cleanHash;
    prevCleanedRef.current = cleaned;
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
          inputHash: `clean_${cleanHash}`,
          outputHash: `clean_out_${cleaned.rows.length}`,
        },
        provenance: {
          datasetIds: dsIds,
          sourceCellIds: [],
          inputHashes: [cleanHash],
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

  // Analysis → cell (per-dataset, deduped by dataset+result keys)
  useEffect(() => {
    if (!results) return;
    if (prevResultsRef.current === results) return;
    const dsIds = datasetIdsFromStore(useDataStore.getState());
    const keys = Object.keys(results).sort().join(",");
    const hasData = Object.values(results).some((v) =>
      Array.isArray(v) ? v.length > 0 : v != null,
    );
    if (!hasData) {
      prevResultsRef.current = results;
      return;
    }
    const analysisHash = stableHash(`${dsIds[0] ?? "guest"}:${keys}:${JSON.stringify(results).slice(0, 120)}`);
    if (lastAnalysisHashRef.current === analysisHash) {
      prevResultsRef.current = results;
      return;
    }
    lastAnalysisHashRef.current = analysisHash;
    prevResultsRef.current = results;
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
          inputHash: `analysis_${analysisHash}`,
          outputHash: `analysis_${Date.now()}`,
        },
        provenance: {
          datasetIds: dsIds,
          sourceCellIds: [],
          inputHashes: [analysisHash],
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
