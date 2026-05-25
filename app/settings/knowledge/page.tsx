import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { listKnowledgeBases } from "@/lib/services/knowledge";
import { PageHeader } from "@/components/layout/PageHeader";
import { KnowledgeBaseCard } from "./KnowledgeBaseCard";
import { CreateBaseForm } from "./CreateBaseForm";

export const metadata: Metadata = { title: "Knowledge Bases — [PLATFORM]" };

export default async function KnowledgePage() {
  if (process.env.KNOWLEDGE_ENABLED !== "true") {
    redirect("/settings/account");
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const bases = await listKnowledgeBases(org.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge Bases"
        description="Upload documents and URLs to build retrieval context for your agents and workflows. Re-indexing improves retrieval quality — it never trains or fine-tunes any model."
      />

      <CreateBaseForm orgId={org.id} />

      {bases.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No knowledge bases yet. Create one above to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {bases.map((base) => (
            <KnowledgeBaseCard key={base.id} base={base} orgId={org.id} />
          ))}
        </div>
      )}
    </div>
  );
}
