import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { listDocuments, listKnowledgeBases } from "@/lib/services/knowledge";
import { PageHeader } from "@/components/layout/PageHeader";
import { DocumentRow } from "./DocumentRow";
import { UploadForm } from "./UploadForm";
import { reindexAction } from "../actions";

export const metadata: Metadata = { title: "Knowledge Base — [PLATFORM]" };

const STATUS_BADGE: Record<string, string> = {
  pending:   "bg-yellow-100 text-yellow-700",
  parsing:   "bg-blue-100 text-blue-700",
  chunking:  "bg-blue-100 text-blue-700",
  embedding: "bg-purple-100 text-purple-700",
  ready:     "bg-green-100 text-green-700",
  failed:    "bg-red-100 text-red-700",
};

export default async function KnowledgeBasePage({
  params,
}: {
  params: Promise<{ baseId: string }>;
}) {
  if (process.env.KNOWLEDGE_ENABLED !== "true") redirect("/settings/account");

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const { baseId } = await params;

  const [bases, docs] = await Promise.all([
    listKnowledgeBases(org.id),
    listDocuments(baseId, org.id),
  ]);

  const base = bases.find((b) => b.id === baseId);
  if (!base) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title={base.name}
        description={`${base.embeddingModel} · ${base.chunkerVersion} · ${base.visibility}`}
      />

      <div className="flex items-center gap-3">
        <UploadForm baseId={base.id} />
        <form action={reindexAction}>
          <input type="hidden" name="base_id" value={base.id} />
          <button
            type="submit"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            title="Re-embed all documents with the latest model. This improves retrieval quality — it never trains or fine-tunes any model."
          >
            Enrich Engine (re-index)
          </button>
        </form>
      </div>

      {docs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No documents yet. Upload a file or add a URL above.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="pb-2 text-left font-medium">Title / Source</th>
              <th className="pb-2 text-left font-medium">Type</th>
              <th className="pb-2 text-right font-medium">Chunks</th>
              <th className="pb-2 text-right font-medium">Status</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {docs.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                baseId={base.id}
                statusBadge={STATUS_BADGE}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
