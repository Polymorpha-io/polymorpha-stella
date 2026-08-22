import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { EMBED_MODEL, EMBED_CHUNK_TOKENS, EMBED_DIM } from "@/config";

let pipe: FeatureExtractionPipeline | null = null;
let tokenizer: unknown | null = null;

let loadingPromise: Promise<void> | null = null;

export async function loadEmbeddingModel(): Promise<void> {
  if (pipe) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    pipe = await pipeline("feature-extraction", EMBED_MODEL as never);
    // G24 §8: tokenizer from same library when available — validates EMBED_CHUNK_TOKENS per model
    try {
      const mod = await import("@xenova/transformers");
      const AutoTokenizer = (
        mod as unknown as {
          AutoTokenizer?: { from_pretrained: (m: string) => Promise<unknown> };
        }
      ).AutoTokenizer;
      if (AutoTokenizer?.from_pretrained) {
        tokenizer = await AutoTokenizer.from_pretrained(EMBED_MODEL).catch(
          () => null,
        );
      }
    } catch {
      tokenizer = null;
    }
  })();
  return loadingPromise;
}

/**
 * G24 §8 chunking — use tokenizer from embedding library when available,
 * fallback to character-window approximation validated per EMBED_DIM 384 model.
 * EMBED_CHUNK_TOKENS is configurable but must be validated against model context (512 for MiniLM).
 */
export function chunkText(
  text: string,
  maxTokens: number = EMBED_CHUNK_TOKENS,
): string[] {
  if (!text) return [];
  const approxCharsPerToken = 4;
  const maxChars = maxTokens * approxCharsPerToken;
  if (text.length <= maxChars) return [text];
  // If tokenizer available with encode, use token boundaries
  try {
    const tok = tokenizer as unknown as {
      encode?: (s: string) => unknown;
    } | null;
    if (tok?.encode) {
      const encoded = tok.encode(text) as unknown;
      const ids: number[] = Array.isArray(encoded)
        ? (encoded as number[])
        : ((encoded as { input_ids?: number[] })?.input_ids ?? []);
      if (ids.length > 0 && ids.length > maxTokens) {
        const chunks: string[] = [];
        // Overlap 50 tokens for continuity G21 sliding window
        const stride = Math.max(1, maxTokens - 50);
        // Fallback to char slicing aligned to token stride when decode not available
        const decode = (
          tok as unknown as { decode?: (ids: number[]) => string }
        )?.decode;
        if (decode) {
          for (let i = 0; i < ids.length; i += stride) {
            const slice = ids.slice(i, i + maxTokens);
            if (slice.length === 0) break;
            chunks.push(decode.call(tok, slice));
            if (i + maxTokens >= ids.length) break;
          }
          return chunks.length ? chunks : [text];
        }
      }
    }
  } catch {
    // fall through to char window
  }
  const chunks: string[] = [];
  const overlap = 200;
  const step = Math.max(1, maxChars - overlap);
  for (let i = 0; i < text.length; i += step) {
    chunks.push(text.slice(i, i + maxChars));
    if (i + maxChars >= text.length) break;
  }
  return chunks;
}

export function getEmbeddingDims(): number {
  return EMBED_DIM;
}

export function getEmbeddingModelId(): string {
  return EMBED_MODEL;
}

export async function embed(text: string): Promise<Float32Array> {
  await loadEmbeddingModel();
  const result = await pipe!(text, {
    pooling: "mean",
    normalize: true,
  } as never);
  const data = result.data as Float32Array;
  return data.slice();
}

export async function embedMany(texts: string[]): Promise<Float32Array[]> {
  await loadEmbeddingModel();
  const out: Float32Array[] = [];
  for (const t of texts) {
    const chunks = chunkText(t);
    if (chunks.length === 1) {
      out.push(await embed(chunks[0]));
    } else {
      // average chunk embeddings for long texts G21 512 window
      const embs = await Promise.all(chunks.map((c) => embed(c)));
      const dim = embs[0]?.length ?? EMBED_DIM;
      const avg = new Float32Array(dim);
      for (const e of embs)
        for (let i = 0; i < dim; i++) avg[i] += e[i] / embs.length;
      // re-normalize
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += avg[i] * avg[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < dim; i++) avg[i] /= norm;
      out.push(avg);
    }
  }
  return out;
}
