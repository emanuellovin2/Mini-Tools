"use server";

import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { enqueueJob } from "@/lib/jobs/queue";
import { getActiveOrg } from "@/lib/services/org";
import type { ExportScope } from "@/lib/services/export";

export async function updateDisplayNameAction(
  formData: FormData
): Promise<{ error?: string }> {
  const name = (formData.get("name") as string | null)?.trim();
  if (!name) return { error: "Name is required" };

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: name })
    .eq("id", user.id);
  return error ? { error: error.message } : {};
}

export async function updateEmailAction(
  formData: FormData
): Promise<{ error?: string }> {
  const email = (formData.get("email") as string | null)?.trim();
  if (!email) return { error: "Email is required" };

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const { error } = await supabase.auth.updateUser({ email });
  return error ? { error: error.message } : {};
}

export async function updatePasswordAction(
  formData: FormData
): Promise<{ error?: string }> {
  const newPw = formData.get("new") as string | null;
  if (!newPw || newPw.length < 8) return { error: "Password must be at least 8 characters" };

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const { error } = await supabase.auth.updateUser({ password: newPw });
  return error ? { error: error.message } : {};
}

export async function enrollTotpAction(): Promise<{ error?: string; qrCode?: string }> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "[PLATFORM] Authenticator",
  });
  if (error) return { error: error.message };
  return { qrCode: data.totp.qr_code };
}

export async function revokeSessionAction(
  formData: FormData
): Promise<{ error?: string }> {
  const sessionId = formData.get("sessionId") as string | null;
  if (!sessionId) return { error: "Session ID required" };

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  // Supabase Auth admin API
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin.auth as any).admin.signOut(sessionId);
  return error ? { error: (error as { message: string }).message } : {};
}

export async function requestDataExportAction(
  scope: ExportScope
): Promise<{ error?: string; jobId?: string }> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const activeCtx = await getActiveOrg();
  const { enqueueExport } = await import("@/lib/services/export");

  const { jobId } = await enqueueExport(scope, {
    userId: user.id,
    orgId: activeCtx.org.id,
    role: profile?.role ?? "buyer",
  }, user.email ?? "");

  return { jobId };
}

export async function deleteAccountAction(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const admin = createAdminClient();
  await admin.from("profiles").update({ deleted_at: new Date().toISOString() } as never).eq("id", user.id);
  await enqueueJob("erasure", { userId: user.id }, {
    idempotencyKey: `erasure:${user.id}`,
    runAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  await supabase.auth.signOut();
}
