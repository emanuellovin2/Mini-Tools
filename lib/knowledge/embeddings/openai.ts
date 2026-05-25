import type { EmbeddingProvider, EmbedResult } from "./index";

const OPENAI_API_BASE = "https://api.openai.com/v1";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  defaultModel(): string {
    return process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
  }

  costCentsPerKToken(): number {
    // text-embedding-3-small: $0.00002/1k tokens = 0.002 cents/1k
    return 0.002;
  }

  async embed(texts: string[], plaintextKey: string): Promise<EmbedResult> {
    const model = this.defaultModel();
    const dims = parseInt(process.env.EMBEDDING_DIMS ?? "1536", 10);

    const res = await fetch(`${OPENAI_API_BASE}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
        dimensions: dims,
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI embeddings error ${res.status}: ${err}`);
    }

    const json = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
      usage: { total_tokens: number; prompt_tokens: number };
    };

    // Sort by index to preserve input order
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      vectors: sorted.map((d) => d.embedding),
      tokens: json.usage.total_tokens,
    };
  }
}
