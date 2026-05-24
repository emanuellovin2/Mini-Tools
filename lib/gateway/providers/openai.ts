import type { ProviderAdapter, ForwardResult, UsageResult } from "./index";

const OPENAI_API_BASE = "https://api.openai.com/v1";

// Approximate provider cost table in cents per 1k tokens (input + output blended).
// Not exact — used only for managed-mode cost estimation.
const MODEL_COST_CENTS_PER_KTOKEN: Record<string, number> = {
  "gpt-4o": 0.5,
  "gpt-4o-mini": 0.015,
  "gpt-4-turbo": 1.0,
  "gpt-4": 3.0,
  "gpt-3.5-turbo": 0.05,
  "o1": 1.5,
  "o1-mini": 0.11,
  "o3-mini": 0.11,
};

export class OpenAIAdapter implements ProviderAdapter {
  async forward(
    body: unknown,
    plaintextKey: string,
    systemPrompt?: string | null,
    maxTokensCap?: number
  ): Promise<ForwardResult> {
    const req = body as Record<string, unknown>;

    // Inject system prompt as first message if set
    let messages = (req.messages as unknown[]) ?? [];
    if (systemPrompt) {
      messages = [{ role: "system", content: systemPrompt }, ...messages];
    }

    // Enforce max_tokens cap
    const maxTokens = typeof req.max_tokens === "number"
      ? Math.min(req.max_tokens, maxTokensCap ?? 4096)
      : (maxTokensCap ?? 4096);

    const payload = {
      ...req,
      messages,
      max_tokens: maxTokens,
      stream: true,
      // Request usage in the stream so we can settle accurately
      stream_options: { include_usage: true },
    };

    const providerRes = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!providerRes.ok || !providerRes.body) {
      const errText = await providerRes.text();
      throw new Error(`OpenAI error ${providerRes.status}: ${errText}`);
    }

    // Tee the stream: one branch to the client, one branch to parse usage
    const [clientStream, usageStream] = providerRes.body.tee();

    const usage: Promise<UsageResult> = parseOpenAIUsageFromStream(usageStream).then((u) => ({
      unit: "tokens",
      quantity: u.total_tokens,
      providerCostCentsEstimate: this.estimateCost(req.model as string, u.total_tokens),
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
// SSE parser for OpenAI streaming usage
// ---------------------------------------------------------------------------

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

async function parseOpenAIUsageFromStream(
  stream: ReadableStream<Uint8Array>
): Promise<OpenAIUsage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let usage: OpenAIUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) {
            usage = {
              prompt_tokens: parsed.usage.prompt_tokens ?? 0,
              completion_tokens: parsed.usage.completion_tokens ?? 0,
              total_tokens: parsed.usage.total_tokens ?? 0,
            };
          }
        } catch {
          // Non-JSON lines in SSE stream — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return usage;
}
