"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { requestClientExport, requestClientErasure } from "@/lib/services/privacy";

export async function exportClientAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const activeCtx = await getActiveOrg();
  const partnerClientId = formData.get("partnerClientId") as string;
  if (!partnerClientId) throw new Error("partnerClientId required");

  await requestClientExport(activeCtx.org.id, partnerClientId, user.id);
  redirect("/settings/client-data?exported=1");
}

export async function eraseClientAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const activeCtx = await getActiveOrg();
  const partnerClientId = formData.get("partnerClientId") as string;
  if (!partnerClientId) throw new Error("partnerClientId required");

  await requestClientErasure(activeCtx.org.id, partnerClientId, user.id);
  redirect("/settings/client-data?erased=1");
}
