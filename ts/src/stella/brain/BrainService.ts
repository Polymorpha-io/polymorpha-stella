/**
 * BrainService — Stella query orchestration via KnowledgeService (single semantic plane).
 * G24: Reuses EmbeddingService + KnowledgeService (hybrid structured+semantic). No direct NotebookStorage/VectorStore/EmbeddingCache.
 * KnowledgeRecord is the semantic boundary: BrainService knows KnowledgeSearchRequest→KnowledgeResult only.
 */
import type { GroqModel, IStellaMessage } from "@/stella/types";
import { DEFAULT_GROQ_MODEL } from "@/stella/types";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import { notebookContextBuilder } from "@/notebook/NotebookContextBuilder";
import type { KnowledgeKind } from "@/knowledge/types";

const STELLA_API_URL = "/api/stella/chat";

const SYSTEM_PROMPT = [
  "You are Stella, a helpful statistics and data analysis assistant for Polymorpha.",
  "You answer questions about statistics, data cleaning, and analysis.",
  "Keep answers concise and informative. Use plain language.",
  "When referring to statistical concepts, explain them simply.",
  "When citing notebook evidence, reference Cell ID and dataset provenance.",
].join("\n");

export interface StellaContext {
  activeCellId?: string;
  notebookId?: string;
  searchScope?: "workspace" | "all";
  kinds?: KnowledgeKind[];
  column?: string;
  datasetIds?: string[];
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

  async answerStreaming(
    messages: IStellaMessage[],
    content: string,
    workspaceId: string | null,
    model: GroqModel = DEFAULT_GROQ_MODEL,
    onToken: (token: string) => void,
    onDone: (full: string) => void,
    onError: (err: Error) => void,
    context?: StellaContext,
  ): Promise<void> {
    try {
      await this.init(workspaceId);
      let contextStr = "";
      try {
        const effectiveWsId = workspaceId ?? "guest";
        const notebookId = context?.notebookId;

        let notebookContextStr = "";
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
            });
            if (nbCtx.activeCell) {
              notebookContextStr = [
                `Active Cell ${nbCtx.activeCell.index} [${nbCtx.activeCell.type}] status=${nbCtx.activeCell.status} title="${nbCtx.activeCell.metadata.title || ""}"`,
                `Operation: ${nbCtx.activeCell.provenance.operation ?? "—"} columns: ${nbCtx.activeCell.provenance.columns?.join(", ") ?? "—"}`,
                `Datasets: ${nbCtx.activeCell.datasetIds.join(", ") || "—"}`,
                `Execution: inputHash=${nbCtx.activeCell.execution.inputHash.slice(0, 8)} outputHash=${nbCtx.activeCell.execution.outputHash?.slice(0, 8) ?? "—"}`,
                `Outputs: ${nbCtx.activeCell.outputs.map((o) => `${o.type}:${o.metadata.title ?? ""} ${JSON.stringify(o.data).slice(0, 180)}`).join(" | ")}`,
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
          limit: 12,
          includeSystemKnowledge: true,
        });

        const parts: string[] = [];
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
        if (parts.length > 0) contextStr = parts.join("\n\n");
      } catch {
        // RAG retrieval optional — continue without context
      }
      const systemContent = contextStr
        ? `${SYSTEM_PROMPT}\n\nContext (Knowledge plane — notebook + dataset + relationship, use when relevant):\n${contextStr}`
        : SYSTEM_PROMPT;
      const stellaMessages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemContent },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content },
      ];

      const res = await fetch(STELLA_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: stellaMessages, model }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "Unknown error");
        throw new Error(`Stella API error (${res.status}): ${errText}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let full = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            let token = parsed.choices?.[0]?.delta?.content || "";
            if (token) {
              token = token.replace(/<\/?think>/g, "");
              full += token;
              onToken(token);
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      onDone(full);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
