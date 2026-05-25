// ---------------------------------------------------------------------------
// Knowledge service — bases, documents, retrieval.
// All vector reads go through VectorIndex; all embedding through EmbeddingProvider.
// Gated by KNOWLEDGE_ENABLED env flag.
// ---------------------------------------------------------------------------

import { createAdminClient } from "@/lib/services/supabase";
import { enforceQuota } from "@/lib/quotas/enforce";
import { enqueueJob } from "@/lib/jobs/queue";
import { getEmbeddingProvider } from "@/lib/knowledge/embeddings";
import { getVectorIndex } from "@/lib/knowledge/pg-vector-index";
import { writeAuditLog } from "@/lib/services/admin";
import { estimateTokens } from "@/lib/knowledge/ingest/parse";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

const MAX_DOC_BYTES = parseInt(process.env.KNOWLEDGE_MAX_DOC_BYTES ?? String(25 * 1024 * 1024), 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeBase {
  id: string;
  orgId: string;
  name: string;
  slug: string | null;
  visibility: "private" | "org" | "public";
  embeddingModel: string;
  embeddingDims: number;
  chunkerVersion: string;
  region: string;
  tenantShardId: number;
  createdAt: string;
  deletedAt: string | null;
}

export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  orgId: string;
  sourceType: "upload" | "url" | "connector";
  sourceRef: string | null;
  contentHash: string;
  title: string | null;
  mimeType: string | null;
  byteSize: number;
  status: "pending" | "parsing" | "chunking" | "embedding" | "ready" | "failed";
  error: string | null;
  chunkCount: number;
  tenantShardId: number;
  createdAt: string;
  deletedAt: string | null;
}

export interface RetrieveArgs {
  orgId: string;
  baseIds: string[];
  query: string;
  topK?: number;
  filter?: Record<string, string>;
  plaintextApiKey?: string;
}

// ---------------------------------------------------------------------------
// Knowledge bases
// ---------------------------------------------------------------------------

export async function createKnowledgeBase(opts: {
  orgId: string;
  name: string;
  slug?: string;
  visibility?: "private" | "org" | "public";
  embeddingModel?: string;
  actorId: string;
}): Promise<KnowledgeBase> {
  const admin = createAdminClient() as AnyClient;
  await enforceQuota(opts.orgId, "knowledge_bases");

  const { data, error } = await admin
    .from("knowledge_bases")
    .insert({
      org_id: opts.orgId,
      name: opts.name,
      slug: opts.slug ?? null,
      visibility: opts.visibility ?? "private",
      embedding_model: opts.embeddingModel ?? (process.env.EMBEDDING_MODEL ?? "text-embedding-3-small"),
    })
    .select()
    .single();

  if (error) throw new Error(`createKnowledgeBase: ${error.message}`);

  await writeAuditLog({
    actorId: opts.actorId,
    actorRole: "member",
    action: "knowledge_base.created",
    entityType: "knowledge_base",
    entityId: (data as { id: string }).id,
    metadata: { org_id: opts.orgId, name: opts.name },
  });

  return mapBase(data);
}

export async function listKnowledgeBases(orgId: string): Promise<KnowledgeBase[]> {
  const admin = createAdminClient() as AnyClient;
  const { data, error } = await admin
    .from("knowledge_bases")
    .select("*")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listKnowledgeBases: ${error.message}`);
  return ((data as unknown[]) ?? []).map((row) => mapBase(row as Record<string, unknown>));
}

export async function deleteKnowledgeBase(id: string, orgId: string, actorId: string): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  const { error } = await admin
    .from("knowledge_bases")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) throw new Error(`deleteKnowledgeBase: ${error.message}`);
  await writeAuditLog({
    actorId,
    actorRole: "member",
    action: "knowledge_base.deleted",
    entityType: "knowledge_base",
    entityId: id,
    metadata: { org_id: orgId },
  });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function ingestDocument(opts: {
  orgId: string;
  knowledgeBaseId: string;
  sourceType: "upload" | "url" | "connector";
  sourceRef: string;
  mimeType?: string;
  byteSize?: number;
  actorId: string;
}): Promise<{ docId: string; alreadyExists: boolean }> {
  if (opts.byteSize && opts.byteSize > MAX_DOC_BYTES) {
    throw new Error(`Document exceeds max size of ${MAX_DOC_BYTES} bytes`);
  }

  await enforceQuota(opts.orgId, "knowledge_documents");

  const admin = createAdminClient() as AnyClient;

  // Insert with placeholder hash; parse job computes the real hash and handles
  // (knowledge_base_id, content_hash) idempotency check.
  const { data, error } = await admin
    .from("knowledge_documents")
    .insert({
      knowledge_base_id: opts.knowledgeBaseId,
      org_id: opts.orgId,
      source_type: opts.sourceType,
      source_ref: opts.sourceRef,
      mime_type: opts.mimeType ?? null,
      byte_size: opts.byteSize ?? 0,
      content_hash: `pending-${Date.now()}`, // replaced by parse job
      status: "pending",
    })
    .select("id")
    .single();

  if (error) throw new Error(`ingestDocument: ${error.message}`);
  const docId = (data as { id: string }).id;

  // Enqueue parse job — idempotency_key = docId so re-submit is a no-op
  await enqueueJob("knowledge_parse", { docId, orgId: opts.orgId }, {
    idempotencyKey: `knowledge_parse:${docId}`,
    orgId: opts.orgId,
  });

  await writeAuditLog({
    actorId: opts.actorId,
    actorRole: "member",
    action: "knowledge_document.ingested",
    entityType: "knowledge_document",
    entityId: docId,
    metadata: { source_type: opts.sourceType, byte_size: opts.byteSize },
  });

  return { docId, alreadyExists: false };
}

export async function listDocuments(knowledgeBaseId: string, orgId: string): Promise<KnowledgeDocument[]> {
  const admin = createAdminClient() as AnyClient;
  const { data, error } = await admin
    .from("knowledge_documents")
    .select("*")
    .eq("knowledge_base_id", knowledgeBaseId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listDocuments: ${error.message}`);
  return ((data as unknown[]) ?? []).map((row) => mapDocument(row as Record<string, unknown>));
}

export async function deleteDocument(id: string, orgId: string, actorId: string): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  const { data: doc, error: readErr } = await admin
    .from("knowledge_documents")
    .select("knowledge_base_id, tenant_shard_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .single();
  if (readErr) throw new Error(`deleteDocument read: ${readErr.message}`);

  const { error } = await admin
    .from("knowledge_documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) throw new Error(`deleteDocument: ${error.message}`);

  const row = doc as { knowledge_base_id: string; tenant_shard_id: number };
  const index = getVectorIndex();
  await index.deleteByDocument(id, row.tenant_shard_id);

  await writeAuditLog({
    actorId,
    actorRole: "member",
    action: "knowledge_document.deleted",
    entityType: "knowledge_document",
    entityId: id,
    metadata: { org_id: orgId },
  });
}

// ---------------------------------------------------------------------------
// Retrieval — embed query → hybrid vector+FTS via VectorIndex
// ---------------------------------------------------------------------------

export async function retrieve(args: RetrieveArgs) {
  const { orgId, baseIds, query, topK = 5, filter, plaintextApiKey } = args;
  if (!baseIds.length) return [];

  // Resolve embedding key: use provided key or platform key
  const apiKey = plaintextApiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) throw new Error("retrieve: no embedding API key available");

  const provider = getEmbeddingProvider();
  const { vectors } = await provider.embed([query], apiKey);
  const embedding = vectors[0];

  // Use shard 0 by default (multi-shard routing is a future seam)
  const index = getVectorIndex();
  return index.query({
    shardId: 0,
    orgId,
    baseIds,
    embedding,
    topK,
    ftsQuery: query,
    filter,
  });
}

// ---------------------------------------------------------------------------
// Reindex (Enrich Engine) — queue a new embedding generation for a base/doc
// ---------------------------------------------------------------------------

export async function enqueueReindex(opts: {
  knowledgeBaseId: string;
  documentId?: string;
  orgId: string;
  actorId: string;
}): Promise<void> {
  await enqueueJob("knowledge_reindex", opts, {
    idempotencyKey: `knowledge_reindex:${opts.knowledgeBaseId}:${opts.documentId ?? "all"}`,
    orgId: opts.orgId,
  });
  await writeAuditLog({
    actorId: opts.actorId,
    actorRole: "member",
    action: "knowledge_base.reindex_enqueued",
    entityType: "knowledge_base",
    entityId: opts.knowledgeBaseId,
    metadata: { document_id: opts.documentId },
  });
}

// ---------------------------------------------------------------------------
// Debug retrieve (admin/dev only)
// ---------------------------------------------------------------------------

export async function debugRetrieve(opts: {
  orgId: string;
  baseId: string;
  query: string;
  topK?: number;
  plaintextApiKey?: string;
}) {
  const estimatedTokens = estimateTokens(opts.query);
  const results = await retrieve({
    orgId: opts.orgId,
    baseIds: [opts.baseId],
    query: opts.query,
    topK: opts.topK ?? 10,
    plaintextApiKey: opts.plaintextApiKey,
  });
  return { results, estimatedQueryTokens: estimatedTokens };
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapBase(row: Record<string, unknown>): KnowledgeBase {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    slug: (row.slug as string | null) ?? null,
    visibility: row.visibility as KnowledgeBase["visibility"],
    embeddingModel: row.embedding_model as string,
    embeddingDims: row.embedding_dims as number,
    chunkerVersion: row.chunker_version as string,
    region: row.region as string,
    tenantShardId: row.tenant_shard_id as number,
    createdAt: row.created_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapDocument(row: Record<string, unknown>): KnowledgeDocument {
  return {
    id: row.id as string,
    knowledgeBaseId: row.knowledge_base_id as string,
    orgId: row.org_id as string,
    sourceType: row.source_type as KnowledgeDocument["sourceType"],
    sourceRef: (row.source_ref as string | null) ?? null,
    contentHash: row.content_hash as string,
    title: (row.title as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    byteSize: row.byte_size as number,
    status: row.status as KnowledgeDocument["status"],
    error: (row.error as string | null) ?? null,
    chunkCount: row.chunk_count as number,
    tenantShardId: row.tenant_shard_id as number,
    createdAt: row.created_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}
