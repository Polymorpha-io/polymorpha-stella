/**
 * BrainService — Stella query orchestration via KnowledgeService (single semantic plane).
 * G24: Reuses EmbeddingService + KnowledgeService (hybrid structured+semantic). No direct NotebookStorage/VectorStore/EmbeddingCache.
 * KnowledgeRecord is the semantic boundary: BrainService knows KnowledgeSearchRequest→KnowledgeResult only.
 */
import type { GroqModel, IStellaMessage } from "../../stella/types";
import { DEFAULT_GROQ_MODEL } from "../../stella/types";
import { routeChatModel } from "../../stella/routing";
import {
  getCachedReply,
  findSimilarReply,
  semanticCacheKey,
  setCachedReply,
} from "../../stella/semanticCache";
import { embeddingService } from "../../embeddings/EmbeddingService";
import { knowledgeService } from "../../knowledge/KnowledgeService";
import { notebookContextBuilder } from "../../notebook/NotebookContextBuilder";
import {
  expandQueryTerms,
  mergeTermBags,
} from "../../knowledge/queryExpansion";
import {
  assembleToolCalls,
  executeToolCall,
  getStellaTools,
  type AssembledToolCall,
  type ToolCallChunk,
  type ToolExecContext,
} from "./tools";
import type { KnowledgeKind } from "../../knowledge/types";
import type { KnowledgeRecord } from "../../knowledge/types";
import {
  SENTINEL_GUEST,
  SNIPPET_BRAIN_OUTPUT,
  STELLA_CHAT_PATH,
} from "../../config/knowledge";
import {
  QUERY_LLM_EXPANSION_ENABLED,
  QUERY_LLM_EXPANSION_MAX_TOKENS,
  NOTEBOOK_EVIDENCE_TOP,
  STELLA_HISTORY_HEAD_KEEP,
  RETRIEVAL_LIMIT_DATA,
  RETRIEVAL_LIMIT_DEFAULT,
  STELLA_HISTORY_LIMIT,
  STELLA_MAX_RETRIES,
  STELLA_MAX_TOKENS,
  STELLA_MAX_TOOL_ITERS,
  STELLA_REQUEST_TIMEOUT_MS,
  STELLA_RETRY_BASE_MS,
  STELLA_SEMANTIC_CACHE_ENABLED,
  STELLA_SEMANTIC_SIM_ENABLED,
  STELLA_SEMANTIC_SIM_THRESHOLD,
  STELLA_TOOLS_ENABLED,
} from "../../config/retrieval";
import { HASH_TINY_LEN } from "@polymorpha/business-logic";

const STELLA_API_URL = STELLA_CHAT_PATH;

const SYSTEM_PROMPT = [
  "You are Stella, a helpful statistics and data analysis assistant for Polymorpha.",
  "You answer questions about statistics, data cleaning, and analysis.",
  "Keep answers concise and informative. Use plain language.",
  "When referring to statistical concepts, explain them simply.",
  "When citing notebook evidence, reference Cell ID and dataset provenance.",
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
  /** Completion cap override. */
  maxTokens?: number;
  /** History window override (most recent N messages forwarded). */
  historyLimit?: number;
  /** Model routing on/off (default on): complex queries upgrade to 120B. */
  routeModel?: boolean;
  /** Agentic tool loop on/off (default `STELLA_TOOLS_ENABLED`). */
  tools?: boolean;
  /** LLM rewrite terms for the BM25 bag (default off, extra call cost). */
  llmExpansion?: boolean;
  /** Telemetry hook — never throws (guarded internally). */
  onEvent?: (event: StellaEvent) => void;
}

export type StellaEventType =
  "cache_hit" | "rag_done" | "llm_done" | "tools_done";

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

  async init(workspaceId: string | null): Promise<void> {
    if (this.initialized && this.initializedWorkspaceId === workspaceId) return;
    this.initialized = true;
    this.initializedWorkspaceId = workspaceId;
  }

  reset(): void {
    this.initialized = false;
    this.initializedWorkspaceId = null;
  }

  /**
   * POST the chat body with a single retry on network-error/5xx.
   * Never retries aborts, 4xx, or mid-stream failures (partial SSE is
   * unresumable). Throws AbortError unchanged for caller mapping.
   */
  private async postChatWithRetry(
    body: string,
    signal: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetch(STELLA_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal,
        });
      } catch (err) {
        if (isAbortError(err) || attempt >= STELLA_MAX_RETRIES) throw err;
        attempt++;
        await sleep(STELLA_RETRY_BASE_MS);
        continue;
      }
      if (res.status >= 500 && attempt < STELLA_MAX_RETRIES) {
        attempt++;
        await sleep(STELLA_RETRY_BASE_MS);
        continue;
      }
      return res;
    }
  }

  async answerStreaming(
    messages: IStellaMessage[],
    content: string,
    workspaceId: string | null,
    model: GroqModel = DEFAULT_GROQ_MODEL,
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
      const resolvedModel =
        opts?.routeModel === false
          ? model
          : routeChatModel(content, messages.length, model);
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

        // LLM rewrite terms (flagged, extra call) join the BM25 bag.
        let extraTerms = "";
        if (opts?.llmExpansion ?? QUERY_LLM_EXPANSION_ENABLED) {
          try {
            extraTerms = await this.rewriteTermsLLM(content, signal);
          } catch {
            /* rule-only expansion */
          }
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
          extraTerms,
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
        ? `${systemPrompt}\n\nContext (Knowledge plane — notebook + dataset + relationship, use when relevant):\n${contextStr}`
        : systemPrompt;
      // History window: full sessions grow linearly — forward the tail only.
      const historyLimit = opts?.historyLimit ?? STELLA_HISTORY_LIMIT;
      const history = selectHistoryWindow(messages, historyLimit);
      const stellaMessages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemContent },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content },
      ];
      const toolsOn = opts?.tools ?? STELLA_TOOLS_ENABLED;
      const conversation: Array<Record<string, unknown>> = [
        { role: "system", content: systemContent },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content },
      ];
      const baseBody = {
        model: resolvedModel,
        stream: true,
        max_tokens: opts?.maxTokens ?? STELLA_MAX_TOKENS,
        ...(toolsOn ? { tools: getStellaTools(), tool_choice: "auto" } : {}),
      };
      const execCtx: ToolExecContext = {
        workspaceId: effectiveWsId,
        notebookId: context?.notebookId ?? undefined,
        activeCellId: context?.activeCellId ?? undefined,
        kinds: context?.kinds,
        column: context?.column,
        datasetIds: context?.datasetIds,
        datasetExpert: context?.datasetExpert
          ? {
              fileName: context.datasetExpert.fileName,
              uploadId: context.datasetExpert.uploadId,
              rowCount: context.datasetExpert.rowCount,
              colCount: context.datasetExpert.colCount,
              columnTypes: context.datasetExpert.columnTypes,
              cleaned: context.datasetExpert.cleaned,
              cleaningSummary: context.datasetExpert.cleaningSummary,
            }
          : null,
      };
      const llmStart = Date.now();
      let toolIters = 0;
      let full = "";
      for (;;) {
        const turn = await this.streamTurn(
          JSON.stringify({ ...baseBody, messages: conversation }),
          signal,
          onToken,
        );
        full += turn.text;
        const calls = toolsOn ? turn.toolCalls : [];
        if (calls.length === 0 || toolIters >= STELLA_MAX_TOOL_ITERS) break;
        toolIters++;
        conversation.push({
          role: "assistant",
          content: turn.text,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });
        for (const call of calls) {
          const result = await executeToolCall(execCtx, call);
          conversation.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }
      }

      if (!full.trim()) {
        throw new Error("Empty response from Stella");
      }
      if (cacheKey)
        setCachedReply(cacheKey, full, Date.now(), queryVector ?? undefined);
      emit({
        type: "llm_done",
        ms: Date.now() - llmStart,
        model: resolvedModel,
        toolIters,
        estInputTokens: Math.round(JSON.stringify(conversation).length / 4),
      });
      if (toolsOn) emit({ type: "tools_done", toolIters });
      onDone(full);
    } catch (err) {
      if (isAbortError(err)) {
        onError(new Error("Stella request cancelled"));
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * One streamed chat turn: SSE `delta.content` via onToken plus assembled
   * `delta.tool_calls`. Non-streaming JSON bodies take the legacy path
   * (content only — tools need streaming).
   */
  private async streamTurn(
    body: string,
    signal: AbortSignal,
    onToken: (token: string) => void,
  ): Promise<{ text: string; toolCalls: AssembledToolCall[] }> {
    const res = await this.postChatWithRetry(body, signal);
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Stella API error (${res.status}): ${errText}`);
    }
    const contentType = res.headers.get("Content-Type") || "";
    if (
      contentType.includes("application/json") &&
      !contentType.includes("text/event-stream")
    ) {
      // Non-stream fallback (e.g., Groq without stream:true or Vite HTML fallback)
      try {
        const json = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string };
            delta?: { content?: string };
          }>;
        };
        const content =
          json.choices?.[0]?.message?.content ??
          json.choices?.[0]?.delta?.content ??
          "";
        const cleaned = content.replace(/<\/?think>/g, "").trim();
        if (cleaned) {
          onToken(cleaned);
          return { text: cleaned, toolCalls: [] };
        }
        throw new Error("Empty response from Stella");
      } catch (e) {
        throw new Error(
          e instanceof Error ? e.message : "Failed to parse Stella response",
        );
      }
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const callChunks: ToolCallChunk[] = [];
    const feed = (jsonStr: string) => {
      if (jsonStr === "[DONE]") return;
      try {
        const parsed = JSON.parse(jsonStr);
        const delta = (parsed.choices?.[0]?.delta ?? {}) as {
          content?: string;
          tool_calls?: ToolCallChunk[];
        };
        let token = delta.content || "";
        if (token) {
          token = token.replace(/<\/?think>/g, "");
          if (token.trim()) {
            text += token;
            onToken(token);
          }
        }
        if (Array.isArray(delta.tool_calls))
          callChunks.push(...delta.tool_calls);
      } catch {
        // skip malformed lines
      }
    };
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        feed(trimmed.slice(6));
      }
    }
    // Flush leftover buffer (no trailing \n)
    if (buffer.trim().startsWith("data: ")) feed(buffer.trim().slice(6));
    return { text, toolCalls: assembleToolCalls(callChunks) };
  }

  /** Single non-streamed rewrite call → raw terms string (may throw). */
  private async rewriteTermsLLM(
    query: string,
    signal: AbortSignal,
  ): Promise<string> {
    const body = JSON.stringify({
      model: DEFAULT_GROQ_MODEL,
      stream: false,
      max_tokens: QUERY_LLM_EXPANSION_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the user question as comma-separated search terms (synonyms, full forms of abbreviations, related statistics vocabulary). Reply with terms only, no prose.",
        },
        { role: "user", content: query },
      ],
    });
    const res = await this.postChatWithRetry(body, signal);
    if (!res.ok) throw new Error(`Stella API error (${res.status})`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
