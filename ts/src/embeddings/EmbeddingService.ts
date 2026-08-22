import { EMBED_DIM } from "@/config";
import { chunkText as modelChunkText, embed as modelEmbed, embedMany as modelEmbedMany } from "@/stella/models/embeddingModel";

export type EmbeddingVector = Float32Array;

export async function chunkText(text: string): Promise<string[]> {
  try {
    return modelChunkText(text);
  } catch {
    return [text];
  }
}

export async function embed(text: string): Promise<EmbeddingVector> {
  if (EMBED_DIM !== 384) {
    console.warn(`[EmbeddingService] EMBED_DIM ${EMBED_DIM} != model 384`);
  }
  return modelEmbed(text);
}

export async function embedMany(texts: string[]): Promise<{ vectors: EmbeddingVector[]; keys: string[] }> {
  const vectors = await modelEmbedMany(texts);
  const keys = texts.map((_, i) => `k${i}`);
  return { vectors, keys };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export const embeddingService = {
  embed,
  embedMany,
  chunkText,
  cosineSimilarity,
} as const;
