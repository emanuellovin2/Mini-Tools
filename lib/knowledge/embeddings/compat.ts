import type { EmbeddingProvider, EmbedResult } from "./index";

// OpenAI-compatible embedding endpoint (any provider with POST /v1/embeddings).
// Configure via EMBEDDING_COMPAT_BASE_URL + EMBEDDING_MODEL env vars.
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  defaultModel(): string {
    return process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
  }

  costCentsPerKToken(): number {
    return 0; // BYOK — no platform-side cost
  }

  async embed(texts: string[], plaintextKey: string): Promise<EmbedResult> {
    const baseUrl = process.env.EMBEDDING_COMPAT_BASE_URL;
    if (!baseUrl) throw new Error("EMBEDDING_COMPAT_BASE_URL is not set for openai_compat provider");

    const model = this.defaultModel();
    const dims = parseInt(process.env.EMBEDDING_DIMS ?? "1536", 10);

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify({ model, input: texts, dimensions: dims, encoding_format: "float" }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Compat embeddings error ${res.status}: ${err}`);
    }

    const json = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
      usage: { total_tokens: number };
    };

    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      vectors: sorted.map((d) => d.embedding),
      tokens: json.usage.total_tokens,
    };
  }
}
