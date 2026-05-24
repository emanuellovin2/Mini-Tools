import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getActiveOrg,
  listMembers,
  listPendingInvitations,
} from "@/lib/services/org";
import { can } from "@/lib/auth/permissions";
import { MembersTable } from "./_components/MembersTable";
import { InviteForm } from "./_components/InviteForm";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { revokeInvitationAction } from "./actions";

export default async function OrganizationPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org, role } = await getActiveOrg();
  const [members, invitations] = await Promise.all([
    listMembers(org.id),
    listPendingInvitations(org.id),
  ]);

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title={org.name}
        description={org.type === "personal" ? "Personal workspace" : "Team workspace"}
      />

      {/* Members */}
      <Card className="p-6 space-y-4">
        <h2 className="text-[14px] font-semibold">Members</h2>
        <MembersTable
          members={members}
          currentUserId={user.id}
          currentRole={role}
        />
      </Card>

      {/* Invite */}
      {can(role, "manage_members") && org.type !== "personal" && (
        <Card className="p-6 space-y-3">
          <h2 className="text-[14px] font-semibold">Invite member</h2>
          <InviteForm />
        </Card>
      )}

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <Card className="p-6 space-y-3">
          <h2 className="text-[14px] font-semibold">Pending invitations</h2>
          <ul className="divide-y divide-border">
            {invitations.map((inv) => (
              <li key={inv.id} className="py-2 flex items-center justify-between text-[13px]">
                <span>
                  <span className="font-medium">{inv.email}</span>
                  <span className="ml-2 text-muted-foreground">— {inv.role}</span>
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    expires {new Date(inv.expires_at).toLocaleDateString()}
                  </span>
                </span>
                {can(role, "manage_members") && (
                  <form action={revokeInvitationAction as unknown as (fd: FormData) => void}>
                    <input type="hidden" name="invite_id" value={inv.id} />
                    <button className="text-[12px] text-bad hover:underline">Revoke</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Create team (only on personal org) */}
      {org.type === "personal" && (
        <Card className="p-6 space-y-2">
          <h2 className="text-[14px] font-semibold">Create a team</h2>
          <p className="text-[13px] text-muted-foreground">
            Teams let you collaborate with colleagues under a shared org.
          </p>
          <form action="/settings/organization/new" className="mt-2">
            <button className="text-[13px] text-primary hover:underline">
              + New team →
            </button>
          </form>
        </Card>
      )}
    </div>
  );
}
