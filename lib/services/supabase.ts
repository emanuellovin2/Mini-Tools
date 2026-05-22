import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

// Server-side admin client (service role — bypasses RLS, server-only)
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase admin env vars missing");
  return createClient<Database>(url, key, {
    auth: { persistSession: false },
  });
}
