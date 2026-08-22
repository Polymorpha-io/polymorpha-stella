import {
  embed as modelEmbed,
  loadEmbeddingModel,
  chunkText,
  embedMany,
  getEmbeddingDims,
  getEmbeddingModelId,
} from "@/stella/models";

export class Embedder {
  async load(): Promise<void> {
    await loadEmbeddingModel();
  }

  async embed(text: string): Promise<Float32Array> {
    return modelEmbed(text);
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    return embedMany(texts);
  }

  chunkText(text: string): string[] {
    return chunkText(text);
  }

  get dims(): number {
    return getEmbeddingDims();
  }

  get modelId(): string {
    return getEmbeddingModelId();
  }

  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
