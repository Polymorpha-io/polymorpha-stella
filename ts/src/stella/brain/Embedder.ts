import {
  embed as modelEmbed,
  loadEmbeddingModel,
  chunkText,
  embedMany,
  getEmbeddingDims,
  getEmbeddingModelId,
} from "@/stella/models/embeddingModel";
import { cosineSimilarity as embeddingCosine } from "@/embeddings/EmbeddingService";

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
    return embeddingCosine(a, b);
  }
}
