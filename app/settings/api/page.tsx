import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { listApiKeys } from "@/lib/services/api-keys";
import { PageHeader } from "@/components/layout/PageHeader";
import ApiKeysManager from "./_components/ApiKeysManager";

export const metadata: Metadata = { title: "API Keys — [PLATFORM]" };

export default async function ApiKeysPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const activeCtx = await getActiveOrg();
  const keys = await listApiKeys(activeCtx.org.id).catch(() => []);

  return (
    <div className="max-w-3xl mx-auto space-y-6 py-8 px-4">
      <PageHeader
        title="API Keys"
        description="Build on top of [PLATFORM] with a stable REST API. Keys are org-scoped."
      />
      <ApiKeysManager initialKeys={keys} />
    </div>
  );
}
