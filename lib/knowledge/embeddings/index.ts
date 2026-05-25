// ---------------------------------------------------------------------------
// Embedding provider abstraction — mirrors lib/gateway/providers/index.ts.
// Adding a provider = new file implementing EmbeddingProvider + entry in PROVIDERS.
// Keys resolved via #41 vault (decryptSecret) — BYOK per org, falls back to
// platform key when cost_mode='managed'. Plaintext keys never logged.
// ---------------------------------------------------------------------------

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}

export interface EmbeddingProvider {
  embed(texts: string[], plaintextKey: string): Promise<EmbedResult>;
  /** Default model for this provider (overridable per knowledge_base). */
  defaultModel(): string;
  /** Estimated cost in cents per 1k tokens (for quota pre-check). */
  costCentsPerKToken(): number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

import { OpenAIEmbeddingProvider } from "./openai";
import { OpenAICompatEmbeddingProvider } from "./compat";

export type EmbeddingProviderName = "openai" | "openai_compat";

const PROVIDERS: Record<EmbeddingProviderName, EmbeddingProvider> = {
  openai: new OpenAIEmbeddingProvider(),
  openai_compat: new OpenAICompatEmbeddingProvider(),
};

export function getEmbeddingProvider(name?: EmbeddingProviderName): EmbeddingProvider {
  const providerName = name ?? ((process.env.EMBEDDING_PROVIDER ?? "openai") as EmbeddingProviderName);
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Unknown embedding provider: ${providerName}`);
  return provider;
}
