/**
 * OpenAI-compatible adapter for self-hosted / third-party providers
 * (Ollama, Together AI, Groq, Mistral, etc.).
 *
 * The base URL is read from the deployment's effective config:
 *   runtime_config.compat_base_url (required for openai_compat provider)
 *
 * Usage reporting follows the OpenAI SSE format (most compat providers match it).
 */
import type { ProviderAdapter, ForwardResult, UsageResult } from "./index";

export class OpenAICompatAdapter implements ProviderAdapter {
  async forward(
    body: unknown,
    plaintextKey: string,
    systemPrompt?: string | null,
    maxTokensCap?: number,
    baseUrl?: string
  ): Promise<ForwardResult> {
    const effectiveBase = baseUrl ?? process.env.OPENAI_COMPAT_BASE_URL ?? "";
    if (!effectiveBase) {
      throw new Error(
        "openai_compat provider requires compat_base_url in runtime_config"
      );
    }

    const req = body as Record<string, unknown>;

    let messages = (req.messages as unknown[]) ?? [];
    if (systemPrompt) {
      messages = [{ role: "system", content: systemPrompt }, ...messages];
    }

    const maxTokens = typeof req.max_tokens === "number"
      ? Math.min(req.max_tokens, maxTokensCap ?? 4096)
      : (maxTokensCap ?? 4096);

    const payload = {
      ...req,
      messages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    const url = `${effectiveBase.replace(/\/$/, "")}/chat/completions`;

    const providerRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!providerRes.ok || !providerRes.body) {
      const errText = await providerRes.text();
      throw new Error(`compat provider error ${providerRes.status}: ${errText}`);
    }

    const [clientStream, usageStream] = providerRes.body.tee();

    const usage: Promise<UsageResult> = parseCompatUsageFromStream(usageStream).then((tokens) => ({
      unit: "tokens",
      quantity: tokens,
    }));

    return { stream: clientStream, usage };
  }

  modelCostCentsPerKToken(_model: string): number | null {
    // Cost unknown for arbitrary compat providers; managed mode not meaningful here.
    return null;
  }
}

async function parseCompatUsageFromStream(
  stream: ReadableStream<Uint8Array>
): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let totalTokens = 0;

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
          if (parsed.usage?.total_tokens) {
            totalTokens = parsed.usage.total_tokens;
          }
        } catch {
          // skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return totalTokens;
}
