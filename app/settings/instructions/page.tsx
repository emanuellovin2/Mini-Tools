import { redirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { listInstructionSets, type InstructionSet } from "@/lib/services/instructions";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { CreateInstructionSetForm } from "./CreateInstructionSetForm";

export const metadata: Metadata = { title: "Instruction Sets — [PLATFORM]" };

const SCOPE_LABELS: Record<string, string> = {
  global: "Global",
  project: "Project",
  client: "Client",
  deployment: "Deployment",
};

export default async function InstructionsPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  const sets = await listInstructionSets(org.id);

  const byScope = sets.reduce<Record<string, InstructionSet[]>>((acc, s) => {
    (acc[s.scope_level] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <PageHeader
        title="Instruction Sets"
        description="Define layered system prompts — global house voice, per-client tone, per-deployment overrides. Every AI call resolves the merged result at call time."
      />

      <CreateInstructionSetForm />

      {sets.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No instruction sets yet. Create one above to get started.
        </div>
      ) : (
        <div className="space-y-6">
          {(["global", "project", "client", "deployment"] as const).map((scope) => {
            const scopeSets = byScope[scope];
            if (!scopeSets?.length) return null;
            return (
              <section key={scope}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {SCOPE_LABELS[scope]}
                </h3>
                <div className="divide-y rounded-lg border">
                  {scopeSets.map((s) => (
                    <Link
                      key={s.id}
                      href={`/settings/instructions/${s.id}`}
                      className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-sm">{s.name}</p>
                        {s.scope_ref_id && (
                          <p className="truncate text-xs text-muted-foreground font-mono">{s.scope_ref_id}</p>
                        )}
                      </div>
                      <Badge variant={s.status === "published" ? "default" : "secondary"}>
                        {s.status}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
