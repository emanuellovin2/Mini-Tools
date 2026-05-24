"use client";

import { useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  setMemberRoleAction,
  removeMemberAction,
  transferOwnershipAction,
  type OrgActionResult,
} from "../actions";
import type { OrgMember, OrgRole } from "@/lib/services/org";
import { can } from "@/lib/auth/permissions";

interface Props {
  members: OrgMember[];
  currentUserId: string;
  currentRole: OrgRole;
}

export function MembersTable({ members, currentUserId, currentRole }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="pb-2 pr-6 font-medium">Member</th>
            <th className="pb-2 pr-6 font-medium">Role</th>
            <th className="pb-2 pr-6 font-medium">Joined</th>
            {can(currentRole, "manage_members") && (
              <th className="pb-2 font-medium">Actions</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              isSelf={m.user_id === currentUserId}
              currentRole={currentRole}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  currentRole,
}: {
  member: OrgMember;
  isSelf: boolean;
  currentRole: OrgRole;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleAction(action: (fd: FormData) => Promise<OrgActionResult>, fd: FormData) {
    startTransition(async () => {
      const result = await action(fd);
      if ("error" in result) setError(result.error);
    });
  }

  return (
    <tr className="py-2">
      <td className="py-2.5 pr-6">
        <div className="font-medium">{member.display_name ?? member.email}</div>
        {member.display_name && (
          <div className="text-[11px] text-muted-foreground">{member.email}</div>
        )}
        {isSelf && <span className="text-[10px] text-primary ml-1">(you)</span>}
      </td>
      <td className="py-2.5 pr-6">
        <RoleBadge role={member.role} />
      </td>
      <td className="py-2.5 pr-6 text-muted-foreground">
        {new Date(member.created_at).toLocaleDateString()}
      </td>
      {can(currentRole, "manage_members") && !isSelf && member.role !== "owner" && (
        <td className="py-2.5">
          <div className="flex items-center gap-2">
            {/* Role select */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                handleAction(setMemberRoleAction, fd);
              }}
            >
              <input type="hidden" name="user_id" value={member.user_id} />
              <select
                name="role"
                defaultValue={member.role}
                className="text-[12px] border border-border rounded px-1.5 py-0.5 bg-background"
                disabled={pending}
              >
                <option value="admin">admin</option>
                <option value="member">member</option>
              </select>
              <button type="submit" className="ml-1 text-[11px] text-primary hover:underline" disabled={pending}>
                Save
              </button>
            </form>

            {/* Remove */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!confirm(`Remove ${member.email ?? member.user_id}?`)) return;
                handleAction(removeMemberAction, new FormData(e.currentTarget));
              }}
            >
              <input type="hidden" name="user_id" value={member.user_id} />
              <button type="submit" className="text-[12px] text-bad hover:underline" disabled={pending}>
                Remove
              </button>
            </form>

            {/* Transfer ownership (owner only) */}
            {currentRole === "owner" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!confirm(`Transfer ownership to ${member.email ?? member.user_id}? You will become an admin.`)) return;
                  handleAction(transferOwnershipAction, new FormData(e.currentTarget));
                }}
              >
                <input type="hidden" name="user_id" value={member.user_id} />
                <button type="submit" className="text-[12px] text-muted-foreground hover:underline" disabled={pending}>
                  Make owner
                </button>
              </form>
            )}
          </div>
          {error && <p className="text-[11px] text-bad mt-1">{error}</p>}
        </td>
      )}
      {can(currentRole, "manage_members") && (isSelf || member.role === "owner") && (
        <td />
      )}
    </tr>
  );
}

function RoleBadge({ role }: { role: OrgRole }) {
  const variant = role === "owner" ? "ok" : role === "admin" ? "warn" : "outline";
  return <Badge variant={variant}>{role}</Badge>;
}

// useState is used inside the component but needs import
import { useState } from "react";
