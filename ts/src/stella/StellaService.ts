import type { GroqModel, IStellaClient, IStellaMessage } from "./types";
import { DEFAULT_GROQ_MODEL } from "./types";
import { BrainService } from "./brain/BrainService";
import type { KnowledgeKind } from "@/knowledge/types";

export type StellaStreamCallbacks = {
  onToken: (token: string) => void;
  onDone: (full: string) => void;
  onError: (err: Error) => void;
};

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
  activeCellId?: string | null;
  notebookId?: string | null;
  searchScope?: "workspace" | "all";
  kinds?: KnowledgeKind[];
  column?: string;
  datasetIds?: string[];
  datasetExpert?: DatasetExpertContext | null;
}

export class StellaService implements IStellaClient {
  private brain = new BrainService();
  private workspaceId: string | null = null;
  private activeCellId: string | null = null;
  private notebookId: string | null = null;
  private searchScope: "workspace" | "all" = "workspace";
  private kinds?: KnowledgeKind[];
  private column?: string;
  private datasetIds?: string[];
  private datasetExpert?: DatasetExpertContext | null = null;

  setContext(
    workspaceId: string | null,
    opts?: {
      activeCellId?: string | null;
      notebookId?: string | null;
      searchScope?: "workspace" | "all";
      kinds?: KnowledgeKind[];
      column?: string;
      datasetIds?: string[];
      datasetExpert?: DatasetExpertContext | null;
    },
  ): void {
    this.workspaceId = workspaceId;
    if (opts) {
      if (opts.activeCellId !== undefined) this.activeCellId = opts.activeCellId;
      if (opts.notebookId !== undefined) this.notebookId = opts.notebookId;
      if (opts.searchScope !== undefined) this.searchScope = opts.searchScope;
      if (opts.kinds !== undefined) this.kinds = opts.kinds;
      if (opts.column !== undefined) this.column = opts.column;
      if (opts.datasetIds !== undefined) this.datasetIds = opts.datasetIds;
      if (opts.datasetExpert !== undefined) this.datasetExpert = opts.datasetExpert;
    }
  }

  setActiveCell(activeCellId: string | null): void {
    this.activeCellId = activeCellId;
  }

  setSearchScope(scope: "workspace" | "all"): void {
    this.searchScope = scope;
  }

  private getStellaContext(): StellaContext & { searchScope: "workspace" | "all" } & Record<string, unknown> {
    return {
      activeCellId: this.activeCellId ?? undefined,
      notebookId: this.notebookId ?? undefined,
      searchScope: this.searchScope,
      kinds: this.kinds,
      column: this.column,
      datasetIds: this.datasetIds,
      datasetExpert: this.datasetExpert ?? undefined,
    } as unknown as Record<string, unknown> as StellaContext & { searchScope: "workspace" | "all" } & Record<string, unknown>;
  }

  async sendMessage(
    messages: IStellaMessage[],
    content: string,
    model: GroqModel = DEFAULT_GROQ_MODEL,
    callbacks?: StellaStreamCallbacks,
  ): Promise<IStellaMessage> {
    if (callbacks) {
      const replyContent = await new Promise<string>((resolve, reject) => {
        this.brain.answerStreaming(
          messages,
          content,
          this.workspaceId,
          model,
          callbacks.onToken,
          (full) => {
            callbacks.onDone(full);
            resolve(full);
          },
          (err) => {
            callbacks.onError(err);
            reject(err);
          },
          this.getStellaContext() as unknown as Parameters<BrainService["answerStreaming"]>[7],
        );
      });
      return { role: "assistant", content: replyContent };
    }

    try {
      const reply = await new Promise<string>((resolve, reject) => {
        this.brain.answerStreaming(
          messages,
          content,
          this.workspaceId,
          model,
          () => {},
          (full) => resolve(full),
          (err) => reject(err),
          this.getStellaContext() as unknown as Parameters<BrainService["answerStreaming"]>[7],
        );
      });
      return { role: "assistant", content: reply };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      return {
        role: "assistant",
        content: `Sorry, I encountered an error: ${message}`,
      };
    }
  }
}
