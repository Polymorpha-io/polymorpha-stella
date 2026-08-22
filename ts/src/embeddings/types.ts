export interface EmbeddingReference {
  model: string;
  version: string;
  dimension: number;
  hash: string;
}

export interface EmbeddingEntry {
  embeddingKey: string; // modelVersion:hash
  model: string;
  version: string;
  dimension: number;
  vector: Float32Array;
  createdAt: number;
  lastAccessedAt: number;
}

export interface EmbedRequest {
  text: string;
  namespace?: string;
}

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_EMBEDDING_DIM = 384;
export const DEFAULT_EMBEDDING_VERSION = "v1";
