"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getActiveOrg,
  switchActiveOrg,
  inviteMember,
  acceptInvite,
  setMemberRole,
  removeMember,
  transferOwnership,
  revokeInvitation,
  createTeamOrg,
  type OrgRole,
} from "@/lib/services/org";
import { can } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/services/admin";

async function requireAuth() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  return user;
}

// ---------------------------------------------------------------------------

export async function switchOrgAction(formData: FormData): Promise<void> {
  const user = await requireAuth();
  const orgId = formData.get("org_id") as string | null;
  if (!orgId) return;
  await switchActiveOrg(orgId);
}

// ---------------------------------------------------------------------------

export type OrgActionResult = { ok: true } | { error: string };

export async function inviteMemberAction(
  formData: FormData
): Promise<OrgActionResult> {
  const user = await requireAuth();
  const { org, role } = await getActiveOrg();

  if (!can(role, "manage_members")) return { error: "Insufficient permissions" };

  const email = (formData.get("email") as string | null)?.trim().toLowerCase();
  const newRole = formData.get("role") as "admin" | "member" | null;

  if (!email || !email.includes("@")) return { error: "Invalid email" };
  if (!newRole || !["admin", "member"].includes(newRole)) return { error: "Invalid role" };

  try {
    const { token } = await inviteMember({
      orgId: org.id,
      email,
      role: newRole,
      byUserId: user.id,
    });

    await writeAuditLog({
      actorId: user.id,
      actorRole: role,
      action: "org.invite_member",
      entityType: "organizations",
      entityId: org.id,
      metadata: { email, role: newRole },
      actorOrgId: org.id,
    });

    // In production: send invite email with the token.
    // Token is logged here only for dev; real email goes via Resend.
    console.info(`[dev] invite token for ${email}: ${token}`);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to send invite" };
  }

  revalidatePath("/settings/organization");
  return { ok: true };
}

export async function revokeInvitationAction(
  formData: FormData
): Promise<OrgActionResult> {
  const user = await requireAuth();
  const { org, role } = await getActiveOrg();

  if (!can(role, "manage_members")) return { error: "Insufficient permissions" };

  const inviteId = formData.get("invite_id") as string | null;
  if (!inviteId) return { error: "Missing invite_id" };

  try {
    await revokeInvitation(inviteId);
    await writeAuditLog({
      actorId: user.id,
      actorRole: role,
      action: "org.revoke_invite",
      entityType: "organizations",
      entityId: org.id,
      actorOrgId: org.id,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to revoke invite" };
  }

  revalidatePath("/settings/organization");
  return { ok: true };
}

export async function setMemberRoleAction(
  formData: FormData
): Promise<OrgActionResult> {
  const user = await requireAuth();
  const { org, role } = await getActiveOrg();

  if (!can(role, "manage_members")) return { error: "Insufficient permissions" };

  const targetUserId = formData.get("user_id") as string | null;
  const newRole = formData.get("role") as OrgRole | null;
  if (!targetUserId || !newRole) return { error: "Missing fields" };

  try {
    await setMemberRole(org.id, targetUserId, newRole, user.id);
    await writeAuditLog({
      actorId: user.id,
      actorRole: role,
      action: "org.set_member_role",
      entityType: "org_members",
      entityId: targetUserId,
      metadata: { new_role: newRole },
      actorOrgId: org.id,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update role" };
  }

  revalidatePath("/settings/organization");
  return { ok: true };
}

export async function removeMemberAction(
  formData: FormData
): Promise<OrgActionResult> {
  const user = await requireAuth();
  const { org, role } = await getActiveOrg();

  if (!can(role, "manage_members")) return { error: "Insufficient permissions" };

  const targetUserId = formData.get("user_id") as string | null;
  if (!targetUserId) return { error: "Missing user_id" };

  try {
    await removeMember(org.id, targetUserId, user.id);
    await writeAuditLog({
      actorId: user.id,
      actorRole: role,
      action: "org.remove_member",
      entityType: "org_members",
      entityId: targetUserId,
      actorOrgId: org.id,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to remove member" };
  }

  revalidatePath("/settings/organization");
  return { ok: true };
}

export async function transferOwnershipAction(
  formData: FormData
): Promise<OrgActionResult> {
  const user = await requireAuth();
  const { org, role } = await getActiveOrg();

  if (role !== "owner") return { error: "Only the owner can transfer ownership" };

  const toUserId = formData.get("user_id") as string | null;
  if (!toUserId) return { error: "Missing user_id" };

  try {
    await transferOwnership(org.id, user.id, toUserId);
    await writeAuditLog({
      actorId: user.id,
      actorRole: role,
      action: "org.transfer_ownership",
      entityType: "organizations",
      entityId: org.id,
      metadata: { to_user_id: toUserId },
      actorOrgId: org.id,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to transfer ownership" };
  }

  revalidatePath("/settings/organization");
  return { ok: true };
}

export async function createTeamOrgAction(
  formData: FormData
): Promise<OrgActionResult> {
  const user = await requireAuth();
  const name = (formData.get("name") as string | null)?.trim();
  if (!name || name.length < 2) return { error: "Team name must be at least 2 characters" };

  try {
    const org = await createTeamOrg(user.id, name);
    await switchActiveOrg(org.id);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create team" };
  }

  redirect("/settings/organization");
}

export async function acceptInviteAction(
  formData: FormData
): Promise<OrgActionResult> {
  const user = await requireAuth();
  const token = formData.get("token") as string | null;
  if (!token) return { error: "Missing token" };

  let orgId: string;
  try {
    orgId = await acceptInvite(token, user.id);
    await switchActiveOrg(orgId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to accept invite" };
  }

  redirect("/settings/organization");
}
