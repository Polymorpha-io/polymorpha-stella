export * from "./knowledge/types";
export * from "./knowledge/KnowledgeStore";
export * from "./knowledge/KnowledgeExtractor";
export {
  KnowledgeService,
  knowledgeService,
} from "./knowledge/KnowledgeService";
export * from "./knowledge/providers/DatasetKnowledgeProvider";
export * from "./knowledge/providers/RelationshipKnowledgeProvider";

export * from "./embeddings/EmbeddingCache";
export * from "./embeddings/EmbeddingWorker";
export type { EmbeddingEntry, EmbedRequest } from "./embeddings/types";
export {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_EMBEDDING_VERSION,
} from "./embeddings/types";
// EmbeddingService duplicates chunkText/embed/embedMany with stella/models/embeddingModel — expose via selective alias
export {
  embeddingService,
  cosineSimilarity,
} from "./embeddings/EmbeddingService";
export type { EmbeddingVector } from "./embeddings/EmbeddingService";

export * from "./lib/vector/VectorStore";
// clientStore duplicates putVectors/getVectors/clearAll — expose only unique helpers via alias
export {
  getAllByUid,
  getAllByWorkspace,
  deleteByContentHash,
} from "./lib/vector/clientStore";

export * from "./lib/representation/DatasetRepresentationService";
export type {
  RepresentationKind,
  DatasetProfileEmbedding,
  ColumnSemanticEmbedding,
  DataRepresentativeEmbedding,
  ExactRowEmbedding,
  RepresentationArtifact,
  RepresentationMode,
  SelectionPolicy,
} from "./lib/representation/types";
export type { DataRepresentativeSample as RepresentationSample } from "./lib/representation/types";

export * from "./lib/rag/RagService";
export * from "./lib/rag/pipelines";
export * from "./lib/rag/types";

export * from "./notebook/types";
export type {
  Notebook,
  NotebookCell,
  NotebookCellType,
  CellStatus,
} from "./notebook/types";
export * from "./notebook/nbformat";
export * from "./notebook/NotebookContextBuilder";
export { NotebookService, notebookService } from "./notebook/NotebookService";
export * from "./notebook/NotebookRepository";
export * from "./notebook/NotebookStorage";

export * from "./stella/types";
export {
  StellaService,
  type StellaStreamCallbacks,
  type StellaContext as ServiceStellaContext,
} from "./stella/StellaService";
export { BrainService } from "./stella/brain/BrainService";
export type { StellaContext as BrainStellaContext } from "./stella/brain/BrainService";
export * from "./stella/brain/Embedder";
export * from "./stella/models/embeddingModel";

export * from "./config/index";
