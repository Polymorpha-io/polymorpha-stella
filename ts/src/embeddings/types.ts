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

export { EMBED_MODEL as DEFAULT_EMBEDDING_MODEL } from "../config";
export { EMBED_DIM as DEFAULT_EMBEDDING_DIM } from "../config";
export const DEFAULT_EMBEDDING_VERSION = "v1";
