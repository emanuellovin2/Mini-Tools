// ---------------------------------------------------------------------------
// VectorIndex interface — all vector read/write goes through this seam.
// Current impl: pgvector (pg-vector-index.ts). Future: external sharded store.
// Adding a new backend = new file implementing VectorIndex + factory env switch.
// No service code imports pg vector queries directly — only this layer does.
// ---------------------------------------------------------------------------

export interface ChunkVector {
  id: string;
  tenantShardId: number;
  documentId: string;
  knowledgeBaseId: string;
  orgId: string;
  chunkIndex: number;
  content: string;
  contentTokens: number;
  embedding: number[];
  embeddingModel: string;
  embeddingVersion: number;
}

export interface ScoredChunk {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  content: string;
  contentTokens: number;
  embeddingModel: string;
  embeddingVersion: number;
  score: number;
}

export interface VectorQueryArgs {
  shardId: number;
  orgId: string;
  baseIds: string[];
  embedding: number[];
  topK: number;
  ftsQuery?: string;
  filter?: Record<string, string>;
}

export interface VectorIndex {
  upsert(chunks: ChunkVector[]): Promise<void>;
  query(args: VectorQueryArgs): Promise<ScoredChunk[]>;
  deleteByDocument(documentId: string, shardId: number): Promise<void>;
}
