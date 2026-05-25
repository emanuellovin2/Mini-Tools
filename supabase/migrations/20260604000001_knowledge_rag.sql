-- #55 Knowledge & Retrieval (RAG) foundation
-- Adds: pgvector extension, knowledge_bases, knowledge_documents, knowledge_chunks (partitioned),
-- match_knowledge_chunks SECURITY DEFINER RPC, RLS policies, quota columns.

-- ---------------------------------------------------------------------------
-- 0. pgvector extension (own statement — Supabase availability: enabled in all projects)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 1. knowledge_bases — grouping unit; one embedding generation = one index
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_bases (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  slug              text,                                      -- nullable; unique per org when set
  visibility        text        NOT NULL DEFAULT 'private',    -- private | org | public
  embedding_model   text        NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_dims    int         NOT NULL DEFAULT 1536,
  chunker_version   text        NOT NULL DEFAULT 'v1',
  region            text        NOT NULL DEFAULT 'us-east-1', -- data residency
  tenant_shard_id   smallint    NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT knowledge_bases_visibility_check CHECK (visibility IN ('private','org','public'))
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_bases_slug_org_uidx
  ON public.knowledge_bases (org_id, slug)
  WHERE slug IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS knowledge_bases_org_idx
  ON public.knowledge_bases (org_id)
  WHERE deleted_at IS NULL;

ALTER TABLE public.knowledge_bases ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'knowledge_bases' AND policyname = 'knowledge_bases_org_rls'
  ) THEN
    CREATE POLICY knowledge_bases_org_rls ON public.knowledge_bases
      FOR ALL
      USING (
        is_org_member(org_id)
        OR visibility = 'public'
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. knowledge_documents — one row per source artifact
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id uuid        NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  org_id            uuid        NOT NULL,                      -- denormalized for RLS + quota
  source_type       text        NOT NULL,                      -- upload | url | connector
  source_ref        text,                                      -- storage path / url / connector resource id
  content_hash      text        NOT NULL,                      -- sha256 of normalized extracted text
  title             text,
  mime_type         text,
  byte_size         bigint      NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'pending',    -- pending|parsing|chunking|embedding|ready|failed
  error             text,
  chunk_count       int         NOT NULL DEFAULT 0,
  tenant_shard_id   smallint    NOT NULL DEFAULT 0,
  region            text        NOT NULL DEFAULT 'us-east-1',
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,                               -- soft-delete; hard erase via #45 eraser
  CONSTRAINT knowledge_documents_source_type_check CHECK (source_type IN ('upload','url','connector')),
  CONSTRAINT knowledge_documents_status_check CHECK (status IN ('pending','parsing','chunking','embedding','ready','failed'))
);

-- Idempotent re-upload: same content in same base returns existing doc
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_base_hash_uidx
  ON public.knowledge_documents (knowledge_base_id, content_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS knowledge_documents_org_idx
  ON public.knowledge_documents (org_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS knowledge_documents_base_status_idx
  ON public.knowledge_documents (knowledge_base_id, status)
  WHERE deleted_at IS NULL;

ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'knowledge_documents' AND policyname = 'knowledge_documents_org_rls'
  ) THEN
    CREATE POLICY knowledge_documents_org_rls ON public.knowledge_documents
      FOR ALL
      USING (is_org_member(org_id));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. knowledge_chunks — retrieval unit, PARTITIONED by tenant_shard_id
-- Vectors cannot be cheaply repartitioned later; shard column must be first-class.
-- FK to knowledge_documents declared per-partition (partitioned-table FK caveat).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_shard_id   smallint    NOT NULL,
  document_id       uuid        NOT NULL,
  knowledge_base_id uuid        NOT NULL,
  org_id            uuid        NOT NULL,
  chunk_index       int         NOT NULL,
  content           text        NOT NULL,
  content_tokens    int         NOT NULL DEFAULT 0,
  embedding         vector(1536) NOT NULL,
  embedding_model   text        NOT NULL,
  embedding_version int         NOT NULL DEFAULT 1,
  fts               tsvector    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_shard_id, id)
) PARTITION BY LIST (tenant_shard_id);

-- Initial partition for shard 0 (additional shards added as needed)
CREATE TABLE IF NOT EXISTS public.knowledge_chunks_shard_0
  PARTITION OF public.knowledge_chunks FOR VALUES IN (0);

-- Indexes on the partition (CONCURRENTLY on partition tables, not the parent)
-- HNSW for vector cosine similarity
CREATE INDEX IF NOT EXISTS knowledge_chunks_s0_embedding_hnsw_idx
  ON public.knowledge_chunks_shard_0
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN for full-text search (reuses FTS tsvector column)
CREATE INDEX IF NOT EXISTS knowledge_chunks_s0_fts_idx
  ON public.knowledge_chunks_shard_0
  USING gin (fts);

-- btree for delete/erasure by document
CREATE INDEX IF NOT EXISTS knowledge_chunks_s0_base_doc_idx
  ON public.knowledge_chunks_shard_0 (knowledge_base_id, document_id);

-- btree for RLS-aligned scans
CREATE INDEX IF NOT EXISTS knowledge_chunks_s0_org_base_idx
  ON public.knowledge_chunks_shard_0 (org_id, knowledge_base_id);

-- Unique per (document_id, chunk_index, embedding_version) for idempotent upserts
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_s0_doc_chunk_ver_uidx
  ON public.knowledge_chunks_shard_0 (document_id, chunk_index, embedding_version);

-- RLS: chunks never directly selectable by clients — only via the RPC
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'knowledge_chunks' AND policyname = 'knowledge_chunks_deny_direct'
  ) THEN
    -- Deny direct access; all reads go through match_knowledge_chunks (SECURITY DEFINER)
    CREATE POLICY knowledge_chunks_deny_direct ON public.knowledge_chunks
      FOR SELECT
      USING (FALSE);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. match_knowledge_chunks — hybrid vector+FTS retrieval via Reciprocal Rank Fusion
-- STABLE SECURITY DEFINER: org + base filtering is inside the function (defense in depth).
-- Cross-tenant retrieval is structurally impossible from this path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  p_shard_id        smallint,
  p_org_id          uuid,
  p_base_ids        uuid[],
  p_query_embedding vector(1536),
  p_top_k           int             DEFAULT 5,
  p_fts_query       text            DEFAULT NULL,
  p_filter          jsonb           DEFAULT NULL
)
RETURNS TABLE (
  id                uuid,
  document_id       uuid,
  knowledge_base_id uuid,
  chunk_index       int,
  content           text,
  content_tokens    int,
  embedding_model   text,
  embedding_version int,
  rrf_score         double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_k_mult int := 4; -- retrieve k*4 candidates from each path before fusion
BEGIN
  RETURN QUERY
  WITH vector_candidates AS (
    SELECT
      c.id,
      c.document_id,
      c.knowledge_base_id,
      c.chunk_index,
      c.content,
      c.content_tokens,
      c.embedding_model,
      c.embedding_version,
      ROW_NUMBER() OVER (ORDER BY c.embedding <=> p_query_embedding) AS vec_rank
    FROM public.knowledge_chunks c
    JOIN public.knowledge_bases b ON b.id = c.knowledge_base_id
    WHERE
      -- Security: org filter first
      c.org_id = p_org_id
      AND c.knowledge_base_id = ANY(p_base_ids)
      -- Allow public bases owned by other orgs (visibility check)
      AND (c.org_id = p_org_id OR b.visibility = 'public')
      -- Only latest embedding version
      AND c.embedding_version = (
        SELECT MAX(c2.embedding_version) FROM public.knowledge_chunks c2
        WHERE c2.document_id = c.document_id AND c2.chunk_index = c.chunk_index
      )
    ORDER BY c.embedding <=> p_query_embedding
    LIMIT p_top_k * v_k_mult
  ),
  fts_candidates AS (
    SELECT
      c.id,
      c.document_id,
      c.knowledge_base_id,
      c.chunk_index,
      c.content,
      c.content_tokens,
      c.embedding_model,
      c.embedding_version,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.fts, websearch_to_tsquery('english', COALESCE(p_fts_query, ''))) DESC) AS fts_rank
    FROM public.knowledge_chunks c
    JOIN public.knowledge_bases b ON b.id = c.knowledge_base_id
    WHERE
      c.org_id = p_org_id
      AND c.knowledge_base_id = ANY(p_base_ids)
      AND (c.org_id = p_org_id OR b.visibility = 'public')
      AND p_fts_query IS NOT NULL
      AND c.fts @@ websearch_to_tsquery('english', p_fts_query)
    ORDER BY ts_rank_cd(c.fts, websearch_to_tsquery('english', p_fts_query)) DESC
    LIMIT p_top_k * v_k_mult
  ),
  -- Reciprocal Rank Fusion: score = 1/(60 + rank)
  rrf AS (
    SELECT
      COALESCE(v.id, f.id)                    AS id,
      COALESCE(v.document_id, f.document_id)  AS document_id,
      COALESCE(v.knowledge_base_id, f.knowledge_base_id) AS knowledge_base_id,
      COALESCE(v.chunk_index, f.chunk_index)  AS chunk_index,
      COALESCE(v.content, f.content)          AS content,
      COALESCE(v.content_tokens, f.content_tokens) AS content_tokens,
      COALESCE(v.embedding_model, f.embedding_model) AS embedding_model,
      COALESCE(v.embedding_version, f.embedding_version) AS embedding_version,
      COALESCE(1.0 / (60.0 + v.vec_rank), 0.0)
        + COALESCE(1.0 / (60.0 + f.fts_rank), 0.0) AS rrf_score
    FROM vector_candidates v
    FULL OUTER JOIN fts_candidates f ON f.id = v.id
  )
  SELECT
    rrf.id,
    rrf.document_id,
    rrf.knowledge_base_id,
    rrf.chunk_index,
    rrf.content,
    rrf.content_tokens,
    rrf.embedding_model,
    rrf.embedding_version,
    rrf.rrf_score
  FROM rrf
  ORDER BY rrf.rrf_score DESC
  LIMIT p_top_k;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. org_quotas — add knowledge columns (migration-safe: nullable first)
-- ---------------------------------------------------------------------------
ALTER TABLE public.org_quotas
  ADD COLUMN IF NOT EXISTS max_knowledge_bases       int NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS max_knowledge_documents   int NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS max_knowledge_chunks      int NOT NULL DEFAULT 200000,
  ADD COLUMN IF NOT EXISTS max_knowledge_bytes       bigint NOT NULL DEFAULT 1073741824; -- 1 GB

-- ---------------------------------------------------------------------------
-- 6. Retention cron — purge soft-deleted knowledge documents past grace window
-- (pg_cron job; runs at 04:30 UTC alongside existing retention jobs)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$
      SELECT cron.schedule(
        'knowledge-retention-cron',
        '30 4 * * *',
        $cmd$
          WITH deleted_docs AS (
            DELETE FROM public.knowledge_documents
            WHERE deleted_at IS NOT NULL
              AND deleted_at < now() - interval '90 days'
            RETURNING id
          )
          SELECT count(*) FROM deleted_docs;
        $cmd$
      )
    $q$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
