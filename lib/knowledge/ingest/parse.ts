// ---------------------------------------------------------------------------
// Parse stage — fetch source, extract text, compute content_hash.
// PDF via pdf-parse (lazy import). Markdown/text passthrough. URL fetch.
// Returns normalized text; caller writes status=chunking on success.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";

export interface ParseResult {
  text: string;
  contentHash: string;
  title?: string;
}

export async function parseDocument(opts: {
  sourceType: "upload" | "url" | "connector";
  sourceRef: string;
  mimeType?: string | null;
}): Promise<ParseResult> {
  const { sourceType, sourceRef, mimeType } = opts;

  let raw: Buffer | string;

  if (sourceType === "url") {
    const res = await fetch(sourceRef, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`parse: URL fetch failed ${res.status}: ${sourceRef}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("pdf") || sourceRef.endsWith(".pdf")) {
      raw = Buffer.from(await res.arrayBuffer());
    } else {
      raw = await res.text();
    }
  } else if (sourceType === "upload") {
    // sourceRef = Supabase Storage path — fetch via admin client
    const { createAdminClient } = await import("@/lib/services/supabase");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any;
    const { data, error } = await admin.storage
      .from("knowledge-uploads")
      .download(sourceRef);
    if (error) throw new Error(`parse: storage download failed: ${error.message}`);
    raw = Buffer.from(await (data as Blob).arrayBuffer());
  } else {
    // connector — sourceRef is a pre-fetched text payload stored by the connector step
    raw = sourceRef;
  }

  let text: string;
  const isPdf = mimeType === "application/pdf" ||
    (typeof sourceRef === "string" && sourceRef.toLowerCase().endsWith(".pdf")) ||
    (raw instanceof Buffer && raw.subarray(0, 4).toString() === "%PDF");

  if (isPdf && raw instanceof Buffer) {
    // Dynamic import so pdf-parse is only loaded when needed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfModule = await import("pdf-parse" as any).catch(() => {
      throw new Error("pdf-parse is not installed — run: npm install pdf-parse");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfParse = (pdfModule as any).default ?? pdfModule;
    const result = await pdfParse(raw);
    text = result.text as string;
  } else if (raw instanceof Buffer) {
    text = raw.toString("utf-8");
  } else {
    text = raw as string;
  }

  // Normalize: collapse whitespace runs, strip null bytes
  text = text.replace(/\0/g, "").replace(/\r\n/g, "\n").trim();

  const contentHash = createHash("sha256").update(text, "utf8").digest("hex");

  // Attempt to extract a title from the first non-empty line
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  const title = firstLine ? firstLine.replace(/^#+\s*/, "").slice(0, 255) : undefined;

  return { text, contentHash, title };
}

/** Estimate token count (~4 chars per token, fast approximation). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
