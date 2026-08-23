import type { Dataset } from "@/types";
import { useRagStore } from "@/store/useRagStore";
import {
  pipelineDataset,
  pipelinePerColumn,
  pipelineMissing,
  pipelineDuplicate,
  pipelineQuality,
} from "./pipelines";
import type { RagPipelineName } from "./types";
import { callStatsApi, callStatsApiWithPath } from "@/lib/stats/api";
import {
  getStorageBackedContext,
  resolveStorageBacked,
} from "@/lib/stats/storageBacked";
import { useDataStore } from "@/store/useDataStore";
import {
  EMBED_SAMPLING_VERSION,
  EMBED_SAMPLING_SEED,
  EMBED_DATA_SAMPLE_N,
} from "@/config";
import type { DataRepresentativeSample } from "./types";

// simple hash for dataset identity (per G21 hashDataset truth, but lightweight here)
async function hashDatasetLight(dataset: Dataset): Promise<string> {
  const payload = `${dataset.fileName}:${dataset.columns.map((c) => `${c.name}:${c.type}`).join(",")}:${dataset.rows.length}:${JSON.stringify(dataset.rows.slice(0, 3))}`;
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const enc = new TextEncoder().encode(payload);
      const buf = await crypto.subtle.digest("SHA-256", enc);
      const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 12);
      return `h${hex}_${dataset.rows.length}_${dataset.columns.length}`;
    } catch {
      // fallthrough
    }
  }
  let h = 5381;
  for (let i = 0; i < payload.length; i++)
    h = (Math.imul(33, h) ^ payload.charCodeAt(i)) >>> 0;
  return `h${h.toString(36)}_${dataset.rows.length}_${dataset.columns.length}`;
}

function nextIdle(): Promise<void> {
  return new Promise((resolve) => {
    const w = window as unknown as {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
    };
    if (w.requestIdleCallback)
      w.requestIdleCallback(() => resolve(), { timeout: 50 });
    else setTimeout(() => resolve(), 16);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timeout after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

let currentRun = 0;
// G23 multi-dataset: Map<uploadId, runId> to avoid global run races
const runByDataset = new Map<string, number>();

function resolveUploadId(dataset: Dataset): string | null {
  try {
    const s = useDataStore.getState();
    // prefer explicit uploadId, fallback to fileName as key for anon
    return s.uploadId ?? dataset.fileName ?? null;
  } catch {
    return null;
  }
}

function buildSampleMeta(dataset: Dataset): DataRepresentativeSample {
  const n = dataset.rows.length;
  const isExact = n <= EMBED_DATA_SAMPLE_N && n > 0 && n <= 1000;
  return {
    n: isExact ? n : Math.min(EMBED_DATA_SAMPLE_N, n),
    method: "stratified",
    coverage: isExact ? "exact" : "sample",
    seed: EMBED_SAMPLING_SEED,
    strategyVersion: EMBED_SAMPLING_VERSION,
  };
}

export async function profileDatasetStreaming(
  dataset: Dataset,
  opts?: { uploadId?: string | null; contentHash?: string | null },
): Promise<void> {
  const hash = await hashDatasetLight(dataset);
  const uploadId = opts?.uploadId ?? resolveUploadId(dataset) ?? "__single__";
  const store = useRagStore.getState();

  // G23: per-dataset dedup — no global overwrite
  const existing = store.byDataset.get(uploadId);
  if (existing?.hash === hash && existing.isProfiling) return;
  if (
    existing?.hash === hash &&
    !existing.isProfiling &&
    existing.profile.dataset
  )
    return;

  const runId = (runByDataset.get(uploadId) ?? 0) + 1;
  runByDataset.set(uploadId, runId);
  currentRun = Math.max(currentRun, runId);

  // Keep activeUploadId in sync for compat readers that still read useRagStore.profile
  try {
    useRagStore
      .getState()
      .setActiveUpload(uploadId === "__single__" ? null : uploadId);
  } catch {}

  store.startProfiling(hash, uploadId);
  // seed sample metadata immediately so VectorStore can read coverage before pipelines finish
  try {
    useRagStore.getState().setSample(buildSampleMeta(dataset), uploadId);
  } catch {}

  // P1: show first pipeline as running immediately
  useRagStore.getState().setStatus("dataset", "running", uploadId);

  const pipelines: Array<{
    name: RagPipelineName;
    key: keyof import("./types").RagDatasetProfile;
    fn: (d: Dataset) => unknown;
  }> = [
    {
      name: "dataset",
      key: "dataset",
      fn: pipelineDataset as unknown as (d: Dataset) => unknown,
    },
    {
      name: "perColumn",
      key: "perColumn",
      fn: pipelinePerColumn as unknown as (d: Dataset) => unknown,
    },
    {
      name: "missing",
      key: "missing",
      fn: pipelineMissing as unknown as (d: Dataset) => unknown,
    },
    {
      name: "duplicate",
      key: "duplicate",
      fn: pipelineDuplicate as unknown as (d: Dataset) => unknown,
    },
    {
      name: "quality",
      key: "quality",
      fn: pipelineQuality as unknown as (d: Dataset) => unknown,
    },
  ];

  let usedBackend = false;
  try {
    const sbCtx = getStorageBackedContext();
    const sb = sbCtx
      ? await withTimeout(
          resolveStorageBacked(sbCtx),
          3000,
          "resolveStorageBacked",
        ).catch(() => null)
      : null;
    const cleaningConfig = useDataStore.getState()
      .cleaningConfig as unknown as Record<string, unknown> | null;

    let ragResult: Record<string, unknown> | null = null;
    if (sb) {
      ragResult = await withTimeout(
        callStatsApiWithPath<Record<string, unknown>>(
          "ragProfile",
          sb.storagePath,
          cleaningConfig,
          { fileName: dataset.fileName },
          { contentHash: sb.contentHash ?? opts?.contentHash ?? undefined },
        ),
        30000,
        "ragProfile storagePath",
      );
    } else {
      ragResult = await withTimeout(
        callStatsApi<Record<string, unknown>>("ragProfile", dataset.rows, {
          fileName: dataset.fileName,
        }),
        30000,
        "ragProfile rows",
      );
    }

    if (ragResult && runByDataset.get(uploadId) === runId) {
      usedBackend = true;
      for (const p of pipelines) {
        if (runByDataset.get(uploadId) !== runId) return;
        useRagStore.getState().setStatus(p.name, "running", uploadId);
        await nextIdle();
        const result =
          (ragResult as Record<string, unknown>)[p.key] ??
          (ragResult as Record<string, unknown>)[p.name];
        if (result !== undefined) {
          useRagStore
            .getState()
            .setPipelineResult(p.name, p.key, result as never, uploadId);
          if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
            console.debug(`[rag:pandas] ${p.name} done`, result);
        } else {
          const local = p.fn(dataset) as unknown;
          useRagStore
            .getState()
            .setPipelineResult(p.name, p.key, local as never, uploadId);
        }
        await nextIdle();
      }
    }
  } catch (e) {
    console.warn("[rag] backend ragProfile failed, falling back to local", e);
  }

  if (!usedBackend) {
    for (const p of pipelines) {
      if (runByDataset.get(uploadId) !== runId) return;
      useRagStore.getState().setStatus(p.name, "running", uploadId);
      await nextIdle();
      try {
        const result = p.fn(dataset) as unknown;
        if (runByDataset.get(uploadId) !== runId) return;
        useRagStore
          .getState()
          .setPipelineResult(p.name, p.key, result as never, uploadId);
        if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
          console.debug(`[rag:local] ${p.name} done`, result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        useRagStore.getState().setStatus(p.name, "error", uploadId);
        console.warn(`[rag] ${p.name} failed`, msg);
      }
      await nextIdle();
    }
  }

  if (runByDataset.get(uploadId) === runId) {
    useRagStore.getState().finishProfiling(uploadId);
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
      console.debug("[rag] streaming complete", hash, uploadId);
  }
}

export function resetRag(uploadId?: string | null) {
  if (uploadId) {
    const cur = runByDataset.get(uploadId) ?? 0;
    runByDataset.set(uploadId, cur + 1);
  } else {
    currentRun++;
  }
  useRagStore.getState().reset(uploadId ?? null);
}
