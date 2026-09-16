export interface IStellaMessage {
  role: "user" | "assistant";
  content: string;
}

export interface IStellaClient {
  sendMessage(
    messages: IStellaMessage[],
    content: string,
    model: StellaChatModel,
  ): Promise<IStellaMessage>;
}

export interface LibraryResult {
  source: "dictionary" | "workspace";
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface StellaSession {
  id: string;
  workspaceId: string | null;
  workspaceIcon: string;
  workspaceColor: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface WorkspaceRef {
  workspaceId: string;
  name: string;
  icon?: string;
  coverGradient?: string;
}

export interface StellaContext {
  workspaceId: string | null;
  question: string;
}

/** Chat model id as `providerID/modelID` (single OpenCode backend). */
export type StellaChatModel = string;

export interface DatasetExpertContext {
  fileName: string;
  uploadId: string | null;
  rowCount: number;
  colCount: number;
  columnTypes: Array<{ name: string; type: string }>;
  cleaned: boolean;
  cleaningSummary?: string;
}

export const EXAMPLE_PROMPTS = [
  "What can Polymorpha do?",
  "Which test compares two groups?",
  "What does a p-value mean?",
  "How do I clean missing data?",
  "Explain a t-test",
  "What charts should I use?",
] as const;
