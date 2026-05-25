// ---------------------------------------------------------------------------
// pgvector implementation of VectorIndex.
// This is the ONLY file that issues vector SQL directly.
// Swap to an external store: implement VectorIndex, update getVectorIndex().
// ---------------------------------------------------------------------------

import { createAdminClient } from "@/lib/services/supabase";
import type { VectorIndex, ChunkVector, ScoredChunk, VectorQueryArgs } from "./vector-index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

class PgVectorIndex implements VectorIndex {
  async upsert(chunks: ChunkVector[]): Promise<void> {
    if (chunks.length === 0) return;
    const admin = createAdminClient() as AnyClient;

    // Upsert in batches of 100 (avoid large payloads; embeddings are ~6KB each)
    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const rows = batch.map((c) => ({
        id: c.id,
        tenant_shard_id: c.tenantShardId,
        document_id: c.documentId,
        knowledge_base_id: c.knowledgeBaseId,
        org_id: c.orgId,
        chunk_index: c.chunkIndex,
        content: c.content,
        content_tokens: c.contentTokens,
        // pgvector expects a string "[x,y,z,...]" or an array — supabase client accepts array
        embedding: `[${c.embedding.join(",")}]`,
        embedding_model: c.embeddingModel,
        embedding_version: c.embeddingVersion,
      }));

      const { error } = await admin
        .from("knowledge_chunks")
        .upsert(rows, {
          onConflict: "document_id,chunk_index,embedding_version",
          ignoreDuplicates: false,
        });

      if (error) throw new Error(`PgVectorIndex.upsert: ${error.message}`);
    }
  }

  async query(args: VectorQueryArgs): Promise<ScoredChunk[]> {
    const admin = createAdminClient() as AnyClient;

    const { data, error } = await admin.rpc("match_knowledge_chunks", {
      p_shard_id: args.shardId,
      p_org_id: args.orgId,
      p_base_ids: args.baseIds,
      p_query_embedding: `[${args.embedding.join(",")}]`,
      p_top_k: args.topK,
      p_fts_query: args.ftsQuery ?? null,
      p_filter: args.filter ? JSON.stringify(args.filter) : null,
    });

    if (error) throw new Error(`PgVectorIndex.query: ${error.message}`);

    return ((data as unknown[]) ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        documentId: r.document_id as string,
        knowledgeBaseId: r.knowledge_base_id as string,
        chunkIndex: r.chunk_index as number,
        content: r.content as string,
        contentTokens: r.content_tokens as number,
        embeddingModel: r.embedding_model as string,
        embeddingVersion: r.embedding_version as number,
        score: r.rrf_score as number,
      };
    });
  }

  async deleteByDocument(documentId: string, _shardId: number): Promise<void> {
    const admin = createAdminClient() as AnyClient;
    const { error } = await admin
      .from("knowledge_chunks")
      .delete()
      .eq("document_id", documentId);
    if (error) throw new Error(`PgVectorIndex.deleteByDocument: ${error.message}`);
  }
}

// Factory — env-switchable for future external vector store
let _instance: VectorIndex | null = null;

export function getVectorIndex(): VectorIndex {
  if (!_instance) _instance = new PgVectorIndex();
  return _instance;
}
