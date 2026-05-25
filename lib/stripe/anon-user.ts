import crypto from "node:crypto";
import { createAdminClient } from "@/lib/services/supabase";

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateAnonUserId(): string {
  let id = "usr_";
  while (id.length < 20) {
    const bytes = crypto.randomBytes(16);
    for (const byte of bytes) {
      if (id.length >= 20) break;
      // Rejection sampling: discard bytes >= 248 to avoid modulo bias
      if (byte < 248) id += BASE62[byte % 62];
    }
  }
  return id;
}

// SPEC §6: anon_user_id is stable per (buyer_id, app_id) across resubscriptions.
// Always call this before creating a Checkout session — never generate unconditionally.
export async function lookupOrGenerateAnonUserId(
  buyerId: string,
  appId: string
): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select("anon_user_id")
    .eq("buyer_id", buyerId)
    .eq("app_id", appId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.anon_user_id ?? generateAnonUserId();
}
