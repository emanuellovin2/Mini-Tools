import type { ProviderAdapter, ForwardResult, UsageResult } from "./index";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// Approximate cost in cents per 1k tokens (blended input+output)
const MODEL_COST_CENTS_PER_KTOKEN: Record<string, number> = {
  "claude-opus-4-7": 1.5,
  "claude-sonnet-4-6": 0.3,
  "claude-haiku-4-5-20251001": 0.025,
  "claude-3-5-sonnet-20241022": 0.3,
  "claude-3-5-haiku-20241022": 0.025,
  "claude-3-opus-20240229": 1.5,
};

export class AnthropicAdapter implements ProviderAdapter {
  async forward(
    body: unknown,
    plaintextKey: string,
    systemPrompt?: string | null,
    maxTokensCap?: number
  ): Promise<ForwardResult> {
    const req = body as Record<string, unknown>;

    // Anthropic uses a top-level "system" field, not a message role
    const system = systemPrompt
      ? (req.system ? `${systemPrompt}\n\n${req.system}` : systemPrompt)
      : (req.system ?? undefined);

    const maxTokens = typeof req.max_tokens === "number"
      ? Math.min(req.max_tokens, maxTokensCap ?? 4096)
      : (maxTokensCap ?? 4096);

    const payload = {
      ...req,
      max_tokens: maxTokens,
      stream: true,
      ...(system !== undefined ? { system } : {}),
    };

    const providerRes = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": plaintextKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
    });

    if (!providerRes.ok || !providerRes.body) {
      const errText = await providerRes.text();
      throw new Error(`Anthropic error ${providerRes.status}: ${errText}`);
    }

    const [clientStream, usageStream] = providerRes.body.tee();

    const usage: Promise<UsageResult> = parseAnthropicUsageFromStream(usageStream).then((u) => ({
      unit: "tokens",
      quantity: u.input_tokens + u.output_tokens,
      providerCostCentsEstimate: this.estimateCost(
        req.model as string,
        u.input_tokens + u.output_tokens
      ),
    }));

    return { stream: clientStream, usage };
  }

  modelCostCentsPerKToken(model: string): number | null {
    return MODEL_COST_CENTS_PER_KTOKEN[model] ?? null;
  }

  private estimateCost(model: string, totalTokens: number): number {
    const rate = MODEL_COST_CENTS_PER_KTOKEN[model] ?? 0;
    return Math.ceil((totalTokens / 1000) * rate);
  }
}

// ---------------------------------------------------------------------------
// SSE parser for Anthropic streaming usage
// ---------------------------------------------------------------------------

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

async function parseAnthropicUsageFromStream(
  stream: ReadableStream<Uint8Array>
): Promise<AnthropicUsage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        try {
          const parsed = JSON.parse(data);
          // message_start carries input_tokens; message_delta carries output_tokens
          if (parsed.type === "message_start" && parsed.message?.usage) {
            usage.input_tokens = parsed.message.usage.input_tokens ?? 0;
          }
          if (parsed.type === "message_delta" && parsed.usage) {
            usage.output_tokens = parsed.usage.output_tokens ?? 0;
          }
        } catch {
          // Non-JSON SSE lines — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return usage;
}
