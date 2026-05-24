import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { detectLogoMimeType } from "@/lib/utils/magic-bytes";

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "vendor") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart request" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > 1_048_576) {
    return NextResponse.json({ error: "File exceeds 1 MB limit" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const detectedType = detectLogoMimeType(buf);
  if (!detectedType) {
    return NextResponse.json(
      { error: "Invalid format. Only PNG, JPG, and WebP are accepted." },
      { status: 400 }
    );
  }

  const ext =
    detectedType === "image/jpeg" ? "jpg" : detectedType === "image/png" ? "png" : "webp";
  const nanoid = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const storagePath = `${user.id}/${nanoid}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from("app-screenshots")
    .upload(storagePath, buf, { contentType: detectedType, upsert: false });
  if (uploadErr) {
    return NextResponse.json({ error: uploadErr.message }, { status: 500 });
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("app-screenshots").getPublicUrl(storagePath);

  return NextResponse.json({ url: publicUrl });
}
