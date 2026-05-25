// ---------------------------------------------------------------------------
// Embed stage — batch-embeds chunks via the EmbeddingProvider abstraction,
// upserts through VectorIndex, meters token usage (#40).
// Called by the knowledge_embed_batch job handler.
// ---------------------------------------------------------------------------

import { getEmbeddingProvider } from "@/lib/knowledge/embeddings";
import { getVectorIndex } from "@/lib/knowledge/pg-vector-index";
import { chunkText } from "./chunk";
import type { ChunkVector } from "@/lib/knowledge/vector-index";
import { randomUUID } from "crypto";

const EMBED_BATCH_SIZE = 100; // respect provider rate limits

export interface EmbedStageInput {
  documentId: string;
  knowledgeBaseId: string;
  orgId: string;
  tenantShardId: number;
  text: string;
  embeddingModel: string;
  embeddingVersion: number;
  chunkerVersion: string;
  plaintextApiKey: string;
}

export interface EmbedStageResult {
  chunkCount: number;
  tokensUsed: number;
}

export async function embedDocument(input: EmbedStageInput): Promise<EmbedStageResult> {
  const {
    documentId, knowledgeBaseId, orgId, tenantShardId,
    text, embeddingModel, embeddingVersion, chunkerVersion,
    plaintextApiKey,
  } = input;

  const chunks = chunkText(text, chunkerVersion);
  if (chunks.length === 0) return { chunkCount: 0, tokensUsed: 0 };

  const provider = getEmbeddingProvider();
  const index = getVectorIndex();
  let totalTokens = 0;

  // Process in batches to respect provider rate limits
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((c) => c.content);

    const { vectors, tokens } = await provider.embed(texts, plaintextApiKey);
    totalTokens += tokens;

    const chunkVectors: ChunkVector[] = batch.map((c, idx) => ({
      id: randomUUID(),
      tenantShardId,
      documentId,
      knowledgeBaseId,
      orgId,
      chunkIndex: c.index,
      content: c.content,
      contentTokens: c.tokens,
      embedding: vectors[idx],
      embeddingModel,
      embeddingVersion,
    }));

    await index.upsert(chunkVectors);
  }

  return { chunkCount: chunks.length, tokensUsed: totalTokens };
}
