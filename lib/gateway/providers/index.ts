/**
 * Provider adapter interface.
 * Adding a new provider = new adapter file + register entry here. No proxy rewrite.
 */

export interface UsageResult {
  unit: string;
  quantity: number;
  /** Estimated provider cost in cents (informational for managed mode). */
  providerCostCentsEstimate?: number;
}

export interface ForwardResult {
  /** Streaming response body passed through verbatim to the client. */
  stream: ReadableStream<Uint8Array>;
  /**
   * Resolves after the stream is fully consumed with the actual usage.
   * The proxy awaits this to settle the reservation.
   */
  usage: Promise<UsageResult>;
}

export interface ProviderAdapter {
  /**
   * Forward the incoming request body to the provider using the decrypted key.
   * Must return a streaming response without buffering the entire body.
   */
  forward(
    body: unknown,
    plaintextKey: string,
    /** Optional: per-product system prompt injected before the user messages. */
    systemPrompt?: string | null,
    /** Hard token cap enforced at the adapter level (added to request params). */
    maxTokensCap?: number
  ): Promise<ForwardResult>;

  /**
   * Model cost table (provider cents per 1k tokens) for managed-mode billing.
   * Returns null if the model is unknown (falls back to zero cost).
   */
  modelCostCentsPerKToken(model: string): number | null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

import { OpenAIAdapter } from "./openai";
import { AnthropicAdapter } from "./anthropic";
import { OpenAICompatAdapter } from "./compat";

export type ProviderName = "openai" | "anthropic" | "openai_compat";

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  openai_compat: new OpenAICompatAdapter(),
};

export function getAdapter(provider: ProviderName): ProviderAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter;
}
