# Task #55 — Knowledge & Retrieval (RAG) foundation

> **Before starting:** read `SPEC.md`, `ENGINEERING.md` §12, [build_prompts/48-scale-resilience-foundation.md](build_prompts/48-scale-resilience-foundation.md) (jobs queue + quotas), [build_prompts/41-ai-gateway-byok.md](build_prompts/41-ai-gateway-byok.md) (key vault + provider adapters), [build_prompts/40-usage-metering-billing.md](build_prompts/40-usage-metering-billing.md) (metering), [build_prompts/45-partner-client-data-lifecycle.md](build_prompts/45-partner-client-data-lifecycle.md) (erasers), [lib/search/index.ts](lib/search/index.ts) (the abstraction pattern to copy), [lib/services/deployments.ts](lib/services/deployments.ts) (`getEffectiveConfig` caching pattern), [lib/gateway/crypto.ts](lib/gateway/crypto.ts), [lib/jobs/queue.ts](lib/jobs/queue.ts).
> **Definition of Done:** any org can upload documents (PDF/markdown/text/url/connector source) into a **knowledge base**; the platform parses → chunks → embeds → indexes them durably and asynchronously; an agent/workflow/gateway call can **retrieve** the most relevant chunks (hybrid vector + full-text) scoped strictly to the caller's org/base, and inject them as context. The vector store and the embedding model both sit **behind interfaces** so they can be swapped at scale without touching service code. This is "the memory" — the substrate #56/#57 build on.

**Phase 7 — Wave 10 foundation. Depends on: #48 (jobs + quotas + partition conventions), #41 (key vault + provider adapter pattern), #40 (metering), #45 (eraser registry), #50 (deployments — bases attach to deployments), #54 (search abstraction precedent). Parallel-able with #56. BLOCKS the knowledge-as-tool path in #57.**

> **Why now:** retrieval is the foundation under multi-agent (#57 agents read knowledge as long-term memory) and under the "AI that knows the client's business" promise that differentiates the agency model from raw ChatGPT. Building the *abstractions* now (vector index interface, embedding provider interface, tenant sharding) is cheap; retrofitting them after 1T chunks exist is a migration nightmare. Get the seams right once.

> **What this is NOT:** model fine-tuning. The "Enrich Engine" is re-embed + re-index of new/changed documents — it improves *retrieval context*, never model weights. Say this plainly in the UI copy. We never train on user data; we retrieve from it. No cross-tenant training, ever.

---

## Hard scale frame (design to these numbers)
- Target envelope: **100M orgs × ~50 docs × ~200 chunks ≈ 1T chunks**. No single Postgres node holds 1T vectors with a usable HNSW index. Therefore:
  - **Every vector read/write goes through a `VectorIndex` interface** (mirror `lib/search/index.ts`). The pgvector implementation is the *default*, not the contract. A future dedicated-vector-store impl (sharded, external) drops in without service-code changes.
  - **`knowledge_chunks` is partitioned by `tenant_shard_id` from day one.** Vectors cannot be cheaply repartitioned later — the shard column must be first-class on the first migration.
  - Embedding **dimension is fixed platform-wide** (`EMBEDDING_DIMS`, default 1536). A `vector(N)` column type cannot vary per row; modern models (OpenAI `text-embedding-3-*`, Matryoshka-capable) project to 1536. Switching dims = a new index generation + backfill job, explicitly versioned (`embedding_model` + `embedding_version` per chunk) so two generations coexist during migration.
- Ingest is **never synchronous**. Parse/chunk/embed are provider-rate-limited and slow; they run on the durable jobs queue (#48) with idempotent, resumable, content-hash-keyed steps.

---

## Sections to build

### 1. `pgvector` + the three tables

Enable `vector` extension in a migration (its own statement; document Supabase availability).

**`knowledge_bases`** — the grouping unit (a base = one embedding generation = one index).
```
id uuid pk
org_id uuid NOT NULL FK organizations(id) ON DELETE CASCADE
name text NOT NULL
slug text                              -- nullable; unique per org when set
visibility text NOT NULL DEFAULT 'private'  -- 'private' (org only) | 'org' (all org members) | 'public' (marketplace-discoverable, read-only)
embedding_model text NOT NULL          -- pinned at creation; all chunks in this base share it
embedding_dims int NOT NULL DEFAULT 1536
chunker_version text NOT NULL DEFAULT 'v1'
region text NOT NULL DEFAULT 'us-east-1'  -- data residency, denormalized like deployments
tenant_shard_id smallint NOT NULL DEFAULT 0
created_at timestamptz NOT NULL DEFAULT now()
deleted_at timestamptz
```
- `visibility='public'` is how concept-1's "personal + public vector DB" is expressed: a public base is retrievable by any org (read-only) but only writable by its owner. Public bases never expose the source documents' raw files, only retrieved chunks.

**`knowledge_documents`** — one row per source artifact.
```
id uuid pk
knowledge_base_id uuid NOT NULL FK knowledge_bases(id) ON DELETE CASCADE
org_id uuid NOT NULL                   -- denormalized for RLS + quota, must match base
source_type text NOT NULL              -- 'upload' | 'url' | 'connector' (Gmail/Sheets via #43)
source_ref text                        -- storage path / url / connector resource id
content_hash text NOT NULL             -- sha256 of normalized extracted text; (knowledge_base_id, content_hash) UNIQUE → idempotent re-upload
title text
mime_type text
byte_size bigint NOT NULL DEFAULT 0
status text NOT NULL DEFAULT 'pending' -- pending | parsing | chunking | embedding | ready | failed
error text
chunk_count int NOT NULL DEFAULT 0
tenant_shard_id smallint NOT NULL DEFAULT 0
region text NOT NULL DEFAULT 'us-east-1'
created_at timestamptz NOT NULL DEFAULT now()
deleted_at timestamptz                 -- soft-delete; hard erase via #45 eraser job
```

**`knowledge_chunks`** — the retrieval unit. **Partitioned `BY LIST (tenant_shard_id)`** (start with 1 partition for shard 0; the seam allows splitting later).
```
id uuid                                -- pk is (tenant_shard_id, id)
tenant_shard_id smallint NOT NULL
document_id uuid NOT NULL              -- FK constraint declared per-partition / app-enforced (partitioned-table FK caveat — document in migration)
knowledge_base_id uuid NOT NULL
org_id uuid NOT NULL
chunk_index int NOT NULL
content text NOT NULL
content_tokens int NOT NULL DEFAULT 0
embedding vector(1536) NOT NULL
embedding_model text NOT NULL
embedding_version int NOT NULL DEFAULT 1
fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED  -- reuse existing FTS investment
created_at timestamptz NOT NULL DEFAULT now()
```
- **Indexes (per partition, all `CONCURRENTLY` — see migration-safety guardrail):**
  - HNSW on `embedding` `vector_cosine_ops` (cosine is the default for normalized embeddings).
  - GIN on `fts`.
  - btree `(knowledge_base_id, document_id)` for deletes/erasure.
  - btree `(org_id, knowledge_base_id)` for RLS-aligned scans.
- HNSW build is expensive; the migration must `SET maintenance_work_mem` appropriately and build CONCURRENTLY so it never locks a hot partition.

### 2. `VectorIndex` interface + pgvector impl (the no-redo seam)
`lib/knowledge/vector-index.ts` — interface mirroring `lib/search/index.ts`:
```ts
interface VectorIndex {
  upsert(chunks: ChunkVector[]): Promise<void>;
  query(args: { shardId: number; orgId: string; baseIds: string[]; embedding: number[]; topK: number; filter?: Record<string,string> }): Promise<ScoredChunk[]>;
  deleteByDocument(documentId: string): Promise<void>;
}
```
`lib/knowledge/pg-vector-index.ts` — Postgres impl calling the `match_knowledge_chunks` RPC below. **No service code imports pg directly for vectors** — only this impl does. Selected via a factory (`getVectorIndex()`), env-switchable later.

### 3. Embedding provider abstraction (mirror gateway providers)
`lib/knowledge/embeddings/{openai,compat}.ts` + `lib/knowledge/embeddings/index.ts` factory — same shape as `lib/gateway/providers/`. Interface: `embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>`. Returns token count for **metering**. Keys resolved via the #41 vault (`decryptSecret`) — BYOK per org, falling back to a platform key only if `cost_mode='managed'`. Plaintext keys never logged (existing guardrail).

### 4. Durable ingest pipeline (on the #48 jobs queue)
`lib/knowledge/ingest/{parse,chunk,embed}.ts` (pure-ish stages) wired through job handlers in `lib/jobs/handlers.ts`. New job types:
- `knowledge_parse` — fetch source → extract text (PDF via a parser lib, markdown/text passthrough, url fetch, connector pull) → compute `content_hash` → if hash already `ready` in this base, short-circuit (idempotent re-upload). Sets status `parsing`→`chunking`.
- `knowledge_embed_batch` — chunk text (chunker `v1`: ~512-token windows, ~64-token overlap; version stored so re-chunk is possible) → call embedding provider in **batches** (respect provider rate limits; backpressure via queue concurrency, not a tight loop) → upsert via `VectorIndex` → meter embedding tokens (#40) → advance status, increment `chunk_count`. Batches are idempotent: re-running re-upserts the same `(document_id, chunk_index)` deterministically.
- `knowledge_reindex` — **the "Enrich Engine."** Re-embeds a base/doc when a new embedding model is rolled out or chunker bumped. Writes new `embedding_version` rows alongside old; flips reads to new version atomically when complete (dual-generation, zero-downtime). Document the flow as RAG, not training.
- Failure handling: any stage failure sets `status='failed'` + `error`, surfaces to UI; retried with jobs-queue backoff; never partially-visible (chunks only become retrievable once doc is `ready`).

### 5. Retrieval RPC + hybrid ranking
`match_knowledge_chunks(p_shard_id, p_org_id, p_base_ids uuid[], p_query_embedding vector, p_top_k int, p_filter jsonb)` — **`STABLE SECURITY DEFINER`**, the only vector read path:
- Filters `org_id = p_org_id AND knowledge_base_id = ANY(p_base_ids)` **inside the function** (defense in depth on top of RLS — never rely on caller filter alone; cross-tenant leak is a security incident).
- Allows `p_base_ids` to include public bases the caller doesn't own (visibility check in the function).
- Vector candidates: `ORDER BY embedding <=> p_query_embedding LIMIT k*4`. FTS candidates: `fts @@ websearch_to_tsquery(...)`. Combine via **Reciprocal Rank Fusion** (reuses the existing `to_tsvector` work — this is why FTS stays valuable), return top `k`.
- `lib/services/knowledge.ts → retrieve({ orgId, baseIds, query, topK, filter })` embeds the query (provider abstraction) then calls the RPC via `VectorIndex`.

### 6. Integration points (make it a "tool")
- **Gateway (#41):** an optional `knowledge_base_ids` on `gateway_products` / per-request → retrieve top-k → inject as system context before the provider call. Retrieval cost (query embedding) metered. Gated by `KNOWLEDGE_ENABLED`.
- **Workflow `ai` step (#42):** new step config field `knowledge_base_ids` — same retrieval-then-inject. This is the seam #57's `agent` step consumes for long-term memory.
- Both must pass the caller's `orgId`/`deploymentId`; retrieval is scoped to bases the deployment is entitled to (owned by client org, agency, or vendor + public).

### 7. Erasure, retention, quotas, RLS (reuse existing machinery)
- **Erasure (#45):** register a `knowledge` eraser in `lib/privacy/erasers.ts` — `(partnerClientId) => hard-delete documents+chunks linked to that client's base scope, idempotent`. Soft-delete is immediate (doc `deleted_at`, chunks excluded from retrieval); hard erase via the `partner_client_erasure_hard` fan-out.
- **Quotas (#48):** new `org_quotas` keys — `knowledge_documents` (default 500/org), `knowledge_storage_bytes` (default 1GB/org), `knowledge_chunks` (default 200k/org). `enforceQuota()` in `ingestDocument` before enqueue. Default-deny.
- **Cost guard:** before embedding, estimate tokens; reject docs over a per-org cap; surface estimated embedding cost in the upload UI.
- **RLS:** `knowledge_bases`/`documents`/`chunks` org-owned via `is_org_member` (`STABLE SECURITY DEFINER`, `org_id = ANY(SELECT my_org_ids())` — never per-row `auth.uid()`). Public bases readable cross-org for retrieval only. Deployment-attached bases follow #50 trust boundaries (agency reads operated, client reads own). Chunks never directly selectable by clients — only through the RPC.

### 8. Surfaces (minimal, dense — reuse design system v2)
- `app/settings/knowledge/` — list bases, create base, upload docs (drag-drop), per-doc status (`parsing`/`embedding`/`ready`/`failed`), reindex ("Enrich Engine") button, delete. Storage bucket `knowledge-uploads` (org-prefixed write, private read; PNG/PDF/text/markdown; magic-bytes verified — reuse brand-upload validation pattern; **no SVG**).
- A `retrieve` debug panel (admin/dev only) to sanity-check relevance.
- Knowledge-graph visualization (entities → nodes/edges derived from chunks): **declared, not built** — a future UI task. Leave a `lib/knowledge/graph.ts` stub returning empty so the route exists. Do not block this task on it.

### 9. Env (add to `lib/validation/env.ts`)
- `KNOWLEDGE_ENABLED` (flag, gates routes + retrieval).
- `EMBEDDING_PROVIDER` (default `openai`), `EMBEDDING_MODEL` (default `text-embedding-3-small`), `EMBEDDING_DIMS` (default `1536`).
- `KNOWLEDGE_MAX_DOC_BYTES` (default 25MB).

---

## Acceptance criteria
- [ ] `vector` extension enabled; `knowledge_bases`, `knowledge_documents`, `knowledge_chunks` created; chunks **partitioned by `tenant_shard_id`** with HNSW + GIN + btree indexes built `CONCURRENTLY`.
- [ ] All vector reads/writes go through the **`VectorIndex` interface**; pgvector impl is the only place importing the vector query — proven by a grep test in CI.
- [ ] Embedding behind a **provider abstraction** mirroring gateway providers; adding a provider = one new file.
- [ ] Ingest is **fully async** on the jobs queue; `(knowledge_base_id, content_hash)` idempotency proven (re-upload same file = no re-embed, returns existing doc).
- [ ] Each ingest stage is **resumable + idempotent**; a crash mid-embed resumes without duplicate chunks (re-run test).
- [ ] `match_knowledge_chunks` is `SECURITY DEFINER`, **filters org + base inside the function**; a cross-tenant retrieval attempt returns zero rows (RLS test, 10+ cases incl. public-base access).
- [ ] Hybrid retrieval (vector + FTS via RRF) returns better top-k than vector-only on a fixture corpus (relevance test).
- [ ] Gateway + workflow `ai` step can attach `knowledge_base_ids` and inject retrieved context; retrieval embedding tokens **metered** via #40.
- [ ] "Enrich Engine" = `knowledge_reindex` job; supports a new `embedding_version` generation with **zero-downtime cutover** (dual-generation test).
- [ ] `knowledge` eraser registered in `lib/privacy/erasers.ts`; idempotent; hard-erase removes chunks (erasure test).
- [ ] Quotas (`knowledge_documents`, `knowledge_storage_bytes`, `knowledge_chunks`) enforced via `enforceQuota()`; default-deny.
- [ ] `KNOWLEDGE_ENABLED` gates all new routes/retrieval; off = no behavior change.
- [ ] Upload validation: magic-bytes verified, no SVG, size-capped; storage bucket org-prefixed private.
- [ ] CLAUDE.md gains a "Knowledge & RAG (as of #55)" data-models section; SPEC.md gains a §16 "Knowledge / Retrieval"; ENGINEERING.md notes the vector-index + embedding-provider abstraction rule.
