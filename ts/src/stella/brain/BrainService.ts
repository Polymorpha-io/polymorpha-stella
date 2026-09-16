/**
 * BrainService — Stella query orchestration via KnowledgeService (single semantic plane).
 * G24: Reuses EmbeddingService + KnowledgeService (hybrid structured+semantic). No direct NotebookStorage/VectorStore/EmbeddingCache.
 * KnowledgeRecord is the semantic boundary: BrainService knows KnowledgeSearchRequest→KnowledgeResult only.
 */
import type { IStellaMessage, StellaChatModel } from "../../stella/types";
import {
  getCachedReply,
  findSimilarReply,
  semanticCacheKey,
  setCachedReply,
} from "../../stella/semanticCache";
import { embeddingService } from "../../embeddings/EmbeddingService";
import { knowledgeService } from "../../knowledge/KnowledgeService";
import { notebookContextBuilder } from "../../notebook/NotebookContextBuilder";
import { openCodeComplete } from "./OpenCodeTransport";
import { DEFAULT_STELLA_CONFIG } from "../../config/StellaConfig";
import type { OpenCodeModelRef } from "../../config/StellaConfig";
import type { KnowledgeKind } from "../../knowledge/types";
import type { KnowledgeRecord } from "../../knowledge/types";
import type { ProviderMemo } from "../../knowledge/types";
import { SENTINEL_GUEST, SNIPPET_BRAIN_OUTPUT } from "../../config/knowledge";
import {
  NOTEBOOK_EVIDENCE_TOP,
  STELLA_HISTORY_HEAD_KEEP,
  RETRIEVAL_LIMIT_DATA,
  STELLA_HISTORY_LIMIT,
  STELLA_REQUEST_TIMEOUT_MS,
  STELLA_SEMANTIC_CACHE_ENABLED,
  STELLA_SEMANTIC_SIM_ENABLED,
  STELLA_SEMANTIC_SIM_THRESHOLD,
} from "../../config/retrieval";
import { HASH_TINY_LEN } from "@polymorpha/business-logic";

const SYSTEM_PROMPT = [
  "You are Stella, a helpful statistics and data analysis assistant for Polymorpha.",
  "You answer questions about statistics, data cleaning, and analysis.",
  "Keep answers concise and informative. Use plain language.",
  "When referring to statistical concepts, explain them simply.",
  "When citing notebook evidence, reference Cell ID and dataset provenance.",
  "When you recommend a Polymorpha capability, ground it ONLY in [functionality] or [guide] context records and cite each one as [functionality:<id>] using the ref shown — never invent method names, thresholds, or UI locations; if no record supports it, say so.",
].join("\n");

const DATASET_EXPERT_PROMPT = [
  "You are an expert of the current dataset. Always ground answers in the Dataset Expert Context below.",
  "Cite column types, missing%, and sample coverage (exact/sample) when relevant.",
  "Prefer data_representative rows for examples, disclose when using sample vs exact.",
  "If the dataset has no rows, say so and do not invent data.",
].join("\n");

export interface DatasetExpertContext {
  fileName: string;
  uploadId: string | null;
  rowCount: number;
  colCount: number;
  columnTypes: Array<{ name: string; type: string }>;
  cleaned: boolean;
  cleaningSummary?: string;
}

export interface StellaContext {
  activeCellId?: string;
  notebookId?: string;
  searchScope?: "workspace" | "all";
  kinds?: KnowledgeKind[];
  column?: string;
  datasetIds?: string[];
  datasetExpert?: DatasetExpertContext | null;
}

/** Per-request harness overrides (all optional — constants are the default). */
export interface AnswerStreamingOptions {
  /** Caller abort (e.g. UI cancel). Combined with the request timeout. */
  signal?: AbortSignal;
  /** History window override (most recent N messages forwarded). */
  historyLimit?: number;
  /** Telemetry hook — never throws (guarded internally). */
  onEvent?: (event: StellaEvent) => void;
}

export type StellaEventType = "cache_hit" | "rag_done" | "llm_done";

export interface StellaEvent {
  type: StellaEventType;
  /** Stage latency ms (rag_done/llm_done). */
  ms?: number;
  /** Resolved model (llm_done/cache_hit). */
  model?: string;
  /** Agentic tool iterations performed (llm_done). */
  toolIters?: number;
  /** Rough input size in tokens, chars/4 (llm_done). */
  estInputTokens?: number;
  /** RAG records stuffed into context (rag_done). */
  ragHits?: number;
}

/**
 * Compact history to a first+tail window: keeps the opening message(s) as
 * the session anchor plus the most recent tail. Short histories pass
 * through untouched. Pure — unit-tested.
 */
export function selectHistoryWindow<T>(
  messages: T[],
  limit: number,
  headKeep: number = STELLA_HISTORY_HEAD_KEEP,
): T[] {
  if (limit < 0) return messages;
  // Note: legacy slice(-limit) sent EVERYTHING at limit 0 (slice(-0) is
  // slice(0)) — 0 now honestly means none.
  if (limit === 0) return [];
  if (messages.length <= limit) return messages;
  const head = messages.slice(0, Math.max(0, Math.min(headKeep, limit)));
  // slice(-0) is slice(0) — guard the degenerate head-fills-window case.
  const tailCount = Math.max(0, limit - head.length);
  const tail = tailCount === 0 ? [] : messages.slice(-tailCount);
  return [...head, ...tail];
}

export class BrainService {
  private initialized = false;
  private initializedWorkspaceId: string | null = null;
  private openCodeBaseUrl: string = DEFAULT_STELLA_CONFIG.openCodeBaseUrl;
  private openCodeModel: OpenCodeModelRef = DEFAULT_STELLA_CONFIG.openCodeModel;
  private openCodePassword: string = DEFAULT_STELLA_CONFIG.openCodePassword;

  async init(workspaceId: string | null): Promise<void> {
    if (this.initialized && this.initializedWorkspaceId === workspaceId) return;
    this.initialized = true;
    this.initializedWorkspaceId = workspaceId;
  }

  reset(): void {
    this.initialized = false;
    this.initializedWorkspaceId = null;
  }

  /** OpenCode endpoint override (default `openCodeBaseUrl` from config).
   *  Matches the setter-injection style of `StellaService.setActiveCell`. */
  setOpenCodeTarget(openCode?: {
    baseUrl?: string;
    model?: OpenCodeModelRef;
    password?: string;
  }): void {
    if (openCode?.baseUrl !== undefined)
      this.openCodeBaseUrl = openCode.baseUrl;
    if (openCode?.model !== undefined) this.openCodeModel = openCode.model;
    if (openCode?.password !== undefined)
      this.openCodePassword = openCode.password;
  }

  /** `providerID/modelID` label for cache keys and telemetry. */
  openCodeModelId(): StellaChatModel {
    return `${this.openCodeModel.providerID}/${this.openCodeModel.modelID}`;
  }

  async answerStreaming(
    messages: IStellaMessage[],
    content: string,
    workspaceId: string | null,
    model: StellaChatModel = this.openCodeModelId(),
    onToken: (token: string) => void,
    onDone: (full: string) => void,
    onError: (err: Error) => void,
    context?: StellaContext,
    opts?: AnswerStreamingOptions,
  ): Promise<void> {
    const emit = (event: StellaEvent) => {
      try {
        opts?.onEvent?.(event);
      } catch {
        /* telemetry never breaks chat */
      }
    };
    try {
      await this.init(workspaceId);
      const effectiveWsId = workspaceId ?? SENTINEL_GUEST;
      const resolvedModel = model;
      // Semantic cache: stable-context repeats skip RAG + LLM entirely.
      const cacheable =
        STELLA_SEMANTIC_CACHE_ENABLED &&
        !context?.activeCellId &&
        !context?.datasetExpert &&
        !(context?.datasetIds && context.datasetIds.length > 0);
      const cacheKey = cacheable
        ? semanticCacheKey(effectiveWsId, resolvedModel, content)
        : null;
      let queryVector: number[] | null = null;
      if (cacheKey) {
        const cached = getCachedReply(cacheKey);
        if (cached) {
          emit({ type: "cache_hit", model: resolvedModel });
          onToken(cached);
          onDone(cached);
          return;
        }
        // Paraphrase path: one query embed (the RAG pass reuses it via
        // the embedding cache — net zero extra model calls once warm).
        if (STELLA_SEMANTIC_SIM_ENABLED) {
          try {
            queryVector = Array.from(await embeddingService.embed(content));
            const similar = findSimilarReply(
              queryVector,
              STELLA_SEMANTIC_SIM_THRESHOLD,
            );
            if (similar) {
              emit({ type: "cache_hit", model: resolvedModel });
              onToken(similar);
              onDone(similar);
              return;
            }
          } catch {
            queryVector = null;
          }
        }
      }
      // Caller signal (cancel) + request timeout, whichever fires first.
      // Created before RAG so the LLM rewrite call shares the deadline.
      const timeoutSignal = AbortSignal.timeout(STELLA_REQUEST_TIMEOUT_MS);
      const signal = opts?.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal;
      const ragStart = Date.now();
      let ragHits = 0;
      // One provider memo for the whole turn: the builder pass and the
      // main pass below share dataset/relationship/dict/funcs outputs.
      const providerMemo: ProviderMemo = new Map();
      let contextStr = "";
      try {
        const notebookId = context?.notebookId;
        let notebookContextStr = "";
        let notebookEvidence: KnowledgeRecord[] = [];
        if (context?.activeCellId) {
          try {
            const nbCtx = await notebookContextBuilder.build({
              workspaceId: effectiveWsId,
              notebookId,
              activeCellId: context.activeCellId,
              query: content,
              scope: context.searchScope,
              kinds: context.kinds,
              column: context.column,
              datasetIds: context.datasetIds,
              memo: providerMemo,
            });
            // Builder's own search is evidence, not waste — merged below.
            notebookEvidence = nbCtx.relevantKnowledge ?? [];
            if (nbCtx.activeCell) {
              notebookContextStr = [
                `Active Cell ${nbCtx.activeCell.index} [${nbCtx.activeCell.type}] status=${nbCtx.activeCell.status} title="${nbCtx.activeCell.metadata.title || ""}"`,
                `Operation: ${nbCtx.activeCell.provenance.operation ?? "—"} columns: ${nbCtx.activeCell.provenance.columns?.join(", ") ?? "—"}`,
                `Datasets: ${nbCtx.activeCell.datasetIds.join(", ") || "—"}`,
                `Execution: inputHash=${nbCtx.activeCell.execution.inputHash.slice(0, HASH_TINY_LEN)} outputHash=${nbCtx.activeCell.execution.outputHash?.slice(0, HASH_TINY_LEN) ?? "—"}`,
                `Outputs: ${nbCtx.activeCell.outputs.map((o) => `${o.type}:${o.metadata.title ?? ""} ${JSON.stringify(o.data).slice(0, SNIPPET_BRAIN_OUTPUT)}`).join(" | ")}`,
                nbCtx.precedingCells.length
                  ? `Preceding: ${nbCtx.precedingCells.map((c) => `Cell ${c.index} ${c.type} ${c.metadata.title ?? ""}`).join(" | ")}`
                  : "",
                nbCtx.relevantCells.length > 1
                  ? `Lineage: ${nbCtx.relevantCells.map((c) => c.id).join(", ")}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n");
            }
          } catch {}
        }

        const kResults = await knowledgeService.search(content, {
          workspaceId: effectiveWsId,
          notebookId,
          activeCellId: context?.activeCellId,
          scope: context?.searchScope ?? "workspace",
          kinds: context?.kinds,
          column: context?.column,
          datasetIds: context?.datasetIds,
          limit: RETRIEVAL_LIMIT_DATA,
          includeSystemKnowledge: true,
          memo: providerMemo,
        });
        ragHits = kResults.length;

        const parts: string[] = [];
        // Dataset expert header — always first, guarantees grounding
        if (context?.datasetExpert) {
          const de = context.datasetExpert;
          const cols = de.columnTypes
            .slice(0, RETRIEVAL_LIMIT_DATA)
            .map((c) => `${c.name}(${c.type})`)
            .join(", ");
          const more =
            de.colCount > RETRIEVAL_LIMIT_DATA
              ? ` +${de.colCount - RETRIEVAL_LIMIT_DATA} more`
              : "";
          parts.push(
            `[dataset_expert] Expert of dataset "${de.fileName}" — ${de.rowCount} rows × ${de.colCount} cols${de.cleaned ? " (cleaned)" : ""}${de.cleaningSummary ? ` — ${de.cleaningSummary}` : ""} — uploadId:${de.uploadId ?? SENTINEL_GUEST} — columns: ${cols}${more}`,
          );
        } else if (context?.datasetIds && context.datasetIds.length > 0) {
          parts.push(
            `[dataset_expert] Current datasetIds: ${context.datasetIds.join(", ")}`,
          );
        }
        if (notebookContextStr)
          parts.push(`[notebook_context]\n${notebookContextStr}`);
        if (kResults.length > 0) {
          parts.push(
            kResults
              .map((r) => {
                const prov = r.record.provenance;
                const cell = prov.cellId ?? r.record.cellId ?? "—";
                const datasets =
                  prov.datasetIds?.join(", ") ?? r.record.datasetId ?? "—";
                const sample = prov.sampleCoverage
                  ? ` coverage=${prov.sampleCoverage}`
                  : "";
                const chunk = prov.chunkId ? ` chunk=${prov.chunkId}` : "";
                const col = prov.columns?.join(",")
                  ? ` columns=${prov.columns?.join(",")}`
                  : "";
                if (
                  r.record.kind === "functionality" ||
                  r.record.kind === "guide"
                ) {
                  const meta = r.record.metadata as {
                    functionalityId?: string;
                    uiPath?: string;
                    verified?: boolean;
                  };
                  const ref = meta.functionalityId ?? r.record.id;
                  const unverified =
                    meta.verified === false
                      ? " experimental-verification-pending"
                      : "";
                  return `[${r.record.kind}] ${r.record.text} (ref: functionality:${ref} ui:${meta.uiPath ?? "—"}${unverified})`;
                }
                return `[${r.record.kind}] ${r.record.text} (cell:${cell} ws:${prov.workspaceId} dataset:${datasets}${sample}${chunk}${col})`;
              })
              .join("\n\n"),
          );
        }
        if (notebookEvidence.length > 0) {
          const seen = new Set(kResults.map((r) => r.record.id));
          const fresh = notebookEvidence
            .filter((rec) => !seen.has(rec.id))
            .slice(0, NOTEBOOK_EVIDENCE_TOP);
          if (fresh.length > 0) {
            parts.push(
              `[notebook_evidence]\n${fresh
                .map((rec) => `[${rec.kind}] ${rec.text.slice(0, 400)}`)
                .join("\n\n")}`,
            );
          }
        }
        if (parts.length > 0) contextStr = parts.join("\n\n");
      } catch {
        // RAG retrieval optional — continue without context
      }
      emit({ type: "rag_done", ms: Date.now() - ragStart, ragHits });
      const systemPrompt = context?.datasetExpert
        ? `${SYSTEM_PROMPT}\n\n${DATASET_EXPERT_PROMPT}`
        : SYSTEM_PROMPT;
      const systemContent = contextStr
        ? `${systemPrompt}\n\nContext (Knowledge plane — notebook + dataset + relationship + functionality, use when relevant):\n${contextStr}`
        : systemPrompt;
      // History window: full sessions grow linearly — forward the tail only.
      const historyLimit = opts?.historyLimit ?? STELLA_HISTORY_LIMIT;
      const history = selectHistoryWindow(messages, historyLimit);
      const llmStart = Date.now();
      // Single chat backend (OpenCode): one stateless turn, no agentic
      // loop — tools stay disabled server-side (`tools:{}` in transport).
      const full = await openCodeComplete({
        baseUrl: this.openCodeBaseUrl,
        model: this.openCodeModel,
        password: this.openCodePassword || undefined,
        system: systemContent,
        history,
        content,
        signal,
      });
      if (full.trim()) onToken(full);

      if (!full.trim()) {
        throw new Error("Empty response from Stella");
      }
      if (cacheKey)
        setCachedReply(cacheKey, full, Date.now(), queryVector ?? undefined);
      emit({
        type: "llm_done",
        ms: Date.now() - llmStart,
        model: this.openCodeModelId(),
        toolIters: 0,
        estInputTokens: Math.round(
          JSON.stringify(history.map((m) => m.content)).length / 4 +
            systemContent.length / 4,
        ),
      });
      onDone(full);
    } catch (err) {
      if (isAbortError(err)) {
        onError(new Error("Stella request cancelled"));
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}
