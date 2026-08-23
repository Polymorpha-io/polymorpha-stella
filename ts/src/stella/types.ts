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

export const AVAILABLE_MODELS: Array<{
  id: GroqModel;
  label: string;
  name: string;
  description: string;
}> = [
  {
    id: "openai/gpt-oss-20b",
    label: "GPT OSS 20B",
    name: "GPT OSS 20B",
    description: "OpenAI GPT OSS 20B",
  },
  {
    id: "llama-3.1-8b-instant",
    label: "Llama 3.1 8B Instant",
    name: "Llama 3.1 8B Instant",
    description: "Fast, lightweight",
  },
  {
    id: "llama-3.1-70b-versatile",
    label: "Llama 3.1 70B Versatile",
    name: "Llama 3.1 70B Versatile",
    description: "Balanced performance",
  },
];

export const EXAMPLE_PROMPTS = [
  "What does a p-value mean?",
  "How do I clean missing data?",
  "Explain a t-test",
  "What charts should I use?",
] as const;
