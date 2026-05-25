import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { ingestDocument } from "@/lib/services/knowledge";
import { createAdminClient } from "@/lib/services/supabase";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

// Magic-bytes checks (same pattern as brand-upload validation)
function verifyMagicBytes(buf: Uint8Array, mimeType: string): boolean {
  if (mimeType === "application/pdf") {
    // PDF: %PDF
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
  }
  // Text types: must be valid UTF-8 (no binary nulls in first 512 bytes)
  for (let i = 0; i < Math.min(512, buf.length); i++) {
    if (buf[i] === 0x00) return false; // null byte = binary, not text
  }
  // No SVG — block XML/SVG regardless of claimed mime
  const head = Buffer.from(buf.slice(0, 128)).toString("ascii").toLowerCase();
  if (head.includes("<svg") || head.includes("<?xml")) return false;
  return true;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.KNOWLEDGE_ENABLED !== "true") {
    return NextResponse.json({ error: "knowledge_disabled" }, { status: 404 });
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { org } = await getActiveOrg();

  const formData = await req.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "invalid_form" }, { status: 400 });

  const file = formData.get("file") as File | null;
  const knowledgeBaseId = formData.get("knowledge_base_id") as string | null;

  if (!file || !knowledgeBaseId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const maxBytes = parseInt(process.env.KNOWLEDGE_MAX_DOC_BYTES ?? String(25 * 1024 * 1024), 10);
  if (file.size > maxBytes) {
    return NextResponse.json({ error: "file_too_large", maxBytes }, { status: 413 });
  }

  // Normalize mime: fall back to text/plain for unknown text extensions
  let mimeType = file.type || "text/plain";
  if (!ALLOWED_MIME.has(mimeType)) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".md") || name.endsWith(".markdown")) mimeType = "text/markdown";
    else if (name.endsWith(".txt")) mimeType = "text/plain";
    else return NextResponse.json({ error: "unsupported_file_type", allowed: [...ALLOWED_MIME] }, { status: 415 });
  }

  // Verify magic bytes
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!verifyMagicBytes(buf, mimeType)) {
    return NextResponse.json({ error: "invalid_file_content" }, { status: 422 });
  }

  // Upload to Supabase Storage (org-prefixed, private bucket)
  const admin = createAdminClient();
  const storagePath = `${org.id}/${knowledgeBaseId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: uploadErr } = await (admin as any).storage
    .from("knowledge-uploads")
    .upload(storagePath, buf, { contentType: mimeType, upsert: false });

  if (uploadErr) {
    return NextResponse.json({ error: "storage_upload_failed", detail: uploadErr.message }, { status: 500 });
  }

  const { docId } = await ingestDocument({
    orgId: org.id,
    knowledgeBaseId,
    sourceType: "upload",
    sourceRef: storagePath,
    mimeType,
    byteSize: file.size,
    actorId: user.id,
  });

  return NextResponse.json({ docId, status: "pending" });
}
