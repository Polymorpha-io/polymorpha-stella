export interface IStellaMessage {
  role: "user" | "assistant";
  content: string;
}

export interface IStellaClient {
  sendMessage(
    messages: IStellaMessage[],
    content: string,
    model: GroqModel,
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

export type GroqModel = string;

export const DEFAULT_GROQ_MODEL: GroqModel = "openai/gpt-oss-20b";

export const EXAMPLE_PROMPTS = [
  "What does a p-value mean?",
  "How do I clean missing data?",
  "Explain a t-test",
  "What charts should I use?",
] as const;
