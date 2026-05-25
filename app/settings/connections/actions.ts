"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { revokeAccount } from "@/lib/services/connectors";
import { getActiveOrg } from "@/lib/services/org";

export async function revokeAccountAction(
  orgId: string,
  accountId: string
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  // Verify the caller's active org matches the requested orgId
  const { org } = await getActiveOrg();
  if (org.id !== orgId) throw new Error("Org mismatch");

  await revokeAccount(orgId, accountId);
  revalidatePath("/settings/connections");
}
