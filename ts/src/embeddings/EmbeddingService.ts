import { EMBED_DIM, MODEL_NATIVE_DIM } from "../config";
import {
  chunkText as modelChunkText,
  embed as modelEmbed,
  embedMany as modelEmbedMany,
} from "../stella/models/embeddingModel";

export type EmbeddingVector = Float32Array;

export async function chunkText(text: string): Promise<string[]> {
  try {
    return modelChunkText(text);
  } catch {
    return [text];
  }
}

/** Warn-once flag: dim mismatch is a deploy-time constant, not per-call news. */
let dimMismatchWarned = false;

export async function embed(text: string): Promise<EmbeddingVector> {
  if (EMBED_DIM !== MODEL_NATIVE_DIM && !dimMismatchWarned) {
    dimMismatchWarned = true;
    console.warn(
      `[EmbeddingService] EMBED_DIM ${EMBED_DIM} != model ${MODEL_NATIVE_DIM}`,
    );
  }
  return modelEmbed(text);
}

export async function embedMany(
  texts: string[],
): Promise<{ vectors: EmbeddingVector[]; keys: string[] }> {
  // Dedupe identical texts before hitting the model: search() fans out
  // per-query over candidates that often repeat (G21). Order + keys stay
  // positional so callers are unaffected; duplicates share the same
  // (read-only) vector — cosineSimilarity never mutates.
  const indicesByText = new Map<string, number[]>();
  texts.forEach((t, i) => {
    const list = indicesByText.get(t);
    if (list) list.push(i);
    else indicesByText.set(t, [i]);
  });
  const unique = [...indicesByText.keys()];
  const uniqueVectors = await modelEmbedMany(unique);
  const vectors: EmbeddingVector[] = new Array(texts.length);
  unique.forEach((t, u) => {
    for (const i of indicesByText.get(t)!) vectors[i] = uniqueVectors[u];
  });
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
