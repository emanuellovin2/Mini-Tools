import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg, getOrgActivity } from "@/lib/services/org";
import { can } from "@/lib/auth/permissions";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function OrgActivityPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org, role } = await getActiveOrg();

  if (!can(role, "manage_members")) {
    redirect("/settings/organization");
  }

  const events = await getOrgActivity(org.id);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Activity" description={`Recent actions in ${org.name}`} />

      <Card className="p-6">
        {events.length === 0 ? (
          <EmptyState
            title="No activity yet"
            body="Actions taken by team members will appear here."
            cta={null}
          />
        ) : (
          <ul className="divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="py-2.5 flex items-start justify-between gap-4 text-[13px]">
                <div>
                  <span className="font-medium font-mono">{e.action}</span>
                  <span className="ml-2 text-muted-foreground">
                    on {e.entity_type} {e.entity_id ? `#${e.entity_id.slice(0, 8)}` : ""}
                  </span>
                  {e.actor_role && (
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      by {e.actor_role}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
