import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import {
  getInstructionSet,
  listVersions,
  getEffectiveInstructions,
} from "@/lib/services/instructions";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { BlockEditor } from "./BlockEditor";
import { VersionHistory } from "./VersionHistory";
import { LivePreview } from "./LivePreview";

export const metadata: Metadata = { title: "Instruction Set — [PLATFORM]" };

export default async function InstructionSetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();

  let set;
  try {
    set = await getInstructionSet(id);
  } catch {
    notFound();
  }

  if (set.org_id !== org.id) notFound();

  const versions = await listVersions(id);

  // Resolved preview using this set's scope context
  const preview = await getEffectiveInstructions({
    orgId: org.id,
    ...(set.scope_level === "client" && set.scope_ref_id
      ? { clientOrgId: set.scope_ref_id }
      : {}),
    ...(set.scope_level === "deployment" && set.scope_ref_id
      ? { deploymentId: set.scope_ref_id }
      : {}),
  });

  const activeVersion = versions.find((v) => v.id === set.active_version_id) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={set.name}
        description={`${set.scope_level} scope${set.scope_ref_id ? ` · ${set.scope_ref_id}` : ""}`}
        action={
          <Badge variant={set.status === "published" ? "default" : "secondary"}>
            {set.status}
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Block editor */}
        <BlockEditor
          instructionSetId={id}
          initialBlocks={activeVersion?.blocks ?? []}
          initialVariables={activeVersion?.variables ?? {}}
        />

        {/* Live resolved preview */}
        <LivePreview
          systemPrompt={preview.systemPrompt}
          resolvedFrom={preview.resolvedFrom}
        />
      </div>

      {/* Version history */}
      {versions.length > 0 && (
        <VersionHistory
          instructionSetId={id}
          versions={versions}
          activeVersionId={set.active_version_id}
        />
      )}
    </div>
  );
}
