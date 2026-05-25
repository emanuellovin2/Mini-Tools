// ---------------------------------------------------------------------------
// Chunker v1 — ~512-token windows with ~64-token overlap, split on sentence
// boundaries where possible. Version stored in knowledge_bases.chunker_version
// so re-chunk is possible (knowledge_reindex job bumps embedding_version).
// ---------------------------------------------------------------------------

export interface Chunk {
  index: number;
  content: string;
  tokens: number;
}

const TARGET_TOKENS = 512;
const OVERLAP_TOKENS = 64;
// ~4 chars per token
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

export function chunkText(text: string, _version = "v1"): Chunk[] {
  if (!text.trim()) return [];

  // Split on sentence-ending punctuation + newline clusters for natural boundaries
  const sentences = splitSentences(text);
  const chunks: Chunk[] = [];

  let current = "";
  let chunkIndex = 0;

  for (const sentence of sentences) {
    if (current.length + sentence.length > TARGET_CHARS && current.length > 0) {
      chunks.push({
        index: chunkIndex++,
        content: current.trim(),
        tokens: Math.ceil(current.length / CHARS_PER_TOKEN),
      });
      // Carry overlap: keep the tail of current chunk
      const overlap = current.slice(-OVERLAP_CHARS);
      current = overlap + sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) {
    chunks.push({
      index: chunkIndex,
      content: current.trim(),
      tokens: Math.ceil(current.length / CHARS_PER_TOKEN),
    });
  }

  return chunks;
}

function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace or newlines,
  // preserving the delimiter with the sentence.
  const parts: string[] = [];
  let last = 0;
  const re = /([.!?])\s+|\n{2,}/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const end = match.index + match[0].length;
    parts.push(text.slice(last, end));
    last = end;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return parts.filter((p) => p.trim().length > 0);
}
